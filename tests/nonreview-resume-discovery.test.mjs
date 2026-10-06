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
const threadId = "nonreview-resume-discovery-test";
const unavailable = /Claude resume identity is unavailable because it was not validated from a provider JSON result/;

function fixture(t, currentThreadId = threadId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-nonreview-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const stateRoot = path.join(root, "state");
  const invocationLog = path.join(root, "invocations.jsonl");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd: repo });
  writeFakeClaude(path.join(bin, fakeClaudeName), `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.SYNTHETIC_PROVIDER_FAIL === "1") process.exit(1);
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
  session_id: ${JSON.stringify(sessionId)}, result: "Synthetic continuation" }));
`, { mode: 0o755 });
  const env = {
    ...isolatedClaudeEnv(root, path.join(bin, fakeClaudeName)),
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CODEX_THREAD_ID: currentThreadId,
    SYNTHETIC_PROVIDER_FAIL: "0"
  };
  const stateDir = resolveStateDir(fs.realpathSync(repo), env);
  const stateFile = path.join(stateDir, "state.json");
  const seed = (jobs) => saveState(stateDir, {
    version: STATE_VERSION, capabilities: null, jobs: Array.isArray(jobs) ? jobs : [jobs]
  });
  const invoke = (args, { json = true, environment = {} } = {}) => {
    const response = spawnSync(process.execPath, [companion, ...args, ...(json ? ["--json"] : [])], {
      cwd: repo, env: { ...env, ...environment }, encoding: "utf8", timeout: fixtureTimeoutMs
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
        } else files[path.relative(stateRoot, file)] = fs.readFileSync(file);
      }
    };
    visit(stateRoot);
    return files;
  };
  return { seed, invoke, invocations, snapshot, jobs: () => JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs };
}

function job(kind, patch = {}) {
  // Ordinary tasks need no review findings, timestamps or canonicalSessionId.
  return {
    id: `source-${kind}`, kind, status: "completed", write: false, codexThreadId: threadId,
    result: "Synthetic source", resultSource: "provider-json", resumeSessionId: sessionId,
    ...patch
  };
}

function resumeArgs(source, explicit, extra = []) {
  return [source.kind, "Synthetic continuation", "--resume", ...(explicit ? ["--job-id", source.id] : []), ...extra];
}

function discover(f, options = {}, extra = []) {
  const before = f.snapshot();
  const calls = f.invocations();
  const response = f.invoke(["resume-candidate", ...extra], options);
  assert.equal(response.status, 0, response.stderr);
  assert.deepEqual(f.invocations(), calls, "discovery must not invoke a provider");
  assert.deepEqual(f.snapshot(), before, "discovery must leave every state and source evidence byte unchanged");
  return JSON.parse(response.stdout);
}

function reject(f, args, diagnostic = unavailable, options = {}) {
  const before = f.snapshot();
  const calls = f.invocations();
  const response = f.invoke(args, options);
  assert.equal(response.status, 1, response.stdout);
  assert.match(response.stderr, diagnostic);
  assert.deepEqual(f.invocations(), calls, "rejection must happen before provider invocation");
  assert.deepEqual(f.snapshot(), before, "rejection must not create a job, supervisor launch artefact or change source/state bytes");
}

for (const kind of ["advise", "do", "rescue"]) {
  test(`${kind} discovers an actual failed resume as unavailable and keeps it ahead of the older valid job`, (t) => {
    const f = fixture(t);
    const older = job(kind);
    f.seed(older);
    const failed = f.invoke(resumeArgs(older, true), { environment: { SYNTHETIC_PROVIDER_FAIL: "1" } });
    const failedId = JSON.parse(failed.stdout).jobId;
    const selected = f.jobs().find((candidate) => candidate.id === failedId);
    assert.equal(selected.status, "failed");
    assert.equal(selected.resumeSessionId, sessionId, "failed current jobs retain the canonical resume identity");
    assert.notEqual(selected.resultSource, "provider-json");
    assert.equal(f.invocations().length, 1);

    for (const json of [true, false]) {
      assert.deepEqual(discover(f, { json }), { available: false, candidate: selected, candidates: [] });
    }
    for (const explicit of [true, false]) reject(f, resumeArgs(selected, explicit));
    assert.equal(f.jobs().length, 2, "resolution must not fall back to the older valid job");
    assert.deepEqual(f.jobs().find((candidate) => candidate.id === older.id), older);
  });

  test(`${kind} rejects unavailable selected sources in the shared background resolver`, { skip: process.platform !== "darwin" }, (t) => {
    const f = fixture(t);
    const selected = job(kind, { status: "failed", resultSource: undefined });
    f.seed([selected, job(kind, { id: `older-${kind}` })]);
    assert.equal(discover(f).available, false);
    for (const explicit of [true, false]) reject(f, resumeArgs(selected, explicit, ["--background"]));
  });

  test(`${kind} valid current authority is discoverable and resumes explicitly and implicitly`, async (t) => {
    for (const explicit of [true, false]) {
      await t.test(explicit ? "explicit" : "implicit", (t) => {
        const f = fixture(t);
        const selected = job(kind);
        f.seed(selected);
        assert.deepEqual(discover(f), { available: true, candidate: selected, candidates: [] });
        const response = f.invoke(resumeArgs(selected, explicit));
        assert.equal(response.status, 0, response.stderr);
        assert.equal(JSON.parse(response.stdout).status, "completed");
        assert.equal(f.invocations().length, 1);
        const [args] = f.invocations();
        assert.equal(args[args.indexOf("--resume") + 1], sessionId);
        assert.equal(args[args.indexOf("--output-format") + 1], "json");
        assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
        assert.equal(f.jobs().length, 2);
        assert.deepEqual(f.jobs().find((candidate) => candidate.id === selected.id), selected);
      });
    }
  });
}

