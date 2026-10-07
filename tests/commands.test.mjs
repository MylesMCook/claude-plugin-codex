import { assertPrivatePermissions, createRedirect } from "./lib/permissions.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";
import { fakeClaudeName, writeFakeClaude, fixtureTimeoutMs } from "./lib/fake-claude.mjs";

import {
  buildReviewPrompt,
  resolveStateDir,
  saveState,
  SUPERVISED_RECORD_VERSION,
  SUPERVISED_TRANSPORT
} from "../plugins/claude-code-advisor/scripts/lib/runtime.mjs";

const companion = fileURLToPath(
  new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url)
);

const darwinTest = process.platform === "darwin" ? test : test.skip;
const nonDarwinTest = process.platform === "darwin" ? test.skip : test;

function initRepo(prefix = "claude-command-repo-") {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  return repo;
}

function makeFakeClaude(scriptBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const bin = path.join(dir, fakeClaudeName);
  writeFakeClaude(bin, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
  fs.chmodSync(bin, 0o755);
  return { dir, bin };
}

function makeFakeClaudeExpectingMaxTurns(expected) {
  return makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const index = args.indexOf("--max-turns");
  if (args[index + 1] !== ${JSON.stringify(String(expected))}) {
    console.error("expected --max-turns ${expected}, got " + args[index + 1]);
    process.exit(2);
  }
  console.log("ok");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
}

test("setup reports print capability and only proved supervised background capability", (t) => {
  const probeLog = path.join(os.tmpdir(), `fake-setup-probe-${Date.now()}.json`);
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log("logged in"); process.exit(0); }
if (args[0] === "logs") process.exit(2);
if (args[0] === "stop") process.exit(2);
if (args[0] === "attach") process.exit(2);
if (args[0] === "agents") process.exit(2);
if (args.includes("-p")) {
  const stdin = fs.readFileSync(0);
  fs.writeFileSync(${JSON.stringify(probeLog)}, JSON.stringify({ args, stdinBase64: stdin.toString("base64") }));
  console.log("{}"); process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  t.after(() => {
    fs.rmSync(probeLog, { force: true });
    fs.rmSync(fake.dir, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  fs.chmodSync(stateRoot, 0o755);
  const stdout = execFileSync(process.execPath, [companion, "setup", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.ready, true);
  assert.equal(payload.capabilities.print, true);
  assert.equal(payload.capabilities.background, process.platform === "darwin");
  assert.deepEqual(payload.capabilities.auth, { loggedIn: true, scope: "current-process", status: "available" });
  assert.deepEqual(payload.capabilities.printProbe, { status: "passed", reason: null });
  const probe = JSON.parse(fs.readFileSync(probeLog, "utf8"));
  assert.equal(Buffer.from(probe.stdinBase64, "base64").toString("utf8"), "Return {}");
  assert.equal(probe.args.includes("Return {}"), false);
  assert.deepEqual(probe.args.slice(0, 3), ["-p", "--output-format", "text"]);
  for (const [flag, value] of [
    ["--max-turns", "1"],
    ["--effort", "low"],
    ["--mcp-config", '{"mcpServers":{}}'],
    ["--tools", ""],
    ["--permission-mode", "default"]
  ]) {
    assert.notEqual(probe.args.indexOf(flag), -1, flag);
    assert.equal(probe.args[probe.args.indexOf(flag) + 1], value, flag);
  }
  assert.equal(probe.args.includes("--strict-mcp-config"), true);
  assert.equal(probe.args.includes("--no-chrome"), true);
  assert.equal(probe.args.includes("--model"), false);
  assertPrivatePermissions(stateRoot, 0o700);
  const workspaceIndex = fs.readdirSync(stateRoot).find((entry) => entry.startsWith("claude-state-"));
  assert.ok(workspaceIndex);
  const indexDir = path.join(stateRoot, workspaceIndex);
  const latestStateFile = path.join(indexDir, "latest-state-dir");
  const stateDir = fs.readFileSync(latestStateFile, "utf8").trim();
  assertPrivatePermissions(indexDir, 0o700);
  assertPrivatePermissions(stateDir, 0o700);
  assertPrivatePermissions(path.join(stateDir, "state.json"), 0o600);
  assertPrivatePermissions(latestStateFile, 0o600);
});

function setupProbeFixture(t, { version = "2.1.132", authExit = 0, authSignal = false, printExit = 0, printSignal = false, probeError = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-setup-test-"));
  const stateRoot = path.join(root, "state");
  const invocationLog = path.join(root, "invocations.jsonl");
  const deadlineLog = path.join(root, "deadlines.jsonl");
  const sentinel = "PRIVATE_SETUP_OUTPUT_MUST_NOT_BE_PERSISTED";
  fs.mkdirSync(stateRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  console.log(${JSON.stringify(version + " (Claude Code)")});
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  fs.writeSync(1, ${JSON.stringify(sentinel + "\n")});
  fs.writeSync(2, ${JSON.stringify(sentinel + "\n")});
  if (${JSON.stringify(authSignal)}) process.kill(process.pid, "SIGKILL");
  process.exit(${JSON.stringify(authExit)});
}
if (args.includes("-p")) {
  fs.writeSync(1, ${JSON.stringify(sentinel + "\n")});
  fs.writeSync(2, ${JSON.stringify(sentinel + "\n")});
  if (${JSON.stringify(printSignal)}) process.kill(process.pid, "SIGKILL");
  process.exit(${JSON.stringify(printExit)});
}
process.exit(2);
`);
  t.after(() => fs.rmSync(fake.dir, { recursive: true, force: true }));
  const preload = path.join(root, "probe-fixture.cjs");
  fs.writeFileSync(preload, `
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = childProcess.spawnSync;
childProcess.spawnSync = function(command, args, options) {
  if (command === "claude" || command === ${JSON.stringify(isolatedClaudeEnv(fake.dir, fake.bin).CLAUDE_COMPANION_EXECUTABLE)}) {
    const probe = args.includes("-p") ? "print" : args[0] === "auth" ? "auth" : "version";
    fs.appendFileSync(${JSON.stringify(deadlineLog)}, JSON.stringify({ probe, timeoutMs: options.timeout }) + "\\n");
    if (${JSON.stringify(probeError)}?.startsWith(probe + "-")) {
      fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + "\\n");
      const error = Object.assign(new Error(${JSON.stringify(sentinel)}), {
        code: ${JSON.stringify(probeError)}?.endsWith("-timeout") ? "ETIMEDOUT" : "EACCES"
      });
      return { status: null, signal: null, error, stdout: ${JSON.stringify(sentinel)}, stderr: ${JSON.stringify(sentinel)} };
    }
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ["--require", preload, companion, "setup", "--json"], {
    env: {
      ...isolatedClaudeEnv(fake.dir, fake.bin),
      CLAUDE_COMPANION_STATE_ROOT: stateRoot,
      CLAUDE_PLUGIN_CODEX_ALLOW_UNKNOWN_CLAUDE: ""
    },
    cwd: root,
    encoding: "utf8",
    timeout: fixtureTimeoutMs
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const persistedState = fs.readFileSync(path.join(payload.stateDir, "state.json"), "utf8");
  for (const output of [result.stdout, result.stderr, persistedState]) {
    assert.equal(output.includes(sentinel), false, "raw probe output must not escape into diagnostics or state");
  }
  assert.deepEqual(JSON.parse(persistedState).capabilities, payload.capabilities);
  const invocations = fs.readFileSync(invocationLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const deadlines = fs.readFileSync(deadlineLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { payload, invocations, deadlines };
}

test("setup skips the provider when authentication is unavailable in this process", (t) => {
  const { payload, invocations } = setupProbeFixture(t, { authExit: 1 });
  assert.equal(payload.ready, false);
  assert.deepEqual(payload.capabilities.auth, { loggedIn: false, scope: "current-process", status: "unavailable" });
  assert.deepEqual(payload.capabilities.printProbe, { status: "skipped", reason: "authentication-unavailable" });
  assert.equal(payload.capabilities.print, false);
  assert.equal(payload.capabilities.background, false);
  assert.equal(invocations.some((args) => args.includes("-p")), false);
});

test("setup distinguishes authentication check errors and skips the provider", (t) => {
  const { payload, invocations } = setupProbeFixture(t, process.platform === "win32" ? { probeError: "auth-error" } : { authSignal: true });
  assert.equal(payload.ready, false);
  assert.deepEqual(payload.capabilities.auth, { loggedIn: false, scope: "current-process", status: "check-failed" });
  assert.deepEqual(payload.capabilities.printProbe, { status: "skipped", reason: "authentication-check-failed" });
  assert.equal(payload.capabilities.print, false);
  assert.equal(payload.capabilities.background, false);
  assert.equal(invocations.some((args) => args.includes("-p")), false);
});

test("setup skips the provider for an unsupported Claude version", (t) => {
  const { payload, invocations } = setupProbeFixture(t, { version: "3.0.0" });
  assert.equal(payload.ready, false);
  assert.equal(payload.capabilities.version.supported, false);
  assert.deepEqual(payload.capabilities.printProbe, { status: "skipped", reason: "unsupported-version" });
  assert.equal(payload.capabilities.print, false);
  assert.equal(payload.capabilities.background, false);
  assert.equal(invocations.some((args) => args.includes("-p")), false);
});

test("setup keeps provider failure distinct from available authentication", (t) => {
  const { payload, invocations } = setupProbeFixture(t, { printExit: 1 });
  assert.equal(payload.ready, false);
  assert.deepEqual(payload.capabilities.auth, { loggedIn: true, scope: "current-process", status: "available" });
  assert.deepEqual(payload.capabilities.printProbe, { status: "failed", reason: "command-failed" });
  assert.equal(payload.capabilities.print, false);
  assert.equal(payload.capabilities.background, false);
  assert.equal(invocations.filter((args) => args.includes("-p")).length, 1);
});

test("setup reports provider command errors without exposing raw output", (t) => {
  const { payload, invocations } = setupProbeFixture(t, process.platform === "win32" ? { probeError: "print-error" } : { printSignal: true });
  assert.equal(payload.ready, false);
  assert.deepEqual(payload.capabilities.auth, { loggedIn: true, scope: "current-process", status: "available" });
  assert.deepEqual(payload.capabilities.printProbe, { status: "failed", reason: "command-error" });
  assert.equal(payload.capabilities.print, false);
  assert.equal(payload.capabilities.background, false);
  assert.equal(invocations.filter((args) => args.includes("-p")).length, 1);
});

test("setup distinguishes a provider timeout and bounds local and live probes separately", (t) => {
  const { payload, invocations, deadlines } = setupProbeFixture(t, { probeError: "print-timeout" });
  assert.equal(payload.ready, false);
  assert.deepEqual(payload.capabilities.auth, { loggedIn: true, scope: "current-process", status: "available" });
  assert.deepEqual(payload.capabilities.printProbe, { status: "failed", reason: "command-timeout" });
  assert.equal(payload.capabilities.print, false);
  assert.equal(payload.capabilities.background, false);
  assert.deepEqual(deadlines, [
    { probe: "version", timeoutMs: 10000 },
    { probe: "auth", timeoutMs: 10000 },
    { probe: "print", timeoutMs: 60000 }
  ]);
  assert.equal(invocations.filter((args) => args.includes("-p")).length, 1);
});

test("setup does not mistake a provider spawn error for a timeout", (t) => {
  const { payload } = setupProbeFixture(t, { probeError: "print-spawn-error" });
  assert.equal(payload.ready, false);
  assert.deepEqual(payload.capabilities.printProbe, { status: "failed", reason: "command-error" });
});

test("setup treats an authentication timeout as a failed check and skips the provider", (t) => {
  const { payload, invocations } = setupProbeFixture(t, { probeError: "auth-timeout" });
  assert.equal(payload.ready, false);
  assert.deepEqual(payload.capabilities.auth, { loggedIn: false, scope: "current-process", status: "check-failed" });
  assert.deepEqual(payload.capabilities.printProbe, { status: "skipped", reason: "authentication-check-failed" });
  assert.equal(invocations.some((args) => args.includes("-p")), false);
});

test("foreground prompts reach Claude byte-for-byte through stdin and remain absent from argv", () => {
  const prompt = "exact foreground prompt\nwith a second line and unicode: café";
  for (const command of ["advise", "do", "rescue"]) {
    const invocationLog = path.join(os.tmpdir(), `fake-foreground-stdin-${command}-${Date.now()}.json`);
    const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const stdin = fs.readFileSync(0);
  fs.writeFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ args, stdinBase64: stdin.toString("base64") }));
  console.log("ok");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
    const stdout = execFileSync(process.execPath, [companion, command, prompt, "--json"], {
      env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    });
    assert.equal(JSON.parse(stdout).status, "completed", command);
    const invocation = JSON.parse(fs.readFileSync(invocationLog, "utf8"));
    assert.equal(Buffer.from(invocation.stdinBase64, "base64").toString("utf8"), prompt, command);
    assert.equal(invocation.args.includes(prompt), false, command);
    assert.deepEqual(
      invocation.args.slice(invocation.args.indexOf("-p"), invocation.args.indexOf("-p") + 2),
      ["-p", "--output-format"],
      command
    );
  }
});

test("review returns validated JSON and stores result", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args.includes("-p")) {
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"11111111-1111-4111-8111-111111111111",result:JSON.stringify({findings:[{severity:"MAJOR",title:"Gap",fact:"No test",recommendation:"Add test"}]})}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const repo = initRepo("claude-review-result-");
  const env = {
    ...isolatedClaudeEnv(fake.dir, fake.bin),
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CODEX_THREAD_ID: "thread-a"
  };
  const stdout = execFileSync(process.execPath, [companion, "review", "--json"], {
    env,
    cwd: repo,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.result.findings[0].severity, "MAJOR");

  const result = execFileSync(process.execPath, [companion, "result", payload.jobId, "--json"], {
    env,
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(result).job.id, payload.jobId);
});

test("adversarial review and invalid-result retry keep both generated prompts on stdin", () => {
  const invocationLog = path.join(os.tmpdir(), `fake-review-retry-${Date.now()}.jsonl`);
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("-p")) process.exit(2);
const stdin = fs.readFileSync(0);
const prior = fs.existsSync(${JSON.stringify(invocationLog)})
  ? fs.readFileSync(${JSON.stringify(invocationLog)}, "utf8").trim().split(/\\r?\\n/).filter(Boolean).length
  : 0;
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ args, stdinBase64: stdin.toString("base64") }) + "\\n");
if (prior === 0) console.log("not valid review JSON");
else console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"11111111-1111-4111-8111-111111111111",result:JSON.stringify({findings:[]})}));
process.exit(0);
`);
  const repo = initRepo("claude-adversarial-retry-");
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const focus = "focus-marker-a61c";
  const stdout = execFileSync(process.execPath, [companion, "adversarial-review", focus, "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: repo,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(stdout).status, "completed");
  const invocations = fs.readFileSync(invocationLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(invocations.length, 2);
  const firstPrompt = buildReviewPrompt({
    kind: "adversarial-review",
    targetLabel: "working tree",
    gitContext: "",
    focus
  });
  const firstDelivered = Buffer.from(invocations[0].stdinBase64, "base64").toString("utf8");
  const retryDelivered = Buffer.from(invocations[1].stdinBase64, "base64").toString("utf8");
  assert.equal(firstDelivered, firstPrompt);
  assert.equal(retryDelivered, `${firstPrompt}\n\nYour previous response was invalid. Return JSON only with the required findings schema.`);
  for (const invocation of invocations) {
    assert.equal(invocation.args.includes(firstDelivered), false);
    assert.equal(invocation.args.includes(retryDelivered), false);
    assert.equal(invocation.args.some((arg) => arg.includes(focus)), false);
  }
});

test("review base range includes the patch in the Claude prompt", () => {
  const promptLog = path.join(os.tmpdir(), `fake-review-base-${Date.now()}.log`);
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-p")) {
  fs.writeFileSync(${JSON.stringify(promptLog)}, fs.readFileSync(0));
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"11111111-1111-4111-8111-111111111111",result:JSON.stringify({findings:[]})}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-base-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "sample.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "sample.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(repo, "sample.txt"), "after-base-range\n", "utf8");
  execFileSync("git", ["add", "sample.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));

  execFileSync(process.execPath, [companion, "review", "--base", base, "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: repo,
    encoding: "utf8"
  });

  assert.match(fs.readFileSync(promptLog, "utf8"), /after-base-range/);
});

test("working-tree review includes staged patch content", () => {
  const promptLog = path.join(os.tmpdir(), `fake-review-staged-${Date.now()}.log`);
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-p")) {
  fs.writeFileSync(${JSON.stringify(promptLog)}, fs.readFileSync(0));
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"11111111-1111-4111-8111-111111111111",result:JSON.stringify({findings:[]})}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-staged-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "sample.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "sample.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "sample.txt"), "after-staging\n", "utf8");
  execFileSync("git", ["add", "sample.txt"], { cwd: repo });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));

  execFileSync(process.execPath, [companion, "review", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: repo,
    encoding: "utf8"
  });

  assert.match(fs.readFileSync(promptLog, "utf8"), /after-staging/);
});

test("working-tree review refuses untracked files whose contents would be omitted", () => {
  const fake = makeFakeClaude(`
console.error("Claude should not run when untracked files are present");
process.exit(2);
`);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-untracked-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "new-source.mjs"), "export const value = 1;\n", "utf8");
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));

  const reviewed = spawnSync(process.execPath, [companion, "review", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: repo,
    encoding: "utf8"
  });

  assert.notEqual(reviewed.status, 0);
  assert.match(reviewed.stderr, /Stage the intended files first/);
  assert.match(reviewed.stderr, /new-source\.mjs/);
});

test("review defaults to a single Claude turn", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const index = args.indexOf("--max-turns");
  if (args[index + 1] !== "1") {
    console.error("expected --max-turns 1, got " + args[index + 1]);
    process.exit(2);
  }
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"11111111-1111-4111-8111-111111111111",result:JSON.stringify({findings:[]})}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const repo = initRepo("claude-review-turns-");
  const stdout = execFileSync(process.execPath, [companion, "review", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: repo,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
});

test("foreground advise defaults to a larger turn budget", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(20);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "advise", "check architecture", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground do defaults to a larger turn budget", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(20);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "do", "inspect local code", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground rescue defaults to a larger turn budget", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(20);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "rescue", "diagnose the failure", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground task max-turn override takes precedence over the default", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(5);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(
    process.execPath,
    [companion, "do", "--max-turns", "5", "inspect local code", "--json"],
    {
      env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground task max-turn failure includes rerun hint", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  console.error("Claude hit max turns before producing a result.");
  process.exit(1);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const result = spawnSync(process.execPath, [companion, "do", "inspect local code", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.status, "failed");
  assert.match(payload.output, /Claude hit the max-turn limit/);
  assert.match(payload.output, /--max-turns <higher>/);
});

test("foreground advise defaults to xhigh effort", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const index = args.indexOf("--effort");
  if (args[index + 1] !== "xhigh") {
    console.error("expected --effort xhigh, got " + args[index + 1]);
    process.exit(2);
  }
  console.log("ok");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "advise", "check architecture", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("background advise refuses project MCP config unless explicitly allowed", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  console.error("background should not launch");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  fs.writeFileSync(path.join(stateRoot, ".mcp.json"), '{"mcpServers":{"playwright":{}}}\n', "utf8");
  const result = spawnSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.mcp\.json/);
  assert.match(result.stderr, /--allow-mcp/);
});

test("background advise refuses MCP config above a nested worktree", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  console.error("background should not launch");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "claude-parent-mcp-"));
  const child = path.join(parent, ".worktrees", "task");
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(parent, ".mcp.json"), '{"mcpServers":{"playwright":{}}}\n', "utf8");
  fs.writeFileSync(path.join(child, ".git"), "gitdir: ../.git/worktrees/task\n", "utf8");
  const result = spawnSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: parent },
    cwd: child,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(path.join(parent, ".mcp.json")));
  assert.match(result.stderr, /--allow-mcp/);
});

test("read-only do defaults to local read-only tools without WebFetch", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const tools = args[args.indexOf("--tools") + 1];
  if (tools !== "Read,Glob,Grep") {
    console.error("expected local read-only tools, got " + tools);
    process.exit(2);
  }
  console.log("done");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "do", "inspect local code", "--json"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "done");
});

darwinTest("foreground advise falls back to supervised background on timeout", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  setTimeout(() => process.exit(0), 5000);
} else {
  console.error("unsupported"); process.exit(2);
}
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(
    process.execPath,
    [companion, "advise", "--timeout-ms", "50", "check architecture", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, null);
  assert.match(payload.output, /Foreground Claude timed out/);

  const status = execFileSync(process.execPath, [companion, "status", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(status).job.fallbackReason, "foreground-timeout");
});

nonDarwinTest("non-macOS foreground timeout never launches legacy or supervised background handling", () => {
  const invocationLog = path.join(os.tmpdir(), `fake-non-darwin-timeout-${Date.now()}.jsonl`);
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + "\\n");
if (args.includes("-p")) setTimeout(() => process.exit(0), 5000);
else process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const result = spawnSync(
    process.execPath,
    [companion, "advise", "--timeout-ms", process.platform === "win32" ? "2000" : "50", "slow", "--json"],
    {
      env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supervised background mode is unavailable on this platform/);
  const invocations = fs.readFileSync(invocationLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(invocations.length, 1);
  assert.ok(invocations[0].includes("-p"));
  assert.equal(
    invocations.some((args) => args.includes("--bg") || ["agents", "logs", "stop", "attach"].includes(args[0])),
    false
  );
  const stateDir = resolveStateDir(fs.realpathSync(stateRoot), {
    ...isolatedClaudeEnv(fake.dir, fake.bin),
    CLAUDE_COMPANION_STATE_ROOT: stateRoot
  }, stateRoot);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, "timed_out");
  assert.equal(Object.hasOwn(state.jobs[0], "transport"), false);
  assert.equal(Object.hasOwn(state.jobs[0], "supervisor"), false);
});

test("foreground advise can disable timeout background fallback", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  setTimeout(() => process.exit(0), 5000);
} else {
  console.error("unsupported"); process.exit(2);
}
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const result = spawnSync(
    process.execPath,
    [companion, "advise", "--timeout-ms", "50", "--no-background-fallback", "slow"],
    {
      env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timed out/);
});

test("foreground advise prints human output by default", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) { console.log("human answer"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "advise", "check architecture"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });

  assert.equal(stdout, "human answer\n");
});

test("rescue runs as a managed task and preserves explicit write mode", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args.includes("-p")) {
  if (!args.includes("--permission-mode") || !args.includes("default")) {
    console.error("expected write-capable default permission mode");
    process.exit(2);
  }
  console.log("rescued");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(process.execPath, [companion, "rescue", "--write", "fix the failing test", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.match(payload.jobId, /^rescue-/);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "rescued");

  const result = execFileSync(process.execPath, [companion, "result", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(result).job.write, true);
});

test("rescue is read-only unless --write is explicit", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args.includes("-p")) {
  if (!args.includes("--permission-mode") || !args.includes("plan")) {
    console.error("expected plan permission mode");
    process.exit(2);
  }
  console.log("diagnosis only");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(process.execPath, [companion, "rescue", "diagnose the failure", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.match(payload.jobId, /^rescue-/);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "diagnosis only");
});

test("do runs a prepared Claude task and preserves explicit write mode", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  if (!args.includes("--permission-mode") || !args.includes("default")) {
    console.error("expected write-capable default permission mode");
    process.exit(2);
  }
  if (!args.includes("--model") || args[args.indexOf("--model") + 1] !== "sonnet") {
    console.error("expected explicit sonnet model");
    process.exit(2);
  }
  console.log("done");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(
    process.execPath,
    [companion, "do", "--write", "--model", "sonnet", "implement the prepared task", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);

  assert.match(payload.jobId, /^do-/);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "done");
});

test("working-tree and base reviews fail closed when the diff exceeds one MiB", () => {
  for (const mode of ["working-tree", "base"]) {
    const called = path.join(os.tmpdir(), `fake-called-${mode}-${Date.now()}.txt`);
    const fake = makeFakeClaude(`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(called)},"called");process.exit(2);`);
    const repo = initRepo(`claude-large-${mode}-`);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(repo, "tracked.txt"), `tracked\n${"x".repeat(1024 * 1024 + 8192)}\n`, "utf8");
    if (mode === "base") {
      execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "large"], { cwd: repo });
    }
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
    const args = [companion, "review", ...(mode === "base" ? ["--base", base] : []), "--json"];
    const reviewed = spawnSync(process.execPath, args, { env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot }, cwd: repo, encoding: "utf8" });
    assert.notEqual(reviewed.status, 0);
    assert.match(reviewed.stderr, /1048576-byte review limit/);
    assert.equal(fs.existsSync(called), false);
  }
});

test("a distinctive marker near the diff limit reaches Claude completely", () => {
  const invocationLog = path.join(os.tmpdir(), `fake-large-prompt-${Date.now()}.json`);
  const fake = makeFakeClaude(`
