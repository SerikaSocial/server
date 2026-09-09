# Contributing to Serika Social

Thanks for your interest in contributing to Serika Social! This project is developed
under the [Serika.art Source Available License](./LICENSE). Please read it before
contributing — by submitting a contribution you accept that license.

## Before you start

- **This is source-available, not open source.** You may view, study, and fork the
  repository for personal, non-commercial experimentation, and submit contributions
  back upstream. You may **not** publicly deploy, commercially use, redistribute, or
  build a competing service from the code. See [`LICENSE`](./LICENSE) for the full
  terms.
- **Contributions are granted to the project.** Under License Section 4(c), any
  feedback, suggestions, or contributions you provide may be used by the copyright
  holder without any obligation to you. By submitting a pull request you confirm that
  you have the right to do so and that you grant the project a perpetual, irrevocable,
  worldwide, royalty-free license to use your contribution.
- **No credentials.** Never commit `.env` files, API keys, tokens, or private
  endpoints. `.env` is gitignored in every repo; copy from `.env.example`.

## Repo layout

Serika Social is a **multi-repo monorepo** — each subdirectory is its own git repo
under `github.com/SerikaSocial`. Commit and push **per-repo**, never from the
workspace root (the root is not a git repo).

```
Godot-SerikaSocial/
  proto/   server/   game/   godot-sdk/   web/   infra/   tools/   docs/
```

`proto` is a **git submodule** pinned in both `server` and `game`. Both pins must
point at the same commit. See each repo's `README.md` and the root `AGENTS.md` for
the full workflow.

## The one rule you must not break

`proto` is the wire codec contract between the Rust relay and the C# client. The
golden-vector corpus (`proto/golden/vectors.json`) must pass byte-identically in
**both** test suites:

```bash
# server
cargo test -p serika-proto
# game
dotnet test Net/Codec/Tests
```

If you change the codec, push `proto` first, then bump the pins in `server` and
`game` together. A client and a relay on different `proto` commits is exactly the
desync the corpus exists to prevent.

## How to contribute

1. **Fork** the relevant repo on GitHub (personal, non-commercial experimentation
   only, per the license).
2. **Branch** off `main`: `git checkout -b my-fix`.
3. **Make your change.** Match the existing code style. Don't add or remove comments
   unless asked. Keep hot paths allocation-free in the Godot client.
4. **Test.** Run the repo's test suite (see its `README.md`). For codec changes, both
   golden suites must pass byte-for-byte.
5. **Commit** with a short imperative subject (e.g. `Relay: evict stale peers on
   HELLO`). Don't commit from the workspace root.
6. **Push** to your fork and open a pull request against `main`.
7. **Describe** what changed and why, and link any related issues.

## Pull request checklist

- [ ] Branch is based on the latest `main`.
- [ ] Tests pass locally.
- [ ] No secrets, `.env` files, or private endpoints committed.
- [ ] Commit message explains *why*, not just *what*.
- [ ] If you touched `proto`, both golden suites pass and both pins are bumped.
- [ ] If you touched auth or the codec, you've read the relevant docs
      (`docs/auth-integration.md`, `proto/pose_codec.md`).

## Reporting bugs and requesting features

Open an issue on the relevant repository. Include:
- What you expected, what happened, and the smallest reproducible steps.
- Versions (client build, browser/OS, headset if VR).
- Logs (redact any secrets/tokens first).

## Conduct

Be respectful and constructive. Harassment, discrimination, or abusive behaviour
will not be tolerated. We're a small team building a social VR platform — assume good
faith.

## Contact

- **Issues:** the relevant `github.com/SerikaSocial/<repo>` repository.
- **License / legal:** legal@serika.dev (see [`LICENSE`](./LICENSE) Section 8).
- **General:** https://serika.art/contact

Thanks for helping make Serika Social better!