test("selected non-review availability preserves the resolver's exact authority and completion rules", async (t) => {
  const cases = {
    "missing provider-json source": [{ resultSource: undefined }, false],
    "non-provider source": [{ resultSource: "legacy-human" }, false],
    "missing resume identity with provider identity retained": [{ resumeSessionId: undefined, claudeSessionId: sessionId }, false],
    "noncanonical resume identity": [{ resumeSessionId: "session-name" }, false],
    "failed with provider-json and UUID": [{ status: "failed" }, false],
    "cancelled with provider-json and UUID": [{ status: "cancelled" }, false],
    "timed out with provider-json and UUID": [{ status: "timed_out" }, false],
    "completed lifecycle despite failed status": [{ lifecycleState: "completed", status: "failed" }, true],
    "completed status despite failed lifecycle": [{ lifecycleState: "failed" }, true]
  };
  for (const [name, [patch, available]] of Object.entries(cases)) {
    await t.test(name, (t) => {
      const f = fixture(t);
      const selected = job("advise", patch);
      const older = job("advise", { id: "older-valid" });
      f.seed([selected, older]);
      // JSON persistence omits undefined fields.
      const stored = f.jobs()[0];
      assert.deepEqual(discover(f), { available, candidate: stored, candidates: [] });
      if (available) {
        const response = f.invoke(resumeArgs(selected, false));
        assert.equal(response.status, 0, response.stderr);
        assert.equal(f.invocations().length, 1);
        assert.deepEqual(f.jobs().find((candidate) => candidate.id === selected.id), stored);
      } else {
        for (const explicit of [true, false]) reject(f, resumeArgs(selected, explicit));
      }
    });
  }
});

test("non-review discovery retains thread scoping and no-candidate behaviour", (t) => {
  const f = fixture(t);
  f.seed([]);
  assert.deepEqual(discover(f), { available: false, candidate: null, candidates: [] });
  reject(f, ["advise", "Synthetic continuation", "--resume"], /No safe Claude job/);

  const foreign = job("advise", { id: "foreign", codexThreadId: "another-thread" });
  const local = job("do", { status: "failed" });
  f.seed([foreign, local]);
  assert.deepEqual(discover(f), { available: false, candidate: local, candidates: [] });
  reject(f, resumeArgs(local, false));
});

test("non-review discovery never infers a thread but an exact source remains usable", (t) => {
  const f = fixture(t, "");
  const selected = job("advise");
  f.seed(selected);
  assert.deepEqual(discover(f), { available: false, candidate: null, candidates: [selected] });
  reject(f, resumeArgs(selected, false), /No safe Claude job/);
  // An exact source remains usable without an inferred thread, as before.
  const response = f.invoke(resumeArgs(selected, true));
  assert.equal(response.status, 0, response.stderr);
  assert.equal(f.invocations().length, 1);
});

test("non-review discovery and resolution preserve explicit write authority", (t) => {
  const f = fixture(t);
  const selected = job("do", { write: true });
  f.seed(selected);
  const denied = discover(f);
  assert.equal(denied.available, false);
  assert.match(denied.error, /write-capable Claude session from a read-only command/);
  assert.deepEqual(denied.candidates, [selected]);
  for (const explicit of [true, false]) {
    reject(f, resumeArgs(selected, explicit), /write-capable Claude session from a read-only command/);
  }
  assert.deepEqual(discover(f, {}, ["--write"]), { available: true, candidate: selected, candidates: [] });
  const response = f.invoke(resumeArgs(selected, true, ["--write"]));
  assert.equal(response.status, 0, response.stderr);
  assert.equal(f.invocations().length, 1);
  const [args] = f.invocations();
  assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
  assert.equal(f.jobs()[0].write, true);
  assert.deepEqual(f.jobs().find((candidate) => candidate.id === selected.id), selected);
});