const fs=require("node:fs");const args=process.argv.slice(2);
if(args.includes("-p")){const stdin=fs.readFileSync(0);fs.writeFileSync(${JSON.stringify(invocationLog)},JSON.stringify({args,stdinBase64:stdin.toString("base64")}));console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"11111111-1111-4111-8111-111111111111",result:JSON.stringify({findings:[]})}));process.exit(0)}
process.exit(2);
`);
  const repo = initRepo("claude-near-limit-");
  const marker = "DISTINCTIVE_FINAL_DIFF_MARKER_7f58e";
  fs.writeFileSync(path.join(repo, "tracked.txt"), `tracked\n${"y".repeat(880 * 1024)}\n${marker}\n`, "utf8");
  const diffBytes = Buffer.byteLength(execFileSync("git", ["diff", "HEAD", "--"], { cwd: repo }));
  assert.ok(diffBytes >= 880 * 1024, `expected a near-limit diff, received ${diffBytes} bytes`);
  assert.ok(diffBytes < 1024 * 1024, `expected a below-limit diff, received ${diffBytes} bytes`);
  assert.ok(1024 * 1024 - diffBytes < 160 * 1024, `diff was not close enough to the limit: ${diffBytes} bytes`);
  const gitContext = [
    execFileSync("git", ["status", "--short", "--untracked-files=all"], { cwd: repo, encoding: "utf8" }),
    execFileSync("git", ["diff", "HEAD", "--"], { cwd: repo, encoding: "utf8" })
  ].join("\n").trim();
  const expectedPrompt = buildReviewPrompt({ kind: "review", targetLabel: "working tree", gitContext });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  execFileSync(process.execPath, [companion, "review", "--json"], { env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot }, cwd: repo, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const invocation = JSON.parse(fs.readFileSync(invocationLog, "utf8"));
  const deliveredPrompt = Buffer.from(invocation.stdinBase64, "base64").toString("utf8");
  assert.equal(deliveredPrompt, expectedPrompt);
  assert.match(deliveredPrompt, new RegExp(marker));
  assert.equal(invocation.args.includes(expectedPrompt), false);
  assert.equal(invocation.args.some((arg) => arg.includes(marker)), false);
});

test("monitor bounds fail before workspace, state, job or provider interaction", () => {
  const providerLog = path.join(os.tmpdir(), `fake-bounds-provider-${Date.now()}.jsonl`);
  const fake = makeFakeClaude(`
