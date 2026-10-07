# Windows state repair and release 0.1.21

Objective: fix 0.1.20 setup/advice/review failure at 285-character Windows paths,
protect the explicit state root, and publish after verification.
Owner: Codex on mac-mini; primary source checkout
`/Users/mylescook/Code/MylesMCook/claude-plugin-codex`,
branch `main`; completed runtime `278fdd1`, base `76e2d80`.
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
LF plugin attributes; Windows CI preflight failure propagation. Released runtime `278fdd1` includes the sharing fix, which retries transient Windows rename
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

Hosted 6c CI passes five jobs but Windows fails88 guarded readback checks:
the seed helper prepared private children without protecting its explicit root.
Repairing that root then triggered the test no-provider-execution guard. Seed
now uses the actual explicit boundary before readback; guard remains unchanged.

Final checks: Mac validate804pass/9platform skips; physical Windows runtime93/93
and guarded readback98/98 pass. Hosted Windows validate769pass/36platform skips.
All six source jobs pass in run37659216404 at exact release runtime278fdd1.
An initial new test had a missing fixture import, now fixed. Fresh native
Windows main installation uses ordinary Git settings and matches all12 bytes.
Evidence: `/Users/mylescook/Documents/Codex/2026-10-07-claude-advisor-long-paths`.

Published alpha v0.1.21 at `278fdd1965b498e52f1201742141156f4b02fbbf`.
Canonical marketplace `6a13ee9aade32cb9ce8379bf65b3ced16c347194` pins that SHA;
all three marketplace jobs pass in run37661018087. Fresh canonical Git-backed
installation confirms version, pin and all12 installed bytes. All36 unrelated
marketplace files remain unchanged. No live cache edits, credential/global
configuration changes or elevation. User owns refreshing their installation.

Release: https://github.com/MylesMCook/claude-plugin-codex/releases/tag/v0.1.21
Full source CI: https://github.com/MylesMCook/claude-plugin-codex/actions/runs/37659216404
Marketplace CI: https://github.com/MylesMCook/mcook-plugins/actions/runs/37661018087
Detailed local evidence and release-receipt.json are in the evidence folder above.
