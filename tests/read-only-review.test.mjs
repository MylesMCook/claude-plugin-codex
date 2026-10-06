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
  buildBackgroundArgs, buildClaudeArgs, buildSupervisedPrintArgs, EMPTY_MCP_CONFIG,
  resolveStateDir, saveState, STATE_VERSION
} from "../plugins/claude-code-advisor/scripts/lib/runtime.mjs";

const companion = fileURLToPath(new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url));
const sessionId = "11111111-1111-4111-8111-111111111111";
const threadId = "read-only-review-test";
const diagnostic = (kind) => `${kind} is read-only and does not support --write. Use advise, do or rescue --write for write-capable work.`;

function fixture(t, { git = true, planProse = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-read-only-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const stateRoot = path.join(root, "state");
  const invocationLog = path.join(root, "invocations.jsonl");
  const spawnLog = path.join(root, "spawns.jsonl");
  const preload = path.join(root, "observe-spawn.cjs");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "working-tree-change\n");
  }
  writeFakeClaude(path.join(bin, fakeClaudeName), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ args, stdin }) + "\\n");
const envelope = ${JSON.stringify({
    type: "result", subtype: "success", is_error: false, session_id: sessionId, result: JSON.stringify({ findings: [] })
  })};
if (${planProse} && args[args.indexOf("--permission-mode") + 1] === "plan") {
  envelope.result = "I must follow the interactive Plan Mode workflow before returning findings.";
}
process.stdout.write(JSON.stringify(envelope));
`, { mode: 0o755 });
  // Observe the launch boundary itself so a rejected background request cannot
  // pass merely because a detached supervisor has not invoked Claude yet.
  fs.writeFileSync(preload, `
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  fs.appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify({ command, args }) + "\\n");
  if (options?.detached) throw new Error("Unexpected detached launch in rejection fixture");
  return original(command, args, options);
};
syncBuiltinESMExports();
`);
  const env = {
    ...isolatedClaudeEnv(root, path.join(bin, fakeClaudeName)),
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CODEX_THREAD_ID: threadId
  };
  const stateDir = resolveStateDir(fs.realpathSync(repo), env);
  const seed = (write = false) => {
    const job = {
      id: "source-job", kind: "do", status: "completed", write, codexThreadId: threadId,
      claudeSessionId: sessionId, canonicalSessionId: sessionId, resumeSessionId: sessionId,
      result: "Synthetic source result", resultSource: "provider-json"
    };
    saveState(stateDir, { version: STATE_VERSION, capabilities: null, jobs: [job] });
    fs.mkdirSync(path.join(stateDir, "jobs", "existing"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "jobs", "existing", "envelope.json"), "Original evidence bytes\n");
    return job;
  };
  const invoke = (args) => {
    const result = spawnSync(process.execPath, ["--require", preload, companion, ...args], {
      cwd: repo, env, encoding: "utf8", timeout: fixtureTimeoutMs
    });
    assert.equal(result.error, undefined, "command must finish within the test deadline");
    assert.equal(result.signal, null);
    return result;
  };
  const readLog = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
  const snapshot = () => {
    const files = {};
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        const key = path.relative(stateRoot, file);
        files[key] = entry.isDirectory() ? null : fs.readFileSync(file);
        if (entry.isDirectory()) visit(file);
      }
    };
    if (fs.existsSync(stateRoot)) {
      files["/"] = null;
      visit(stateRoot);
    }
    return files;
  };
  const jobs = () => JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs;
  return { invoke, seed, snapshot, jobs, invocations: () => readLog(invocationLog), spawns: () => readLog(spawnLog) };
}

function assertRejected(f, args, message) {
  const before = f.snapshot();
  const response = f.invoke(args);
  assert.equal(response.status, 1, response.stdout);
  assert.equal(response.stdout, "");
  assert.equal(response.stderr, `${message}\n`);
  assert.deepEqual(f.invocations(), [], "no provider command may run");
  assert.deepEqual(f.spawns(), [], "no provider or detached supervisor may be spawned");
  assert.deepEqual(f.snapshot(), before, "state bytes and artefacts must remain unchanged");
}

function assertIsolation(args, write = false) {
  assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
  assert.equal(args.includes("--tools"), !write);
  if (!write) assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args.includes("--model"), false, "retain the configured provider default model");
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
  assert.equal(args[args.indexOf("--mcp-config") + 1], EMPTY_MCP_CONFIG);
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(args.includes("--no-chrome"), true);
}

for (const kind of ["review", "adversarial-review"]) {
  test(`${kind} avoids interactive planning without enabling tools`, (t) => {
    // Real native reviews can refuse JSON in Plan Mode, even with no tools.
    // The fixture models that provider response without invoking a real writer.
    const f = fixture(t, { planProse: true });
    const response = f.invoke([kind, "Synthetic focus", "--json"]);
    assert.equal(response.status, 0, response.stderr);
    assert.deepEqual(JSON.parse(response.stdout).result, { findings: [] });
    assert.equal(f.invocations().length, 1, "complete without a formatting retry");
    assertIsolation(f.invocations()[0].args);
    assert.equal(f.jobs()[0].write, false);
    assert.equal(f.jobs()[0].resultSource, "provider-json");
  });

  test(`${kind} rejects --write outside Git before initial state creation`, (t) => {
    const f = fixture(t, { git: false });
    assertRejected(f, [kind, "--write", "--json"], diagnostic(kind));
    assert.deepEqual(f.snapshot(), {});
  });

  test(`${kind} rejects --write across output, target and resume routes`, async (t) => {
    for (const json of [false, true]) {
      for (const base of [false, true]) {
        for (const resume of ["none", "implicit", "explicit"]) {
          for (const background of [false, true]) {
            await t.test(`${json ? "JSON" : "plain"}, ${base ? "base" : "working tree"}, ${resume} resume, background=${background}`, (t) => {
              const f = fixture(t);
              const job = f.seed(true);
              const args = [kind, "Synthetic focus", "--write"];
              if (json) args.push("--json");
              if (base) args.push("--base", "HEAD");
              if (resume !== "none") args.push("--resume");
              if (resume === "explicit") args.push("--job-id", job.id);
              if (background) args.push("--background");
              assertRejected(f, args, diagnostic(kind));
            });
          }
        }
      }
    }
  });

  test(`${kind} still rejects write-capable resume when --write is absent`, async (t) => {
    for (const explicit of [false, true]) {
      await t.test(explicit ? "explicit" : "implicit", (t) => {
        const f = fixture(t);
        const job = f.seed(true);
        assertRejected(f, [kind, "--resume", ...(explicit ? ["--job-id", job.id] : []), "--json"],
          "Refusing to resume a write-capable Claude session from a read-only command. Pass --write --resume.");
      });
    }
  });

  test(`${kind} retains isolated default provider arguments and validated findings`, (t) => {
    const f = fixture(t);
    const response = f.invoke([kind, "Synthetic focus", "--json"]);
    assert.equal(response.status, 0, response.stderr);
    assert.deepEqual(JSON.parse(response.stdout).result, { findings: [] });
    assert.equal(f.invocations().length, 1);
    assertIsolation(f.invocations()[0].args);
    assert.equal(f.invocations()[0].args[f.invocations()[0].args.indexOf("--output-format") + 1], "json");
    assert.match(f.invocations()[0].stdin, /working-tree-change/);
    const [job] = f.jobs();
    assert.equal(job.write, false);
    assert.equal(job.resultSource, "provider-json");
    assert.equal(job.claudeSessionId, sessionId);
  });

  test(`${kind} exported foreground builder rejects explicit write`, () => {
    assert.throws(() => buildClaudeArgs({ mode: kind, prompt: "Review", write: true }), {
      message: diagnostic(kind)
    });
    assertIsolation(buildClaudeArgs({ mode: kind, prompt: "Review", effort: "xhigh" }));
  });
}

for (const kind of ["advise", "do", "rescue"]) {
  test(`${kind} keeps explicit write arguments across foreground and background builders`, () => {
    for (const builder of [buildClaudeArgs, buildBackgroundArgs, buildSupervisedPrintArgs]) {
      const args = builder({ mode: kind, prompt: "Synthetic task", write: true, resumeSessionId: sessionId, effort: "xhigh" });
      assertIsolation(args, true);
      assert.equal(args[args.indexOf("--resume") + 1], sessionId);
    }
  });

  test(`${kind} still resumes an explicitly authorised write session`, async (t) => {
    for (const explicit of [false, true]) {
      await t.test(explicit ? "explicit" : "implicit", (t) => {
        const f = fixture(t);
        const source = f.seed(true);
        const response = f.invoke([kind, "Synthetic task", "--write", "--resume", ...(explicit ? ["--job-id", source.id] : []), "--json"]);
        assert.equal(response.status, 0, response.stderr);
        assert.equal(f.invocations().length, 1);
        const { args } = f.invocations()[0];
        assertIsolation(args, true);
        assert.equal(args[args.indexOf("--resume") + 1], sessionId);
        const job = f.jobs().find((candidate) => candidate.id === JSON.parse(response.stdout).jobId);
        assert.equal(job.write, true);
        assert.equal(job.resumeSessionId, sessionId);
      });
    }
  });
}
