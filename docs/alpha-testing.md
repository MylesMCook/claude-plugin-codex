# Optional alpha reports

The project remains alpha. People who already use both Codex and Claude Code
may submit unsolicited reports at any time. Reporting is entirely optional.
The current public release is
[`v0.1.19`](https://github.com/MylesMCook/claude-plugin-codex/releases/tag/v0.1.19).

See the GitHub release notes for exact-commit checks, authenticated execution
and installed Codex routing evidence. Deterministic tests alone do not establish
authenticated use. Optional reports can add independent end-to-end evidence,
particularly for platforms that have not been independently verified.

## Before you test

You need:

- a supported local Codex installation with plugin marketplace support
- a supported, authenticated local Claude Code CLI
- Node.js 18.18 or newer
- a non-sensitive Git repository where you can run a read-only review

Do not install or pay for Claude Code only to test this plugin. This optional
check is only for people who already have an authenticated Claude Code
installation.

The report form records native Windows separately from WSL because WSL evidence
does not establish native Windows compatibility.

## Optional 15–20-minute check

1. Install `v0.1.19` using the marketplace and plugin commands in the
   [README](../README.md).
2. Start a new Codex task.
3. Run `$claude setup`.
4. In a public, disposable or otherwise non-sensitive Git repository with a
   small tracked or staged change and no untracked files, run one foreground
   `$claude review`.
5. If you choose to report, submit the
   [structured alpha test report](https://github.com/MylesMCook/claude-plugin-codex/issues/new?template=alpha_test_report.yml),
   whether the result passed, failed or was inconclusive.

Use the foreground review route for comparable cross-platform evidence.
Supervised background mode currently requires macOS and is not part of this
check.

GitHub requires you to sign in before you can submit an issue form. You do not
need collaborator access to the repository.

Do not use confidential code for the first test. The plugin is alpha software,
and prompts and selected repository content are processed through your local
Claude Code account.

## Reporting safety

The report form collects only the environment and outcome evidence needed for
an alpha report: operating system, native Windows versus WSL, architecture,
Codex, Claude Code and Node.js versions, install, setup and review outcomes,
elapsed time, the smallest reproducible sanitised symptom, and optional
usefulness notes.

Never provide confidential or private source code, credentials, tokens,
cookies, session data, private prompts, personal information, unredacted
screenshots or full unsanitised logs. Do not use the alpha form for a security
vulnerability. Follow [SECURITY.md](../SECURITY.md) and keep vulnerability
details out of public issues.

The project does not add phone-home analytics for alpha reporting. It relies
only on information people choose to submit.
