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
const otherSessionId = "22222222-2222-4222-8222-222222222222";
const threadId = "legacy-review-readback-test";
const privateText = "SYNTHETIC_PRIVATE_LEGACY_REVIEW_TEXT";
const payload = {
  findings: [{ severity: "MAJOR", title: "Gap", fact: "The result needs validation.", recommendation: "Validate the result." }]
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-legacy-readback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const invocationLog = path.join(root, "invocations.jsonl");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd: repo });
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + "\\n");
process.stdout.write(${JSON.stringify(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: JSON.stringify(payload) }))});
`, { mode: 0o755 });
  const env = {
    ...isolatedClaudeEnv(root, path.join(bin, "claude")),
    CLAUDE_COMPANION_STATE_ROOT: path.join(root, "state"),
    CODEX_THREAD_ID: threadId
  };
  const stateDir = resolveStateDir(fs.realpathSync(repo), env);
  const stateFile = path.join(stateDir, "state.json");
  const invoke = (args, json = true) => {
    const response = spawnSync(process.execPath, [companion, ...args, ...(json ? ["--json"] : [])], {
      cwd: repo, env, encoding: "utf8", timeout: 5000
    });
    assert.equal(response.error, undefined, "readback must terminate within the test deadline");
    assert.equal(response.signal, null);
    return response;
  };
  const seed = (job) => saveState(stateDir, { version: STATE_VERSION, capabilities: null, jobs: [job] });
  const bytes = () => fs.readFileSync(stateFile);
  const invocations = () => fs.existsSync(invocationLog)
    ? fs.readFileSync(invocationLog, "utf8").trim().split("\n").map(JSON.parse)
    : [];
  return { invoke, seed, bytes, invocations };
}

function currentJob(kind, patch = {}) {
  return {
    id: `stored-${kind}`, kind, status: "completed", write: false, codexThreadId: threadId,
    result: payload, resultState: "available", resultSource: "provider-json",
    resultAuthoritativeAt: "2026-01-01T00:00:00.000Z",
    resumeSessionId: sessionId, canonicalSessionId: sessionId, claudeSessionId: sessionId,
    ...patch
  };
}

function historicalSupervisedJob(kind, patch = {}) {
  // The earlier foreground timeout fallback retained the review kind when it
  // launched supervised print mode. Its terminal producer stored a string
  // result and canonical/resume IDs, without a foreground claudeSessionId.
  return {
    id: `supervised-${kind}`,
    recordVersion: SUPERVISED_RECORD_VERSION,
    transport: SUPERVISED_TRANSPORT,
    stateGeneration: 3,
    lifecycleState: "completed",
    status: "completed",
    kind,
    authority: "read",
    write: false,
    codexThreadId: threadId,
    lifecycleId: "supervisor-33333333-3333-4333-8333-333333333333",
    resultState: "available",
    cleanupStatus: "verified",
    resumeSessionId: sessionId,
    canonicalSessionId: sessionId,
    resumedFromJobId: null,
    notice: "Foreground Claude timed out; launched a background job.",
    fallbackFromJobId: `timed-out-${kind}`,
    fallbackReason: "foreground-timeout",
    supervisor: { token: "44444444-4444-4444-8444-444444444444", pid: null },
    result: JSON.stringify(payload),
    resultSource: "provider-json",
    resultAuthoritativeAt: "2026-01-01T00:00:00.000Z",
    terminalAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2025-12-31T23:59:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch
  };
}

function readJson(f, args) {
  const response = f.invoke(args);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(`${response.stdout}${response.stderr}`.includes(privateText), false, "private historical evidence must not appear in readback");
  return JSON.parse(response.stdout);
}

function assertUnavailableJob(job) {
  assert.notEqual(job.status, "completed");
  assert.notEqual(job.lifecycleState, "completed");
  assert.equal(job.resultState, "unavailable");
  assert.equal(job.result, null);
  assert.equal(Boolean(job.resultAuthoritativeAt), false);
  assert.equal(Boolean(job.resultSource), false);
}

function assertUnavailableSurfaces(f, job, { human = false } = {}) {
  const before = f.bytes();
  const results = readJson(f, ["result", job.id]);
  assertUnavailableJob(results.job);
  assert.equal(results.resultState, "unavailable");
  assert.equal(results.result, null);
  assert.equal(typeof results.diagnostic, "string");
  assert.ok(results.diagnostic.length > 0);

  for (const args of [["status", job.id], ["status"]]) {
    const status = readJson(f, args);
    assertUnavailableJob(status.job);
    assert.notEqual(status.live.lifecycleState, "completed");
    assert.equal(status.live.result.state, "unavailable");
  }

  const candidates = readJson(f, ["resume-candidate"]);
  const listed = candidates.candidate ? [candidates.candidate] : candidates.candidates;
  assert.equal(listed.length, 1);
  assertUnavailableJob(listed[0]);

  const monitorCommands = [
    ["monitor", job.id], ["status", job.id, "--watch"], ["status", job.id, "--follow"]
  ];
  for (const args of monitorCommands) {
    const snapshot = readJson(f, [...args, "--max-checks", "1", "--interval-ms", "0"]);
    assert.notEqual(snapshot.lifecycleState, "completed");
    assert.equal(snapshot.completed, false);
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.result.state, "unavailable");
  }
  assert.notEqual(readJson(f, ["cancel", job.id]).status, "completed");

  if (human) {
    for (const args of [["result", job.id], ["status", job.id], ["resume-candidate"], ...monitorCommands]) {
      const response = f.invoke([...args, "--max-checks", "1", "--interval-ms", "0"], false);
      assert.equal(response.status, 0, response.stderr);
      assert.equal(`${response.stdout}${response.stderr}`.includes(privateText), false);
    }
  }
  assert.deepEqual(f.bytes(), before, "readback must preserve the original stored evidence byte for byte");
}

for (const kind of ["review", "adversarial-review"]) {
  test(`${kind} redacts historical supervised fallback results without changing terminal evidence`, async (t) => {
    const f = fixture(t);
    const defects = {
      "arbitrary text": { result: privateText },
      "prose without findings": { result: `${privateText}: I will inspect the code.` },
      "ambiguous findings": { result: `${JSON.stringify(payload)}\n${JSON.stringify({ findings: [] })}\n${privateText}` },
      "invalid finding schema": { result: JSON.stringify({ findings: [{ severity: "SEVERE", title: privateText }] }) },
      "missing canonical identity": { canonicalSessionId: undefined },
      "missing resume identity": { resumeSessionId: undefined },
      "conflicting identity": { canonicalSessionId: otherSessionId },
      "noncanonical identity": { canonicalSessionId: "session-name", resumeSessionId: "session-name" },
      "missing timestamp": { resultAuthoritativeAt: undefined },
      "missing source": { resultSource: undefined },
      "unavailable result": { resultState: "unavailable" },
      "failed lifecycle": { status: "failed", lifecycleState: "failed", failureClassification: "invalid-result" },
      "cancelled lifecycle": { status: "cancelled", lifecycleState: "cancelled", failureClassification: "cancellation" }
    };
    for (const [name, patch] of Object.entries(defects)) {
      await t.test(name, () => {
        const job = historicalSupervisedJob(kind, patch);
        f.seed(job);
        assertUnavailableSurfaces(f, job, { human: name === "arbitrary text" });
        if (name === "cancelled lifecycle") {
          assert.equal(readJson(f, ["status", job.id]).job.status, "cancelled");
          assert.equal(readJson(f, ["cancel", job.id]).status, "cancelled");
        }
        assert.equal(f.invocations().length, 0, "terminal review readback must not invoke a provider or supervisor");
      });
    }
  });

  test(`${kind} reads validated historical supervised fallback strings as findings only`, async (t) => {
    const f = fixture(t);
    const content = JSON.stringify(payload);
    const forms = {
      plain: content,
      fenced: `${privateText}\n\`\`\`json\n${content}\n\`\`\`\nDone.`,
      prose: `${privateText}\n${content}\nDone.`
    };
    for (const [name, result] of Object.entries(forms)) {
      await t.test(name, () => {
        const job = historicalSupervisedJob(kind, { result });
        f.seed(job);
        const before = f.bytes();
        const published = readJson(f, ["result", job.id]);
        assert.equal(published.resultState, "available");
        assert.equal(published.diagnostic, null);
        assert.deepEqual(published.result, payload);
        assert.deepEqual(published.job.result, payload);
        assert.equal(published.job.status, "completed");
        assert.equal(Object.hasOwn(published.job, "supervisor"), false);
        assert.equal(published.job.resumeSessionId, sessionId);
        const status = readJson(f, ["status", job.id]);
        assert.equal(status.live.completed, true);
        assert.deepEqual(status.job.result, payload);
        assert.deepEqual(status.live.result.result, payload);
        const candidate = readJson(f, ["resume-candidate"]).candidate;
        assert.equal(candidate.id, job.id);
        assert.deepEqual(candidate.result, payload);
        for (const args of [["monitor", job.id], ["status", job.id, "--watch"], ["status", job.id, "--follow"]]) {
          const snapshot = readJson(f, [...args, "--max-checks", "1", "--interval-ms", "0"]);
          assert.equal(snapshot.lifecycleState, "completed");
          assert.equal(snapshot.completed, true);
          assert.equal(snapshot.available, true);
          assert.deepEqual(snapshot.result.result, payload);
        }
        assert.equal(readJson(f, ["cancel", job.id]).status, "completed");
        assert.deepEqual(f.bytes(), before, "normalisation must be a readback projection, not a stored-state rewrite");
        assert.equal(f.invocations().length, 0);
      });
    }
  });

  test(`${kind} redacts malformed legacy evidence on every public readback surface`, async (t) => {
    const f = fixture(t);
    const cases = {
      "completed without authority": { id: `legacy-${kind}`, kind, status: "completed", write: false, result: privateText },
      "old availability flags": { id: `legacy-${kind}`, kind, status: "completed", write: false, result: privateText, resultState: "available", resultAuthoritativeAt: "2026-01-01T00:00:00.000Z" },
      "plausible payload without provider proof": { id: `legacy-${kind}`, kind, status: "completed", write: false, result: payload },
      "malformed result with claimed current metadata": currentJob(kind, { result: privateText }),
      "failed result with stale completion metadata": currentJob(kind, { status: "failed", lifecycleState: "completed", result: privateText }),
      "write candidate error projection": currentJob(kind, { write: true, result: privateText })
    };
    for (const [name, seed] of Object.entries(cases)) {
      await t.test(name, () => {
        const job = { ...seed, resultDiagnostic: privateText, failureDiagnostic: privateText, failureClassification: privateText,
          claudeEnvelope: { result: privateText }, rawOutput: privateText, summary: privateText, prompt: privateText };
        f.seed(job);
        assertUnavailableSurfaces(f, job, { human: true });
        assert.equal(f.invocations().length, 0, "historical readback must never invoke Claude");
      });
    }
  });

  test(`${kind} does not infer authority from plausible JSON or partial provenance`, async (t) => {
    const f = fixture(t);
    const defects = {
      "missing source": { resultSource: undefined },
      "legacy source": { resultSource: "legacy-authoritative" },
      "missing availability": { resultState: undefined },
      "missing timestamp": { resultAuthoritativeAt: undefined },
      "empty timestamp": { resultAuthoritativeAt: "" },
      "invalid timestamp": { resultAuthoritativeAt: "not-a-date" },
      "missing provider identity": { claudeSessionId: undefined },
      "missing canonical identity": { canonicalSessionId: undefined },
      "missing resume identity": { resumeSessionId: undefined },
      "noncanonical provider identity": { claudeSessionId: "session-name" },
      "different provider identity": { claudeSessionId: otherSessionId },
      "different canonical identity": { canonicalSessionId: otherSessionId },
      "different resume identity": { resumeSessionId: otherSessionId },
      "noncompleted record": { status: "failed" },
      "conflicting lifecycle": { lifecycleState: "failed" },
      "failure classification": { failureClassification: "command-failure" },
      "failure diagnostic": { failureDiagnostic: privateText },
      "result diagnostic": { resultDiagnostic: privateText },
      "JSON string instead of validated object": { result: JSON.stringify(payload) },
      "invalid findings": { result: { findings: [{ severity: "SEVERE", title: "Gap" }] } },
      "unexpected result field": { result: { findings: [], extra: privateText } }
    };
    for (const [name, patch] of Object.entries(defects)) {
      await t.test(name, () => {
        const job = currentJob(kind, patch);
        f.seed(job);
        assertUnavailableSurfaces(f, job);
        assert.equal(f.invocations().length, 0);
      });
    }
  });

  test(`${kind} preserves explicit legacy resume rejection without invoking Claude`, (t) => {
    const f = fixture(t);
    const job = { id: `legacy-${kind}`, kind, status: "completed", write: false, result: privateText };
    f.seed(job);
    const before = f.bytes();
    const response = f.invoke([kind, "synthetic review", "--resume", "--job-id", job.id]);
    assert.equal(response.status, 1);
    assert.match(response.stderr, /not validated from a provider JSON result/);
    assert.equal(`${response.stdout}${response.stderr}`.includes(privateText), false);
    assert.equal(f.invocations().length, 0);
    assert.deepEqual(f.bytes(), before);
  });

  test(`${kind} preserves a validated provenance fixture while withholding ancillary legacy envelope data`, (t) => {
    const f = fixture(t);
    const job = currentJob(kind, {
      lifecycleState: "completed",
      claudeEnvelope: { result: `${privateText}\n${JSON.stringify(payload)}` },
      stdout: privateText,
      monitorSnapshot: { result: privateText }
    });
    f.seed(job);
    const before = f.bytes();
    const result = readJson(f, ["result", job.id]);
    assert.equal(result.resultState, "available");
    assert.deepEqual(result.result, payload);
    assert.equal(result.job.status, "completed");
    assert.equal(Object.hasOwn(result.job, "claudeEnvelope"), false);
    assert.equal(Object.hasOwn(result.job, "stdout"), false);
    assert.equal(Object.hasOwn(result.job, "monitorSnapshot"), false);
    const status = readJson(f, ["status", job.id]);
    assert.deepEqual(status.live.result.result, payload);
    assert.equal(readJson(f, ["resume-candidate"]).candidate.id, job.id);
    const monitor = readJson(f, ["monitor", job.id, "--max-checks", "1", "--interval-ms", "0"]);
    assert.equal(monitor.available, true);
    assert.deepEqual(monitor.result.result, payload);
    assert.deepEqual(f.bytes(), before);
    assert.equal(f.invocations().length, 0);
  });

  test(`${kind} preserves results produced by current validated foreground execution`, (t) => {
    const f = fixture(t);
    const run = readJson(f, [kind, "synthetic review"]);
    assert.equal(run.status, "completed");
    assert.deepEqual(run.result, payload);
    assert.equal(f.invocations().length, 1);
    const before = f.bytes();
    const result = readJson(f, ["result", run.jobId]);
    assert.equal(result.resultState, "available");
    assert.deepEqual(result.result, payload);
    assert.equal(result.job.status, "completed");
    const status = readJson(f, ["status", run.jobId]);
    assert.equal(status.live.lifecycleState, "completed");
    assert.deepEqual(status.live.result.result, payload);
    const candidate = readJson(f, ["resume-candidate"]).candidate;
    assert.equal(candidate.id, run.jobId);
    assert.equal(candidate.status, "completed");
    assert.deepEqual(candidate.result, payload);
    for (const args of [["monitor", run.jobId], ["status", run.jobId, "--watch"]]) {
      const snapshot = readJson(f, [...args, "--max-checks", "1", "--interval-ms", "0"]);
      assert.equal(snapshot.completed, true);
      assert.equal(snapshot.available, true);
      assert.deepEqual(snapshot.result.result, payload);
    }
    assert.equal(readJson(f, ["cancel", run.jobId]).status, "completed");
    assert.deepEqual(f.bytes(), before);
    assert.equal(f.invocations().length, 1, "readback of valid results must not start another provider call");
  });
}

