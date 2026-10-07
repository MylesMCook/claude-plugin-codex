# Windows state repair and release 0.1.21

Objective: fix 0.1.20 setup/advice/review failure at 285-character Windows paths,
protect the explicit state root, and publish after verification.
Owner: Codex on mac-mini; primary source checkout
`/Users/mylescook/Code/MylesMCook/claude-plugin-codex`,
branch `codex/windows-long-path-state`, base `76e2d80`.
User authorized publication after the fixes work on October 7, 2026.

Accepted outcomes: private long-path directory/file creation; atomic state
publication and interruption recovery; explicit-root privacy without changing
implicit parents; concurrent updates without data loss; real setup, JSON advice,
exact-session marker recall and structured review. Preserve permission checks,
existing provider/lock deadlines and unrelated checkouts. User owns installation.

Implemented: namespaced native ACL paths; explicit-root protection; isolated
PowerShell helper with direct .NET ACL construction; strict final ACL readback;
private state/lock preparation outside the critical section; exclusive hard-link
lock claim with unsupported-filesystem fallback and partial-write cleanup;
LF plugin attributes; Windows CI preflight failure propagation. Candidate
`6c1602d` is pushed. Subsequent local sharing fix retries transient Windows rename
errors for one second and reads lock-owner hints only when the wait expires.

Failing-before evidence: native 325-character ownership path exits3, namespaced
path succeeds; explicit root remains0755; isolated PowerShell `New-Object` hangs;
16 Windows writers exceed fixture lock wait; held old state reader causes EPERM.
Claude consulted twice read-only through the installed advisor using configured
model and xhigh. Its held-reader suggestion exposed the last confirmed defect;
it found no confirmed CLI invocation blocker. Optional Plan-mode observations
are outside this repair; existing read-only authority remains unchanged.

Verified on 6c1602d: Mac validate803pass/8platform skips; physical Windows
validate767pass/36platform skips, no failures. Windows runtime90/90 includes
16 writers completing insert/update in4.25seconds. Both OSes pass fresh native
installation and 12-file byte parity (isolated Windows candidate clone uses
per-process LF configuration); authenticated setup/JSON/exact-marker resume/
review and independent state privacy pass at366/371-character state paths.
Codex routing passes with nested-sandbox authentication unavailable; smoke
confirms installed Claude2.1.287 and excludes opt-in background execution.

Sharing patch: Mac runtime92pass/1Windows skip; physical Windows held-reader and
permanent-denial regressions2/2 pass. An initial new test had a missing fixture
import, now fixed. Final full CI and package receipts remain required.
Evidence: `/Users/mylescook/Documents/Codex/2026-10-07-claude-advisor-long-paths`.

Next: final checks, land/tag/release0.1.21, pin exact runtime SHA in the canonical
marketplace and verify fresh Git catalog visibility. Preserve all36 unrelated
marketplace files. No credential/cache/global configuration changes or elevation.
