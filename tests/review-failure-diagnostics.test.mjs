import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";

import {
  resolveStateDir, saveState, STATE_VERSION, SUPERVISED_RECORD_VERSION, SUPERVISED_TRANSPORT
} from "../plugins/claude-code-advisor/scripts/lib/runtime.mjs";

const companion = fileURLToPath(
  new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url)
);
const sessionId = "11111111-1111-4111-8111-111111111111";
const threadId = "recorded-review-failure-test";
const privateText = "PRIVATE_RECORDED_REVIEW_FAILURE_SENTINEL";
const generic = "Claude review result is unavailable because validated review authority is missing.";
const diagnostics = {
  "command-failure": "Claude review result is unavailable. Recorded failure metadata: the Claude command failed.",
  "invalid-result": "Claude review result is unavailable. Recorded failure metadata: the returned result failed validation.",
  timeout: "Claude review result is unavailable. Recorded failure metadata: the Claude command timed out."
};
const payload = {
  findings: [{ severity: "MAJOR", title: "Gap", fact: "The result needs validation.", recommendation: "Validate the result." }]
};

function fixture(t, response = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-recorded-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const invocationLog = path.join(root, "invocations.jsonl");
  const executionLog = path.join(root, "readback-execution.jsonl");
  const guard = path.join(root, "readback-guard.cjs");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd: repo });
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + "\\n");
const response = ${JSON.stringify(response)};
fs.writeSync(1, response.stdout || ${JSON.stringify(privateText)});
fs.writeSync(2, ${JSON.stringify(privateText)});
if (response.delayMs) setTimeout(() => process.exit(response.exit || 0), response.delayMs);
else process.exit(response.exit || 0);
`, { mode: 0o755 });
  // Readback may use Git to locate the workspace. Any provider/supervisor launch
  // or socket contact is a failure, including attempts that never reach Claude.
  fs.writeFileSync(guard, `const fs = require("node:fs");
