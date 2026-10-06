import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { loadState, resolveStateDir } from "../plugins/claude-code-advisor/scripts/lib/runtime.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const skillMarker = "claude-code-advisor:claude";
const advisePrompt = [
  "Run $claude setup --json first, then exactly one $claude advise --effort xhigh --max-turns 1 --timeout-ms 120000 --no-background-fallback to ask Claude Code to reply with exactly PASS. Use the configured default Claude model, without a --model override.",
  "Run setup and advise as separate direct node commands using the same installed companion, without shell wrappers, cd or environment assignments. Do not retry either command.",
  "Only setup uses --json. Do not add --json to advise; its command output must be plain text PASS.",
  "Do not enable background work, writes, web or MCP access. Do not request approval or escalation. Do not modify files.",
  "Return only a concise PASS/FAIL summary with the key command result."
].join(" ");
const safeStages = new Set([
  "preflight",
  "prompt-input",
  "worktree-before",
  "state-setup",
  "codex-exec",
  "state-cleanup",
  "routed-command",
  "routed-setup",
  "routed-state",
  "routed-output",
  "worktree-after",
  "internal"
]);
const safeReasons = new Set([
  "invalid-repository",
  "missing-skill",
  "timeout",
  "spawn-error",
  "signal",
  "non-zero-exit",
  "filesystem",
  "routing-missing",
  "companion-failed",
  "invalid-setup",
  "invalid-state",
  "unsafe-command",
  "unexpected-result",
  "worktree-changed",
  "unexpected"
]);

function e2eFailure(stage, reason) {
  const error = new Error("Codex routing E2E failed.");
  error.e2eStage = safeStages.has(stage) ? stage : "internal";
  error.e2eReason = safeReasons.has(reason) ? reason : "unexpected";
  return error;
}

export function renderE2eFailure(candidate) {
  const stage = safeStages.has(candidate?.e2eStage) ? candidate.e2eStage : "internal";
  const reason = safeReasons.has(candidate?.e2eReason) ? candidate.e2eReason : "unexpected";
  return `Codex E2E FAIL (${stage}:${reason}).`;
}

export function classifyCommandFailure(result) {
  if (result?.error?.code === "ETIMEDOUT") return "timeout";
  if (result?.error) return "spawn-error";
  if (result?.signal) return "signal";
  if (!Number.isInteger(result?.status) || result.status !== 0) return "non-zero-exit";
  return null;
}

export function classifyRoutedOutput(value, { authenticationUnavailable = false, job } = {}) {
  const output = typeof value === "string" ? value : "";
  if (output === "PASS\n") return "authenticated";
  if (authenticationUnavailable && job?.status === "failed"
    && /^advise-[a-z0-9]+-[a-z0-9]{1,6}$/u.test(job.id)
    && job.result === "Claude command failed with status 1."
    && output === `Claude job ${job.id} failed.\n${job.result}\n`) {
    return "authentication-unavailable";
  }
  return "unexpected";
}

