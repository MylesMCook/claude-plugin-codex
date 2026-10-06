import test from "node:test";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";
import { fakeClaudeName, writeFakeClaude } from "./lib/fake-claude.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverClaude, inspectAuthentication, prepareUxTask } from "../plugins/claude-code-advisor/scripts/lib/local-cli.mjs";
import { buildClaudeArgs } from "../plugins/claude-code-advisor/scripts/lib/runtime.mjs";

for (const platform of ["darwin", "linux", "win32"]) {
  test(`${platform}: absolute PATH/native discovery tolerates spaces and excludes cwd`, () => {
    const win = platform === "win32";
    const home = win ? "C:\\Users\\Test User" : "/Users/Test User";
    const expected = win ? "C:\\Tools With Spaces\\claude.exe" : "/Tools With Spaces/claude";
    const checked = [];
    const resolved = discoverClaude({ platform, home, env: { PATH: win ? '.;relative;C:\\Tools With Spaces' : ':relative:/Tools With Spaces' }, usable: (p) => { checked.push(p); return p === expected; } });
    assert.equal(resolved, expected);
    assert.deepEqual(checked, [expected]);
  });
}
test("Desktop minimal PATH finds Mac native install; Windows native home install uses Path", () => {
  assert.equal(discoverClaude({ platform: "darwin", home: "/Users/user", env: { PATH: "/usr/bin" }, usable: p => p === "/Users/user/.local/bin/claude" }), "/Users/user/.local/bin/claude");
  assert.equal(discoverClaude({ platform: "win32", home: "C:\\Users\\User", env: { Path: "C:\\Windows" }, usable: p => p.endsWith(".local\\bin\\claude.exe") }), "C:\\Users\\User\\.local\\bin\\claude.exe");
});
test("explicit executable fails closed and Windows rejects shell shims", () => {
  for (const candidate of ["claude", "C:\\bin\\claude.cmd", "C:\\bin\\claude.bat"]) assert.throws(() => discoverClaude({ platform: "win32", env: { CLAUDE_COMPANION_EXECUTABLE: candidate }, usable: () => true }));
  assert.throws(() => discoverClaude({ platform: "darwin", env: { CLAUDE_COMPANION_EXECUTABLE: "/missing" }, usable: () => false }));
  assert.equal(discoverClaude({ platform: "win32", env: { CLAUDE_COMPANION_EXECUTABLE: "C:\\Tools With Spaces\\claude.exe" }, usable: () => true }), "C:\\Tools With Spaces\\claude.exe");
});

test("Windows npm installs resolve the bundled native CLI without running a shim", () => {
  const home = "C:\\Users\\Test User";
  const appData = "C:\\Users\\Test User\\AppData\\Roaming";
  const suffix = "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
  for (const [env, prefix] of [
    [{ Path: `${appData}\\npm`, APPDATA: appData }, `${appData}\\npm`],
    [{ PATH: "D:\\Custom npm prefix" }, "D:\\Custom npm prefix"],
    [{ PATH: "C:\\Windows", APPDATA: "D:\\Roaming With Spaces" }, "D:\\Roaming With Spaces\\npm"],
    [{ PATH: "C:\\Windows" }, `${appData}\\npm`]
  ]) {
    const expected = `${prefix}\\${suffix}`;
    const checked = [];
    assert.equal(discoverClaude({ platform: "win32", home, env, usable: candidate => {
      checked.push(candidate);
      return candidate === expected || candidate === `${prefix}\\claude.cmd` || candidate === `${prefix}\\claude.ps1`;
    } }), expected);
    assert.ok(checked.includes(expected));
  }
});

test("Windows npm fallback preserves native PATH priority and ignores relative APPDATA", () => {
  const expected = "C:\\Native\\claude.exe";
  assert.equal(discoverClaude({ platform: "win32", home: "C:\\Users\\Test", env: {
    PATH: "C:\\npm;C:\\Native"
  }, usable: candidate => candidate === expected || candidate.includes("node_modules") }), expected);
  const home = "C:\\Users\\Test";
  assert.equal(discoverClaude({ platform: "win32", home, env: {
    PATH: "C:\\npm"
  }, usable: candidate => candidate.endsWith(".local\\bin\\claude.exe") || candidate.includes("node_modules") }), `${home}\\.local\\bin\\claude.exe`);
  assert.equal(discoverClaude({ platform: "win32", home, env: {
    PATH: "C:\\npm", CLAUDE_COMPANION_EXECUTABLE: expected
  }, usable: () => true }), expected);
  const checked = [];
  assert.throws(() => discoverClaude({ platform: "win32", home: "C:\\Users\\Test", env: {
    PATH: ".;relative", APPDATA: "relative"
  }, usable: candidate => { checked.push(candidate); return false; } }));
  assert.ok(checked.includes(`${home}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`));
});