const cp = require("node:child_process");
const net = require("node:net");
function reject(operation) {
  fs.appendFileSync(${JSON.stringify(executionLog)}, JSON.stringify(operation) + "\\n");
  throw new Error("Readback attempted provider or supervisor execution.");
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = cp[name];
  cp[name] = function(command, ...args) {
    if (command !== "git") reject(name);
    return original.call(this, command, ...args);
  };
}
net.createConnection = net.connect = () => reject("socket");
require("node:module").syncBuiltinESMExports();
`);
  const env = {
    ...isolatedClaudeEnv(root, path.join(bin, "claude")),
    CLAUDE_COMPANION_EXECUTABLE: path.join(bin, "claude"),
    CLAUDE_COMPANION_STATE_ROOT: path.join(root, "state"),
    CODEX_THREAD_ID: threadId
  };
  const stateDir = resolveStateDir(fs.realpathSync(repo), env);
  const stateFile = path.join(stateDir, "state.json");
  const invoke = (args, { json = true, readback = true } = {}) => {
    const result = spawnSync(process.execPath, [
      ...(readback ? ["--require", guard] : []), companion, ...args, ...(json ? ["--json"] : [])
    ], { cwd: repo, env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined, "readback must terminate within the test deadline");
    assert.equal(result.signal, null);
    return result;
  };
  return {
    invoke,
    seed: (jobs) => saveState(stateDir, { version: STATE_VERSION, capabilities: null, jobs: Array.isArray(jobs) ? jobs : [jobs] }),
    bytes: () => fs.readFileSync(stateFile),
    jobs: () => JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs,
    invocations: () => fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8").trim().split("\n").map(JSON.parse) : [],
    executionAttempts: () => fs.existsSync(executionLog) ? fs.readFileSync(executionLog, "utf8") : ""
  };
}

function failedJob(kind, patch = {}) {
  return {
    id: `failed-${kind}`, kind, status: "failed", write: false, codexThreadId: threadId,
    result: null, resultState: "unavailable", failureClassification: "command-failure",
    resultDiagnostic: privateText, failureDiagnostic: privateText,
    claudeEnvelope: { result: privateText }, stdout: privateText,
    ...patch
  };
}

function supervisedJob(kind, patch = {}) {
  return {
    id: `supervised-${kind}`, kind, status: "failed", lifecycleState: "failed", write: false,
    codexThreadId: threadId, authority: "read", recordVersion: SUPERVISED_RECORD_VERSION,
    transport: SUPERVISED_TRANSPORT, stateGeneration: 3, resultState: "unavailable",
    failureClassification: "invalid-result", cleanupStatus: "verified",
    lifecycleId: "supervisor-33333333-3333-4333-8333-333333333333",
    supervisor: { token: "44444444-4444-4444-8444-444444444444", pid: null },
    terminalAt: "2026-01-01T00:00:00.000Z",
    ...patch
  };
}

function assertRedacted(response) {
  assert.equal(`${response.stdout}${response.stderr}`.includes(privateText), false, "raw historical or provider text must stay redacted");
}

function readJson(f, args) {
  const response = f.invoke(args);
  assert.equal(response.status, 0, response.stderr);
  assertRedacted(response);
  return JSON.parse(response.stdout);
}

function assertUnavailable(job, diagnostic, status) {
  if (status) assert.equal(job.status, status);
  assert.notEqual(job.status, "completed");
  assert.equal(job.resultState, "unavailable");
  assert.equal(job.result, null);
  assert.equal(job.resultDiagnostic, diagnostic);
  assert.equal(job.failureDiagnostic, diagnostic);
  assert.equal(Object.hasOwn(job, "failureClassification"), false, "classifications are descriptions, never raw metadata passthrough");
  assert.equal(Boolean(job.resultSource), false);
  assert.equal(Boolean(job.resultAuthoritativeAt), false);
}

function assertReadback(f, job, diagnostic, { human = false, status = job.status, aliases = false } = {}) {
  const before = f.bytes();
  const invocations = f.invocations();
  const result = readJson(f, ["result", job.id]);
  assertUnavailable(result.job, diagnostic, status);
  assert.equal(result.diagnostic, diagnostic);
  assert.equal(result.resultState, "unavailable");
  assert.equal(result.result, null);
  for (const args of [["status", job.id], ...(aliases ? [["status"]] : [])]) {
    const snapshot = readJson(f, args);
    assertUnavailable(snapshot.job, diagnostic, status);
    assert.equal(snapshot.live.result.state, "unavailable");
    assert.equal(snapshot.live.result.reason, diagnostic);
  }
  const candidates = readJson(f, ["resume-candidate"]);
  const listed = candidates.candidate ? [candidates.candidate] : candidates.candidates;
  const candidate = listed.find((item) => item.id === job.id);
  assert.ok(candidate);
  assertUnavailable(candidate, diagnostic, status);
  const commands = [["monitor", job.id], ...(aliases ? [["status", job.id, "--watch"], ["status", job.id, "--follow"]] : [])];
  for (const args of commands) {
    const snapshot = readJson(f, [...args, "--max-checks", "1", "--interval-ms", "0"]);
    assert.equal(snapshot.completed, false);
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.result.state, "unavailable");
    assert.equal(snapshot.result.reason, diagnostic);
  }
  if (human) {
    for (const args of [["result", job.id], ["status", job.id], ["resume-candidate"], ...commands]) {
      const response = f.invoke([...args, "--max-checks", "1", "--interval-ms", "0"], { json: false });
      assert.equal(response.status, 0, response.stderr);
      assertRedacted(response);
      assert.ok(response.stdout.includes(diagnostic), `human ${args.join(" ")} must include the fixed diagnostic`);
    }
  }
  assert.deepEqual(f.bytes(), before, "readback must preserve stored evidence byte for byte");
  assert.deepEqual(f.invocations(), invocations, "readback must not invoke a provider");
  assert.equal(f.executionAttempts(), "", "readback must not launch or contact a supervisor");
}

for (const kind of ["review", "adversarial-review"]) {
  test(`${kind} retains current fake-provider failure causes across readback`, async (t) => {
    for (const [classification, response] of Object.entries({
      "command-failure": { exit: 7 },
      "invalid-result": {},
      timeout: { delayMs: 4000 }
    })) {
      await t.test(classification, (t) => {
        const f = fixture(t, response);
        const run = f.invoke([kind, "synthetic review", ...(classification === "timeout" ? ["--timeout-ms", "1000"] : [])], { readback: false });
        assert.equal(run.status, 1, run.stderr);
        assertRedacted(run);
        const published = JSON.parse(run.stdout);
        assert.equal(published.diagnostic, `Claude review failed: ${classification}.`, "immediate execution diagnostics retain existing semantics");
        const job = f.jobs().find((item) => item.id === published.jobId);
        assert.equal(job.failureClassification, classification);
        assert.equal(job.status, "failed");
        assert.equal(f.invocations().length, classification === "invalid-result" ? 2 : 1);
        assertReadback(f, job, diagnostics[classification], { human: true, aliases: true });
        const before = f.bytes();
        const resume = f.invoke([kind, "synthetic review", "--resume", "--job-id", job.id]);
        assert.equal(resume.status, 1);
        assert.match(resume.stderr, /not validated from a provider JSON result/);
        assertRedacted(resume);
        assert.deepEqual(f.bytes(), before);
        assert.equal(f.executionAttempts(), "");
      });
    }
  });

  test(`${kind} describes allowlisted historical metadata without trusting forged diagnostics`, async (t) => {
    const f = fixture(t);
    for (const classification of Object.keys(diagnostics)) {
      await t.test(classification, () => {
        const job = failedJob(kind, { failureClassification: classification });
        f.seed(job);
        assertReadback(f, job, diagnostics[classification], { human: true, aliases: true });
      });
    }
    for (const [name, patch] of Object.entries({
      "selected candidate": { resumeSessionId: sessionId },
      "write candidate error list": { resumeSessionId: sessionId, write: true },
      "explicit failed lifecycle": { lifecycleState: "failed" },
      "missing result value": { result: undefined },
      "null lifecycle and authority fields": { lifecycleState: null, resultSource: null, resultAuthoritativeAt: null }
    })) {
      await t.test(name, () => {
        const job = failedJob(kind, patch);
        f.seed(job);
        assertReadback(f, job, diagnostics["command-failure"]);
      });
    }
  });

  test(`${kind} uses the fixed fallback for missing unknown or conflicting failure metadata`, async (t) => {
    const f = fixture(t);
    const cases = {
      "missing classification": { failureClassification: undefined },
      "null classification": { failureClassification: null },
      "unknown classification": { failureClassification: privateText },
      "object classification": { failureClassification: { cause: privateText } },
      "array classification": { failureClassification: ["command-failure"] },
      "inherited property name": { failureClassification: "toString" },
      "prototype property name": { failureClassification: "__proto__" },
      "almost matching classification": { failureClassification: "timeout " },
      "missing status": { status: undefined },
      "completed status": { status: "completed" },
      "running status": { status: "running" },
      "cancelled status": { status: "cancelled" },
      "interrupted status": { status: "interrupted" },
      "timed out status": { status: "timed_out" },
      "completed lifecycle": { lifecycleState: "completed" },
      "running lifecycle": { lifecycleState: "running" },
      "empty lifecycle": { lifecycleState: "" },
      "missing result state": { resultState: undefined },
      "available result state": { resultState: "available" },
      "result with plausible findings": { result: payload },
      "raw result": { result: privateText },
      "empty result string": { result: "" },
      "claimed provider source": { resultSource: "provider-json" },
      "empty source": { resultSource: "" },
      "claimed authoritative timestamp": { resultAuthoritativeAt: "2026-01-01T00:00:00.000Z" },
      "empty authoritative timestamp": { resultAuthoritativeAt: "" }
    };
    for (const [name, patch] of Object.entries(cases)) {
      await t.test(name, () => {
        const job = failedJob(kind, patch);
        f.seed(job);
        const status = [undefined, "completed"].includes(job.status) ? "interrupted" : job.status;
        assertReadback(f, job, generic, { status, human: name === "unknown classification", aliases: name === "completed lifecycle" });
      });
    }
  });

  test(`${kind} projects terminal supervised failure metadata without supervisor execution`, async (t) => {
    const f = fixture(t);
    for (const classification of ["invalid-result", "timeout", "non-zero-exit"]) {
      await t.test(classification, () => {
        const job = supervisedJob(kind, { failureClassification: classification });
        f.seed(job);
        assertReadback(f, job, diagnostics[classification] || generic, { human: true, aliases: true });
      });
    }
    for (const [name, patch] of Object.entries({
      "cancelled lifecycle": { status: "cancelled", lifecycleState: "cancelled" },
      "interrupted lifecycle": { status: "interrupted", lifecycleState: "interrupted" },
      "stale result": { result: privateText },
      "stale available result": { resultState: "available" }
    })) {
      await t.test(name, () => {
        const job = supervisedJob(kind, patch);
        f.seed(job);
        assertReadback(f, job, generic);
      });
    }
  });

  test(`${kind} keeps valid authoritative findings available without a recorded failure label`, (t) => {
    const f = fixture(t, {
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: JSON.stringify(payload) })
    });
    const run = f.invoke([kind, "synthetic review"], { readback: false });
    assert.equal(run.status, 0, run.stderr);
    const job = f.jobs().find((item) => item.id === JSON.parse(run.stdout).jobId);
    const before = f.bytes();
    const result = readJson(f, ["result", job.id]);
    assert.equal(result.resultState, "available");
    assert.equal(result.diagnostic, null);
    assert.deepEqual(result.result, payload);
    const status = readJson(f, ["status", job.id]);
    assert.deepEqual(status.job.result, payload);
    assert.deepEqual(status.live.result.result, payload);
    const monitor = readJson(f, ["monitor", job.id, "--max-checks", "1", "--interval-ms", "0"]);
    assert.equal(monitor.available, true);
    assert.deepEqual(monitor.result.result, payload);
    assert.equal(JSON.stringify([result, status, monitor]).includes("Recorded failure metadata"), false);
    assert.deepEqual(f.bytes(), before);
    assert.equal(f.invocations().length, 1);
    assert.equal(f.executionAttempts(), "");
  });
}