const fs=require("node:fs");const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(providerLog)},JSON.stringify(args)+"\\n");
process.exit(2);
`);
  const workspace = initRepo("claude-monitor-validation-");
  const baseEnv = { ...isolatedClaudeEnv(fake.dir, fake.bin) };
  const run = (stateRoot, args) => spawnSync(process.execPath, [companion, ...args, "--json"], {
    env: { ...baseEnv, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: workspace,
    encoding: "utf8"
  });

  const absentRoot = path.join(os.tmpdir(), `claude-monitor-absent-${process.pid}-${Date.now()}`);
  const absent = run(absentRoot, ["monitor", "missing-job", "--forever"]);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /Unbounded --forever/);
  assert.equal(fs.existsSync(absentRoot), false);

  const missingRoot = path.join(os.tmpdir(), `claude-monitor-missing-${process.pid}-${Date.now()}`);
  const missing = run(missingRoot, ["status", "missing-job", "--watch", "--interval-ms", "-1"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--interval-ms must be between 0 and 3600000/);
  assert.doesNotMatch(missing.stderr, /No Claude job found/);
  assert.equal(fs.existsSync(missingRoot), false);

  const malformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-malformed-"));
  fs.chmodSync(malformedRoot, 0o751);
  const malformedEnv = { ...baseEnv, CLAUDE_COMPANION_STATE_ROOT: malformedRoot };
  const malformedStateDir = resolveStateDir(fs.realpathSync(workspace), malformedEnv, malformedRoot);
  fs.mkdirSync(malformedStateDir, { recursive: true, mode: 0o711 });
  fs.chmodSync(malformedStateDir, 0o711);
  const malformedFile = path.join(malformedStateDir, "state.json");
  fs.writeFileSync(malformedFile, "{ definitely-not-json }\n", { mode: 0o640 });
  const malformedBytes = fs.readFileSync(malformedFile);
  const malformedBefore = {
    root: fs.statSync(malformedRoot, { bigint: true }),
    directory: fs.statSync(malformedStateDir, { bigint: true }),
    file: fs.statSync(malformedFile, { bigint: true })
  };
  const malformed = run(malformedRoot, ["status", "missing-job", "--follow", "--max-checks", "0"]);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /--max-checks must be an integer between 1 and 1000/);
  assert.deepEqual(fs.readFileSync(malformedFile), malformedBytes);
  for (const [name, target] of [["root", malformedRoot], ["directory", malformedStateDir], ["file", malformedFile]]) {
    const after = fs.statSync(target, { bigint: true });
    assert.equal(after.mode, malformedBefore[name].mode, `${name} mode changed`);
    assert.equal(after.size, malformedBefore[name].size, `${name} size changed`);
    assert.equal(after.mtimeNs, malformedBefore[name].mtimeNs, `${name} mtime changed`);
  }

  const hostileRoot = path.join(os.tmpdir(), `claude-monitor-hostile-${process.pid}-${Date.now()}`);
  fs.writeFileSync(hostileRoot, "hostile-state-root\n", { mode: 0o640 });
  const hostileBytes = fs.readFileSync(hostileRoot);
  const hostileBefore = fs.statSync(hostileRoot, { bigint: true });
  const hostile = run(hostileRoot, ["monitor", "missing-job", "--interval-ms", "invalid"]);
  assert.notEqual(hostile.status, 0);
  assert.match(hostile.stderr, /--interval-ms must be between 0 and 3600000/);
  assert.deepEqual(fs.readFileSync(hostileRoot), hostileBytes);
  const hostileAfter = fs.statSync(hostileRoot, { bigint: true });
  assert.equal(hostileAfter.mode, hostileBefore.mode);
  assert.equal(hostileAfter.size, hostileBefore.size);
  assert.equal(hostileAfter.mtimeNs, hostileBefore.mtimeNs);

  assert.equal(fs.existsSync(providerLog), false);
});

test("Git execution and invalid-base errors fail before Claude review", () => {
  const called = path.join(os.tmpdir(), `fake-git-called-${Date.now()}.txt`);
  const fake = makeFakeClaude(`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(called)},"called");process.exit(2);`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-not-repo-"));
  const env = { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const executionError = spawnSync(process.execPath, [companion, "review", "--json"], { env, cwd: notRepo, encoding: "utf8" });
  assert.notEqual(executionError.status, 0);
  assert.match(executionError.stderr, /Git exited with status/);
  const repo = initRepo("claude-invalid-base-");
  const invalidBase = spawnSync(process.execPath, [companion, "review", "--base", "missing-ref", "--json"], { env, cwd: repo, encoding: "utf8" });
  assert.notEqual(invalidBase.status, 0);
  assert.match(invalidBase.stderr, /Git exited with status/);
  assert.equal(fs.existsSync(called), false);
});

test("foreground timeout fails the job without hanging", () => {
  const fake = makeFakeClaude(`
setTimeout(() => {}, 5000);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const result = spawnSync(process.execPath, [companion, "advise", "--timeout-ms", "50", "--no-background-fallback", "slow"], {
    env: { ...isolatedClaudeEnv(fake.dir, fake.bin), CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timed out/);
});
