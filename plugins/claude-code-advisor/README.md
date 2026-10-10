# Claude Code Advisor

Consult the installed local Claude Code CLI from Codex for reviews, prepared
tasks, advice and rescue work. Codex owns the task and verification. Use the
`$claude` skill; it routes requests through the bundled companion runtime.

## Package conformance and compatibility

Version 0.1.22 has an Agent Plugins 1.0.0 portable core: root `plugin.json` and
the fixed `skills/claude/SKILL.md` discovery path. OpenAI interface metadata lives
under `extensions.com.openai`, with its icon and logo under `com.openai/assets/`.
The `.codex-plugin/plugin.json` file preserves compatibility
with Codex clients that use the native manifest. Both manifests retain the same
stable name and version. The portable core needs no native-only packaging exception.

The source distribution also carries the legacy `.codex-plugin/plugin.json` for
Codex clients that expect that fixed native path. It is a separate compatibility
artifact outside the Agent Plugins core, not a portable client-extension file.
Conformance claims cover the portable core; strict conformance of the complete
legacy distribution is not claimed. The portable-only installation check omits
this legacy manifest and still discovers the same skill.

The workflow targets Codex and requires Node.js 18.18 or newer plus a local,
authenticated Claude Code installation. Packaging conformance does not establish
workflow support in another client. Other clients and model-driven activation are
not verified by the packaging checks. The skill, runtime, provider authentication,
read-only defaults, explicit write approval and platform limits are unchanged.
Supervised background mode requires macOS; native Windows supports foreground
work. No MCP server, hooks or automatic background maintenance are declared.

Codex CLI 0.162.1 is the packaging verification target. Fresh disposable-home
installation, skill discovery and installed-byte checks require no provider
execution or credentials. The source repository's `npm run validate` uses
synthetic provider fixtures. Authenticated routing, live provider behavior and
additional platforms require separate evidence.

## Install

```bash
codex plugin marketplace add MylesMCook/claude-plugin-codex
codex plugin add claude-code-advisor@claude-plugin-codex
```

Start a new Codex chat after installation. Run `$claude setup` only when ready to
check your installed Claude Code environment. See the [repository README](https://github.com/MylesMCook/claude-plugin-codex#readme)
for commands, permission rules, platform evidence and optional live checks.

## Licence and attribution

MIT. The original copyright (c) 2026 Yanchuk is retained in [LICENSE](LICENSE).
This maintained fork builds on [Yanchuk](https://github.com/yanchuk/claude-plugin-codex)
and [Bold New Media](https://github.com/BoldNewMedia/claude-plugin-codex), and is
published by [Myles Cook](https://github.com/MylesMCook). It is an unofficial
community integration, unaffiliated with OpenAI or Anthropic.
