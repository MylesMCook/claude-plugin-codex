import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";
import { discoverClaude } from "../plugins/claude-code-advisor/scripts/lib/local-cli.mjs";
import { fakeClaudeName, writeFakeClaude, fixtureTimeoutMs } from "./lib/fake-claude.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("test environment contains only safe allowlisted keys and isolated directories", t => {
  const root = fixture(t);
  const env = isolatedClaudeEnv(root);
  const allowed = new Set(["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_COMPANION_EXECUTABLE", "CLAUDE_COMPANION_STATE_ROOT", "TMPDIR", "TMP", "TEMP", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "SystemRoot"]);
  assert.ok(Object.keys(env).every(key => allowed.has(key)));
  for (const key of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_COMPANION_STATE_ROOT", "GIT_CONFIG_GLOBAL"]) assert.ok(env[key].startsWith(fs.realpathSync(root) + path.sep));
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS", "NODE_OPTIONS", "SSH_AUTH_SOCK"]) assert.equal(env[key], undefined);
});
test("a missing explicit mock cannot fall back to a usable host executable", t => {
  const root = fixture(t);
  const env = isolatedClaudeEnv(root);
  const probes = [];
  assert.throws(() => discoverClaude({ env, usable: candidate => { probes.push(candidate); return candidate !== env.CLAUDE_COMPANION_EXECUTABLE; } }), /must name an absolute executable/);
  assert.deepEqual(probes, [env.CLAUDE_COMPANION_EXECUTABLE]);
});
test("companion missing-mock failure never executes PATH or home fallback sentinel", t => {
  const root = fixture(t);
  const env = isolatedClaudeEnv(root);
  const bin = path.join(root, "host-sentinel");
  const localBin = path.join(env.HOME, ".local", "bin");
  const called = path.join(root, "sentinel-called");
  fs.mkdirSync(bin); fs.mkdirSync(localBin, { recursive: true });
  for (const dir of [bin, localBin]) writeFakeClaude(path.join(dir, fakeClaudeName), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(called)},'CALLED');`);
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  const result = spawnSync(process.execPath, [path.resolve("plugins/claude-code-advisor/scripts/claude-companion.mjs"), "advise", "synthetic", "--json"], { cwd: root, env, encoding: "utf8", timeout: fixtureTimeoutMs });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLAUDE_COMPANION_EXECUTABLE/);
  assert.equal(fs.existsSync(called), false);
});
test("every provider harness uses isolated environment and none spreads host environment", () => {
  const files = fs.readdirSync("tests").filter(name => name.endsWith(".test.mjs"));
  for (const name of files) {
    const source = fs.readFileSync(path.join("tests", name), "utf8");
    assert.doesNotMatch(source, /\.\.\.process\.env|\$\{process\.env\.PATH\}/, name);
    if (/const companion\s*=/.test(source)) assert.match(source, /isolatedClaudeEnv/, name);
  }
});
