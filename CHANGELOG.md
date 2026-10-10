# Changelog

All notable public changes to Claude Code Advisor for Codex are recorded here.

## 0.1.22 - 2026-10-10

- add an Agent Plugins 1.0.0 portable manifest while retaining the native Codex
  identity, discovery paths and interface metadata
- include package-local compatibility documentation, changelog and original MIT
  licence in installed bytes; leave provider execution and permissions unchanged
- check portable/native version and metadata alignment in synthetic validation

## 0.1.21 - 2026-10-07

- retry transient Windows file-sharing errors for at most one second while
  preserving private state and cleaning up safely after permanent denial

- prepare private lock/state files before acquiring the state lock, keeping
  concurrent writers within the existing wait without caching ACL approval
- construct ACLs directly through .NET so repair avoids PowerShell module autoload
- support extended Windows paths for ownership and ACL inspection/replacement,
  including long atomic state filenames and parent directories
- protect an explicitly configured state root while preserving implicit parents
- give the ACL-only PowerShell helper a disposable profile with existing folders
  and no inherited provider credentials or caller configuration
- reduce new-file ACL work without removing final readback; make Windows preflight
  use the same isolated environment and process containment as full validation

## 0.1.20 - 2026-10-07

- replace Windows state access rules without requiring restore privilege;
  retain ownership, strict private ACL readback and the native fast path
- validate fresh foreground JSON advice and preserve exact session identity for
  continuation, with raw-byte rejection of malformed or ambiguous provider results
- keep failed results non-resumable and preserve existing read-only authority checks

## 0.1.19 - 2026-10-06

- discover the native Claude executable bundled by Windows npm installations,
  preserving explicit overrides and native PATH precedence without shell shims
- protect Windows state paths and existing files with verified private ACLs;
  protect temporary files before publication and release owned locks on ACL failure
- reject inherit-only ACLs and normalize ownership of managed state paths
- keep non-macOS timeouts from attempting unsupported background fallback
- run native Windows fixtures with exact argv/stdin forwarding and owned descendant
  cleanup; run full validation on Windows, macOS and Linux in CI
- preserve configured Claude model selection and add an explicit authenticated
  host-permissions routing gate alongside restricted-sandbox denial coverage
- publish this maintained fork with its own version and repository links,
  retaining upstream MIT notices and attribution

## 0.1.18 - 2026-09-06

- keep default structured reviews out of interactive Plan Mode, which can cause
  Claude to refuse the required JSON findings response even when tools are disabled
- retain the empty review tool set, strict empty MCP configuration, no Chrome,
  configured model, xhigh effort and strict result/session validation
- use the same tool-free mode for the setup readiness probe; advice, prepared
  tasks, rescue and explicitly opted-in MCP reviews keep their existing
  permission modes
- add regressions for the observed planning response and preserve failed-result,
  read-only and resume authority checks

## 0.1.17 - 2026-09-06

- diagnose authentication in the invoking process and bound the tool-free
  readiness probe, with clear host-sandbox guidance
- publish foreground review findings only after successful provider-envelope,
  session and findings validation, retry invalid formatting once, and prevent
  failed reviews from falling back to background execution
- withhold unproven historical review results across public readback while
  preserving stored evidence and fixed, non-disclosing failure explanations
- require validated review authority before resume and align review and
  non-review resume discovery with the resolver
- reject `--write` for review commands before side effects
- return a nonzero exit for failed foreground advice, prepared tasks and rescue,
  including resumed jobs, while preserving successful background-launch exits
- make alpha reports optional, align release metadata and strengthen setup,
  routing, review, resume and lifecycle regression coverage
- verify the updated failure exit contract in Codex routing checks without
  confusing unavailable nested authentication with authenticated success

## 0.1.16 - 2026-09-04

- give an automatic foreground-timeout fallback the normal 10-minute
  supervised background deadline instead of 30 seconds
- retain fixed, non-disclosing supervisor failure classifications for known
  worker, provider-start and control-socket events, with `worker-failure` kept
  only as the unknown fallback

## 0.1.15 - 2026-08-18

- replace provider-managed background and terminal-log result handling with a
  plugin-owned supervised `claude -p --output-format json` lifecycle on macOS
- accept only one bounded, valid UTF-8 provider result and enforce canonical
  session continuity for foreground and background resume
- transport prompts over standard input and keep prompts, raw output and
  process details out of persisted job state
- reject invalid monitor bounds before workspace or state access
- terminate owned process groups and remove control resources after worker
  exit, IPC loss, cancellation, timeout or output-limit failure
- preserve ambiguous legacy jobs and unsupported platforms as visible,
  fail-closed states instead of recovering authority from terminal logs

## 0.1.14 - 2026-08-18

- clarify the community-maintained product name and non-affiliation statement
- add direct CLI installation, update and removal instructions
- add compatibility status and beta exit criteria
- add public privacy, terms, security, support and contribution documentation
- add issue templates, pull request guidance and launch visual assets
- publish a concise command reference for users

## 0.1.13 - 2026-08-17

First release from the Bold New Media maintained fork.

- harden structured review extraction and validation
- include complete staged and base review diffs and reject unsafe untracked-file
  reviews
- improve background lifecycle monitoring, cancellation and result recovery
- isolate inherited MCP configuration for unattended work by default
- restrict local state directory and file permissions
- add sandbox-safe end-to-end Codex routing coverage
- verify deterministic tests and metadata on Node.js 20, 22 and 24

See the [v0.1.13 release](https://github.com/BoldNewMedia/claude-plugin-codex/releases/tag/v0.1.13)
for the published tag.
