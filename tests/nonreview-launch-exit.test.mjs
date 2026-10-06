import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";
import { fakeClaudeName, writeFakeClaude } from "./lib/fake-claude.mjs";
import { fileURLToPath } from "node:url";

import { resolveStateDir, saveState, STATE_VERSION } from "../plugins/claude-code-advisor/scripts/lib/runtime.mjs";

const companion = fileURLToPath(new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url));
const sessionId = "11111111-1111-4111-8111-111111111111";

function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  } while (Date.now() < deadline);
  assert.fail(message);
}

function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return windowsProcesses().find(row => row.pid === pid)?.identity || null;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function windowsProcesses() {
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;identity=$_.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress`;
  const output = execFileSync(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")
  ], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  return JSON.parse(output);
}

function fixture(t, { unavailable = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-nonreview-launch-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const stateRoot = path.join(root, "state");
  const gate = path.join(root, "gate");
  const log = path.join(root, "invocations.jsonl");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  writeFakeClaude(path.join(bin, fakeClaudeName), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, parent: process.ppid, args }) + "\\n");
if (!args.includes("-p")) process.exit(2);
const deadline = Date.now() + 15000;
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(gate)}) && Date.now() < deadline) return;
  clearInterval(timer);
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
    session_id: ${JSON.stringify(sessionId)}, result: "Synthetic completion" }));
}, 10);
`, { mode: 0o755 });
  const env = {
    ...isolatedClaudeEnv(root, path.join(bin, fakeClaudeName)),
    // A nested fixture TMPDIR can exceed macOS's Unix socket path limit.
    TMPDIR: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CODEX_THREAD_ID: "nonreview-launch-exit-test"
  };
  execFileSync("git", ["init", "-q"], { cwd: repo, env });
  const stateDir = resolveStateDir(fs.realpathSync(repo), env);
  const stateFile = path.join(stateDir, "state.json");
  if (unavailable) saveState(stateDir, { version: STATE_VERSION, capabilities: { background: false }, jobs: [] });
  const jobs = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs : [];
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const owned = new Map();
  const rememberProcesses = () => {
    const roots = new Set([...calls().map((call) => call.pid), ...jobs().map((job) => job.supervisor?.pid)].filter(Number.isInteger));
    const windows = process.platform === "win32" ? windowsProcesses() : null;
    if (windows) for (const call of calls()) roots.add(call.parent);
    const rows = windows ? windows.map(row => [row.pid, row.parent])
      : execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).map(Number));
    // Include the supervisor's worker as well as the logged fake provider.
    for (let changed = true; changed;) {
      changed = false;
      for (const [pid, parent] of rows) {
        if (roots.has(parent) && !roots.has(pid)) { roots.add(pid); changed = true; }
      }
    }
    for (const pid of roots) {
      const identity = windows ? windows.find(row => row.pid === pid)?.identity : processIdentity(pid);
      if (identity && !owned.has(pid)) owned.set(pid, identity);
    }
  };
  const gone = () => [...owned].every(([pid, identity]) => processIdentity(pid) !== identity);
  const release = () => fs.writeFileSync(gate, "continue\n");
  t.after(() => {
    rememberProcesses();
    release();
    try {
      waitFor(gone, "all owned fake providers, workers and supervisors must exit", 20000);
    } finally {
      for (const [pid, identity] of owned) {
        if (processIdentity(pid) === identity) {
          try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      }
      waitFor(gone, "owned process cleanup did not finish", 5000);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const invoke = (args) => {
    const response = spawnSync(process.execPath, [companion, ...args, "--json"], {
      cwd: repo, env, encoding: "utf8", timeout: 10000
    });
    rememberProcesses();
    assert.equal(response.error, undefined, "the command must finish within the test deadline");
    assert.equal(response.signal, null);
    return response;
  };
  return { invoke, jobs, calls, release, gone, owned, rememberProcesses };
}

for (const kind of ["advise", "do", "rescue"]) {
  for (const write of [false, true]) {
    const mode = write ? "write" : "read";
    const args = [kind, "Synthetic task", ...(write ? ["--write"] : [])];
    for (const fallback of [false, true]) {
      test(`${kind} ${mode} ${fallback ? "timeout fallback" : "background launch"} exits zero while running and cleans up`, {
        skip: process.platform !== "darwin"
      }, (t) => {
        const f = fixture(t);
        const result = f.invoke([...args, ...(fallback ? ["--timeout-ms", "1500"] : ["--background"])]);
        assert.equal(result.status, 0, result.stderr);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.status, "running");
        const running = f.jobs().find((job) => job.id === payload.jobId);
        assert.equal(running.lifecycleState, "running");
        assert.equal(running.write, write);
        assert.equal(running.authority, mode);
        assert.equal(running.fallbackReason, fallback ? "foreground-timeout" : null);
        const foreground = f.jobs().filter((job) => job.id !== running.id);
        assert.equal(foreground.length, fallback ? 1 : 0);
        if (fallback) {
          assert.equal(foreground[0].status, "timed_out");
          assert.equal(running.fallbackFromJobId, foreground[0].id);
          assert.match(payload.output, /Foreground Claude timed out/);
        }
        waitFor(() => f.calls().length === (fallback ? 2 : 1), "fake supervised provider did not start");
        f.rememberProcesses();
        assert.ok(f.owned.size >= 3, "capture the live supervisor, worker and fake provider before releasing work");
        for (const call of f.calls()) {
          assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], write ? "default" : "plan");
        }
        if (fallback) assert.equal(processIdentity(f.calls()[0].pid), null, "timed-out foreground provider must already be gone");
        f.release();
        waitFor(() => f.jobs().some((job) => job.id === running.id && job.lifecycleState === "completed" && job.cleanupStatus === "verified"),
          "the supervised task must complete with verified cleanup");
        waitFor(f.gone, "the supervisor, worker and provider must all exit after completion");
        const completed = f.jobs().find((job) => job.id === running.id);
        assert.equal(completed.result, "Synthetic completion");
        assert.equal(completed.resumeSessionId, sessionId);
      });
    }
    for (const unavailable of [false, true]) {
      test(`${kind} ${mode} timeout with ${unavailable ? "unavailable" : "disabled"} fallback retains thrown failure`, (t) => {
        const f = fixture(t, { unavailable });
        const result = f.invoke([...args, "--timeout-ms", "1500", ...(unavailable ? [] : ["--no-background-fallback"])]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /timed out/i);
        assert.equal(f.calls().length, 1, "no fallback provider may launch");
        assert.equal(f.jobs().length, 1);
        assert.equal(f.jobs()[0].status, unavailable ? "timed_out" : "failed");
        assert.equal(f.jobs()[0].write, write);
        assert.equal(Object.hasOwn(f.jobs()[0], "supervisor"), false);
        assert.equal(processIdentity(f.calls()[0].pid), null, "the timed-out fake provider must exit");
      });
    }
  }
}
