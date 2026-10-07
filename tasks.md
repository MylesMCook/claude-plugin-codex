# Claude advisor 0.1.20 fixes and release

Objective: repair unelevated Windows state ACL replacement and make explicit
fresh JSON advice resumable only after strict provider-result validation.
Investigate the single structured-review timeout without weakening deadlines.

Owner: Codex on mac-mini, primary checkout `~/Code/MylesMCook/claude-plugin-codex`,
branch `codex/windows-state-and-json-resume`, based on published `04fb296`.
User explicitly requested fixes, deployment and release on October 7, 2026.
Tracking uses tasks.md; no approved Linear mapping exists.

Accepted behavior and evidence: sanitized October 7 handoff packet. Ordinary
Windows tokens must protect fresh/existing state without restore privilege;
exact user/SYSTEM grants, ownership, redirected-path rejection and private
atomic publication remain required. Fresh JSON results establish exact session
identity only after successful strict envelope validation. Invalid results
remain non-resumable and read-only continuations retain their authority.

Implemented: access-only Windows DACL replacement with strict readback, native
fast path and scoped Windows module search; successful fresh JSON result
validation on original bytes; explicit continuation guidance; version 0.1.20.

Verified: nine new JSON regressions failed before implementation. Current
non-review result/resume checks pass 95/95. A first full Mac run exposed four
output-contract regressions; removing the extra response identity preserves
that contract, and all 95 relevant checks now pass. Windows focused checks pass
38 with three platform skips; native privacy checks pass 4/4 under the affected
ordinary account. Real fresh-installed Mac setup, exact marker recall across
one resumed session, and structured review pass; review took 2.6 seconds at the
unchanged 120-second deadline. Metadata and native CLI smoke pass; restricted
Codex routing passes with authentication denial correctly reported.

Publication completed at the user's request. Source main and release v0.1.20
contain `50af938ef69de6dcdfd2c7dac8b13bd6d3c2565f`; canonical marketplace commit
`47d06d2609f2601a676cd1e92d319a64d6e0a1ef` pins that exact source. A fresh
Git-backed catalog confirms visibility. Fresh installed Mac package bytes match
all 12 final source files; the real final-package foreground conversation and
structured review pass. The Windows real conversation recalls its first-turn
marker and a structured review completes in 25.6 seconds.

Source CI: Mac, Linux and Node20/22/24 pass. Full Windows CI is still running;
no full Windows pass is claimed. Exact receipt:
https://github.com/MylesMCook/claude-plugin-codex/actions/runs/37648759981
The bounded physical Windows full run also remains in progress. Evidence is in
the October 7 task scratch directory. No Windows primary checkout, credentials
or unrelated marketplace edits changed. The user will install the published
update; no live installation is part of this publication.

Next: user marketplace refresh/install. Inspect the remaining Windows CI receipt
if needed; publication, source landing and canonical catalog update are complete.
