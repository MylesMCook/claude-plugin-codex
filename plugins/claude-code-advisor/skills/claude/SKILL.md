---
name: claude
description: >
  Use when the user asks Codex to consult Claude Code, run a Claude advisor
  pass, get a Claude adversarial review, check a plan or diff with Claude,
  ask Claude to do a prepared coding, exploration, verifier, scout, or rescue
  task, inspect Claude advisor job status, fetch a Claude result, or cancel a
  Claude advisor job. This skill routes through the bundled claude-companion.mjs
  runtime; it does not call the Claude CLI directly.
---

# Claude Code Advisor

Use this skill to route Codex work to the local Claude Code CLI through the
bundled companion runtime. Codex remains the orchestrator. Claude Code is the
advisor, checker, or reviewer.

## Invocation Contract

Canonical forms:

```text
$claude setup
$claude ux --billing-source subscription|api|third-party <question>
$claude advise [--max-turns <n>] <question>
$claude do [--background] [--write] [--model sonnet|opus] [--max-turns <n>] <prepared task>
$claude rescue [--background] [--write] [--resume] [--model sonnet|opus] [--max-turns <n>] <task>
$claude review [--base <ref>]
$claude adversarial-review [--base <ref>] [focus]
$claude monitor [job-id]
$claude status [job-id]
$claude result [job-id]
$claude cancel [job-id]
$claude resume-candidate
```

If Codex passes slash-style text through to this skill, normalize it before
routing:

```text
/claude <subcommand> <args> -> $claude <subcommand> <args>
/claude:setup -> $claude setup
/claude:advise <question> -> $claude advise <question>
/claude:do <prepared task> -> $claude do <prepared task>
/claude:rescue <task> -> $claude rescue <task>
/claude:review [--base <ref>] -> $claude review [--base <ref>]
/claude:adversarial-review [focus] -> $claude adversarial-review [focus]
/claude:monitor [job-id] -> $claude monitor [job-id]
/claude:status [job-id] -> $claude status [job-id]
/claude:result [job-id] -> $claude result [job-id]
/claude:cancel [job-id] -> $claude cancel [job-id]
```

Do not add or depend on undocumented plugin manifest fields for custom slash
commands. The guaranteed Codex surface is the `$claude` skill mention.

## Hard Rules

- Always call the bundled companion at `<plugin root>/scripts/claude-companion.mjs`
  using an absolute path. The plugin root is the `claude-code-advisor`
  directory that contains `.codex-plugin/`, `skills/`, and `scripts/`.
- Do not call `claude` directly from the skill instructions.
- Return a concise human summary unless the user asks for raw JSON.
- Review and adversarial-review are read-only.
- Write-capable Claude work requires explicit `--write`.
- Every default companion launch must be non-interactive. Keep the runtime's
  empty strict MCP restriction flags: `--mcp-config '{"mcpServers":{}}'
  --strict-mcp-config --no-chrome`. These are essential for unattended runs;
  without them Claude Code can stop at the MCP permission picker instead of
  producing an answer.
- Do not use project MCP servers unless the user explicitly asks for MCP.
  Background mode must refuse the current directory and ancestor directories
  with `.mcp.json` unless `--allow-mcp` is explicit. Use `--allow-mcp` only
  after that explicit user approval.
- Keep read-only `advise`, `do` and `rescue` tasks on local tools by default:
  `Read,Glob,Grep`. Enable `WebFetch` or `WebSearch` only when the task needs
  web access and `--allow-web` is explicit.
- Do not pass `--model sonnet` for advice, review, adversarial-review, rescue,
  or monitor work unless the user explicitly asks for Sonnet. Let Claude Code
  use the user's configured default model.
- Pass `--effort xhigh` for advice, review, adversarial-review, rescue, and
  background jobs unless the user explicitly asks for another effort.
- Sonnet is reserved for explicit junior-agent delegation governed by the
  `tasks-for-sonnet` skill. Never send Sonnet a vague task.
- Before `$claude do --model sonnet`, load `tasks-for-sonnet` and prepare the
  task from that skill. The prompt must include the role, absolute paths or a
  pinned commit, a word cap, "What Must Be True", "Known Constraints", and
  "Mechanical Verification".
- Use `$claude do --model opus` for complex/high-judgment Claude tasks when the
  user asks for or agrees to a stronger Claude worker. Treat Opus as the
  Claude-side choice for tasks you would not hand to a junior agent.
- Foreground `advise`, `do`, and `rescue` use a larger default max-turn budget
  for prepared work. `review` and `adversarial-review` stay tight and
  structured with one default turn. If a foreground prepared task hits the
  max-turn limit, rerun with `--max-turns <higher>` or narrow the task.
