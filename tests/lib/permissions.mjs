import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function assertPrivatePermissions(target, mode) {
  if (process.platform !== "win32") { assert.equal(fs.statSync(target).mode & 0o777, mode); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-check-acl-"));
  try {
    const output = path.join(root, "acl.txt");
    const tools = path.join(process.env.SystemRoot, "System32");
    const sid = execFileSync(path.join(tools, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).match(/S-1-\d+(?:-\d+)+/)[0];
    execFileSync(path.join(tools, "icacls.exe"), [target, "/save", output, "/q"]);
    const acl = fs.readFileSync(output).toString("utf16le").split(/\r?\n/).find(line => line.startsWith("D:"));
    assert.match(acl, /^D:P/);
    const entries = [...acl.matchAll(/\(([^()]+)\)/g)].map(match => match[1].split(";"));
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map(entry => entry[5])), new Set(["SY", sid]));
    assert.ok(entries.every(entry => entry[0] === "A" && entry[2] === "FA"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

export function createRedirect(target, link, type) {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : type);
}
