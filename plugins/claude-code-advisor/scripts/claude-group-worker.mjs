#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";

import { discoverClaude } from "./lib/local-cli.mjs";

const CONFIG_LIMIT_BYTES = 2 * 1024 * 1024;
const TERMINATION_GRACE_MS = 500;
let terminating = false;

if (
  process.env.CLAUDE_TEST_SCENARIO &&
  process.env.CLAUDE_COMPANION_TEST_EXIT_GROUP_WORKER_BEFORE_CONFIG === "1"
) {
  process.exit(0);
}

process.on("SIGTERM", () => {
  // The group anchor must survive the graceful group signal long enough to
  // escalate against descendants that deliberately ignore it.
});

async function readConfig() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > CONFIG_LIMIT_BYTES) throw new Error("invalid-worker-config");
    chunks.push(Buffer.from(chunk));
  }
  let config;
  try {
    config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid-worker-config");
  }
  if (
    !config ||
    !Array.isArray(config.claudeArgs) ||
    config.claudeArgs.some((value) => typeof value !== "string") ||
    typeof config.prompt !== "string" ||
    !config.prompt.trim() ||
    typeof config.cwd !== "string"
  ) throw new Error("invalid-worker-config");
  return config;
}

async function forward(readable, writable) {
  for await (const chunk of readable) {
    if (!writable.write(chunk)) await once(writable, "drain");
  }
}

async function closeForwardingStreams() {
  const close = (stream) => new Promise((resolve) => stream.end(resolve));
  await Promise.all([close(process.stdout), close(process.stderr)]);
}

function terminateOwnGroup() {
  if (terminating) return;
  terminating = true;
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {
    process.exit(1);
    return;
  }
  const escalation = setTimeout(() => {
    process.kill(-process.pid, "SIGKILL");
  }, TERMINATION_GRACE_MS);
  escalation.unref();
}

process.on("message", (message) => {
  if (message?.type === "terminate") terminateOwnGroup();
});

async function main() {
  const config = await readConfig();
  const provider = spawn(discoverClaude(), config.claudeArgs, {
    cwd: config.cwd,
    env: { ...process.env, NO_COLOR: "1" },
    detached: false,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const outcomePromise = new Promise((resolve, reject) => {
    provider.once("close", (code, signal) => resolve({ code, signal }));
    provider.once("error", reject);
  });
  await once(provider, "spawn");
  const stdoutForward = forward(provider.stdout, process.stdout);
  const stderrForward = forward(provider.stderr, process.stderr);
  provider.stdin.end(config.prompt);
  process.send?.({ type: "provider-ready" });
  let outcome;
  try {
    outcome = await outcomePromise;
  } catch {
    await Promise.allSettled([stdoutForward, stderrForward]);
    await closeForwardingStreams();
    process.send?.({ type: "provider-spawn-error" });
    return;
  }
  await Promise.all([stdoutForward, stderrForward]);
  await closeForwardingStreams();
  process.send?.({ type: "provider-close", code: outcome.code, signal: outcome.signal });
}

main().catch(() => {
  process.send?.({ type: "provider-spawn-error" });
});
