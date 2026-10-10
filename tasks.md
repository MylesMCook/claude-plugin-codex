# Agent Plugins packaging conformance, candidate 0.1.22

Objective: make Claude Code Advisor conform where possible and release through
its existing standalone source and marketplace pin. Owner: Codex on mac-mini;
isolated implementation checkout `/private/tmp/mcook-portable-fixes.WNpgg0/advisor`,
branch `main`, base `278fdd1965b498e52f1201742141156f4b02fbbf`. The current user
requested fixes and “git it out”; the primary agent owns commits and publication.

Implemented, uncommitted: portable `plugins/claude-code-advisor/plugin.json` with
fixed skill discovery and `extensions.com.openai.interface`; matching native
manifest and package version 0.1.22; package-local README/CHANGELOG and unchanged
original MIT licence. Portable packaging needs no native-only exception. The
workflow still targets Codex. The skill now recognizes a root portable manifest
or the legacy native manifest; runtime, auth and permission contracts are unchanged.
New packaging tests enforce identity/version/interface alignment, contained
assets, discovered skill and installed licence/documentation.

Verified: both packaging regressions failed before (missing portable manifest
and installed licence), then 2/2 passed. Bundled Agent Plugins validator passed
with zero warnings using cached jsonschema 4.26.0; skill quick validation passed
using cached PyYAML 6.0.3; `node tests/validate-plugin.mjs` passed. Codex CLI
0.162.1 `npm run test:install:codex` passed overlay and portable-only disposable
fixtures, respectively 16 and 15 exact installed files and stable skill discovery.
It uses an allowlisted credential-free environment and calls no provider/model.
The final package moves client-specific icons into `com.openai/assets/`. The new namespace assertion failed before and passes after; exact candidate metadata and both ingestion modes pass. Diff whitespace checks pass.

Restricted `npm run validate` failed on sandbox socket/process restrictions; that runner exited. The supported host-permission rerun passed 806 checks with 9 platform-specific skips and zero failures. The exact final candidate rerun also passed 806 checks with 9 platform-specific skips, zero failures, and native metadata validation. OpenAI plugin-creator validator script is absent; source metadata
validation and actual CLI ingestion passed instead. Live `test:e2e:codex` is
unrun: it always invokes real Codex exec and Claude setup/advice. Default smoke passed with Claude Code 2.1.293 and intentionally skipped authenticated background calls. Authenticated background smoke needs explicit opt-in.
No fresh model activation or authenticated provider result is claimed. Packaging-only changes now use candidate ingestion as their local gate; existing live routing tests remain required for changes to workflow execution and provider routing. Legacy native compatibility artifacts are documented outside the portable conformance claim.

Next: primary agent reruns exact candidate checks, reviews diff, commits/pushes
source release, updates the pinned marketplace entry and verifies published
visibility. User owns active installation. Previous v0.1.21 Windows/runtime
release was verified at base 278fdd1; details remain in the repository changelog,
docs/windows-verification.md and GitHub release v0.1.21.


Windows release gate follow-up: initial CI attempt stalled at the 20-minute harness deadline before full-suite results. One unchanged retry executed 807 tests: 770 passed, 36 platform skips, one failure. The failure was exact licence parity: root LICENSE checked out as CRLF while the package subtree was pinned to LF. The original licence text and committed content were identical.

Fixed only the root LICENSE checkout attribute to LF. A core.autocrlf=true checkout reproduced the mismatch before and exact original-byte parity after. Both packaging regressions and native metadata validation pass with assertions unchanged. Runtime and package content remain unchanged from f7b45a5. Next: push this follow-up, require the new source CI green, then tag 0.1.22 and update the marketplace pin to the validated commit.