test("ordinary foreground advice keeps its existing readback semantics", (t) => {
  const f = fixture(t);
  const job = { id: "legacy-advice", kind: "advise", status: "completed", write: false, result: "ordinary advice" };
  f.seed(job);
  const before = f.bytes();
  const result = readJson(f, ["result", job.id]);
  assert.equal(result.resultState, "available");
  assert.equal(result.result, job.result);
  assert.deepEqual(result.job, job);
  assert.deepEqual(readJson(f, ["status", job.id]).job, job);
  assert.deepEqual(readJson(f, ["resume-candidate"]).candidates, [job]);
  assert.deepEqual(f.bytes(), before);
  assert.equal(f.invocations().length, 0);
});

test("ordinary supervised advice keeps its existing string result and lifecycle projections", (t) => {
  const f = fixture(t);
  const job = historicalSupervisedJob("advise", { result: "ordinary supervised advice" });
  f.seed(job);
  const before = f.bytes();
  const { supervisor: _supervisor, ...expectedJob } = job;
  const result = readJson(f, ["result", job.id]);
  assert.equal(result.resultState, "available");
  assert.equal(result.result, job.result);
  assert.deepEqual(result.job, expectedJob);
  const status = readJson(f, ["status", job.id]);
  assert.deepEqual(status.job, expectedJob);
  assert.equal(status.live.lifecycleState, "completed");
  assert.equal(status.live.result.result, job.result);
  assert.deepEqual(readJson(f, ["resume-candidate"]).candidate, expectedJob);
  const snapshot = readJson(f, ["monitor", job.id, "--max-checks", "1", "--interval-ms", "0"]);
  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.result.result, job.result);
  assert.equal(readJson(f, ["cancel", job.id]).status, "completed");
  assert.deepEqual(f.bytes(), before);
  assert.equal(f.invocations().length, 0);
});
