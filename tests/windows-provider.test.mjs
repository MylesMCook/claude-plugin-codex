import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fakeClaudeName, writeFakeClaude, fixtureTimeoutMs } from "./lib/fake-claude.mjs";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";

test("native mock forwards arbitrary argv and stdin without a shell", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude mock with spaces "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, fakeClaudeName);
  writeFakeClaude(executable, `#!/usr/bin/env node\nconst fs=require('node:fs'); console.log(JSON.stringify({argv:process.argv.slice(2),stdin:fs.readFileSync(0).toString('base64')}));`);
  const args = ["-p", "quoted \"value\"", "trailing\\", "$(never execute); & | % !", "日本語"];
  const input = Buffer.from("Private synthetic stdin\r\n\u0000", "utf8");
  const result = spawnSync(executable, args, { input, env: isolatedClaudeEnv(root, executable), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { argv: args, stdin: input.toString("base64") });
});

test("Windows mock timeout terminates its observed provider and grandchild", t => {
  if (process.platform !== "win32") { t.skip("Tests Windows Job Object ownership"); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mock-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, fakeClaudeName);
  const pidFile = path.join(root, "owned-pids.json");
  writeFakeClaude(executable, `const fs=require('node:fs');const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  const result = spawnSync(executable, [], { env: isolatedClaudeEnv(root, executable), encoding: "utf8", timeout: fixtureTimeoutMs });
  assert.equal(result.error?.code, "ETIMEDOUT");
  const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
  const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { assert.equal(error.code, "ESRCH"); return false; } };
  const deadline = Date.now() + 5000;
  while (pids.some(live) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  assert.ok(pids.every(pid => !live(pid)), "mock descendants must exit after the launcher is terminated");
});

test("Windows mock exit drains pipes and terminates an immediately spawned descendant", t => {
  if (process.platform !== "win32") { t.skip("Tests Windows Job Object ownership"); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mock-exit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, fakeClaudeName);
  const pidFile = path.join(root, "descendant.json");
  writeFakeClaude(executable, `const fs=require('node:fs');const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify(child.pid));console.log('PASS');process.exit(0);`);
  const result = spawnSync(executable, [], { env: isolatedClaudeEnv(root, executable), encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "PASS");
  const pid = JSON.parse(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