function shellWords(command, windows = false, powershell = false) {
  const words = [];
  let word = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (windows && !powershell && char === "\\" && quote === '"' && command[index + 1] === '"') {
      word += command[++index];
    } else if (windows && char === "'" && quote === "'" && command[index + 1] === "'") {
      word += char;
      index += 1;
    } else if (windows && char === "`" && quote === '"' && command[index + 1] === '"') {
      word += command[++index];
    } else if (!windows && char === "\\" && quote !== "'") {
      if (++index === command.length) return [];
      word += command[index];
    } else if (char === quote) {
      quote = null;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
    } else if (!quote && /\s/u.test(char)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (quote) return [];
  if (word) words.push(word);
  return words;
}

function routedInvocation(item) {
  const windows = /(?:^|\s|['"])[A-Za-z]:[\\/]|\b(?:node|pwsh|powershell)\.exe/u.test(item.command);
  let words = shellWords(item.command, windows);
  // Codex records its execution shell even when the requested command is direct.
  // Unwrap one known shell invocation, then apply the same direct-node checks.
  if (["/bin/bash", "/bin/zsh"].includes(words[0])) {
    if (words.length !== 3 || !["-c", "-lc"].includes(words[1])) throw e2eFailure("routed-command", "unsafe-command");
    words = shellWords(words[2]);
  } else if (["pwsh.exe", "powershell.exe"].includes(path.win32.basename(words[0] || "").toLowerCase())) {
    let index = 1;
    const startupFlags = new Set();
    while (["-noprofile", "-nologo", "-noninteractive"].includes(words[index]?.toLowerCase())) {
      const flag = words[index++].toLowerCase();
      if (startupFlags.has(flag)) throw e2eFailure("routed-command", "unsafe-command");
      startupFlags.add(flag);
    }
    if (words.length !== index + 2 || words[index].toLowerCase() !== "-command") throw e2eFailure("routed-command", "unsafe-command");
    words = shellWords(words[index + 1], true, true);
  }
  if (windows && words[0] === "&") words.shift();
  const [node, launcher, ...args] = words;
  const normalizedLauncher = launcher?.replace(/\\/g, "/");
  if (!node || !["node", "node.exe"].includes(path.win32.basename(node).toLowerCase()) || !launcher
    || !(path.posix.isAbsolute(launcher) || path.win32.isAbsolute(launcher))
    || !normalizedLauncher.endsWith("/claude-companion.mjs") || words.some((arg) => /[$;&|<>`\n]/u.test(arg))) {
    throw e2eFailure("routed-command", "unsafe-command");
  }
  if (args[0] === "setup" && isDeepStrictEqual(args.slice(1), ["--json"])) return { kind: "setup", launcher: normalizedLauncher };
  if (args[0] !== "advise") throw e2eFailure("routed-command", "unsafe-command");
  const required = new Map([["--effort", "xhigh"], ["--max-turns", "1"], ["--timeout-ms", "120000"], ["--no-background-fallback", null]]);
  let prompt = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (required.has(arg)) {
      const value = required.get(arg);
      if (value !== null && args[++index] !== value) throw e2eFailure("routed-command", "unsafe-command");
      required.delete(arg);
    } else if (arg.startsWith("-")) {
      throw e2eFailure("routed-command", "unsafe-command");
    } else {
      prompt = true;
    }
  }
  if (required.size || !prompt) throw e2eFailure("routed-command", "unsafe-command");
  return { kind: "advise", launcher: normalizedLauncher };
}

function setupAuthentication(setup, launcher) {
  const capabilities = setup?.capabilities;
  const auth = capabilities?.auth;
  const version = capabilities?.version;
  if (setup?.node?.supported !== true || version?.supported !== true || version.major !== 2
    || typeof setup.node.version !== "string" || !/^v(?:1[89]|[2-9]\d|\d{3,})\./u.test(setup.node.version)
    || typeof version.raw !== "string" || !Number.isInteger(version.minor) || version.minor < 0
    || !Number.isInteger(version.patch) || version.patch < 0
    || typeof auth?.loggedIn !== "boolean" || typeof capabilities.print !== "boolean"
    || typeof capabilities.background !== "boolean" || typeof setup.ready !== "boolean"
    || setup.ready !== (auth.loggedIn && capabilities.print) || (capabilities.background && !capabilities.print)) {
    throw e2eFailure("routed-setup", "invalid-setup");
  }
  if (Object.hasOwn(auth, "status") || Object.hasOwn(auth, "scope")) {
    if (Object.keys(auth).length !== 3 || auth.scope !== "current-process" || auth.status !== (auth.loggedIn ? "available" : "unavailable")) {
      throw e2eFailure("routed-setup", "invalid-setup");
    }
    const probe = capabilities.printProbe;
    if (capabilities.print ? !isDeepStrictEqual(probe, { status: "passed", reason: null })
      : !auth.loggedIn ? !isDeepStrictEqual(probe, { status: "skipped", reason: "authentication-unavailable" })
        : probe?.status !== "failed" || !["command-failed", "command-error", "command-timeout"].includes(probe.reason)) {
      throw e2eFailure("routed-setup", "invalid-setup");
    }
  } else {
    // In installed 0.1.16, setup throws on auth spawn errors, signals and timeouts.
    // Its successful JSON with loggedIn:false therefore records a non-zero auth exit.
    if (!/\/claude-code-advisor\/0\.1\.16\/scripts\/claude-companion\.mjs$/u.test(launcher)
      || !isDeepStrictEqual(Object.keys(auth), ["loggedIn"]) || Object.hasOwn(capabilities, "printProbe")) {
      throw e2eFailure("routed-setup", "invalid-setup");
    }
  }
  if (!auth.loggedIn && (capabilities.print || capabilities.background)) throw e2eFailure("routed-setup", "invalid-setup");
  return auth.loggedIn ? "available" : "unavailable";
}

export function inspectRoutedRun(execOutput, { stateRoot, workspaceRoot }) {
  const commands = parseJsonLines(execOutput).filter((event) => event.type === "item.completed"
    && event.item?.type === "command_execution" && event.item.command?.includes("claude-companion.mjs"));
  if (commands.length !== 2) throw e2eFailure("routed-command", "routing-missing");
  const [setupCommand, adviseCommand] = commands.map((event) => event.item);
  const setupInvocation = routedInvocation(setupCommand);
  const adviseInvocation = routedInvocation(adviseCommand);
  if (setupInvocation.kind !== "setup" || adviseInvocation.kind !== "advise"
    || setupInvocation.launcher !== adviseInvocation.launcher) throw e2eFailure("routed-command", "routing-missing");
  if (setupCommand.exit_code !== 0) throw e2eFailure("routed-command", "companion-failed");
  let setup;
  try { setup = JSON.parse(setupCommand.aggregated_output); } catch { throw e2eFailure("routed-setup", "invalid-setup"); }
  const authentication = setupAuthentication(setup, setupInvocation.launcher);
  const expectedParent = path.dirname(resolveStateDir(workspaceRoot, {}, stateRoot));
  if (typeof setup.stateDir !== "string" || path.dirname(setup.stateDir) !== expectedParent
    || !/^(workspace|thread-[a-zA-Z0-9._-]+)$/u.test(path.basename(setup.stateDir))) {
    throw e2eFailure("routed-state", "invalid-state");
  }
  let state;
  try { state = loadState(setup.stateDir, { pathBoundary: stateRoot }); } catch { throw e2eFailure("routed-state", "invalid-state"); }
  const job = state.jobs[0];
  if (state.jobs.length !== 1 || !isDeepStrictEqual(state.capabilities, setup.capabilities)
    || job.kind !== "advise" || job.write !== false || job.workspaceRoot !== workspaceRoot
    || job.transport || job.lifecycleState || job.fallbackFromJobId || !["completed", "failed"].includes(job.status)) {
    throw e2eFailure("routed-state", "invalid-state");
  }
  const classification = classifyRoutedOutput(adviseCommand.aggregated_output, { authenticationUnavailable: authentication === "unavailable", job });
  if (classification === "unexpected" || (classification === "authenticated" && (job.status !== "completed" || job.result !== "PASS"))) {
    throw e2eFailure("routed-output", "unexpected-result");
  }
  // v0.1.16 returned zero for failed foreground jobs. New installs return one.
  // Accept that failure only after binding setup, output and terminal job state.
  const legacyExit = /\/claude-code-advisor\/0\.1\.16\/scripts\/claude-companion\.mjs$/u.test(adviseInvocation.launcher);
  const expectedExit = classification === "authentication-unavailable" && !legacyExit ? 1 : 0;
  if (adviseCommand.exit_code !== expectedExit) throw e2eFailure("routed-command", "companion-failed");
  return classification;
}

function run(stage, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
    ...options
  });
  const failure = classifyCommandFailure(result);
  if (failure) throw e2eFailure(stage, failure);
  return result.stdout;
}

function parseJsonLines(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function main() {
  const hostPermissions = process.argv.slice(2).includes("--host-permissions");
  if (!fs.existsSync(path.join(repoRoot, "package.json"))) {
    throw e2eFailure("preflight", "invalid-repository");
  }

  const promptInput = run("prompt-input", "codex", ["debug", "prompt-input", "Check Claude plugin availability."]);
  if (!promptInput.includes(skillMarker)) throw e2eFailure("prompt-input", "missing-skill");

  const statusBefore = run("worktree-before", "git", ["status", "--short"]);
  let stateRoot;
  try {
    stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "claude-plugin-codex-e2e-state-"));
  } catch {
    throw e2eFailure("state-setup", "filesystem");
  }

  const execOutput = run(
      "codex-exec",
      "codex",
      ["--ask-for-approval", "never", "exec", ...(hostPermissions ? [] : ["--sandbox", "workspace-write"]), "--cd", repoRoot, "--json", advisePrompt],
      { input: "", env: { ...process.env, CLAUDE_COMPANION_STATE_ROOT: stateRoot } }
    );
  // Failed or unknown runs retain their state, including any live job handles.
  if (process.env.CLAUDE_PLUGIN_CODEX_E2E_DIAGNOSTICS === "1") {
    const knownFlags = new Set(["-Command", "-NoProfile", "-NoLogo", "-NonInteractive", "-c", "-lc", "--json", "--effort", "--model", "--max-turns", "--timeout-ms", "--no-background-fallback"]);
    const shapes = parseJsonLines(execOutput).filter(event => event.type === "item.completed" && event.item?.type === "command_execution" && event.item.command?.includes("claude-companion.mjs"))
      .map(event => {
        const words = shellWords(event.item.command, process.platform === "win32");
        const first = path.win32.basename(words[0] || "").toLowerCase();
        return { executable: ["node", "node.exe", "pwsh.exe", "powershell.exe", "bash", "zsh", "&"].includes(first) ? first : "other", words: words.length, flags: words.filter(word => knownFlags.has(word)), exitCode: event.item.exit_code };
      });
    process.stderr.write(`Codex command shapes: ${JSON.stringify(shapes)}\n`);
  }
  const routedClassification = inspectRoutedRun(execOutput, { stateRoot, workspaceRoot: repoRoot });
  if (hostPermissions && routedClassification !== "authenticated") {
    throw e2eFailure("routed-output", "unexpected-result");
  }
  try {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  } catch {
    throw e2eFailure("state-cleanup", "filesystem");
  }

  const statusAfter = run("worktree-after", "git", ["status", "--short"]);
  if (statusAfter !== statusBefore) throw e2eFailure("worktree-after", "worktree-changed");

  console.log(
    routedClassification === "authenticated"
      ? "codex skill routing ok: authenticated Claude advise used the configured default model"
      : "codex skill routing ok: default-model Claude advise routed; nested sandbox authentication was unavailable"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${renderE2eFailure(error)}\n`);
    process.exitCode = 1;
  }
}
