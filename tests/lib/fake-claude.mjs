import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const fakeClaudeName = process.platform === "win32" ? "claude.exe" : "claude";
// Allow native ACL setup/retry as well as the mock's startup. Provider deadlines
// remain the explicit values passed to the companion by each scenario.
export const fixtureTimeoutMs = process.platform === "win32" ? 60000 : 5000;
let nativeLauncher;

export function nativeUtility() {
  if (process.platform !== "win32") throw new Error("Windows native utility unavailable.");
  if (!nativeLauncher) {
    const build = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-mock-"));
    nativeLauncher = path.join(build, "provider.exe");
    const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const code = fileURLToPath(new URL("../fixtures/windows-provider.cs", import.meta.url));
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${nativeLauncher}`, code], { stdio: "pipe" });
    process.once("exit", () => fs.rmSync(build, { recursive: true, force: true }));
  }
  return nativeLauncher;
}

export function windowsProcesses() {
  return JSON.parse(execFileSync(nativeUtility(), ["--list-processes"], { encoding: "utf8", timeout: 10000, windowsHide: true }));
}

export function writeFakeClaude(executable, source, options = {}) {
  if (process.platform !== "win32") {
    fs.writeFileSync(executable, source, { encoding: "utf8", mode: 0o755 });
    return;
  }
  const nativeLauncher = nativeUtility();
  const script = `${executable}.${options.module ? "mjs" : "cjs"}`;
  fs.writeFileSync(script, source, "utf8");
  fs.copyFileSync(nativeLauncher, executable);
  fs.writeFileSync(`${executable}.mock`, `${process.execPath}\n${script}\n`, "utf8");
}
