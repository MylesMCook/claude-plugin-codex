import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { nativeUtility } from "./fake-claude.mjs";

export function assertPrivatePermissions(target, mode) {
  if (process.platform !== "win32") { assert.equal(fs.statSync(target).mode & 0o777, mode); return; }
  const acl = JSON.parse(execFileSync(nativeUtility(), ["--acl", target], { encoding: "utf8", timeout: 10000 }));
  assert.equal(acl.protected, true);
  assert.equal(acl.owner, acl.user, "the current account must own managed state");
  assert.equal(acl.entries.length, 2);
  assert.deepEqual(new Set(acl.entries.map(entry => entry.sid)), new Set(["S-1-5-18", acl.user]));
  const inheritance = fs.statSync(target).isDirectory() ? 3 : 0;
  assert.ok(acl.entries.every(entry => entry.allow && entry.rights === 2032127
    && entry.inheritance === inheritance && entry.propagation === 0));

}

export function createRedirect(target, link, type) {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : type);
}
