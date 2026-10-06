import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolatedClaudeEnv } from "./lib/isolated-env.mjs";
import { writeFakeClaude } from "./lib/fake-claude.mjs";
import { hasPrivateWindowsAcl } from "../plugins/claude-code-advisor/scripts/lib/private-path.mjs";

function native(command, args, env) {
  const start = Date.now();
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return { result, summary: { status: result.status, code: result.error?.code || null, elapsedMs: Date.now() - start } };
}

export function probe(env = process.env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-acl-probe-"));
  const tools = path.join(env.SystemRoot, "System32");
  const powershell = path.join(tools, "WindowsPowerShell", "v1.0", "powershell.exe");
  const sid = native(path.join(tools, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], env).result.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
  try {
    const directory = path.join(root, "state"); fs.mkdirSync(directory);
    const grant = native(path.join(tools, "icacls.exe"), [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/q"], env);
    const snapshot = path.join(root, "acl.txt");
    const saved = native(path.join(tools, "icacls.exe"), [directory, "/save", snapshot, "/q"], env);
    const dacl = fs.existsSync(snapshot) ? fs.readFileSync(snapshot).toString("utf16le").split(/\r?\n/).find(line => line.startsWith("D:")) : null;
    const psArgs = ["-NoProfile", "-NonInteractive", "-Command", "Write-Output 'PROBE'"];
    const baseline = native(powershell, psArgs, env);
    const coreEnv = { ...env, WINDIR: env.SystemRoot, COMSPEC: path.join(tools, "cmd.exe"), PSModulePath: path.join(tools, "WindowsPowerShell", "v1.0", "Modules") };
    const core = native(powershell, psArgs, coreEnv);
    let aliases = null;
    if (core.result.status === 0 && dacl) {
      const script = "$d=New-Object System.Security.AccessControl.RawSecurityDescriptor($env:CLAUDE_PROBE_DACL); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @($d.DiscretionaryAcl | ForEach-Object { if($_.SecurityIdentifier.Value -eq $sid){'CURRENT_USER'} elseif($_.SecurityIdentifier.Value -eq 'S-1-5-18'){'SYSTEM'} else {'OTHER'} }) | ConvertTo-Json -Compress";
      const resolved = native(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { ...coreEnv, CLAUDE_PROBE_DACL: dacl });
      aliases = { ...resolved.summary, principals: resolved.result.status === 0 ? JSON.parse(resolved.result.stdout) : null };
    }
    console.log(JSON.stringify({ userRid: sid?.split("-").at(-1), grant: grant.summary, snapshot: saved.summary, dacl: dacl?.replaceAll(sid, "CURRENT_USER"), parserPrivate: hasPrivateWindowsAcl(dacl, sid, true), powershell: baseline.summary, powershellCoreEnv: core.summary, aliases }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "win32") { console.log("Windows-only ACL diagnostic."); process.exit(0); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-acl-environments-"));
  try {
    console.log("ordinary environment"); probe();
    console.log("isolated environment"); probe(isolatedClaudeEnv(root));
    console.log("isolated environment inside native suite job");
    const executable = path.join(root, "probe.exe");
    writeFakeClaude(executable, `import(${JSON.stringify(import.meta.url)}).then(m => m.probe());`);
    const result = spawnSync(executable, [], { env: isolatedClaudeEnv(root), encoding: "utf8", timeout: 30000 });
    console.log(result.stdout || "");
    console.log(JSON.stringify({ nativeJobStatus: result.status, nativeJobError: result.error?.code || null }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
