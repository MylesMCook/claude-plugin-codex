import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";

// CLI ingestion only: disposable Codex homes; no auth, exec or provider calls.
const repository = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.join(repository, "plugins", "claude-code-advisor");
const marketplace = JSON.parse(fs.readFileSync(path.join(repository, ".agents/plugins/marketplace.json")));
const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin.json"))).version;
const codexName = process.platform === "win32" ? "codex.exe" : "codex";
const codex = (process.env.PATH || process.env.Path || "").split(path.delimiter)
  .map(directory => path.join(directory, codexName)).find(candidate => fs.existsSync(candidate));
assert.ok(codex, "Codex CLI must be installed for the optional ingestion check");
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "claude-portable-install-"));
const env = isolatedClaudeEnv(scratch);

function run(args, cwd, codexHome) {
  const result = spawnSync(codex, args, {
    cwd, env: { ...env, CODEX_HOME: codexHome }, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.error, undefined, `codex ${args[0]} failed: ${result.error?.code}`);
  assert.equal(result.status, 0, `codex ${args.slice(0, 3).join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function files(root) {
  return fs.readdirSync(root, { recursive: true }).filter(name => fs.lstatSync(path.join(root, name)).isFile()).sort();
}

try {
  for (const mode of ["overlay", "portable-only"]) {
    const fixture = path.join(scratch, mode);
    const source = path.join(fixture, "plugins", "claude-code-advisor");
    const codexHome = path.join(scratch, `${mode}-home`);
    fs.mkdirSync(path.join(fixture, ".agents", "plugins"), { recursive: true });
    fs.mkdirSync(codexHome);
    fs.cpSync(packageRoot, source, { recursive: true });
    if (mode === "portable-only") fs.rmSync(path.join(source, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(path.join(fixture, ".agents", "plugins", "marketplace.json"), JSON.stringify(marketplace));
    const added = JSON.parse(run(["plugin", "marketplace", "add", fixture, "--json"], fixture, codexHome));
    assert.ok(added);
    run(["plugin", "add", "claude-code-advisor@claude-plugin-codex", "--json"], fixture, codexHome);
    const installed = path.join(codexHome, "plugins", "cache", "claude-plugin-codex", "claude-code-advisor", version);
    assert.deepEqual(files(installed), files(source), `${mode}: installed file set differs`);
    for (const relative of files(source)) {
      assert.deepEqual(fs.readFileSync(path.join(installed, relative)), fs.readFileSync(path.join(source, relative)), `${mode}: installed byte drift: ${relative}`);
    }
    const prompt = run(["debug", "prompt-input", "Check Claude advisor availability."], fixture, codexHome);
    assert.ok(prompt.includes(`claude-code-advisor/${version}/skills/claude/SKILL.md`), `${mode}: skill discovery missing`);
    assert.ok(prompt.includes("claude-code-advisor:claude"), `${mode}: stable skill identity missing`);
    assert.equal(fs.existsSync(path.join(codexHome, "auth.json")), false);
    console.log(`${mode}: fresh install, fixed skill discovery and ${files(source).length} exact files passed`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
