import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = new URL("../plugins/claude-code-advisor/", import.meta.url);
const readJson = (name) => JSON.parse(fs.readFileSync(new URL(name, root), "utf8"));

test("portable package preserves native identity, fixed skill discovery and interface metadata", () => {
  const portable = readJson("plugin.json");
  const native = readJson(".codex-plugin/plugin.json");
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url))).version;
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(portable.name, "claude-code-advisor");
  assert.equal(portable.version, version);
  for (const field of ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"]) {
    assert.deepEqual(portable[field], native[field], `portable/native ${field} drift`);
  }
  assert.deepEqual(portable.extensions, { "com.openai": { interface: native.interface } });
  assert.equal(Object.hasOwn(portable, "skills"), false);
  assert.equal(Object.hasOwn(portable, "mcpServers"), false);
  assert.equal(native.skills, "./skills/");
  assert.deepEqual(fs.readdirSync(new URL("skills/", root)), ["claude"]);
  assert.ok(fs.statSync(new URL("skills/claude/SKILL.md", root)).isFile());
  for (const asset of [native.interface.composerIcon, native.interface.logo]) {
    assert.ok(asset.startsWith('./com.openai/'), 'Client-specific assets must be namespaced');
    assert.equal(path.posix.normalize(asset).startsWith("../"), false);
    assert.ok(fs.statSync(new URL(asset, root)).isFile());
  }
});

test("installed package carries the original licence and explicit compatibility limits", () => {
  assert.equal(fs.readFileSync(new URL("LICENSE", root), "utf8"), fs.readFileSync(new URL("../LICENSE", import.meta.url), "utf8"));
  const readme = fs.readFileSync(new URL("README.md", root), "utf8");
  assert.match(readme, /Agent Plugins 1\.0\.0/);
  assert.match(readme, /Codex/);
  assert.match(readme, /Other clients.*not.*verified/s);
  assert.match(readme, /Yanchuk/);
  assert.ok(fs.statSync(new URL("CHANGELOG.md", root)).isFile());
});
