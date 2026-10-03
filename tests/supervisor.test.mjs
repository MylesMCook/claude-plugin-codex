import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";
import { fileURLToPath } from "node:url";

import {
  resolveStateDir,
  saveState,
  SUPERVISED_RECORD_VERSION,
  SUPERVISED_TRANSPORT,
  supervisorPaths,
  transitionSupervisedJob,
  updateSupervisedCleanup,
  validateSupervisedClaudeResult
} from "../plugins/claude-code-advisor/scripts/lib/runtime.mjs";

const companion = fileURLToPath(new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url));
const supervisor = fileURLToPath(new URL("../plugins/claude-code-advisor/scripts/claude-supervisor.mjs", import.meta.url));
const groupWorker = fileURLToPath(new URL("../plugins/claude-code-advisor/scripts/claude-group-worker.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/fake-claude-print.mjs", import.meta.url));
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const supervisedTest = process.platform === "darwin" ? test : test.skip;

function makeHarness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-supervisor-test-"));
  const repo = path.join(root, "repo");
  const stateRoot = path.join(root, "state");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(stateRoot);
  fs.mkdirSync(binDir);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const fakeClaude = path.join(binDir, "claude");
  fs.copyFileSync(fixture, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  const scenarioFile = path.join(root, "scenario.json");
  const scenario = {
    invocationLog: path.join(root, "invocations.jsonl"),
    nameFile: path.join(root, "name.txt"),
    sessionId: SESSION_ID,
    stdoutBase64: Buffer.from(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "PASS",
      session_id: SESSION_ID
    })).toString("base64"),
    ...overrides
  };
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario), "utf8");
  const env = {
    ...isolatedClaudeEnv(root, fakeClaude),
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CLAUDE_COMPANION_EXECUTABLE: fakeClaude,
    CLAUDE_TEST_SCENARIO: scenarioFile
  };
  return { root, repo, stateRoot, scenarioFile, scenario, env };
}

function runCompanion(harness, args, options = {}) {
  return spawnSync(process.execPath, [companion, ...args, "--json"], {
    cwd: harness.repo,
    env: harness.env,
    encoding: "utf8",
    timeout: options.timeout || 10000
  });
}

function readInvocations(harness) {
  if (!fs.existsSync(harness.scenario.invocationLog)) return [];
  return fs.readFileSync(harness.scenario.invocationLog, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function findStateFile(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      if (entry.isFile() && entry.name === "state.json") return target;
    }
  }
  return null;
}

function readJob(harness, jobId) {
  const stateFile = findStateFile(harness.stateRoot);
  if (!stateFile) return null;
  return JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find((job) => job.id === jobId) || null;
}

function waitForJob(harness, jobId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = readJob(harness, jobId);
    if (job && predicate(job)) return job;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error("Timed out waiting for supervised job state.");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function processRelationships() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isInteger))
    .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
}

function processStartIdentity(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function waitForProcessRelationship(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = processRelationships().find(predicate);
    if (match) return match;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return null;
}

function waitForProcessCondition(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return predicate();
}

function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return fs.existsSync(file);
}

