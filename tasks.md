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

Implemented locally: namespace native ACL paths; isolated disposable PowerShell
profile folders; explicit state-root protection; new-file native grant/readback.
Regression evidence: root-privacy test fails before implementation; native long
owner probe fails before namespace normalization. Windows long-path regression
and full checks are pending. No commit, push or publication yet.

Next: validate long-path fallback and isolated startup, repair independent
long-path ACL inspection, run full Windows/Mac/CI checks, release0.1.21 and pin
its exact source in the canonical marketplace. No approved Linear mapping.
