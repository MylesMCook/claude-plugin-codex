# UX advisor verification and approvals

These local changes reuse the foreground companion and preserve LICENSE and
Yanchuk's MIT notice. Anthropic's frontend-design plugin is an external
prerequisite; no third-party skill text or implementation is redistributed.

Official references checked October 3, 2026:

- https://code.claude.com/docs/en/cli-reference (`-p`, `--tools`, `--allowedTools`, `auth status`, turn limits)
- https://code.claude.com/docs/en/headless (explicit skill request in the prompt; print mode loads installed skills; project/user hooks may run)
- https://github.com/anthropics/claude-plugins-official/tree/main/plugins/frontend-design (external skill)

The UX route enables Read/Glob/Grep and Skill, pre-approving only the named
frontend-design skill. It does not offer command, editing or delegation tools.
The model's claim that it loaded the skill is not independently verified by this
runtime. Real integration must confirm tool behavior with the installed CLI.
Print mode can load local hooks/configuration; inspect those before approving a
real call. Do not use bare mode here: it changes subscription authentication and
skill discovery. The preset bounds provider time to 120s plus a 10s local auth
preflight. Existing process timeout cleanup is retained; real descendant cleanup
is not established by the synthetic test.

No global install, login, commit, push or PR was performed. Local verification
was intended to use temporary synthetic executables; see the incident below. Platform-specific discovery tests simulate Windows paths on macOS;
they do not establish Windows CLI behavior. Existing broad tests include POSIX
process-group assumptions and are not claimed as portable Windows integration.

Pending exact actions require separate approval:

- `npm run test:smoke`: repository tests/smoke-installed-tools.mjs invokes actual
  Claude setup and foreground/background prompts, accessing configured auth and
  consuming model quota. Review its synthetic workspace/context first.
- `npm run test:e2e:codex`: repository tests/e2e-codex-skill.mjs launches Codex and
  routes a real Claude advice call; both providers can consume quota.
- Any real `node <absolute-plugin-root>/scripts/claude-companion.mjs ux
  --billing-source <source> <exact-question>` call: report exact prompt, cwd,
  accessible files, installed hooks/plugins and billing source before approval.
- Anthropic frontend-design installation/enablement and any global configuration
  changes, if needed, are separate actions.

AGENTS.md requested Context7 via `npx ctx7@latest` for CLI documentation. This
would download/execute an unreviewed package. It was not executed; official
Anthropic documentation was read directly instead. No install script was run.

## Local validation evidence and test isolation incident

Fourteen focused UX/isolation tests passed (no skipped tests on this Mac). Static syntax checks,
`git diff --check`, and `node tests/validate-plugin.mjs` passed. A broad host run
reported 777 tests: 769 passed, six failed, two skipped. Failures included stale
literal-command test assumptions, timing-sensitive fixtures, and one isolation
failure. Those fixtures were corrected. The first follow-up run was paused at the user's
instruction, and full harness isolation was completed before safely resuming.

In the isolation failure, the missing-executable supervisor test deleted its
fake CLI and shortened PATH. New Desktop discovery could select the host's real
Claude CLI. The test unexpectedly reported successful background launch. Its
exact stdin was `check`, cwd was a temporary empty Git repo, and arguments were
print/json, max-turns 20, xhigh effort, empty strict MCP config, no Chrome,
Read/Glob/Grep tools and plan permission mode. Environment and user configuration
were inherited. There is no verified evidence of a completed model request,
authentication/billing source, usage or charge. No private repository code was
in the test prompt/workspace. Host hooks/configuration were not isolated, so no
broader claim about provider context is made.

The supervisor fixture now pins `CLAUDE_COMPANION_EXECUTABLE` to its fake path;
deleting it fails closed and cannot discover a host installation. The focused UX
integration fixtures already pin the fake path, use a temporary HOME/state root,
and construct their environment without host credentials. The corrected timeout
fixture also pins its fake path. The isolation review now covers all eleven companion harnesses. Each imports a
shared test-only allowlisted environment and pins its mock path. `npm test` also
starts every worker in temporary HOME/Claude/Codex configuration and state with
a missing mock as the fail-closed default. Neither provider credentials nor
NODE_OPTIONS/SSH agents are inherited. Sentinel tests prove that missing mocks
cannot execute PATH or home-directory fallbacks. The first isolated broad run had 781 tests: 777 passed, two failed, two
skipped. Both failures were fake-provider startup assertions with 300ms deadlines
under concurrent load. Their synthetic response delay is now 4s against a 1s
provider deadline; both targeted timeout checks passed. Final `npm run validate` passed after that correction: 781 tests, 779 passed,
zero failed, two platform-specific skips, followed by `plugin metadata ok`.
All nineteen changed/new JavaScript files also passed syntax checks and the
local diff passed `git diff --check`. Real provider invocation remains unapproved.

Read-only process inspection found no surviving test-owned provider/supervisor
process from the unintended launch. The paused follow-up validation tree was
stopped by its observed PIDs only; unrelated existing Claude processes were left
alone. Logs are local diagnostic evidence, not real integration proof.

## Activation

Install this fork with the supported Codex marketplace/plugin commands in README.
The manifest retains upstream version 0.1.18; record the installed Git commit as
the build identity. Install `frontend-design@claude-plugins-official` with Claude's
plugin manager. Verify subscription authentication in the process that will run
the advisor, then use `$claude ux --billing-source subscription <question>`.

Start a new Codex thread to load newly installed skills and any global AGENTS
routing change. Existing Claude sessions may need `/reload-plugins` or a fresh
session; a new companion print invocation loads installed plugins afresh. Do not
restart active apps or sessions automatically. More specific project policies
apply. Provider-call approval must cover the exact context; private source,
screenshots and sensitive data always require permission before transmission.
A global routing rule proposes the advisor, keeps Codex responsible for code and
verification, and must not cause recursive consultations or background retries.

The CI workflow also supports manual dispatch so the reviewed synthetic suite
can be verified on a chosen published fork ref without invoking either model.
