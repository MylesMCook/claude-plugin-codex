# Windows integration fixes

Objective: make Claude Code Advisor discover native Windows npm installs and
preserve private state, complete review input and authoritative results.

Owner: Codex on mac-mini, macOS. Primary checkout:
`~/Code/MylesMCook/claude-plugin-codex`, branch
`codex/windows-claude-discovery`, based on `1350874964aa35cd5fc5f78b32eecac9b1c5f8bd`.
Release authorized on October 6, 2026: publish 0.1.19, update the marketplace pin
and reinstall. Verification gaps are closed; release closeout is in progress.

Recovered 69 source files directly from the idle Work HP checkout. Every byte
matched the transfer snapshot before text line endings were normalized to LF.
The raw snapshot and evidence are preserved in
`~/Documents/Codex/2026-10-06-claude-advisor-resume/`.
No credentials or private assistant state were transferred.

Implemented:
- Native Windows npm discovery, preserving explicit/native PATH precedence.
- Scoped Windows state ACLs, private atomic publication and bounded ACL retry.
- Existing state-file protection, inherit-only ACL rejection and owned-lock cleanup
  after permission failure. Regression tests failed before these fixes and pass now.
- Native fixture argv/stdin forwarding, pre-execution job assignment and descendant
  cleanup before pipe drain. Cross-platform synthetic concurrency is capped at four.
- Windows process inspection, portable CLAUDE.md import and line-ending-safe checks.
- Full OS-matrix CI validation and default-model Codex E2E checks.

Verified locally:
- Full macOS validation: 793 discovered, 788 passed, zero failed, five platform skips;
  plugin metadata passes. The skips do not prove Windows behavior.
- Real Windows scratch tests: six privacy/publication checks and two native
  forwarding/exit checks passed. The source checkout on Work HP was not edited.
- Marketplace 0.1.18 installed and enabled on this Mac. Direct setup and advice
  succeeded with the configured Claude model; advice returned PASS.
- Fresh isolated corrected-source install: all 12 package files match source;
  real authentication/print setup passes without an executable override.
- Fresh-session Codex routing passes but nested sandbox authentication is unavailable.
- Authenticated fresh-session gate now passes with `--host-permissions`, inheriting
  the existing host profile. The default restricted gate retains denial coverage.
- Source review findings repaired; focused re-review found no remaining defect.
- See `docs/windows-verification.md` for evidence and remaining delivery boundaries.

Windows full gate completed: 785 discovered, 749 passed, zero failed, 36 platform
skips; metadata passes. All 69 snapshot hashes match. Fresh corrected Windows
installation matches all 12 files; real setup and advise PASS without overrides.
The source snapshot and complete Windows log are in the evidence directory.
The final E2E harness change also passes ten focused Windows routing checks.
No original Windows checkout or global configuration was changed.

Both original verification gaps are closed. The explicit host-permissions E2E
requires an authenticated result; the default restricted gate retains denial
coverage. No host-security change or credential transfer was needed.

Implementation and pre-publication verification are complete. The user authorized
version 0.1.19 publication, CI, marketplace pin update and live installation.
Delivery receipts belong in the v0.1.19 GitHub release and the existing
mcook-plugins/tasks.md record. The preserved marketplace checkout contains
unrelated dirty work and must not be included in this release.
Tracking remains tasks.md; neither repository has an approved Linear mapping.