test("Windows npm discovery checks actual files and ignores a directory named claude.exe", t => {
  if (process.platform !== "win32") { t.skip("Requires Windows filesystem paths"); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude npm discovery "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, "npm");
  const expected = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  fs.mkdirSync(path.dirname(expected), { recursive: true });
  fs.mkdirSync(path.join(prefix, "claude.exe"));
  for (const shim of ["claude.cmd", "claude.ps1"]) fs.writeFileSync(path.join(prefix, shim), "Must never execute");
  fs.writeFileSync(expected, "Discovery fixture; never executed");
  assert.equal(discoverClaude({ platform: "win32", home: root, env: { Path: prefix } }), expected);
});
test("auth projection is fixed, fail-closed and respects API/provider overrides", () => {
  const result = { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "PRIVATE", token: "SECRET" }) };
  assert.deepEqual(inspectAuthentication(result, {}), { loggedIn: true, billingSource: "subscription" });
  assert.equal(inspectAuthentication(result, { ANTHROPIC_API_KEY: "SECRET" }).billingSource, "api");
  assert.equal(inspectAuthentication(result, { CLAUDE_CODE_USE_VERTEX: "1" }).billingSource, "third-party");
  assert.equal(inspectAuthentication({ ...result, stdout: '{"loggedIn":true,"authMethod":"SECRET"}' }, {}).billingSource, "unknown");
  for (const bad of [{ status: 0, stdout: "SECRET" }, { status: 1, stdout: result.stdout }]) assert.deepEqual(inspectAuthentication(bad, {}), { loggedIn: false, billingSource: "unknown" });
});
test("UX policy is bounded, foreground and read-only with explicit skill request", () => {
  const prepared = prepareUxTask({ "billing-source": "subscription" }, "Review navigation");
  assert.equal(prepared.options["no-background-fallback"], true);
  assert.equal(prepared.options["max-turns"], 6);
  assert.match(prepared.prompt, /frontend-design:frontend-design/);
  assert.match(prepared.prompt, /Codex owns planning, implementation and verification/);
  for (const key of ["background", "write", "resume", "allow-web", "allow-mcp", "output-format"]) assert.throws(() => prepareUxTask({ "billing-source": "api", [key]: true }, "Question"));
  for (const timeout of ["0", "-1", "Infinity", "NaN", "120001"]) assert.throws(() => prepareUxTask({ "billing-source": "api", "timeout-ms": timeout }, "Question"));
  assert.throws(() => prepareUxTask({}, "Question"));
  assert.throws(() => prepareUxTask({ "billing-source": "api", "max-turns": 7 }, "Question"));
  const args = buildClaudeArgs({ mode: "ux", prompt: prepared.prompt });
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Skill");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Glob,Grep,Skill(frontend-design:frontend-design)");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.throws(() => buildClaudeArgs({ mode: "ux", prompt: "Q", write: true }));
});

function fixture(t, auth, slow = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-synthetic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, fakeClaudeName);
  const log = path.join(root, "calls.jsonl");
  writeFakeClaude(cli, `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n'); if(args[0]==='auth'){console.log(${JSON.stringify(JSON.stringify(auth))});process.exit(0);} ${slow ? "process.on('SIGTERM',()=>{});setTimeout(()=>console.log('late'),10000);" : "let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>console.log('SYNTHETIC UX'));"}`);
  fs.chmodSync(cli, 0o755);
  const companion = path.resolve("plugins/claude-code-advisor/scripts/claude-companion.mjs");
  const run = args => spawnSync(process.execPath, [companion, "ux", ...args, "Navigation question", "--json"], { cwd: root, encoding: "utf8", timeout: 15000, env: isolatedClaudeEnv(root, cli) });
  return { run, calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split('\n').map(JSON.parse) : [] };
}
test("synthetic UX invocation preflights billing before the single advice call", t => {
  const f = fixture(t, { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
  const result = f.run(["--billing-source", "subscription"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SYNTHETIC UX/);
  assert.deepEqual(f.calls()[0], ["auth", "status"]);
  assert.equal(f.calls().length, 2);
});
test("billing mismatch never sends a prompt", t => {
  const f = fixture(t, { loggedIn: true, authMethod: "api_key", token: "SECRET" });
  const result = f.run(["--billing-source", "subscription"]);
  assert.equal(result.status, 1);
  assert.equal(f.calls().length, 1);
  assert.doesNotMatch(result.stderr, /SECRET/);
});
test("UX timeout never creates a background retry", t => {
  const f = fixture(t, { loggedIn: true, authMethod: "api_key" }, true);
  const result = f.run(["--billing-source", "api", "--timeout-ms", process.platform === "win32" ? "2000" : "100"]);
  assert.equal(result.status, 1);
  assert.equal(f.calls().length, 2);
  assert.match(result.stderr, /timed out/);
});
