import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Isolate module mocks so a full API test run retains its real auth/database modules.
test("game HTTP lifecycle: race progression, co-op completion, hidden-role tasks and replay", async () => {
  const fixture = fileURLToPath(new URL("../test-fixtures/games-lifecycle.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(output + errors);
  expect(output.match(/PASS:/g)?.length).toBe(3);
});
