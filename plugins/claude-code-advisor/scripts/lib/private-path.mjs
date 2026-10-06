import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let userSid;
export function hasPrivateWindowsAcl(dacl, sid, directory) {
  if (!dacl || !/^D:P/.test(dacl)) return false;
  const matches = [...dacl.matchAll(/\(([^()]+)\)/g)];
  if (matches.map(match => match[0]).join("") !== dacl.slice(dacl.indexOf("("))) return false;
  const entries = matches.map(match => match[1].split(";"));
  return entries.length === 2 && entries.every(entry => entry.length === 6 && entry[0] === "A" && entry[2] === "FA"
    && (entry[5] === sid || entry[5] === "SY")
    && (directory ? /^(OICI|CIOI)$/.test(entry[1]) : entry[1] === ""))
    && new Set(entries.map(entry => entry[5])).size === 2;
}
const windowsAclScript = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$target=$env:CLAUDE_STATE_ACL_PATH
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ([System.IO.Directory]::Exists($target)) {
  $acl=New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm(('D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)'),[System.Security.AccessControl.AccessControlSections]::Access)
  [System.IO.Directory]::SetAccessControl($target,$acl)
} else {
  $acl=New-Object System.Security.AccessControl.FileSecurity
  $acl.SetSecurityDescriptorSddlForm(('D:P(A;;FA;;;'+$sid+')(A;;FA;;;SY)'),[System.Security.AccessControl.AccessControlSections]::Access)
  [System.IO.File]::SetAccessControl($target,$acl)
}`;

export function restrictPrivatePath(target, mode, { newFile = false } = {}) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Refusing unsafe private state path.");
  if (process.platform !== "win32") { fs.chmodSync(target, mode); return; }
  const tools = path.join(process.env.SystemRoot, "System32");
  const options = { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] };
  const run = (name, args) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // ACL results are read from the snapshot, not console output. Ignoring
        // unused pipes also avoids waiting for inherited Windows console handles.
        return execFileSync(path.join(tools, name), args, name === "whoami.exe" ? options : { ...options, stdio: "ignore" });
      }
      catch (error) {
        // These local ACL operations are idempotent. Retry one native timeout,
        // while permission errors remain immediate, visible failures.
        if (attempt !== 0 || error.code !== "ETIMEDOUT") throw error;
      }
    }
  };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-acl-"));
  let stage = "identity";
  try {
    if (!userSid) {
      userSid = run("whoami.exe", ["/user", "/fo", "csv", "/nh"]).match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!userSid) throw new Error("User SID unavailable.");
    }
    if (newFile) {
      // Exclusive creation in an already protected directory gives no explicit
      // foreign grants. Protect the file without ACL inspection inside the lock.
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Not a newly created private file.");
      stage = "restrict";
      run("icacls.exe", [target, "/inheritance:r", "/grant:r", `*${userSid}:F`, "*S-1-5-18:F", "/q"]);
      return;
    }
    // An unrelated owner retains WRITE_DAC even with no matching access rule.
    // Normalize ownership of this managed path without requesting elevation.
    stage = "owner";
    run("icacls.exe", [target, "/setowner", `*${userSid}`, "/q"]);
    const snapshot = path.join(temporary, "permissions.txt");
    const isPrivate = () => {
      stage = "inspect";
      if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot);
      run("icacls.exe", [target, "/save", snapshot, "/q"]);
      const dacl = fs.readFileSync(snapshot).toString("utf16le").split(/\r?\n/).find(line => line.startsWith("D:"));
      return hasPrivateWindowsAcl(dacl, userSid, stat.isDirectory());
    };
    if (isPrivate()) return;
    const inheritance = stat.isDirectory() ? "(OI)(CI)" : "";
    stage = "restrict";
    run("icacls.exe", [target, "/inheritance:r", "/grant:r", `*${userSid}:${inheritance}F`, `*S-1-5-18:${inheritance}F`, "/q"]);
    if (isPrivate()) return;
    // Replace any remaining explicit grants without resolving orphaned SID names.
    stage = "replace";
    execFileSync(path.join(tools, "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsAclScript, "utf16le").toString("base64")
    ], { ...options, stdio: "ignore", env: { ...process.env, CLAUDE_STATE_ACL_PATH: target } });
    if (!isPrivate()) throw new Error("Private state ACL verification failed.");
  } catch (error) {
    const status = Number.isInteger(error.status) ? `, exit ${error.status}` : "";
    const code = ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT"].includes(error.code) ? `, ${error.code}` : "";
    throw new Error(`Unable to protect private state path: ${target} (${stage}${status}${code})`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