supervisedTest("background jobs use detached supervised print mode with stdin prompt and exact JSON authority", () => {
  const gateFile = path.join(os.tmpdir(), `claude-supervisor-gate-${process.pid}-${Date.now()}`);
  const startedFile = `${gateFile}.started`;
  const harness = makeHarness({ gateFile, startedFile });
  const launched = runCompanion(harness, ["advise", "--background", "private prompt"]);
  assert.equal(launched.status, 0, launched.stderr);
  const payload = JSON.parse(launched.stdout);
  assert.ok(payload.jobId);
  const running = readJob(harness, payload.jobId);
  assert.equal(running.lifecycleState, "running");
  const startedDeadline = Date.now() + 5000;
  while (!fs.existsSync(startedFile) && Date.now() < startedDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.ok(fs.existsSync(startedFile), "supervised fake work did not remain active after the initiating command returned");
  const liveStatus = JSON.parse(runCompanion(harness, ["status", payload.jobId]).stdout);
  assert.equal(liveStatus.job.lifecycleState, "running");
  fs.writeFileSync(gateFile, "continue\n", "utf8");
  const completed = waitForJob(harness, payload.jobId, (job) => job.lifecycleState === "completed");
  assert.equal(completed.result, "PASS");
  assert.equal(completed.resumeSessionId, SESSION_ID);
  assert.notEqual(completed.id, completed.resumeSessionId);
  const invocation = readInvocations(harness).find((entry) => entry.args.includes("-p"));
  assert.ok(invocation);
  assert.equal(Buffer.from(invocation.stdinBase64, "base64").toString("utf8"), "private prompt");
  assert.equal(invocation.args.includes("--bg"), false);
  assert.equal(invocation.args.includes("logs"), false);
  assert.equal(invocation.args.includes("private prompt"), false);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("-p"), invocation.args.indexOf("-p") + 4), [
    "-p", "--output-format", "json", "--max-turns"
  ]);
  const first = JSON.parse(runCompanion(harness, ["result", payload.jobId]).stdout);
  const repeated = JSON.parse(runCompanion(harness, ["result", payload.jobId]).stdout);
  assert.equal(first.result, "PASS");
  assert.equal(repeated.result, "PASS");
  assert.equal(repeated.job.resultAuthoritativeAt, first.job.resultAuthoritativeAt);
  const lateCancel = JSON.parse(runCompanion(harness, ["cancel", payload.jobId]).stdout);
  assert.equal(lateCancel.status, "completed");
  const cleaned = waitForJob(harness, payload.jobId, (job) => job.cleanupStatus !== "pending");
  assert.equal(cleaned.cleanupStatus, "verified");
  for (const file of [gateFile, startedFile]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

supervisedTest("job list and resume-candidate output never disclose supervisor control capability", () => {
  const gateFile = path.join(os.tmpdir(), `claude-supervisor-redaction-${process.pid}-${Date.now()}`);
  const harness = makeHarness({ gateFile, startedFile: `${gateFile}.started` });
  const launched = JSON.parse(runCompanion(harness, ["advise", "--background", "check"]).stdout);
  const internal = readJob(harness, launched.jobId);
  assert.ok(internal.supervisor.token);
  const statusList = runCompanion(harness, ["status"]);
  const candidateList = runCompanion(harness, ["resume-candidate"]);
  const publicOutput = `${statusList.stdout}\n${statusList.stderr}\n${candidateList.stdout}\n${candidateList.stderr}`;
  try {
    assert.equal(publicOutput.includes(internal.supervisor.token), false);
    assert.equal(publicOutput.includes('"supervisor"'), false);
  } finally {
    fs.writeFileSync(gateFile, "continue\n", "utf8");
    waitForJob(harness, launched.jobId, (job) => job.lifecycleState === "completed");
    for (const file of [gateFile, `${gateFile}.started`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test("supervisor uses a persistent checked-in group leader as the live signalling anchor", () => {
  assert.equal(fs.existsSync(groupWorker), true);
  const supervisorSource = fs.readFileSync(supervisor, "utf8");
  const workerSource = fs.readFileSync(groupWorker, "utf8");
  assert.match(supervisorSource, /claude-group-worker\.mjs/);
  assert.doesNotMatch(supervisorSource, /spawn\("claude"/);
  assert.match(workerSource, /spawn\(discoverClaude\(\)/);
  assert.match(workerSource, /provider-close/);
  assert.match(workerSource, /terminateOwnGroup/);
});

test("background supervision fails closed on unproved non-macOS platforms", {
  skip: process.platform === "darwin"
}, () => {
  const harness = makeHarness();
  const launched = runCompanion(harness, ["advise", "--background", "check"]);
  assert.notEqual(launched.status, 0);
  assert.match(launched.stderr, /supervised background mode is unavailable on this platform/);
  assert.equal(readInvocations(harness).some((entry) => entry.args.includes("-p")), false);
});

supervisedTest("state-lock contention during cancellation cannot crash the owning supervisor", () => {
  const gateFile = path.join(os.tmpdir(), `claude-supervisor-lock-cancel-${process.pid}-${Date.now()}`);
  const harness = makeHarness({ gateFile, startedFile: `${gateFile}.started`, ignoreTerm: true });
  const launched = JSON.parse(runCompanion(harness, ["advise", "--background", "check"]).stdout);
  assert.ok(waitForFile(`${gateFile}.started`));
  const stateFile = findStateFile(harness.stateRoot);
  const lockFile = path.join(path.dirname(stateFile), ".state.lock");
  const readyFile = `${gateFile}.lock-ready`;
  const holder = spawn(process.execPath, [
    "-e",
    "const fs=require('fs'),os=require('os');const [lock,ready]=process.argv.slice(1);fs.writeFileSync(lock,JSON.stringify({pid:process.pid,hostname:os.hostname(),token:'test-holder'})+'\\n',{mode:0o600,flag:'wx'});fs.writeFileSync(ready,'ready');setTimeout(()=>{try{fs.unlinkSync(lock)}catch{}},5200);setTimeout(()=>process.exit(0),5400);",
    lockFile,
    readyFile
  ], { stdio: "ignore" });
  assert.ok(waitForFile(readyFile));
  try {
    const cancelled = runCompanion(harness, ["cancel", launched.jobId, "--timeout-ms", "10000"], { timeout: 12000 });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
    const terminal = waitForJob(harness, launched.jobId, (job) => job.lifecycleState === "cancelled");
    assert.equal(terminal.cleanupStatus, "verified");
  } finally {
    if (!fs.existsSync(gateFile)) fs.writeFileSync(gateFile, "continue\n", "utf8");
    if (processExists(holder.pid)) {
      try { process.kill(holder.pid, "SIGTERM"); } catch {}
    }
    for (const file of [gateFile, `${gateFile}.started`, readyFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

supervisedTest("supervisor reconstructs one JSON document split across arbitrary stream chunks", () => {
  const valid = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "chunked",
    session_id: SESSION_ID
  });
  const harness = makeHarness({
    stdoutChunks: [...Buffer.from(` \n${valid}\t`)].map((byte, index) => ({
      base64: Buffer.from([byte]).toString("base64"),
      delayMs: index % 7 === 0 ? 1 : 0
    }))
  });
  const launched = JSON.parse(runCompanion(harness, ["advise", "--background", "check"]).stdout);
  const completed = waitForJob(harness, launched.jobId, (job) => job.lifecycleState === "completed");
  assert.equal(completed.result, "chunked");
});

supervisedTest("supervised JSON authority rejects a success envelope without a canonical session id", () => {
  const invalid = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "PASS" });
  const harness = makeHarness({ stdoutBase64: Buffer.from(invalid).toString("base64") });
  const launched = runCompanion(harness, ["advise", "--background", "check"]);
  assert.equal(launched.status, 0, launched.stderr);
  const payload = JSON.parse(launched.stdout);
  const failed = waitForJob(harness, payload.jobId, (job) => ["failed", "interrupted"].includes(job.lifecycleState));
  assert.equal(failed.failureClassification, "invalid-result");
  assert.equal(Object.hasOwn(failed, "result"), false);
});

supervisedTest("supervisor enforces stdout streaming limits before persisting any partial result", () => {
  const valid = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "PASS", session_id: SESSION_ID });
  const harness = makeHarness({ stdoutBase64: Buffer.from(valid).toString("base64") });
  harness.env.CLAUDE_COMPANION_STDOUT_LIMIT_BYTES = String(Buffer.byteLength(valid) - 1);
  const launched = runCompanion(harness, ["advise", "--background", "check"]);
  assert.equal(launched.status, 0, launched.stderr);
  const payload = JSON.parse(launched.stdout);
  const failed = waitForJob(harness, payload.jobId, (job) => job.lifecycleState === "failed");
  assert.equal(failed.failureClassification, "output-limit");
  assert.equal(Object.hasOwn(failed, "result"), false);
  assert.equal(JSON.stringify(failed).includes("PASS"), false);
});

supervisedTest("cancellation terminates and reaps a TERM-ignoring child and grandchild process group", () => {
  const gateFile = path.join(os.tmpdir(), `claude-supervisor-cancel-${process.pid}-${Date.now()}`);
  const grandchildPidFile = `${gateFile}.grandchild`;
  const harness = makeHarness({
    gateFile,
    startedFile: `${gateFile}.started`,
    spawnGrandchild: true,
    grandchildIgnoresTerm: true,
    grandchildPidFile,
    ignoreTerm: true,
    legacyLifecycle: "active"
  });
  const launched = runCompanion(harness, ["advise", "--background", "check"]);
  assert.equal(launched.status, 0, launched.stderr);
  const payload = JSON.parse(launched.stdout);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(grandchildPidFile) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.ok(fs.existsSync(grandchildPidFile));
  const grandchildPid = Number(fs.readFileSync(grandchildPidFile, "utf8").trim());
  assert.equal(processExists(grandchildPid), true);
  try {
    const cancelled = runCompanion(harness, ["cancel", payload.jobId, "--timeout-ms", "5000"], { timeout: 8000 });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
    waitForJob(harness, payload.jobId, (job) => job.lifecycleState === "cancelled");
    assert.equal(JSON.parse(runCompanion(harness, ["cancel", payload.jobId]).stdout).status, "cancelled");
    assert.equal(processExists(grandchildPid), false);
  } finally {
    if (processExists(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    for (const file of [gateFile, `${gateFile}.started`, grandchildPidFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

supervisedTest("worker-first exit terminates its owned process group and cleans control resources", () => {
  const gateFile = path.join(os.tmpdir(), `claude-supervisor-worker-first-${process.pid}-${Date.now()}`);
  const startedFile = `${gateFile}.started`;
  const harness = makeHarness({ gateFile, startedFile, ignoreTerm: true, gateTimeoutMs: 30000 });
  let supervisorPid = null;
  let workerPid = null;
  let providerPid = null;
  let ownedPgid = null;
  let control = null;
  const processIdentities = new Map();
  try {
    const launched = runCompanion(harness, ["advise", "--background", "check"]);
    assert.equal(launched.status, 0, launched.stderr);
    const payload = JSON.parse(launched.stdout);
    assert.ok(waitForFile(startedFile));
    const running = waitForJob(harness, payload.jobId, (job) => job.lifecycleState === "running");
    supervisorPid = running.supervisor.pid;
    processIdentities.set(supervisorPid, processStartIdentity(supervisorPid));
    const worker = waitForProcessRelationship((entry) => entry.ppid === supervisorPid);
    assert.ok(worker, "group worker did not become observable");
    workerPid = worker.pid;
    processIdentities.set(workerPid, processStartIdentity(workerPid));
    ownedPgid = worker.pgid;
    assert.equal(ownedPgid, workerPid);
    const provider = waitForProcessRelationship((entry) => entry.ppid === workerPid && entry.pgid === ownedPgid);
    assert.ok(provider, "fake provider did not join the worker-owned process group");
    providerPid = provider.pid;
    processIdentities.set(providerPid, processStartIdentity(providerPid));
    assert.equal(processExists(providerPid), true);
    control = supervisorPaths(path.dirname(findStateFile(harness.stateRoot)), payload.jobId);
    assert.equal(fs.existsSync(control.directory), true);
    assert.equal(fs.existsSync(control.socket), true);

    process.kill(workerPid, "SIGKILL");
    const terminal = waitForJob(
      harness,
      payload.jobId,
      (job) => ["failed", "interrupted"].includes(job.lifecycleState) && job.cleanupStatus !== "pending",
      12000
    );
    assert.equal(terminal.lifecycleState, "failed");
    assert.equal(terminal.failureClassification, "worker-exit-signal");
    assert.equal(terminal.cleanupStatus, "verified");
    assert.equal(Object.hasOwn(terminal, "result"), false);
    assert.equal(Object.hasOwn(terminal, "resultAuthoritativeAt"), false);
    assert.equal(waitForProcessCondition(() => !processGroupExists(ownedPgid)), true);
    assert.equal(waitForProcessCondition(() => !processExists(providerPid)), true);
    assert.equal(waitForProcessCondition(() => !processExists(workerPid)), true);
    assert.equal(waitForProcessCondition(() => !processExists(supervisorPid)), true);
    assert.equal(fs.existsSync(control.socket), false);
    assert.equal(fs.existsSync(control.directory), false);

    const stateFile = findStateFile(harness.stateRoot);
    const immutableBytes = fs.readFileSync(stateFile);
    const immutableJob = structuredClone(terminal);
    const repeated = [
      runCompanion(harness, ["status", payload.jobId]),
      runCompanion(harness, ["monitor", payload.jobId, "--interval-ms", "0", "--max-checks", "1"]),
      runCompanion(harness, ["result", payload.jobId]),
      runCompanion(harness, ["cancel", payload.jobId])
    ];
    for (const call of repeated) {
      assert.equal(call.signal, null);
      assert.equal(call.status, 0, call.stderr);
    }
    const after = readJob(harness, payload.jobId);
    assert.deepEqual(after, immutableJob);
    assert.deepEqual(fs.readFileSync(stateFile), immutableBytes);
  } finally {
    for (const pid of [providerPid, workerPid, supervisorPid]) {
      if (
        Number.isInteger(pid) &&
        processIdentities.get(pid) &&
        processStartIdentity(pid) === processIdentities.get(pid)
      ) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    waitForProcessCondition(() => [providerPid, workerPid, supervisorPid].every((pid) => !Number.isInteger(pid) || !processExists(pid)), 2000);
    if (control) {
      try {
        if (fs.lstatSync(control.socket).isSocket()) fs.unlinkSync(control.socket);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        if (fs.lstatSync(control.directory).isDirectory()) fs.rmdirSync(control.directory);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    for (const file of [gateFile, startedFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

supervisedTest("worker exit before config consumption cannot bypass cleanup through stdin EPIPE", async () => {
  const harness = makeHarness();
  const stateDir = resolveStateDir(fs.realpathSync(harness.repo), harness.env, harness.stateRoot);
  const jobId = `worker-config-exit-${process.pid}-${Date.now()}`;
  const token = "synthetic-worker-config-token";
  saveState(stateDir, {
    version: 1,
    capabilities: null,
    jobs: [{
      id: jobId,
      recordVersion: SUPERVISED_RECORD_VERSION,
      transport: SUPERVISED_TRANSPORT,
      stateGeneration: 1,
      lifecycleState: "starting",
      status: "starting",
      lifecycleId: `supervisor-${jobId}`,
      resultState: "unavailable",
      cleanupStatus: "pending",
      supervisor: { pid: null, token }
    }]
  }, { pathBoundary: harness.stateRoot });
  const config = {
    jobId,
    token,
    prompt: "x".repeat(1536 * 1024),
    claudeArgs: ["-p", "--output-format", "json"],
    cwd: harness.repo,
    stateDir,
    stateRoot: harness.stateRoot,
    expectedSessionId: null,
    timeoutMs: 10000,
    stdoutLimitBytes: 1024 * 1024,
    stderrLimitBytes: 64 * 1024
  };
  const child = spawn(process.execPath, [supervisor], {
    cwd: harness.repo,
    env: {
      ...harness.env,
      CLAUDE_COMPANION_TEST_EXIT_GROUP_WORKER_BEFORE_CONFIG: "1"
    },
    stdio: ["pipe", "ignore", "ignore", "ipc"]
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(config));
  let exitTimeout;
  const timedOut = new Promise((resolve) => {
    exitTimeout = setTimeout(() => resolve(null), 12000);
    exitTimeout.unref();
  });
  const outcome = await Promise.race([
    exited,
    timedOut
  ]);
  clearTimeout(exitTimeout);
  if (!outcome && processExists(child.pid)) process.kill(child.pid, "SIGKILL");
  assert.ok(outcome, "supervisor did not exit after the worker rejected its config pipe");
  assert.equal(outcome.signal, null);
  const terminal = readJob(harness, jobId);
  assert.equal(terminal.lifecycleState, "failed");
  assert.equal(terminal.failureClassification, "worker-exit-code");
  assert.equal(Object.hasOwn(terminal, "result"), false);
  assert.equal(Object.hasOwn(terminal, "resultAuthoritativeAt"), false);
  const control = supervisorPaths(stateDir, jobId);
  assert.equal(fs.existsSync(control.socket), false);
  assert.equal(fs.existsSync(control.directory), false);
  assert.equal(terminal.cleanupStatus, "verified", JSON.stringify({ outcome, terminal }));
  assert.equal(outcome.code, 0, JSON.stringify(terminal));
});

supervisedTest("cancellation during streamed output discards partial stdout", () => {
  const startedFile = path.join(os.tmpdir(), `claude-supervisor-output-cancel-${process.pid}-${Date.now()}`);
  const valid = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "PASS", session_id: SESSION_ID });
  const midpoint = Math.floor(valid.length / 2);
  const harness = makeHarness({
    startedFile,
    ignoreTerm: true,
    stdoutChunks: [
      { base64: Buffer.from(valid.slice(0, midpoint)).toString("base64") },
      { base64: Buffer.from(valid.slice(midpoint)).toString("base64"), delayMs: 10000 }
    ]
  });
  const launched = JSON.parse(runCompanion(harness, ["advise", "--background", "check"]).stdout);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(startedFile) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.ok(fs.existsSync(startedFile));
  const cancelled = runCompanion(harness, ["cancel", launched.jobId, "--timeout-ms", "5000"], { timeout: 8000 });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const job = waitForJob(harness, launched.jobId, (candidate) => candidate.lifecycleState === "cancelled");
  assert.equal(Object.hasOwn(job, "result"), false);
  assert.equal(JSON.stringify(job).includes(valid.slice(0, midpoint)), false);
  if (fs.existsSync(startedFile)) fs.unlinkSync(startedFile);
});

test("strict provider JSON accepts one complete document and rejects every ambiguous boundary", () => {
  const valid = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "payload <CODEX_RESULT_fake> ⏺ {\"state\":\"failed\"} \u001b[31m",
    session_id: SESSION_ID
  });
  assert.equal(validateSupervisedClaudeResult(Buffer.from(` \n${valid}\t`)).sessionId, SESSION_ID);
  const invalid = [
    "",
    "{",
    valid.slice(0, -1),
    `${valid}{}`,
    `${valid}\nterminal text`,
    "[]",
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "PASS" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "PASS", session_id: SESSION_ID }),
    JSON.stringify({ type: "result", subtype: "error", is_error: false, result: "PASS", session_id: SESSION_ID }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: 1, session_id: SESSION_ID }),
    `{"type":"result","type":"result","subtype":"success","is_error":false,"result":"PASS","session_id":"${SESSION_ID}"}`,
    `{"type":"result","subtype":"success","is_error":false,"result":"PASS","session_id":"${SESSION_ID}","session_\\u0069d":"${SESSION_ID}"}`
  ];
  for (const candidate of invalid) {
    assert.throws(() => validateSupervisedClaudeResult(Buffer.from(candidate)), /invalid-result/);
  }
  assert.throws(
    () => validateSupervisedClaudeResult(Buffer.from([0xff, 0xfe, 0xfd])),
    /invalid-result/
  );
});

supervisedTest("valid-looking JSON from a non-zero provider process is never authoritative", () => {
  const harness = makeHarness({ exitStatus: 7 });
  const launched = runCompanion(harness, ["advise", "--background", "check"]);
  assert.equal(launched.status, 0, launched.stderr);
  const payload = JSON.parse(launched.stdout);
  const failed = waitForJob(harness, payload.jobId, (job) => job.lifecycleState === "failed");
  assert.equal(failed.failureClassification, "non-zero-exit");
  assert.equal(Object.hasOwn(failed, "result"), false);
});

supervisedTest("provider spawn failure is classified and its control resources are cleaned", () => {
  const harness = makeHarness();
  fs.unlinkSync(path.join(harness.root, "bin", "claude"));
  harness.env.PATH = path.join(harness.root, "bin");
  const launched = runCompanion(harness, ["advise", "--background", "check"]);
  assert.notEqual(launched.status, 0);
  const stateFile = findStateFile(harness.stateRoot);
  assert.ok(stateFile);
  const [job] = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
  assert.equal(job.lifecycleState, "failed");
  assert.equal(job.failureClassification, "spawn-failure");
  assert.equal(job.cleanupStatus, "verified");
});

supervisedTest("stdout and stderr limits are independent, inclusive and non-disclosing", () => {
  const valid = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "PASS", session_id: SESSION_ID });
  const exact = makeHarness({ stderrBase64: Buffer.alloc(64, 0x78).toString("base64") });
  exact.env.CLAUDE_COMPANION_STDOUT_LIMIT_BYTES = String(Buffer.byteLength(valid));
  exact.env.CLAUDE_COMPANION_STDERR_LIMIT_BYTES = "64";
  const exactLaunch = JSON.parse(runCompanion(exact, ["advise", "--background", "check"]).stdout);
  const exactJob = waitForJob(exact, exactLaunch.jobId, (job) => job.lifecycleState === "completed");
  assert.equal(exactJob.result, "PASS");

  const secret = "SYNTHETIC_SECRET prompt /Users/example/private 123e4567-e89b-42d3-a456-426614174999";
  const overflow = makeHarness({ stderrBase64: Buffer.from(secret.repeat(2)).toString("base64") });
  overflow.env.CLAUDE_COMPANION_STDERR_LIMIT_BYTES = "64";
  const overflowLaunch = JSON.parse(runCompanion(overflow, ["advise", "--background", "check"]).stdout);
  const failed = waitForJob(overflow, overflowLaunch.jobId, (job) => job.lifecycleState === "failed");
  assert.equal(failed.failureClassification, "output-limit");
  const publicResult = runCompanion(overflow, ["result", overflowLaunch.jobId]);
  const combined = `${JSON.stringify(failed)}\n${publicResult.stdout}\n${publicResult.stderr}`;
  assert.equal(combined.includes("SYNTHETIC_SECRET"), false);
  assert.equal(combined.includes("/Users/example/private"), false);
  assert.equal(combined.includes("174999"), false);
});

test("terminal state CAS permits exactly one closer and preserves immutable completion", () => {
  const harness = makeHarness();
  const stateDir = resolveStateDir(fs.realpathSync(harness.repo), harness.env, harness.stateRoot);
  saveState(stateDir, {
    version: 1,
    capabilities: null,
    jobs: [{
      id: "cas-job",
      recordVersion: SUPERVISED_RECORD_VERSION,
      transport: SUPERVISED_TRANSPORT,
      stateGeneration: 2,
      lifecycleState: "running",
      status: "running",
      resultState: "unavailable",
      cleanupStatus: "pending"
    }]
  }, { pathBoundary: harness.stateRoot });
  assert.throws(
    () => transitionSupervisedJob(stateDir, "cas-job", {
      expectedGeneration: 2,
      expectedStates: ["running"],
      toState: "failed",
      patch: { failureClassification: "SECRET raw exception text" }
    }, { pathBoundary: harness.stateRoot }),
    /invalid-supervised-failure-classification/
  );
  const completed = transitionSupervisedJob(stateDir, "cas-job", {
    expectedGeneration: 2,
    expectedStates: ["running"],
    toState: "completed",
    patch: {
      result: "immutable",
      resultState: "available",
      resultSource: "provider-json",
      resumeSessionId: SESSION_ID,
      canonicalSessionId: SESSION_ID,
      resultAuthoritativeAt: "2026-08-18T00:00:00.000Z",
      terminalAt: "2026-08-18T00:00:00.000Z",
      cleanupStatus: "pending"
    }
  }, { pathBoundary: harness.stateRoot });
  const cancelled = transitionSupervisedJob(stateDir, "cas-job", {
    expectedGeneration: 2,
    expectedStates: ["running"],
    toState: "cancelled",
    patch: { failureClassification: "cancellation", terminalAt: "later" }
  }, { pathBoundary: harness.stateRoot });
  assert.equal(completed.applied, true);
  assert.equal(cancelled.applied, false);
  assert.equal(cancelled.job.lifecycleState, "completed");
  assert.equal(cancelled.job.result, "immutable");
  assert.equal(cancelled.job.resultAuthoritativeAt, "2026-08-18T00:00:00.000Z");
});

test("pre-spawn cancellation closes once and strict state rejects prompt persistence", () => {
  const harness = makeHarness();
  const stateDir = resolveStateDir(fs.realpathSync(harness.repo), harness.env, harness.stateRoot);
  const created = {
    id: "pre-spawn-job",
    recordVersion: SUPERVISED_RECORD_VERSION,
    transport: SUPERVISED_TRANSPORT,
    stateGeneration: 0,
    lifecycleState: "created",
    status: "created",
    resultState: "unavailable",
    cleanupStatus: "pending"
  };
  saveState(stateDir, { version: 1, capabilities: null, jobs: [created] }, { pathBoundary: harness.stateRoot });
  const cancelled = transitionSupervisedJob(stateDir, created.id, {
    expectedGeneration: 0,
    expectedStates: ["created"],
    toState: "cancelled",
    patch: {
      failureClassification: "cancellation",
      terminalAt: "2026-08-18T00:00:00.000Z",
      cleanupStatus: "pending"
    }
  }, { pathBoundary: harness.stateRoot });
  assert.equal(cancelled.applied, true);
  const cleaned = updateSupervisedCleanup(stateDir, created.id, "failed", { pathBoundary: harness.stateRoot });
  assert.equal(cleaned.applied, true);
  const late = transitionSupervisedJob(stateDir, created.id, {
    expectedStates: ["cancelled"],
    toState: "completed",
    patch: { result: "forbidden" }
  }, { pathBoundary: harness.stateRoot });
  assert.equal(late.applied, false);
  assert.equal(late.job.lifecycleState, "cancelled");
  assert.equal(late.job.cleanupStatus, "failed");
  assert.throws(
    () => saveState(
      stateDir,
      { version: 1, capabilities: null, jobs: [{ ...created, prompt: "must not persist" }] },
      { pathBoundary: harness.stateRoot }
    ),
    /invalid supervised job field prompt/
  );
});

test("restart without a live ownership challenge fails closed without signalling a stored PID", () => {
  const harness = makeHarness();
  const stateDir = resolveStateDir(fs.realpathSync(harness.repo), harness.env, harness.stateRoot);
  saveState(stateDir, {
    version: 1,
    capabilities: null,
    jobs: [{
      id: "orphan-job",
      recordVersion: SUPERVISED_RECORD_VERSION,
      transport: SUPERVISED_TRANSPORT,
      stateGeneration: 2,
      lifecycleState: "running",
      status: "running",
      lifecycleId: "supervisor-test",
      resultState: "unavailable",
      cleanupStatus: "pending",
      supervisor: { pid: process.pid, token: "wrong-owner-token" }
    }]
  }, { pathBoundary: harness.stateRoot });
  const status = runCompanion(harness, ["status", "orphan-job"]);
  assert.equal(status.status, 0, status.stderr);
  const job = JSON.parse(status.stdout).job;
  assert.equal(job.lifecycleState, "interrupted");
  assert.equal(job.failureClassification, "interrupted-supervisor");
  assert.equal(processExists(process.pid), true);
});

supervisedTest("foreground and supervised asynchronous resume preserve the validated canonical identity", () => {
  const harness = makeHarness();
  const initialLaunch = JSON.parse(runCompanion(harness, ["advise", "--background", "first"]).stdout);
  waitForJob(harness, initialLaunch.jobId, (job) => job.lifecycleState === "completed");
  const foreground = runCompanion(harness, [
    "rescue", "--resume", "--job-id", initialLaunch.jobId, "second"
  ]);
  assert.equal(foreground.status, 0, foreground.stderr);
  const foregroundPayload = JSON.parse(foreground.stdout);
  assert.equal(foregroundPayload.status, "completed");
  assert.equal(foregroundPayload.output, "PASS");
  const foregroundInvocation = readInvocations(harness).find((entry) =>
    entry.args.includes("--resume") &&
    Buffer.from(entry.stdinBase64, "base64").toString("utf8") === "second"
  );
  assert.ok(foregroundInvocation);
  assert.deepEqual(
    foregroundInvocation.args.slice(
      foregroundInvocation.args.indexOf("--resume"),
      foregroundInvocation.args.indexOf("--resume") + 2
    ),
    ["--resume", SESSION_ID]
  );
  assert.deepEqual(
    foregroundInvocation.args.slice(
      foregroundInvocation.args.indexOf("--output-format"),
      foregroundInvocation.args.indexOf("--output-format") + 2
    ),
    ["--output-format", "json"]
  );
  assert.equal(foregroundInvocation.args.includes("second"), false);
  const resumed = runCompanion(harness, [
    "rescue", "--background", "--resume", "--job-id", foregroundPayload.jobId, "third"
  ]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedPayload = JSON.parse(resumed.stdout);
  assert.notEqual(resumedPayload.jobId, initialLaunch.jobId);
  assert.notEqual(resumedPayload.jobId, foregroundPayload.jobId);
  const resumedJob = waitForJob(harness, resumedPayload.jobId, (job) => job.lifecycleState === "completed");
  assert.equal(resumedJob.resumeSessionId, SESSION_ID);
});

supervisedTest("foreground resume rejects missing, malformed and mismatched provider identity", () => {
  const cases = [
    {
      name: "missing",
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "missing" })
    },
    { name: "malformed", stdout: "{not-json" },
    {
      name: "mismatched",
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "mismatched",
        session_id: "123e4567-e89b-42d3-a456-426614174001"
      })
    }
  ];
  for (const candidate of cases) {
    const harness = makeHarness();
    const initial = JSON.parse(runCompanion(harness, ["advise", "--background", "first"]).stdout);
    waitForJob(harness, initial.jobId, (job) => job.lifecycleState === "completed");
    fs.writeFileSync(harness.scenarioFile, JSON.stringify({
      ...harness.scenario,
      stdoutBase64: Buffer.from(candidate.stdout).toString("base64")
    }), "utf8");
    const resumed = runCompanion(harness, [
      "rescue", "--resume", "--job-id", initial.jobId, `second-${candidate.name}`
    ]);
    assert.equal(resumed.status, 1, resumed.stderr);
    const payload = JSON.parse(resumed.stdout);
    assert.equal(payload.status, "failed", candidate.name);
    assert.equal(payload.output, "Claude returned an invalid resumed result envelope.", candidate.name);
    const job = readJob(harness, payload.jobId);
    assert.equal(job.status, "failed", candidate.name);
    assert.equal(job.resultSource, undefined, candidate.name);
    assert.equal(job.resumeSessionId, undefined, candidate.name);
  }
});

supervisedTest("supervised resume fails closed when the provider changes the canonical session id", () => {
  const harness = makeHarness();
  const initial = JSON.parse(runCompanion(harness, ["advise", "--background", "first"]).stdout);
  waitForJob(harness, initial.jobId, (job) => job.lifecycleState === "completed");
  const changedId = "123e4567-e89b-42d3-a456-426614174001";
  const changedScenario = {
    ...harness.scenario,
    sessionId: changedId,
    stdoutBase64: Buffer.from(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "changed",
      session_id: changedId
    })).toString("base64")
  };
  fs.writeFileSync(harness.scenarioFile, JSON.stringify(changedScenario), "utf8");
  const resumed = JSON.parse(runCompanion(harness, [
    "rescue", "--background", "--resume", "--job-id", initial.jobId, "second"
  ]).stdout);
  const failed = waitForJob(harness, resumed.jobId, (job) => job.lifecycleState === "failed");
  assert.equal(failed.failureClassification, "invalid-result");
  assert.equal(Object.hasOwn(failed, "result"), false);
});

test("legacy records are read only when authority was already durable and are never resumed", () => {
  const harness = makeHarness();
  const stateDir = resolveStateDir(fs.realpathSync(harness.repo), harness.env, harness.stateRoot);
  saveState(stateDir, {
    version: 1,
    capabilities: null,
    jobs: [
      {
        id: "legacy-complete",
        status: "completed",
        result: "legacy durable",
        resultState: "available",
        resultAuthoritativeAt: "2026-08-18T00:00:00.000Z",
        resultSource: "encoded-v1",
        resumeSessionId: SESSION_ID
      },
      { id: "legacy-active", status: "running", lifecycleId: "old-bg", resultState: "unavailable" }
    ]
  }, { pathBoundary: harness.stateRoot });
  const complete = JSON.parse(runCompanion(harness, ["result", "legacy-complete"]).stdout);
  assert.equal(complete.result, "legacy durable");
  const active = JSON.parse(runCompanion(harness, ["result", "legacy-active"]).stdout);
  assert.equal(active.result, null);
  assert.equal(active.resultState, "unavailable");
  const resumed = runCompanion(harness, ["rescue", "--resume", "--job-id", "legacy-complete", "continue"]);
  assert.notEqual(resumed.status, 0);
  assert.match(resumed.stderr, /not validated from a provider JSON result/);
  assert.equal(readInvocations(harness).some((entry) => entry.args.includes("--resume")), false);
});
