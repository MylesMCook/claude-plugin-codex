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

const companion = fileURLToPath(new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url));
const sessionId = "11111111-1111-4111-8111-111111111111";
const threadId = "nonreview-failure-exit-test";
const successText = "Synthetic task completed without a findings schema.";

function fixture(t, { kind, resumed, write, outcome }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-nonreview-exit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const stateRoot = path.join(root, "state");
  const invocationLog = path.join(root, "invocations.jsonl");
  for (const directory of [repo, bin, home]) fs.mkdirSync(directory);
  const env = {
    ...isolatedClaudeEnv(root, path.join(bin, fakeClaudeName)),
    TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CODEX_THREAD_ID: threadId
  };
  execFileSync("git", ["init", "-q"], { cwd: repo, env });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd: repo, env });
  writeFakeClaude(path.join(bin, fakeClaudeName), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ args, stdin: fs.readFileSync(0, "utf8") }) + "\\n");
const outcome = ${JSON.stringify(outcome)};
if (outcome === "nonzero" || outcome === "maxturn") {
  fs.writeSync(2, outcome === "maxturn" ? "Claude hit the max-turn limit" : "Synthetic provider failure");
  process.exit(outcome === "maxturn" ? 1 : 7);
}
if (outcome === "malformed") fs.writeSync(1, "not a JSON envelope");
else if (args.includes("--resume")) fs.writeSync(1, JSON.stringify({
  type: "result", subtype: "success", is_error: outcome === "error-envelope",
  session_id: outcome === "wrong-session" ? "22222222-2222-4222-8222-222222222222" : ${JSON.stringify(sessionId)},
  result: ${JSON.stringify(successText)}
}));
else fs.writeSync(1, ${JSON.stringify(successText)});
`, { mode: 0o700 });
  const stateDir = resolveStateDir(fs.realpathSync(repo), env);
  const source = resumed ? {
    id: `source-${kind}`, kind, status: "completed", write,
    codexThreadId: threadId, result: "Synthetic source task",
    resultSource: "provider-json", resumeSessionId: sessionId
  } : null;
  saveState(stateDir, { version: STATE_VERSION, capabilities: null, jobs: source ? [source] : [] });
  return {
    source,
    jobs: () => JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs,
    invocations: () => fs.readFileSync(invocationLog, "utf8").trim().split("\n").map(JSON.parse),
    invoke(json) {
      const result = spawnSync(process.execPath, [
        companion, kind, "Synthetic task", "--no-background-fallback",
        ...(source ? ["--resume", "--job-id", source.id] : []),
        ...(write ? ["--write"] : []), ...(json ? ["--json"] : [])
      ], { cwd: repo, env, encoding: "utf8", timeout: fixtureTimeoutMs });
      assert.equal(result.error, undefined, "the command must terminate within the test deadline");
      assert.equal(result.signal, null);
      return result;
    }
  };
}

function verifyCase(t, { kind, resumed, outcome, json, write = false }) {
  const f = fixture(t, { kind, resumed, outcome, write });
  const response = f.invoke(json);
  const failed = outcome !== "success";
  assert.equal(response.status, failed ? 1 : 0, response.stdout);
  assert.equal(response.stderr, "", "returned failures retain the existing normal output channel");
  const jobs = f.jobs();
  assert.equal(jobs.length, resumed ? 2 : 1);
  if (resumed) assert.deepEqual(jobs.find((job) => job.id === f.source.id), f.source);
  const job = jobs.find((candidate) => candidate.id !== f.source?.id);
  assert.equal(job.kind, kind);
  assert.equal(job.write, write);
  assert.equal(job.status, failed ? "failed" : "completed");
  for (const field of ["supervisorPid", "workerPid", "lifecycleVersion"]) {
    assert.equal(job[field], undefined, "a returned foreground failure must not launch background work");
  }

  const expectedOutput = outcome === "nonzero"
    ? "Claude command failed with status 7."
    : outcome === "maxturn"
      ? "Claude hit the max-turn limit. Rerun with `--max-turns <higher>` or narrow the task."
      : failed ? "Claude returned an invalid resumed result envelope." : successText;
  const expectedDiagnostic = outcome === "nonzero"
    ? "Claude command returned non-zero status 7."
    : outcome === "maxturn" ? "Claude hit the max-turn limit."
      : failed ? "Claude returned an invalid resumed result envelope." : null;
  assert.equal(job.result, expectedOutput);
  assert.equal(job.failureDiagnostic, expectedDiagnostic);
  assert.equal(job.resultSource, resumed && !failed ? "provider-json" : undefined);
  assert.equal(job.resultState, resumed && !failed ? "available" : undefined);
  if (resumed && !failed) {
    assert.equal(job.resumeSessionId, sessionId);
    assert.equal(job.canonicalSessionId, sessionId);
    assert.ok(Number.isFinite(Date.parse(job.resultAuthoritativeAt)));
  }
  if (json) {
    assert.deepEqual(JSON.parse(response.stdout), {
      jobId: job.id, status: job.status, claudeSessionId: null, output: expectedOutput
    });
  } else {
    assert.equal(response.stdout, failed
      ? `Claude job ${job.id} failed.\n${expectedOutput}\n`
      : `${expectedOutput}\n`);
  }
  const calls = f.invocations();
  assert.equal(calls.length, 1, "non-review failure must not gain a review retry");
  const [{ args, stdin }] = calls;
  assert.equal(stdin, "Synthetic task");
  assert.equal(args.includes("--resume"), resumed);
  if (resumed) assert.equal(args[args.indexOf("--resume") + 1], sessionId);
  assert.equal(args[args.indexOf("--output-format") + 1], resumed ? "json" : "text");
  assert.equal(args[args.indexOf("--permission-mode") + 1], write ? "default" : "plan");
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
  assert.equal(args.includes("--model"), false);
}

for (const kind of ["advise", "do", "rescue"]) {
  for (const resumed of [false, true]) {
    const outcomes = ["success", "nonzero", "maxturn", ...(resumed ? ["malformed", "wrong-session", "error-envelope"] : [])];
    for (const outcome of outcomes) {
      for (const json of [true, false]) {
        test(`${kind} ${resumed ? "resumed" : "fresh"} ${outcome} preserves ${json ? "JSON" : "plain"} output and reports the task exit status`, (t) => {
          verifyCase(t, { kind, resumed, outcome, json });
        });
      }
    }
  }
}

for (const resumed of [false, true]) {
  for (const outcome of ["success", "nonzero"]) {
    test(`do --write ${resumed ? "resumed" : "fresh"} ${outcome} retains explicit write authority and task exit status`, (t) => {
      verifyCase(t, { kind: "do", resumed, outcome, json: true, write: true });
    });
  }
}
