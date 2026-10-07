import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { restrictPrivatePath, hasPrivateWindowsAcl, parseWindowsUserSid } from "../plugins/claude-code-advisor/scripts/lib/private-path.mjs";
import { assertPrivatePermissions, createRedirect } from "./lib/permissions.mjs";

test("Windows identity comes from the SID column rather than a SID-shaped username", () => {
  const sid = "S-1-5-21-1-2-3-500";
  assert.equal(parseWindowsUserSid(`"DOMAIN\\S-1-1-0","${sid}"\r\n`), sid);
  assert.equal(parseWindowsUserSid('"DOMAIN\\S-1-1-0","invalid"'), null);
});

test("Windows private ACL verification rejects extra, conditional and incomplete grants", () => {
  const sid = "S-1-5-21-1-2-3-1001";
  const privateFile = `D:P(A;;FA;;;SY)(A;;FA;;;${sid})`;
  assert.equal(hasPrivateWindowsAcl(privateFile, sid, false), true);
  assert.equal(hasPrivateWindowsAcl(privateFile, sid, true), false);
  assert.equal(hasPrivateWindowsAcl(`D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${sid})`, sid, true), true);
  assert.equal(hasPrivateWindowsAcl(`D:P(A;OICIIO;FA;;;SY)(A;OICIIO;FA;;;${sid})`, sid, true), false);
  const aliasFile = "D:P(A;;FA;;;SY)(A;;FA;;;LA)";
  assert.equal(hasPrivateWindowsAcl(aliasFile, sid, false), false);
  assert.equal(hasPrivateWindowsAcl(aliasFile, sid, false, "LA"), true);
  assert.equal(hasPrivateWindowsAcl(aliasFile + "(A;;FA;;;BA)", sid, false, "LA"), false);
  assert.equal(hasPrivateWindowsAcl("D:P(A;;FA;;;LA)(A;;FA;;;WD)", sid, false, "LA"), false);
  for (const invalid of [
    privateFile.replace("D:P", "D:AI"), privateFile + "(A;;FA;;;WD)",
    privateFile + '(XA;;FA;;;WD;(Exists(@User.Claim)))',
    privateFile.replace("FA", "FR"), privateFile.replace("SY", "WD"),
    privateFile + "unexpected", privateFile.slice(0, -1),
    privateFile.replaceAll("A;;FA", "A;IO;FA"),
    `D:P(A;OICIIO;FA;;;SY)(A;OICIIO;FA;;;${sid})`
  ]) assert.equal(hasPrivateWindowsAcl(invalid, sid, false), false);
});

test("private state protection removes broad grants and rejects redirected paths", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-private-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "state");
  fs.mkdirSync(directory);
  if (process.platform === "win32") {
    const tool = path.join(process.env.SystemRoot, "System32", "icacls.exe");
    execFileSync(tool, [directory, "/grant", "*S-1-1-0:(OI)(CI)F", "/q"]);
  } else fs.chmodSync(directory, 0o777);
  restrictPrivatePath(directory, 0o700);
  assertPrivatePermissions(directory, 0o700);
  restrictPrivatePath(directory, 0o700);
  assertPrivatePermissions(directory, 0o700);
  const file = path.join(directory, "state.json");
  fs.writeFileSync(file, "synthetic private state");
  restrictPrivatePath(file, 0o600);
  assertPrivatePermissions(file, 0o600);
  const link = path.join(root, "redirect");
  createRedirect(directory, link, "dir");
  assert.throws(() => restrictPrivatePath(link, 0o700), /unsafe private state path/);
  assert.equal(fs.readFileSync(file, "utf8"), "synthetic private state");
});

test("exclusive new Windows state files remove default or explicit foreign grants", t => {
  if (process.platform !== "win32") { t.skip("Requires Windows ACLs"); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-new-file-acl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "state"); fs.mkdirSync(directory);
  restrictPrivatePath(directory, 0o700);
  const file = path.join(directory, "state.json");
  fs.writeFileSync(file, "synthetic", { flag: "wx", mode: 0o600 });
  execFileSync(path.join(process.env.SystemRoot, "System32", "icacls.exe"), [file, "/grant", "*S-1-1-0:R", "/q"]);
  restrictPrivatePath(file, 0o600, { newFile: true });
  assertPrivatePermissions(file, 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), "synthetic");
});

test("Windows ACL repair supports long directories and exclusive temporary files", t => {
  if (process.platform !== "win32") { t.skip("Requires Windows long-path ACLs"); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-long-acl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let directory = path.join(root, "state-" + "x".repeat(95), "nested-" + "y".repeat(95));
  while (directory.length <= 260) directory = path.join(directory, "long-" + "z".repeat(45));
  fs.mkdirSync(directory, { recursive: true });
  assert.ok(directory.length > 260);
  const tool = path.join(process.env.SystemRoot, "System32", "icacls.exe");
  execFileSync(tool, [path.toNamespacedPath(directory), "/grant", "*S-1-1-0:(OI)(CI)F", "/q"]);
  restrictPrivatePath(directory, 0o700);
  assertPrivatePermissions(directory, 0o700);
  const file = path.join(directory, ".state.json.12345." + "z".repeat(36) + ".tmp");
  fs.writeFileSync(file, "synthetic", { flag: "wx" });
  execFileSync(tool, [path.toNamespacedPath(file), "/grant", "*S-1-1-0:R", "/q"]);
  restrictPrivatePath(file, 0o600, { newFile: true });
  assertPrivatePermissions(file, 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), "synthetic");
});
