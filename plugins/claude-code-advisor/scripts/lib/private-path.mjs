import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const replaceAccessRulesScript = `
$ErrorActionPreference = 'Stop'
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)
$target = $env:CLAUDE_STATE_ACL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sections = [System.Security.AccessControl.AccessControlSections]::Access
if ($env:CLAUDE_STATE_ACL_DIRECTORY -eq "1") {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm(('D:P(A;OICI;FA;;;' + $sid + ')(A;OICI;FA;;;SY)'), $sections)
  [System.IO.Directory]::SetAccessControl($target, $acl)
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetSecurityDescriptorSddlForm(('D:P(A;;FA;;;' + $sid + ')(A;;FA;;;SY)'), $sections)
  [System.IO.File]::SetAccessControl($target, $acl)
}`;

let userSid;
export function parseWindowsUserSid(csv) {
  return String(csv || "").match(/,"(S-1-\d+(?:-\d+)+)"\s*$/)?.[1] || null;
}
export function hasPrivateWindowsAcl(dacl, sid, directory, verifiedAlias = null) {
  if (!dacl || !/^D:P/.test(dacl)) return false;
  const matches = [...dacl.matchAll(/\(([^()]+)\)/g)];
  if (matches.map(match => match[0]).join("") !== dacl.slice(dacl.indexOf("("))) return false;
  const entries = matches.map(match => match[1].split(";"));
  const principal = entry => entry[5] === "SY" ? "S-1-5-18" : entry[5] === verifiedAlias ? sid : entry[5];
  return entries.length === 2 && entries.every(entry => entry.length === 6 && entry[0] === "A" && entry[2] === "FA"
    && (principal(entry) === sid || principal(entry) === "S-1-5-18")
    && (directory ? /^(OICI|CIOI)$/.test(entry[1]) : entry[1] === ""))
    && new Set(entries.map(principal)).size === 2;
}

export function restrictPrivatePath(target, mode, { newFile = false } = {}) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Refusing unsafe private state path.");
  if (process.platform !== "win32") { fs.chmodSync(target, mode); return; }
  const nativeTarget = path.toNamespacedPath(path.resolve(target));
  const tools = path.join(process.env.SystemRoot, "System32");
  const options = { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] };
  const run = (name, args, stdoutFile = null) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // ACL results are read from the snapshot, not console output. Ignoring
        // unused pipes also avoids waiting for inherited Windows console handles.
        return execFileSync(path.join(tools, name), args, name === "whoami.exe" ? options : { ...options, stdio: stdoutFile === null ? "ignore" : ["ignore", stdoutFile, "ignore"] });
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
      userSid = parseWindowsUserSid(run("whoami.exe", ["/user", "/fo", "csv", "/nh"]));
      if (!userSid) throw new Error("User SID unavailable.");
    }
    if (newFile && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Not a newly created private file.");
    // A token's default owner can be the Administrators group, even for an
    // exclusive new file. Normalize ownership before publishing any state.
    stage = "owner";
    run("icacls.exe", [nativeTarget, "/setowner", `*${userSid}`, "/q"]);
    const replaceAcl = () => {
      fs.mkdirSync(path.join(temporary, "AppData", "Roaming"), { recursive: true });
      fs.mkdirSync(path.join(temporary, "AppData", "Local"), { recursive: true });
      stage = "replace";
      // Set only the DACL. icacls /restore requests a restore privilege that
      // ordinary Windows accounts lack, even when they own the managed file.
      execFileSync(path.join(tools, "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(replaceAccessRulesScript, "utf16le").toString("base64")
      ], { ...options, stdio: "ignore", env: {
        // ACL-only PowerShell gets a disposable profile with existing folders.
        // Caller config and provider credentials never enter this child.
        SystemRoot: process.env.SystemRoot, windir: process.env.SystemRoot,
        SystemDrive: path.parse(process.env.SystemRoot).root.replace(/[\\/]$/, ""),
        PATH: tools,
        USERPROFILE: temporary,
        APPDATA: path.join(temporary, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(temporary, "AppData", "Local"),
        TEMP: temporary, TMP: temporary,
        PSModulePath: path.join(tools, "WindowsPowerShell", "v1.0", "Modules"),
        CLAUDE_STATE_ACL_PATH: nativeTarget,
        CLAUDE_STATE_ACL_DIRECTORY: stat.isDirectory() ? "1" : "0"
      } });
    };
    const snapshot = path.join(temporary, "permissions.txt");
    const isPrivate = () => {
      stage = "inspect";
      if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot);
      run("icacls.exe", [nativeTarget, "/save", path.toNamespacedPath(snapshot), "/q"]);
      const dacl = fs.readFileSync(snapshot).toString("utf16le").split(/\r?\n/).find(line => line.startsWith("D:"));
      if (hasPrivateWindowsAcl(dacl, userSid, stat.isDirectory())) return true;
      // SDDL can abbreviate the current local administrator as LA. Accept an
      // alias only when this exact DACL explicitly contains the numeric user SID.
      const alias = [...(dacl || "").matchAll(/\(([^()]+)\)/g)]
        .map(match => match[1].split(";")[5]).find(value => value !== "SY" && /^[A-Z]{2}$/.test(value));
      if (!alias || !hasPrivateWindowsAcl(dacl, userSid, stat.isDirectory(), alias)) return false;
      const foundFile = path.join(temporary, "sid-match.txt");
      const fd = fs.openSync(foundFile, "w");
      try { run("icacls.exe", [nativeTarget, "/findsid", `*${userSid}`, "/q"], fd); }
      finally { fs.closeSync(fd); }
      const expected = `\\${path.basename(target)}`.toLowerCase();
      return fs.readFileSync(foundFile, "utf8").split(/\r?\n/).some(line => {
        const text = line.trim().replaceAll("/", "\\").toLowerCase();
        return text.endsWith(expected) || text.endsWith(`${expected}.`);
      });
    };
    if (!newFile && isPrivate()) return;
    const inheritance = stat.isDirectory() ? "(OI)(CI)" : "";
    stage = "restrict";
    run("icacls.exe", [nativeTarget, "/inheritance:r", "/grant:r", `*${userSid}:${inheritance}F`, `*S-1-5-18:${inheritance}F`, "/q"]);
    if (isPrivate()) return;
    // Replace only this managed object's protected DACL. Existing
    // explicit foreign grants must be removed, not merely supplemented.
    replaceAcl();
    if (!isPrivate()) throw new Error("Private state ACL verification failed.");
  } catch (error) {
    const status = Number.isInteger(error.status) ? `, exit ${error.status}` : "";
    const code = ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT"].includes(error.code) ? `, ${error.code}` : "";
    throw new Error(`Unable to protect private state path: ${target} (${stage}${status}${code})`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
