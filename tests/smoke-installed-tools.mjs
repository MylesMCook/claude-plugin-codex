import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverClaude } from "../plugins/claude-code-advisor/scripts/lib/local-cli.mjs";

import {
  isCanonicalResumeReference,
  loadState,
  resolveStateDir,
  supervisorPaths
} from "../plugins/claude-code-advisor/scripts/lib/runtime.mjs";

const companion = fileURLToPath(new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url));
const commandTimeoutMs = 30_000;
const foregroundTimeoutMs = 120_000;
const backgroundDeadlineMs = 180_000;
const pollIntervalMs = 250;
const terminalStates = new Set(["completed", "cancelled", "failed", "interrupted"]);
const allowedFailures = new Set([
  "authentication-unavailable",
  "capability-unavailable",
  "cleanup-unverified",
  "command-failure",
  "identity-failure",
  "invalid-result",
  "lifecycle-failure",
  "timeout",
  "unexpected-failure"
]);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fail(classification) {
  const error = new Error(classification);
  error.classification = allowedFailures.has(classification) ? classification : "unexpected-failure";
  throw error;
}

function expect(condition, classification) {
  if (!condition) fail(classification);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || commandTimeoutMs,
    maxBuffer: 1024 * 1024
  });
}

function requireSuccess(result, classification = "command-failure") {
  if (result.error?.code === "ETIMEDOUT") fail("timeout");
  if (result.error || result.signal || result.status !== 0) fail(classification);
  return result.stdout;
}

function parseJson(text, classification = "invalid-result") {
  try {
    return JSON.parse(text);
  } catch {
    fail(classification);
  }
}

function companionJson(context, args, options = {}) {
  const result = run(process.execPath, [companion, ...args, "--json"], {
    cwd: context.repoRoot,
    env: context.env,
    timeout: options.timeout || commandTimeoutMs
  });
  return parseJson(requireSuccess(result, options.classification || "command-failure"));
}

function stateJobs(context) {
  return loadState(context.stateDir, { pathBoundary: context.stateRoot }).jobs;
}

function savedJob(context, jobId) {
  return stateJobs(context).find((job) => job.id === jobId) || null;
}

function waitForJob(context, jobId, predicate) {
  const deadline = Date.now() + backgroundDeadlineMs;
  while (Date.now() < deadline) {
    const job = savedJob(context, jobId);
    if (job && predicate(job)) return job;
    sleep(pollIntervalMs);
  }
  fail("timeout");
}

function launchBackground(context, args) {
  const launched = companionJson(context, [...args, "--background"]);
  expect(typeof launched.jobId === "string" && launched.jobId, "lifecycle-failure");
  expect(["running", "cancelling"].includes(launched.status), "lifecycle-failure");
  context.managedJobIds.push(launched.jobId);
  return launched;
}

function verifyCompletedJob(context, jobId, expectedResult, expectedSessionId = null) {
  const completed = waitForJob(
    context,
    jobId,
    (job) => terminalStates.has(job.lifecycleState) && job.cleanupStatus !== "pending"
  );
  expect(completed.lifecycleState === "completed", "lifecycle-failure");
  expect(completed.cleanupStatus === "verified", "cleanup-unverified");
  expect(completed.resultState === "available", "invalid-result");
  expect(completed.resultSource === "provider-json", "invalid-result");
  expect(completed.result === expectedResult, "invalid-result");
  expect(isCanonicalResumeReference(completed.canonicalSessionId), "identity-failure");
  expect(completed.resumeSessionId === completed.canonicalSessionId, "identity-failure");
  expect(completed.id !== completed.canonicalSessionId, "identity-failure");
  if (expectedSessionId) expect(completed.canonicalSessionId === expectedSessionId, "identity-failure");
  const control = supervisorPaths(context.stateDir, completed.id);
  expect(!fs.existsSync(control.socket) && !fs.existsSync(control.directory), "cleanup-unverified");
  return completed;
}

function verifyIdempotence(context, job, expectedResult) {
  const monitorOne = companionJson(context, ["monitor", job.id, "--interval-ms", "0", "--max-checks", "1"]);
  const resultOne = companionJson(context, ["result", job.id]);
  const monitorTwo = companionJson(context, ["monitor", job.id, "--interval-ms", "0", "--max-checks", "1"]);
  const resultTwo = companionJson(context, ["result", job.id]);
  expect(monitorOne.lifecycleState === "completed" && monitorTwo.lifecycleState === "completed", "lifecycle-failure");
  expect(resultOne.result === expectedResult && resultTwo.result === expectedResult, "invalid-result");
  expect(
    resultOne.job.resultAuthoritativeAt === job.resultAuthoritativeAt &&
      resultTwo.job.resultAuthoritativeAt === job.resultAuthoritativeAt,
    "lifecycle-failure"
  );
  const cancelled = companionJson(context, ["cancel", job.id]);
  expect(cancelled.status === "completed", "lifecycle-failure");
  const preserved = savedJob(context, job.id);
  expect(preserved.result === expectedResult && preserved.resultAuthoritativeAt === job.resultAuthoritativeAt, "lifecycle-failure");
}

function strictEnvelope(text, expectedResult, expectedSessionId) {
  const envelope = parseJson(text);
  expect(envelope?.type === "result", "invalid-result");
  expect(envelope?.subtype === "success", "invalid-result");
  expect(envelope?.is_error === false, "invalid-result");
  expect(envelope?.result === expectedResult, "invalid-result");
  expect(envelope?.session_id === expectedSessionId, "identity-failure");
}

