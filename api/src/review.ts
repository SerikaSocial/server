import { unzipSync } from "fflate";
import { Cap } from "./trust.ts";
import { validateScriptBytecode, type ScriptValidation } from "./serikascript.ts";

/// World-version review state machine. Mirrors the `WorldVersion.reviewStatus` column.
export const ReviewStatus = {
  Draft: 0,
  Submitted: 1,
  AutoApproved: 2,
  InReview: 3,
  ChangesRequested: 4,
  Approved: 5,
  Rejected: 6,
  Withdrawn: 7,
} as const;

export const REVIEW_LABELS: Record<number, string> = {
  0: "draft", 1: "submitted", 2: "auto_approved", 3: "in_review",
  4: "changes_requested", 5: "approved", 6: "rejected", 7: "withdrawn",
};

/// A world version is joinable by others only in these terminal-good states.
export const PUBLISHED_STATES = new Set<number>([ReviewStatus.AutoApproved, ReviewStatus.Approved]);

// glTF extensions we can prove are inert. Anything else routes to review as "code".
const GLTF_EXT_WHITELIST = new Set([
  "KHR_materials_unlit",
  "KHR_texture_transform",
  "KHR_materials_emissive_strength",
  "KHR_lights_punctual",
]);

// Asset budgets scale with trust rank (bytes). Static worlds from higher ranks may be larger.
function bundleBudgetBytes(rank: number): number {
  if (rank >= Cap.AutoApproveStatic) return 200 * 1024 * 1024; // 200 MiB
  if (rank >= Cap.SubmitScriptedWorld) return 120 * 1024 * 1024;
  return 60 * 1024 * 1024;
}

export interface ValidatorReport {
  ok: boolean;
  hasScript: boolean;
  bundleBytes: number;
  budgetBytes: number;
  scripts: { name: string; validation: ScriptValidation }[];
  gltfExtensions: string[];
  errors: string[];
  warnings: string[];
}

const SCRIPT_MAGIC = new Uint8Array([0x53, 0x53, 0x4b, 0x42]); // "SSKB"

function startsWith(buf: Uint8Array, magic: Uint8Array): boolean {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
  return true;
}

/// Inspect a `.serikaworld` bundle: detect script content, run static validation, check the
/// asset budget and the glTF extension whitelist. Conservative — anything it cannot prove
/// inert is treated as executable content (`hasScript = true`) and routed to human review.
export function validateBundle(bundle: Uint8Array, rank: number): ValidatorReport {
  const report: ValidatorReport = {
    ok: true,
    hasScript: false,
    bundleBytes: bundle.length,
    budgetBytes: bundleBudgetBytes(rank),
    scripts: [],
    gltfExtensions: [],
    errors: [],
    warnings: [],
  };

  if (bundle.length > report.budgetBytes) {
    report.errors.push(`bundle ${bundle.length} bytes exceeds rank budget ${report.budgetBytes}`);
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bundle);
  } catch (e) {
    report.errors.push(`bundle is not a readable zip: ${e instanceof Error ? e.message : String(e)}`);
    report.ok = false;
    return report;
  }

  for (const [name, data] of Object.entries(files)) {
    const lower = name.toLowerCase();

    // 1. SerikaScript bytecode — by extension or by magic. Validate every one.
    if (lower.endsWith(".sskb") || lower.endsWith(".sscript") || startsWith(data, SCRIPT_MAGIC)) {
      report.hasScript = true;
      const validation = validateScriptBytecode(data, rank);
      report.scripts.push({ name, validation });
      if (!validation.ok) report.errors.push(`script ${name}: ${validation.errors.join("; ")}`);
      continue;
    }

    // 2. Reject anything that could load code at runtime (defense in depth).
    if (/\.(dll|so|dylib|gd(script|extension)|cs|exe|sh|py)$/i.test(lower)) {
      report.errors.push(`disallowed executable/resource file in bundle: ${name}`);
      report.hasScript = true;
      continue;
    }

    // 3. glTF extension whitelist — scan .gltf JSON for extensionsUsed/Required.
    if (lower.endsWith(".gltf")) {
      try {
        const json = JSON.parse(new TextDecoder().decode(data));
        const used: string[] = [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])];
        for (const ext of used) {
          if (!report.gltfExtensions.includes(ext)) report.gltfExtensions.push(ext);
          if (!GLTF_EXT_WHITELIST.has(ext)) {
            report.errors.push(`non-whitelisted glTF extension: ${ext} (in ${name})`);
            report.hasScript = true; // treat as code until proven inert
          }
        }
      } catch {
        report.warnings.push(`could not parse glTF json ${name} to check extensions`);
      }
    }

    // 4. manifest path/URL whitelist — no engine resource paths.
    if (lower.endsWith("manifest.json") || lower.endsWith(".json")) {
      const text = new TextDecoder().decode(data);
      if (/res:\/\/|user:\/\/|(^|["'\s])(\/[A-Za-z])/.test(text)) {
        report.warnings.push(`${name} contains suspicious path-like strings; verify no engine loads`);
      }
    }
  }

  report.ok = report.errors.length === 0;
  return report;
}

export interface RoutingDecision {
  reviewStatus: number;
  hasScript: boolean;
  /// True when a top-rank author self-published scripted content (log + spot-audit).
  selfPublishScripted: boolean;
  report: ValidatorReport;
}

/// Decide where a freshly-uploaded submission lands, given the author's effective rank and the
/// validator report. This is the core policy from the spec §3.2 step 5.
export function routeSubmission(rank: number, report: ValidatorReport, isAdmin: boolean): RoutingDecision {
  const base = { hasScript: report.hasScript, report, selfPublishScripted: false };

  // A validator failure never queues a human — it's an immediate rejection.
  if (!report.ok) {
    return { ...base, reviewStatus: ReviewStatus.Rejected };
  }

  if (report.hasScript) {
    // Scripted content: only the top rank (or an admin) may auto-publish; everyone else queues.
    if (isAdmin || rank >= Cap.PublishScriptNoReview) {
      return { ...base, reviewStatus: ReviewStatus.AutoApproved, selfPublishScripted: true };
    }
    return { ...base, reviewStatus: ReviewStatus.InReview };
  }

  // Code-free content: creators (rank 5+) auto-publish; lower ranks queue for a human.
  if (isAdmin || rank >= Cap.AutoApproveStatic) {
    return { ...base, reviewStatus: ReviewStatus.AutoApproved };
  }
  return { ...base, reviewStatus: ReviewStatus.Submitted };
}
