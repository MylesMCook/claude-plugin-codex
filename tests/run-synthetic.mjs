import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";

// All test workers start without host auth, hooks, config or NODE_OPTIONS.
// A forgotten per-fixture provider path fails closed at a nonexistent mock.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-synthetic-suite-"));
try {
  const files = fs.readdirSync("tests").filter(name => name.endsWith(".test.mjs")).sort().map(name => path.join("tests", name));
  const result = spawnSync(process.execPath, ["--test", ...files], {
    env: isolatedClaudeEnv(root),
    stdio: "inherit",
    timeout: 10 * 60 * 1000
  });
  process.exitCode = result.error || result.signal ? 1 : result.status ?? 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
