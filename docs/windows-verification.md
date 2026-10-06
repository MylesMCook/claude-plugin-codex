# Claude advisor verification

Version 0.1.19 changes on `codex/windows-claude-discovery`, based on
`1350874964aa35cd5fc5f78b32eecac9b1c5f8bd`. Continued on mac-mini on October 6, 2026.
Release closeout was explicitly authorized after these verification gates passed.

## Recovery

The idle Work HP checkout contained the Windows fixes and test-harness repairs.
69 tracked and untracked source files were transferred directly to the Mac primary
checkout and checked byte for byte. Text was then normalized to LF to preserve a
reviewable Git diff. The original snapshot and SHA-256 manifest remain in
`~/Documents/Codex/2026-10-06-claude-advisor-resume/`.
The shortened marketplace README was also recovered. Credentials, ignored files,
assistant memory stores and application-managed state were excluded.

## Changes

Native npm discovery follows explicit overrides and existing native locations.
Shell shims are never executed. The native smoke check uses the same resolver.
Windows fixtures now use a native launcher with argv/stdin fidelity and a Job
Object. Fixture execution waits for job assignment. Provider exit closes the job
before draining output, so descendants cannot keep the pipes open indefinitely.

Windows state protection applies only to managed advisor paths and test fixtures.
Existing state files are protected before reading. ACL validation rejects extra,
conditional and inherit-only grants. A failed permission check during lock
acquisition removes only a lock whose ownership token matches this process.
Temporary state files are protected before atomic publication. Denied permissions
fail immediately; native timeout retry is bounded.

## Verified on macOS

- `npm run validate`: 793 discovered, 788 passed, zero failed, five platform skips;
  plugin metadata validation passed. Native Windows branches are not proved by this.
- `npm run test:smoke`: native Claude 2.1.287 discovered. Authenticated background
  smoke was not requested or run.
- `npm run test:e2e:codex`: fresh-session advisor routing passed. Nested sandbox
  authentication was unavailable, so this check did not obtain an authenticated
  Claude response.
- `node tests/e2e-codex-skill.mjs --host-permissions`: a fresh Codex session
  authenticated, called the installed advisor using the configured default model,
  returned PASS and matched persisted job state. This explicit test inherits the
  existing host permissions. It does not change configuration or remove an
  originating sandbox. Authentication denial is a failure in this mode.
- The installed Git-marketplace 0.1.18 companion's direct setup authenticated and
  passed its real print probe. A bounded direct advisor call returned PASS using
  the configured default model, without an executable override or model override.
- A fresh isolated install of the corrected source contains 12 byte-identical
  package files and passes its real authentication/print setup probe.
- New state-permission, failed-lock and inherit-only ACL checks failed before their
  fixes and pass afterward. Existing malformed-state and ownership checks remain.
- Independent source review identified the privacy/lock/native-fixture defects;
  focused re-review found no remaining concrete defect in those fixes.

## Verified on Windows

The last pre-handoff full run found 782 tests: 744 passed, two failed and 36 skipped.
The failures were a timeout subtest and its parent. Both review kinds' targeted
failure-diagnostic checks subsequently passed all eight tests on Work HP.

After continuation, current source was copied into an isolated Windows scratch
checkout, without editing the original source checkout. Six native permission,
legacy-file protection, failed-lock and pre-rename publication checks passed.
Two native argv/stdin forwarding and immediate-descendant/pipe-drain checks passed.
These targeted checks preceded the full gate below.

The earlier Windows installed-plugin Codex E2E and fresh corrected installation
were reported successful in the handoff. They were not rerun as full Windows E2E
checks during this Mac continuation. Windows background execution is unsupported.

The final full Windows gate passed on Work HP: 785 discovered tests, 749 passed,
zero failed, 36 platform skips, followed by passing plugin metadata validation.
The run took 581 seconds. All 69 source files matched the transferred SHA-256
manifest. The only later code change adds the explicit host-permissions E2E mode;
production package files were unchanged during this gate.
After synchronizing that final E2E harness change, all ten focused Windows
Codex-routing checks and plugin metadata validation passed.

A fresh isolated Windows install of the corrected source contains 12 byte-identical
package files. Real setup authenticated and passed the print probe without an
executable override. A bounded advice call through that corrected installed
package returned PASS with no model or executable override.

Full Windows log: `windows-full-validation.log` in the evidence directory.
Install/advice evidence: `corrected-install-windows.json` and
`corrected-advise-windows.json` in that directory.

## Pre-publication verification boundaries

At the time of these checks, the active marketplace installation was pinned to
the old base commit. The corrected source and isolated installation tests were
separate. Version 0.1.19 changes the release metadata; the verified production
runtime is unchanged. Published delivery receipts are recorded in the v0.1.19
GitHub release and mcook-plugins/tasks.md.
Full current Windows validation is verified. Hosted OS-matrix CI has not run for
these unpublished changes. The default restricted E2E intentionally verifies
unavailable authentication; the explicit host-permissions E2E requires an actual
authenticated response under the existing host policy.
Publication and marketplace replacement were authorized after verification.
CI, published-source identity and installed-package checks are release gates.
No host-service change or credential transfer is part of this release.

Evidence directory: `~/Documents/Codex/2026-10-06-claude-advisor-resume/`.
