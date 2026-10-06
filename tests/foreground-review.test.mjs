import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";
import { fakeClaudeName, writeFakeClaude, fixtureTimeoutMs } from "./lib/fake-claude.mjs";

import { resolveStateDir, saveState, STATE_VERSION } from "../plugins/claude-code-advisor/scripts/lib/runtime.mjs";

const companion = fileURLToPath(
  new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url)
);
const sessionId = "11111111-1111-4111-8111-111111111111";
const sentinels = ["PRIVATE_FAILED_REVIEW_OUTPUT", "PRIVATE_REVIEW_STDERR", "PRIVATE_REVIEW_PROMPT"];
const payload = {
  findings: [{ severity: "MAJOR", title: "Gap", fact: "The result lacks validation.", recommendation: "Validate before publishing." }]
};

function envelope(result = JSON.stringify(payload), extra = {}) {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result, ...extra });
}

function fixture(t, responses) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-authority-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const stateRoot = path.join(root, "state");
  const invocationLog = path.join(root, "invocations.jsonl");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"]]) {
    execFileSync("git", args, { cwd: repo });
  }
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  writeFakeClaude(path.join(bin, fakeClaudeName), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = ${JSON.stringify(invocationLog)};
const previous = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).length : 0;
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(log, JSON.stringify({ args, stdin }) + "\\n");
if (!args.includes("-p")) process.exit(90);
const responses = ${JSON.stringify(responses)};
const response = responses[Math.min(previous, responses.length - 1)];
fs.writeSync(1, response.stdoutBase64 ? Buffer.from(response.stdoutBase64, "base64") : response.stdout || "");
fs.writeSync(2, response.stderr || ${JSON.stringify(sentinels[1])});
if (response.delayMs) setTimeout(() => process.exit(response.exit || 0), response.delayMs);
else if (response.signal) process.kill(process.pid, response.signal);
else process.exit(response.exit || 0);
`);
  fs.chmodSync(path.join(bin, fakeClaudeName), 0o755);
  const env = {
    ...isolatedClaudeEnv(root, path.join(bin, fakeClaudeName)),
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CODEX_THREAD_ID: "foreground-review-authority-test"
  };
  const invoke = (args) => {
    const result = spawnSync(process.execPath, [companion, ...args, "--json"], {
      env, cwd: repo, encoding: "utf8", timeout: fixtureTimeoutMs
    });
    assert.equal(result.error, undefined, "companion must terminate within the test deadline");
    assert.equal(result.signal, null);
    return result;
  };
  const readState = () => {
    const index = fs.readdirSync(stateRoot).map((entry) => path.join(stateRoot, entry));
    assert.equal(index.length, 1);
    const stateDir = fs.readFileSync(path.join(index[0], "latest-state-dir"), "utf8").trim();
    return JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  };
  const invocations = () => fs.readFileSync(invocationLog, "utf8").trim().split("\n").map(JSON.parse);
  const seedJob = (job) => saveState(resolveStateDir(fs.realpathSync(repo), env), {
    version: STATE_VERSION, capabilities: null, jobs: [job]
  });
  return { invoke, readState, invocations, seedJob };
}

function assertRedacted(...values) {
  for (const value of values) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const sentinel of sentinels) assert.equal(text.includes(sentinel), false, "private provider or prompt text must not escape");
  }
}

function assertFailedJob(job, classification = "invalid-result") {
  assert.equal(job.status, "failed");
  assert.equal(job.resultState, "unavailable");
  assert.equal(job.result, null);
  assert.equal(job.failureClassification, classification);
  assert.equal(job.failureDiagnostic, `Claude review failed: ${classification}.`);
  assert.equal(job.resultDiagnostic, job.failureDiagnostic);
  assert.equal(Boolean(job.resultAuthoritativeAt), false);
  assert.equal(Boolean(job.resultSource), false);
  assert.equal(Boolean(job.claudeEnvelope), false);
  assert.equal(Boolean(job.claudeSessionId), false);
  assertRedacted(job);
}

function assertFailedSurfaces(f, job) {
  const result = f.invoke(["result", job.id]);
  const status = f.invoke(["status", job.id]);
  assert.equal(result.status, 0);
  assert.equal(status.status, 0);
  const published = JSON.parse(result.stdout);
  assert.equal(published.job.id, job.id);
  assert.equal(published.resultState, "unavailable");
  assert.equal(published.result, null);
  assert.equal(JSON.parse(status.stdout).live.result.state, "unavailable");
  assertRedacted(result.stdout, result.stderr, status.stdout, status.stderr);
}

function assertBoundedInvocations(f, count, expectedResume = null) {
  const invocations = f.invocations();
  assert.equal(invocations.length, count);
  for (const { args, stdin } of invocations) {
    assert.equal(args.includes("-p"), true);
    assert.equal(args.includes("--bg"), false);
    assert.equal(args.includes("--resume"), Boolean(expectedResume));
    if (expectedResume) assert.equal(args[args.indexOf("--resume") + 1], expectedResume);
    assert.equal(args.includes("--model"), false);
    assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
    assert.equal(args[args.indexOf("--output-format") + 1], "json");
    assert.equal(args.some((arg) => arg.includes(sentinels[2])), false);
    assert.equal(stdin.includes(sentinels[2]), true, "review prompt remains on stdin");
    assert.equal(stdin.includes(sentinels[0]), false, "retry must not echo the failed provider output");
    assert.equal(stdin.includes(sentinels[1]), false);
  }
  if (count === 2) assert.equal(invocations[1].args[invocations[1].args.indexOf("--max-turns") + 1], "1");
}

for (const command of ["review", "adversarial-review"]) {
  test(`${command} publishes only the validated payload from supported wrappers`, async (t) => {
    const json = JSON.stringify(payload);
    const results = {
      plain: json,
      prose: `${sentinels[0]}\n${json}\nDone.`,
      fenced: `${sentinels[0]}\n\`\`\`json\n${json}\n\`\`\`\nDone.`,
      "tool-prefixed": `<function_calls>\n<invoke name="Read"><parameter name="file_path">${sentinels[0]}</parameter></invoke>\n</function_calls>\n${json}\nDone.`
    };
    for (const [name, content] of Object.entries(results)) {
      await t.test(name, (t) => {
        const f = fixture(t, [{ stdout: envelope(content) }]);
        const run = f.invoke([command, sentinels[2]]);
        assert.equal(run.status, 0, run.stderr);
        const published = JSON.parse(run.stdout);
        const state = f.readState();
        assert.equal(state.jobs.length, 1);
        const job = state.jobs[0];
        assert.deepEqual(published, { jobId: job.id, status: "completed", result: payload });
        assert.equal(job.kind, command);
        assert.equal(job.status, "completed");
        assert.equal(job.resultState, "available");
        assert.equal(job.resultSource, "provider-json");
        assert.ok(Number.isFinite(Date.parse(job.resultAuthoritativeAt)));
        assert.deepEqual(job.result, payload);
        assert.equal(job.claudeSessionId, sessionId);
        const result = JSON.parse(f.invoke(["result", job.id]).stdout);
        const status = JSON.parse(f.invoke(["status", job.id]).stdout);
        assert.equal(result.resultState, "available");
        assert.deepEqual(result.result, payload);
        assert.equal(result.job.id, published.jobId);
        assert.equal(status.job.id, published.jobId);
        assert.deepEqual(status.live.result.result, payload);
        assertRedacted(run.stdout, run.stderr, state, result, status);
        assertBoundedInvocations(f, 1);
      });
    }
  });

  test(`${command} retries invalid output once and leaves its first attempt redacted`, (t) => {
    const f = fixture(t, [{ stdout: envelope(`${sentinels[0]}: I will inspect the files.`) }, { stdout: envelope() }]);
    const run = f.invoke([command, sentinels[2]]);
    assert.equal(run.status, 0, run.stderr);
    const published = JSON.parse(run.stdout);
    const jobs = f.readState().jobs;
    assert.equal(jobs.length, 2);
    assert.equal(new Set(jobs.map((job) => job.id)).size, 2);
    const completed = jobs.filter((job) => job.status === "completed");
    const failed = jobs.filter((job) => job.status === "failed");
    assert.equal(completed.length, 1);
    assert.equal(failed.length, 1);
    assert.equal(published.jobId, completed[0].id);
    assert.deepEqual(published.result, payload);
    assert.deepEqual(completed[0].result, payload);
    assert.equal(completed[0].resultState, "available");
    assertFailedJob(failed[0]);
    assertFailedSurfaces(f, failed[0]);
    assertRedacted(run.stdout, run.stderr, jobs);
    assertBoundedInvocations(f, 2);
  });

  test(`${command} rejects failed first and retry provider exits even when their payload is valid`, async (t) => {
    for (const attempt of ["first", "retry"]) {
      await t.test(attempt, (t) => {
        const responses = attempt === "first" ? [] : [{ stdout: envelope(sentinels[0]) }];
        responses.push({ stdout: envelope(), stderr: sentinels[1], exit: 7 });
        const f = fixture(t, responses);
        const run = f.invoke([command, sentinels[2]]);
        assert.equal(run.status, 1);
        const published = JSON.parse(run.stdout);
        assert.equal(published.status, "failed");
        assert.equal(Object.hasOwn(published, "result"), false);
        const jobs = f.readState().jobs;
        assert.equal(jobs.length, responses.length);
        const final = jobs.find((job) => job.id === published.jobId);
        assert.ok(final);
        for (const job of jobs) {
          assertFailedJob(job, job.id === final.id ? "command-failure" : "invalid-result");
          assertFailedSurfaces(f, job);
        }
        assertRedacted(run.stdout, run.stderr, jobs);
        assertBoundedInvocations(f, responses.length);
      });
    }
  });

  test(`${command} rejects malformed, incomplete and ambiguous results after two attempts`, async (t) => {
    const cases = {
      "malformed envelope": `{"result":${sentinels[0]}`,
      "plain payload without envelope": JSON.stringify(payload),
      "provider error envelope": envelope(JSON.stringify(payload), { subtype: "error_max_turns", is_error: true, errors: [sentinels[0]] }),
      "missing session identity": envelope(JSON.stringify(payload), { session_id: undefined }),
      "prose-only payload": envelope(`${sentinels[0]}: I will read the code.`),
      "ambiguous payload": envelope(`${JSON.stringify(payload)}\n${JSON.stringify({ findings: [], private: sentinels[0] })}`),
      "incomplete second JSON": envelope(`${JSON.stringify(payload)}\n{"findings":["${sentinels[0]}"`),
      "unmatched trailing close": envelope(`${sentinels[0]}\n${JSON.stringify(payload)}}`),
      "unclosed code fence": envelope(`\`\`\`json\n${JSON.stringify(payload)}\n${sentinels[0]}`),
      "unclosed tool wrapper": envelope(`<function_calls>${sentinels[0]}\n${JSON.stringify(payload)}`),
      "tool-prefixed conflicting JSON": envelope(`<function_calls>${JSON.stringify({ findings: [], private: sentinels[0] })}</function_calls>\n${JSON.stringify(payload)}`),
      "invalid finding": envelope(JSON.stringify({ findings: [{ severity: "SEVERE", title: sentinels[0] }] })),
      "unexpected payload properties": envelope(JSON.stringify({ findings: [], private: sentinels[0] })),
      "duplicate findings key": envelope(`{"findings":[{"severity":"MAJOR","title":"${sentinels[0]}"}],"findings":[]}`),
      "wrapped duplicate findings key": envelope(`\`\`\`json\n{"findings":[{"title":"${sentinels[0]}"}],"findings":[]}\n\`\`\``)
    };
    for (const [name, stdout] of Object.entries(cases)) {
      await t.test(name, (t) => {
        const f = fixture(t, [{ stdout }]);
        const run = f.invoke([command, sentinels[2]]);
        assert.equal(run.status, 1);
        const published = JSON.parse(run.stdout);
        assert.equal(published.status, "failed");
        assert.equal(Object.hasOwn(published, "result"), false);
        const jobs = f.readState().jobs;
        assert.equal(jobs.length, 2);
        assert.ok(jobs.some((job) => job.id === published.jobId));
        for (const job of jobs) {
          assertFailedJob(job);
          assertFailedSurfaces(f, job);
        }
        assertRedacted(run.stdout, run.stderr, jobs);
        assertBoundedInvocations(f, 2);
      });
    }
  });

  test(`${command} timeout fails without a retry or background fallback`, (t) => {
    const f = fixture(t, [{ stdout: envelope(sentinels[0]), delayMs: 4000 }]);
    const run = f.invoke([command, sentinels[2], "--timeout-ms", "1000"]);
    assert.equal(run.status, 1);
    const published = JSON.parse(run.stdout);
    const jobs = f.readState().jobs;
    assert.equal(jobs.length, 1);
    assert.equal(published.jobId, jobs[0].id);
    assertFailedJob(jobs[0], "timeout");
    assertFailedSurfaces(f, jobs[0]);
    assertRedacted(run.stdout, run.stderr, jobs);
    assertBoundedInvocations(f, 1);
  });

  test(`${command} rejects invalid UTF-8 before decoding the provider envelope`, (t) => {
    const valid = Buffer.from(envelope(JSON.stringify({ findings: [{ ...payload.findings[0], title: "placeholder" }] })));
    const at = valid.indexOf(Buffer.from("placeholder"));
    const raw = Buffer.concat([valid.subarray(0, at), Buffer.from([0xff]), valid.subarray(at + "placeholder".length)]);
    const f = fixture(t, [{ stdoutBase64: raw.toString("base64") }]);
    const run = f.invoke([command, sentinels[2]]);
    assert.equal(run.status, 1);
    const jobs = f.readState().jobs;
    assert.equal(jobs.length, 2);
    for (const job of jobs) {
      assertFailedJob(job);
      assertFailedSurfaces(f, job);
    }
    assertRedacted(run.stdout, run.stderr, jobs);
    assertBoundedInvocations(f, 2);
  });

  test(`${command} resumed review rejects a different canonical provider session`, (t) => {
    const differentSessionId = "22222222-2222-4222-8222-222222222222";
    const f = fixture(t, [{ stdout: envelope(JSON.stringify(payload), { session_id: differentSessionId }) }]);
    const seed = {
      id: "review-seed", kind: command, status: "completed", write: false,
      codexThreadId: "foreground-review-authority-test",
      resumeSessionId: sessionId, canonicalSessionId: sessionId, claudeSessionId: sessionId,
      result: { findings: [] }, resultState: "available", resultSource: "provider-json",
      resultAuthoritativeAt: "2026-01-01T00:00:00.000Z"
    };
    f.seedJob(seed);
    const run = f.invoke([command, sentinels[2], "--resume", "--job-id", seed.id]);
    assert.equal(run.status, 1);
    const jobs = f.readState().jobs;
    assert.equal(jobs.length, 3);
    assert.deepEqual(jobs.find((job) => job.id === seed.id), seed);
    for (const job of jobs.filter((job) => job.id !== seed.id)) {
      assertFailedJob(job);
      assertFailedSurfaces(f, job);
    }
    assertRedacted(run.stdout, run.stderr, jobs);
    assertBoundedInvocations(f, 2, sessionId);
  });
}
