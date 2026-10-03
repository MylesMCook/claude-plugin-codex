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

const companion = fileURLToPath(new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url));
const sessionId = "11111111-1111-4111-8111-111111111111";
const otherSessionId = "22222222-2222-4222-8222-222222222222";
const threadId = "review-resume-authority-test";
const privateText = "SYNTHETIC_PRIVATE_STORED_REVIEW";
const payload = {
  findings: [{ severity: "MAJOR", title: "Gap", fact: "Validation is missing.", recommendation: "Validate the result." }]
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const stateRoot = path.join(root, "state");
  const invocationLog = path.join(root, "invocations.jsonl");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd: repo });
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ args, stdin }) + "\\n");
process.stdout.write(${JSON.stringify(JSON.stringify({
    type: "result", subtype: "success", is_error: false, session_id: sessionId, result: JSON.stringify(payload)
  }))});
`, { mode: 0o755 });
  const env = {
    ...isolatedClaudeEnv(root, path.join(bin, "claude")),
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CODEX_THREAD_ID: threadId
  };
  const stateDir = resolveStateDir(fs.realpathSync(repo), env);
  const stateFile = path.join(stateDir, "state.json");
  const seed = (job) => saveState(stateDir, {
    version: STATE_VERSION, capabilities: null, jobs: Array.isArray(job) ? job : [job]
  });
  const invoke = (args) => {
    const response = spawnSync(process.execPath, [companion, ...args, "--json"], {
      cwd: repo, env, encoding: "utf8", timeout: 5000
    });
    assert.equal(response.error, undefined, "the command must finish within the test deadline");
    assert.equal(response.signal, null);
    return response;
  };
  const invocations = () => fs.existsSync(invocationLog)
    ? fs.readFileSync(invocationLog, "utf8").trim().split("\n").map(JSON.parse)
    : [];
  const snapshot = () => {
    const files = {};
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          files[`${path.relative(stateRoot, file)}/`] = null;
          visit(file);
        }
        else files[path.relative(stateRoot, file)] = fs.readFileSync(file);
      }
    };
    visit(stateRoot);
    return files;
  };
  const jobs = () => JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
  return { seed, invoke, invocations, snapshot, jobs };
}

function currentJob(kind, patch = {}) {
  return {
    id: `source-${kind}`, kind, status: "completed", write: false, codexThreadId: threadId,
    result: payload, resultState: "available", resultSource: "provider-json",
    resultAuthoritativeAt: "2026-01-01T00:00:00.000Z",
    resumeSessionId: sessionId, canonicalSessionId: sessionId, claudeSessionId: sessionId,
    ...patch
  };
}

function historicalJob(kind, patch = {}) {
  const { claudeSessionId, ...base } = currentJob(kind);
  void claudeSessionId;
  return {
    ...base,
    recordVersion: SUPERVISED_RECORD_VERSION, transport: SUPERVISED_TRANSPORT,
    stateGeneration: 3, lifecycleState: "completed", authority: "read",
    lifecycleId: "supervisor-33333333-3333-4333-8333-333333333333",
    cleanupStatus: "verified",
    supervisor: { token: "44444444-4444-4444-8444-444444444444", pid: null },
    result: JSON.stringify(payload),
    terminalAt: "2026-01-01T00:00:00.000Z",
    notice: "Foreground Claude timed out; launched a background job.",
    fallbackFromJobId: `timed-out-${kind}`, fallbackReason: "foreground-timeout",
    ...patch
  };
}

const recordKinds = { current: currentJob, historical: historicalJob };

function resumeArgs(command, job, explicit, extra = []) {
  return [command, "Synthetic follow-up", "--resume", ...(explicit ? ["--job-id", job.id] : []), ...extra];
}

function assertRejected(f, args, diagnostic = /not validated from a provider JSON result|validated review authority/) {
  const before = f.snapshot();
  const response = f.invoke(args);
  assert.equal(response.status, 1, response.stdout);
  assert.match(response.stderr, diagnostic);
  assert.equal(`${response.stdout}${response.stderr}`.includes(privateText), false);
  assert.equal(f.invocations().length, 0, "unsupported authority must fail before any provider invocation");
  assert.deepEqual(f.snapshot(), before, "all stored evidence must remain byte-identical, without a new job or launch artefact");
}

for (const kind of ["review", "adversarial-review"]) {
  for (const [recordKind, makeJob] of Object.entries(recordKinds)) {
    test(`${kind} resume discovery reports ${recordKind} availability only for validated review authority`, async (t) => {
      const f = fixture(t);
      const cases = {
        "malformed findings": { result: recordKind === "current"
          ? { findings: [{ severity: "SEVERE", title: privateText }] }
          : JSON.stringify({ findings: [{ severity: "SEVERE", title: privateText }] }) },
        "missing provenance": { resultAuthoritativeAt: undefined },
        "conflicting provenance": { canonicalSessionId: otherSessionId },
        "valid authority": {}
      };
      for (const [name, patch] of Object.entries(cases)) {
        await t.test(name, () => {
          const job = makeJob(kind, patch);
          const older = currentJob(kind, { id: `older-${kind}` });
          f.seed([job, older]);
          const before = f.snapshot();
          const response = f.invoke(["resume-candidate"]);
          assert.equal(response.status, 0, response.stderr);
          const discovery = JSON.parse(response.stdout);
          const valid = name === "valid authority";
          assert.equal(discovery.available, valid);
          assert.equal(discovery.candidate.id, job.id, "discovery must retain the selected source without falling back to an older job");
          assert.deepEqual(discovery.candidates, []);
          if (valid) {
            assert.deepEqual(discovery.candidate.result, payload);
            assert.equal(discovery.candidate.resultState, "available");
          } else {
            assert.equal(discovery.candidate.result, null);
            assert.equal(discovery.candidate.resultState, "unavailable");
            assert.match(discovery.candidate.resultDiagnostic, /validated review authority is missing/);
            assert.equal(Object.hasOwn(discovery.candidate, "resumeSessionId"), false);
          }
          assert.equal(`${response.stdout}${response.stderr}`.includes(privateText), false);
          assert.equal(f.invocations().length, 0, "discovery must not invoke the provider");
          assert.deepEqual(f.snapshot(), before, "discovery must preserve all stored evidence byte for byte");
        });
      }
    });

    test(`${kind} rejects unsupported ${recordKind} authority through explicit and implicit foreground resume`, async (t) => {
      const f = fixture(t);
      const defects = {
        "malformed findings": { result: recordKind === "current"
          ? { findings: [{ severity: "SEVERE", title: privateText }] }
          : JSON.stringify({ findings: [{ severity: "SEVERE", title: privateText }] }) },
        "unvalidated prose": { result: privateText },
        "missing availability": { resultState: undefined },
        "missing timestamp": { resultAuthoritativeAt: undefined },
        "invalid timestamp": { resultAuthoritativeAt: "not-a-date" },
        "missing source": { resultSource: undefined },
        "missing canonical identity": { canonicalSessionId: undefined },
        "conflicting identity": { canonicalSessionId: otherSessionId },
        "noncanonical resume identity": { resumeSessionId: "session-name" },
        "failure metadata": { failureClassification: "invalid-result" },
        ...(recordKind === "current"
          ? {
              "missing provider identity": { claudeSessionId: undefined },
              "failed lifecycle with completed status": { lifecycleState: "failed" },
              "failed status with completed lifecycle": { status: "failed", lifecycleState: "completed" },
              "private failure diagnostic": { failureDiagnostic: privateText },
              "private result diagnostic": { resultDiagnostic: privateText }
            }
          : {
              "failed historical lifecycle": { status: "failed", lifecycleState: "failed" },
              "ambiguous historical findings": { result: `${JSON.stringify(payload)}\n{"findings":[]}\n${privateText}` }
            })
      };
      for (const [name, patch] of Object.entries(defects)) {
        for (const explicit of [true, false]) {
          await t.test(`${name}, ${explicit ? "explicit" : "implicit"}`, () => {
            const job = makeJob(kind, patch);
            f.seed(job);
            assertRejected(f, resumeArgs(kind, job, explicit));
          });
        }
      }
    });

    test(`${kind} accepts validated ${recordKind} authority through explicit and implicit foreground resume`, async (t) => {
      for (const explicit of [true, false]) {
        await t.test(explicit ? "explicit" : "implicit", (t) => {
          const f = fixture(t);
          const job = makeJob(kind, recordKind === "historical"
            ? { result: `${privateText}\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nDone.` }
            : {});
          f.seed(job);
          const stored = f.jobs()[0];
          const response = f.invoke(resumeArgs(kind, job, explicit));
          assert.equal(response.status, 0, response.stderr);
          assert.deepEqual(JSON.parse(response.stdout).result, payload);
          assert.equal(f.jobs().length, 2);
          assert.deepEqual(f.jobs().find((candidate) => candidate.id === job.id), stored, "resuming must preserve the original source job");
          const calls = f.invocations();
          assert.equal(calls.length, 1);
          const { args, stdin } = calls[0];
          assert.equal(args[args.indexOf("--resume") + 1], sessionId);
          assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
          assert.equal(args[args.indexOf("--output-format") + 1], "json");
          assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
          assert.equal(args.includes("--model"), false);
          assert.equal(`${stdin}${response.stdout}${response.stderr}`.includes(privateText), false);
        });
      }
    });

    test(`${kind} preserves ${recordKind} write restrictions while accepting explicit write authority`, async (t) => {
      for (const explicit of [true, false]) {
        await t.test(explicit ? "explicit" : "implicit", (t) => {
          const f = fixture(t);
          const job = makeJob(kind, { write: true, authority: "write" });
          f.seed(job);
          const stored = f.jobs()[0];
          assertRejected(f, resumeArgs("do", job, explicit), /write-capable Claude session from a read-only command/);
          const response = f.invoke(resumeArgs("do", job, explicit, ["--write"]));
          assert.equal(response.status, 0, response.stderr);
          const [call] = f.invocations();
          assert.equal(f.invocations().length, 1);
          assert.equal(call.args[call.args.indexOf("--resume") + 1], sessionId);
          assert.equal(call.args[call.args.indexOf("--permission-mode") + 1], "default");
          assert.deepEqual(f.jobs().find((candidate) => candidate.id === job.id), stored);
          assert.equal(f.jobs().find((candidate) => candidate.id === JSON.parse(response.stdout).jobId).write, true);
        });
      }
    });

    test(`${kind} rejects invalid ${recordKind} sources in the shared background resolver`, { skip: process.platform !== "darwin" }, async (t) => {
      const f = fixture(t);
      for (const explicit of [true, false]) {
        await t.test(explicit ? "explicit" : "implicit", () => {
          const job = makeJob(kind, { result: privateText });
          f.seed(job);
          // A task destination must validate the source review kind too. The
          // rejection occurs before detached supervisor or provider creation.
          assertRejected(f, resumeArgs("advise", job, explicit, ["--background"]));
        });
      }
    });
  }

  test(`${kind} keeps failed current reviews unavailable for explicit and implicit resume`, (t) => {
    const f = fixture(t);
    const job = currentJob(kind, {
      status: "failed", result: null, resultState: "unavailable", resultSource: undefined,
      resultAuthoritativeAt: undefined, resumeSessionId: undefined, canonicalSessionId: undefined,
      claudeSessionId: undefined, failureClassification: "invalid-result"
    });
    f.seed(job);
    for (const explicit of [true, false]) {
      assertRejected(f, resumeArgs(kind, job, explicit), /not validated from a provider JSON result|validated review authority|No safe Claude job/);
    }
  });

  test(`${kind} invalid authority cannot be bypassed by requesting a write-capable task`, (t) => {
    const f = fixture(t);
    const job = currentJob(kind, { write: true, result: privateText });
    f.seed(job);
    assertRejected(f, resumeArgs("do", job, true, ["--write"]));
  });

  test(`${kind} implicit resume rejects its selected invalid source without falling back to an older valid job`, (t) => {
    const f = fixture(t);
    const invalid = currentJob(kind, { result: privateText });
    const older = currentJob(kind, { id: `older-${kind}`, resumeSessionId: otherSessionId,
      canonicalSessionId: otherSessionId, claudeSessionId: otherSessionId });
    f.seed([invalid, older]);
    assertRejected(f, resumeArgs("advise", invalid, false));
  });
}

test("ordinary non-review resume retains its existing completed-lifecycle semantics", (t) => {
  const f = fixture(t);
  const job = {
    id: "ordinary-task", kind: "advise", status: "failed", lifecycleState: "completed",
    write: false, codexThreadId: threadId, result: "ordinary text",
    resultSource: "provider-json", resumeSessionId: sessionId
  };
  f.seed(job);
  const response = f.invoke(resumeArgs("advise", job, true));
  assert.equal(response.status, 0, response.stderr);
  assert.equal(f.invocations().length, 1);
  const { args } = f.invocations()[0];
  assert.equal(args[args.indexOf("--resume") + 1], sessionId);
});

test("ordinary non-review resume discovery requires resolver authority without adding review provenance", async (t) => {
  const f = fixture(t);
  for (const status of ["completed", "failed", "cancelled", "timed_out"]) {
    await t.test(status, () => {
      const job = {
        id: "ordinary-discovery", kind: "advise", status, write: false,
        codexThreadId: threadId, resumeSessionId: sessionId, resultSource: "provider-json", result: "ordinary text"
      };
      f.seed(job);
      const before = f.snapshot();
      const response = f.invoke(["resume-candidate"]);
      assert.equal(response.status, 0, response.stderr);
      assert.deepEqual(JSON.parse(response.stdout), { available: status === "completed", candidate: job, candidates: [] });
      assert.equal(f.invocations().length, 0);
      assert.deepEqual(f.snapshot(), before);
    });
  }
});
