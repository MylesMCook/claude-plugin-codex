# Windows long-path state and isolated ACL repair

Objective: make published advisor state work at long Windows paths, protect its
explicit root, and resolve the completed Windows CI failure without loosening
privacy, deadlines or acceptance checks.

Owner: Codex on mac-mini, primary source checkout `~/Code/MylesMCook/claude-plugin-codex`,
branch `codex/windows-long-path-state`, base `76e2d80` / release0.1.20 runtime50af938.
User authorized publication once these repairs work on October 7, 2026.

Observed: installed0.1.20 user test fails on285-character atomic files at native
owner exit3. Native control325-character path fails3 without a Windows namespace
and succeeds0 with it. An explicit state root retains inherited broad access.
Completed source CI37648759981 fails at PowerShell replacement timeouts under
isolated environments. Physical full Windows run has two failures: a10-second
fixture command limit and concurrent state-lock contention. These are not passes.

Accepted checks: long directory/file protection, private atomic publication and
interruption recovery, explicit-root privacy without implicit-parent mutation,
existing ownership/redirected-path and concurrency tests, real setup/advice,
exact-session marker recall and structured review. Keep120-second provider and
existing lock deadlines. No cache edits, elevation, security weakening or
credential changes. Preserve unrelated Windows source and marketplace work.

Implemented and pushed candidate `4c9e529` on `codex/windows-long-path-state`:
namespace all native ACL targets; protect the explicit state root; isolate the
ACL helper; construct ACLs directly through .NET; reduce new-file work while
retaining strict readback. Preserve original deadlines and privacy assertions.

Verified: failing-before ownership probe and root-privacy regression; Work HP
isolated native ACL preflight5/5; Mac validate800pass/0fail/8platform skips,
long-state/root cases2/2, native package12-file parity and real foreground
setup/JSON/exact-marker resume/review/private360-character state file. Codex
routing passes with authentication unavailable in its nested sandbox; smoke
checks installed Claude2.1.287 and excludes opt-in background execution.

Hosted diagnostic confirms `New-Object` hangs after identity resolution; direct
.NET construction passes5 ACL and2 native utility checks in run37655003156.
The first preflight's green summary hid3 ACL failures; fixed exit propagation.
Temporary diagnostics are removed. Physical Windows validate completes763pass/36skip/1fail:16 concurrent writers
exceed the existing10-second lock wait. The previous timeout fixture now passes.
Long365-character authenticated foreground checks and independent ACL readback
all pass; fresh native install passes12-file parity with per-process LF settings.
Normal Git clone/switch leaves preexistingCRLF; root attributes preserve future
mainline clones. Final line-ending-only CI37655495290 is queued.

Implemented further locally: prepare exact-private lock/state inodes outside the
critical section; claim through an exclusive hard link; preserve exclusive-create
fallback only for unsupported filesystems; read latest state under lock, keeping
regular/no-follow/schema checks. No ACL caching or deadline increases. Mac validate803pass/0fail/8platform skips. Windows isolated runtime90/90 passes;
16 writers insert/update with no lost data in4.25seconds. Additional three
recovery/fallback checks pass both OSes, including partial owner-write cleanup.
Full corrected physical Windows validation is running. User requested Claude
consultation; one read-only configured-model/xhigh pass is running through the
installed advisor with bounded local file reads. Re-review and full gates remain
required before publication.

Next: reconcile final results, land/release0.1.21, pin exact source in canonical
marketplace, verify fresh Git catalog, preserve all36 unrelated marketplace
files. User owns live installation. No approved Linear mapping.