function allCleanupVerified(context) {
  return stateJobs(context).every((job) => {
    if (job.recordVersion !== 2) return true;
    return terminalStates.has(job.lifecycleState) && job.cleanupStatus === "verified";
  });
}

function cleanupActiveJobs(context) {
  if (!context?.stateDir || !fs.existsSync(context.stateDir)) return true;
  for (const job of stateJobs(context)) {
    if (job.recordVersion !== 2 || terminalStates.has(job.lifecycleState)) continue;
    try {
      companionJson(context, ["cancel", job.id, "--timeout-ms", "10000"]);
    } catch {
      // The fixed cleanup verdict below remains authoritative.
    }
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (allCleanupVerified(context)) return true;
    sleep(100);
  }
  return allCleanupVerified(context);
}

const claudeExecutable = discoverClaude();
const versionOutput = requireSuccess(run(claudeExecutable, ["--version"]), "capability-unavailable");
const version = versionOutput.match(/\b\d+\.\d+\.\d+\b/)?.[0];
expect(version, "capability-unavailable");
console.log(`Claude Code ${version}`);

if (process.env.CLAUDE_PLUGIN_CODEX_RUN_BG_SMOKE !== "1") {
  console.log("Skipping authenticated background smoke; set CLAUDE_PLUGIN_CODEX_RUN_BG_SMOKE=1 to run it.");
  process.exit(0);
}

const help = requireSuccess(run(claudeExecutable, ["--help"]), "capability-unavailable");
for (const required of ["--print", "--output-format", "--resume", "--mcp-config", "--strict-mcp-config", "--no-chrome"]) {
  expect(help.includes(required), "capability-unavailable");
}

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-codex-live-repo-"));
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-codex-live-state-"));
const context = {
  repoRoot,
  stateRoot,
  stateDir: null,
  env: { ...process.env, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
  managedJobIds: []
};
let cleanupVerified = false;
let passed = false;
let failureClassification = null;

try {
  requireSuccess(run("git", ["init", "-q"], { cwd: repoRoot }), "command-failure");
  fs.writeFileSync(path.join(repoRoot, "README.md"), "Synthetic read-only lifecycle smoke.\n", "utf8");
  context.stateDir = resolveStateDir(fs.realpathSync(repoRoot), context.env, stateRoot);

  const firstNonce = randomUUID();
  const firstLaunch = launchBackground(context, [
    "advise", "--effort", "xhigh", "--max-turns", "3",
    "--timeout-ms", String(backgroundDeadlineMs),
    `Reply with exactly ${firstNonce}. Do not inspect or modify files.`
  ]);
  const initialRunning = savedJob(context, firstLaunch.jobId);
  expect(initialRunning?.lifecycleId && initialRunning.lifecycleId !== initialRunning.id, "identity-failure");
  const firstJob = verifyCompletedJob(context, firstLaunch.jobId, firstNonce);
  expect(firstJob.lifecycleId !== firstJob.canonicalSessionId, "identity-failure");
  verifyIdempotence(context, firstJob, firstNonce);

  const secondNonce = randomUUID();
  const foreground = companionJson(context, [
    "rescue", "--resume", "--job-id", firstJob.id, "--effort", "xhigh",
    "--output-format", "json", "--no-background-fallback", "--timeout-ms", String(foregroundTimeoutMs),
    `Reply with exactly ${secondNonce}. Do not inspect or modify files.`
  ], { timeout: foregroundTimeoutMs + commandTimeoutMs, classification: "authentication-unavailable" });
  expect(foreground.status === "completed" && foreground.jobId !== firstJob.id, "lifecycle-failure");
  strictEnvelope(foreground.output, secondNonce, firstJob.canonicalSessionId);
  const foregroundJob = savedJob(context, foreground.jobId);
  expect(foregroundJob?.resumeSessionId === firstJob.canonicalSessionId, "identity-failure");

  const thirdNonce = randomUUID();
  const resumedLaunch = launchBackground(context, [
    "rescue", "--resume", "--job-id", foreground.jobId, "--effort", "xhigh",
    "--max-turns", "3", "--timeout-ms", String(backgroundDeadlineMs),
    `Reply with exactly ${thirdNonce}. Do not inspect or modify files.`
  ]);
  expect(resumedLaunch.jobId !== firstJob.id && resumedLaunch.jobId !== foreground.jobId, "identity-failure");
  const resumedJob = verifyCompletedJob(context, resumedLaunch.jobId, thirdNonce, firstJob.canonicalSessionId);
  verifyIdempotence(context, resumedJob, thirdNonce);

  cleanupVerified = allCleanupVerified(context);
  expect(cleanupVerified, "cleanup-unverified");
  passed = true;
} catch (error) {
  failureClassification = allowedFailures.has(error?.classification) ? error.classification : "unexpected-failure";
} finally {
  cleanupVerified = cleanupActiveJobs(context);
  if (cleanupVerified) {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

if (!passed || !cleanupVerified) {
  console.error(`Authenticated smoke FAIL: ${cleanupVerified ? failureClassification : "cleanup-unverified"}`);
  process.exitCode = 1;
} else {
  console.log("Authenticated supervised print lifecycle passed.");
  console.log("Live cancellation escalation and hostile-output cases were not induced; deterministic tests cover them.");
  console.log("Live write-capable smoke was not run.");
}