- Do not auto-resume a Claude job when the companion says explicit selection
  is required.
- For foreground advice that will need continuation, pass `--output-format json`.
  Successful fresh JSON results acquire validated session identity. Text advice
  does not. Continue through `rescue --resume --job-id <job-id>`.
- Resume only through the companion's canonical full Claude session UUID.
  Plugin job IDs and supervisor lifecycle IDs are never passed to `--resume`.
  The UUID must come from a validated provider JSON result, and a resumed result
  must return that same UUID. Legacy ambiguous jobs are not resumable.
  `--resume --background` must never degrade to a fresh conversation.
- Treat progress, bounded diagnostics and the authoritative final result as
  separate data. Never present monitor output as a completed result. New
  background results are authoritative only after successful exit and strict
  exact-one-document validation of `claude -p --output-format json`. Never use
  terminal logs or stderr as a result source. Report unavailable results
  explicitly.
- The one automatic foreground-timeout fallback uses the normal 10-minute
  supervised background deadline. Treat its fixed failure classification as a
  diagnostic only. Never promote stderr, stdout, prompts, provider output or
  unrestricted exception text into failure metadata or a result.
- Review commands fail closed if Git fails or the complete working-tree or
  `--base` diff exceeds 1 MiB. Narrow or split the change; never substitute a
  stat-only or partial review.
- Treat malformed or unsupported companion state as a visible integrity error.
  Do not delete or silently replace the preserved evidence with empty state.

## Routing

- `ux`: focused read-only UX advice. First report the exact command, selected
  workspace/files, prompt and intended billing source and obtain permission to
  send that context to Claude. Route through the companion `ux` command with
  `--billing-source subscription|api|third-party`. It invokes the installed
  `frontend-design:frontend-design` skill through an explicit print-mode prompt,
  not a slash command. Claude returns recommendations; Codex implements and
  verifies them. Never substitute `do --write`, background mode or retries.
  Defaults: six turns, 120 seconds, local reads plus the frontend-design Skill
  tool, no MCP/web. Report missing skill/auth/billing evidence as a prerequisite.
  Install/enable Anthropic's frontend-design plugin separately only when approved.
  An allowed Skill tool is needed to load its instructions; do not add Bash,
  Edit, Write, Agent or unrestricted tools to help it implement those instructions.

- `setup`: run the companion setup command and show the result. Authentication
  is checked in the current process. If it is unavailable, distinguish host
  permissions from the launcher and the user's Claude login. Compare the same
  installed companion in a normal terminal when evidence is available. Use only
  supported host approval or execution controls and verify their effect; do not
  assume a requested escalation changed the sandbox. Network access and a
  writable state root do not grant credential access. If no authorised route is
  available, report the blocker instead of repeatedly asking for login, copying
  credentials, or adding a launcher to bypass host restrictions.
- `advise`: use for architecture questions, second opinions, and checker work.
  Use `--background` for substantive prompts, large context, or anything likely
  to need more than one short answer.
- `do`: use only for a specific prepared task. This is the preferred route when
  the user asks Claude to do coding, exploration, scout, verifier, reviewer, or
  synthesis work. For Sonnet, first apply `tasks-for-sonnet`; then route the
  prepared task through `do`. For complex/high-judgment tasks, use Opus or the
  user's configured default powerful model instead of Sonnet.
- `rescue`: use for substantial task handoff, debugging, implementation help,
  or follow-up work. Prefer `--background`. It is read-only unless `--write`
  is explicit.
- `monitor`: use after a background advise or rescue job to read the
  plugin-managed supervisor state. Default to `--interval-ms 30000`. It does
  not read provider logs. Preserve explicit `created`, `starting`, `running`,
  `cancelling`, `completed`, `cancelled`, `failed` or `interrupted` state.
- `review`: use for short structured read-only review of local git state.
- `adversarial-review`: use for challenge reviews, plan attacks, and harness
  checker passes.
- `status`, `result`, `cancel`: use for managed Claude jobs only.
- `resume-candidate`: use before follow-up work when the user did not provide a
  job id and the request sounds like "continue", "resume", or "dig deeper".

For long-running work, prefer:

```bash
node "<plugin root>/scripts/claude-companion.mjs" advise --background "<question>"
node "<plugin root>/scripts/claude-companion.mjs" do --background --model sonnet "<prepared task>"
node "<plugin root>/scripts/claude-companion.mjs" do --background --model opus "<prepared task>"
node "<plugin root>/scripts/claude-companion.mjs" rescue --background --model opus "<task>"
node "<plugin root>/scripts/claude-companion.mjs" monitor <job-id> --interval-ms 30000
```

