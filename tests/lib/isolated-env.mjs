import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Build a fresh allowlisted environment; never spread process.env. Every
// provider-reaching harness pins a test-owned mock even when testing its absence.
export function isolatedClaudeEnv(root, executable = path.join(root, process.platform === "win32" ? "missing-mock-claude.exe" : "missing-mock-claude")) {
  const canonicalRoot = fs.realpathSync(root);
  const requestedExecutable = path.resolve(executable);
  if (fs.existsSync(requestedExecutable) && fs.lstatSync(requestedExecutable).isSymbolicLink()) throw new Error("Mock executable cannot be a symlink.");
  const absoluteExecutable = path.join(fs.realpathSync(path.dirname(requestedExecutable)), path.basename(requestedExecutable));
  const relative = path.relative(canonicalRoot, absoluteExecutable);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Mock executable must be inside the test root.");
  if (fs.existsSync(absoluteExecutable) && fs.lstatSync(absoluteExecutable).isSymbolicLink()) throw new Error("Mock executable cannot be a symlink.");
  const home = path.join(canonicalRoot, "isolated-home");
  const config = path.join(home, ".claude");
  const state = path.join(canonicalRoot, "isolated-state");
  for (const directory of [home, config, state]) fs.mkdirSync(directory, { recursive: true });
  return {
    PATH: [path.dirname(process.execPath), ...(process.platform === "win32"
      ? (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(directory => path.isAbsolute(directory))
      : ["/usr/bin", "/bin", "/usr/sbin"])].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData"),
    LOCALAPPDATA: path.join(home, "LocalAppData"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CLAUDE_CONFIG_DIR: config,
    CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_COMPANION_EXECUTABLE: absoluteExecutable,
    CLAUDE_COMPANION_STATE_ROOT: state,
    // Keep Unix socket paths short, while never inheriting credentials/config.
    TMPDIR: os.tmpdir(),
    TMP: os.tmpdir(),
    TEMP: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {})
  };
}
