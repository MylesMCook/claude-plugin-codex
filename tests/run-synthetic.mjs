import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";
import { writeFakeClaude } from "./lib/fake-claude.mjs";

// All test workers start without host auth, hooks, config or NODE_OPTIONS.
// A forgotten per-fixture provider path fails closed at a nonexistent mock.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-synthetic-suite-"));
try {
  const files = fs.readdirSync("tests").filter(name => name.endsWith(".test.mjs")).sort().map(name => path.join("tests", name));
  let executable = process.execPath;
  let args = ["--test", "--test-concurrency=4", ...files];
  if (process.platform === "win32") {
    // The native test launcher also contains the suite's descendants on timeout.
    executable = path.join(root, "synthetic-suite.exe");
    args = [];
    const nodeArgs = ["--test", "--test-concurrency=4", ...files];
    writeFakeClaude(executable, `const {spawnSync}=require('node:child_process');
const result=spawnSync(process.execPath,${JSON.stringify(nodeArgs)},{stdio:'inherit',env:process.env});
process.exitCode=result.error||result.signal?1:result.status??1;`);
  }
  const result = spawnSync(executable, args, {
    env: isolatedClaudeEnv(root),
    stdio: "inherit",
    timeout: (process.platform === "win32" ? 20 : 10) * 60 * 1000
  });
  process.exitCode = result.error || result.signal ? 1 : result.status ?? 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