If the companion refuses background mode because the workspace contains
`.mcp.json`, do not retry background blindly. Use foreground mode, or ask the
user whether Claude should use MCP and rerun with `--allow-mcp` only if they
explicitly approve it.

If an `advise`, `do` or `rescue` task needs external docs or URLs, ask whether
web access is acceptable and rerun with `--allow-web`. Otherwise keep the task
on `Read,Glob,Grep`.

For a vague request like "check with Claude", ask a short clarification unless
the user clearly wants setup/readiness. If they want setup/readiness, run
`setup`. If they want Claude to inspect a plan, diff, or question, run `advise`
with a concrete prompt. Use `--background` for anything likely to take more
than one short answer. If a foreground `advise` or `rescue` times out, the
companion automatically launches one supervised background job; monitor that
job instead of retrying the same prompt.

## Prepared Sonnet Tasks

Use `$claude do --model sonnet` only when the user asks for Claude/Sonnet or
agrees to use it for a concrete task. The task must be prepared through
`tasks-for-sonnet` before launching Claude.

Good Sonnet roles:

- Scout or mapper: read a bounded area and return file:line citations.
- Verifier: read absolute paths or a pinned commit and return PASS/FAIL.
- Single-concern reviewer: inspect one concern only.
- Synthesis worker: digest many small inputs into one bounded summary.
- Fully templated coding or scaffolding: only when the invariant, files, and
  verification command are explicit.

Do not use Sonnet for application code that needs judgment, broad business
logic, auth, money, migrations, PII, provider boundaries, or any task where the
task says only "use X correctly." Codex remains the brain.

Every prepared task must include:

```text
Role: <scout | verifier | reviewer | synthesis | hands>
Word cap: <400-600 words unless coding output requires otherwise>
Targets: <absolute paths and/or pinned commit>
What Must Be True:
- <falsifiable invariant>
Known Constraints:
- <repo rules, trigger citations, permissions, dependency limits>
Mechanical Verification:
- <exact command, grep, browser check, or PASS/FAIL condition>
Stop Conditions:
- <when Claude must stop and report instead of guessing>
```

Route read-only exploration through:

```bash
node "<plugin root>/scripts/claude-companion.mjs" do --background --model sonnet --effort xhigh "<prepared task>"
```

Route explicit coding work only after the user agrees to write-capable Claude:

```bash
node "<plugin root>/scripts/claude-companion.mjs" do --background --write --model sonnet --effort xhigh "<prepared task>"
```

The companion adds strict non-interactive flags automatically. Do not remove or
work around them when copying commands:

```bash
--mcp-config '{"mcpServers":{}}' --strict-mcp-config --no-chrome
```

## Prepared Opus Tasks

Use `$claude do --model opus` when the user asks Claude to do a complex task
and Sonnet is the wrong executor. Opus is the backup for work that needs the
same level of judgment you would reserve for GPT-5.5 or the strongest available
reasoning model.

Use Opus for:

- ambiguous debugging where the failure source is unknown
- broad multi-file refactors or architecture changes
- auth, money, migrations, PII, provider reliability, or AI runtime paths
- tasks where the "how" needs judgment, not only execution against invariants
- recovery work where Codex needs a strong second agent, not junior hands

Still prepare a specific task before launching Opus. Include the goal, relevant
absolute paths, constraints, allowed write scope, verification command, and stop
conditions. Use `--write` only after the user agrees to write-capable Claude.
Foreground `do --model opus` and `rescue --model opus` use the larger prepared
task max-turn default. Add `--max-turns <n>` only when the task needs a
different budget.

```bash
node "<plugin root>/scripts/claude-companion.mjs" do --background --model opus --effort xhigh "<prepared task>"
node "<plugin root>/scripts/claude-companion.mjs" do --background --write --model opus --effort xhigh "<prepared task>"
```

## Commands

When invoked, map the user request to one companion call:

```bash
node "<plugin root>/scripts/claude-companion.mjs" <subcommand> <args>
```

Examples:

```bash
node "<plugin root>/scripts/claude-companion.mjs" setup --json
node "<plugin root>/scripts/claude-companion.mjs" adversarial-review --base main --json
node "<plugin root>/scripts/claude-companion.mjs" advise --background --effort xhigh "<question>"
node "<plugin root>/scripts/claude-companion.mjs" do --background --model sonnet --effort xhigh "<prepared task>"
node "<plugin root>/scripts/claude-companion.mjs" do --background --model opus --effort xhigh "<prepared task>"
node "<plugin root>/scripts/claude-companion.mjs" monitor <job-id> --interval-ms 30000 --stale-after-ms 120000
node "<plugin root>/scripts/claude-companion.mjs" status --json
```
