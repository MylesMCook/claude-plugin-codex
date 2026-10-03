#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildClaudeArgs,
  buildReviewPrompt,
  buildSupervisedPrintArgs,
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_DIFF_MAX_BYTES,
  generateJobId,
  isCanonicalResumeReference,
  isSupervisedJob,
  loadState,
  parseClaudeJsonResult,
  renderHuman,
  resolveBackgroundFallbackTimeout,
  resolveStateDir,
  resolveStateRoot,
  resolveWorkspaceIndexDir,
  resolveWorkspaceRoot,
  selectResumeCandidate,
  supervisorPaths,
  SUPERVISED_RECORD_VERSION,
  SUPERVISED_TRANSPORT,
  transactState,
  transitionSupervisedJob,
  updateLatestStateDir,
  upsertJob,
  validateSupervisedClaudeResult,
  validateReviewPayload
} from "./lib/runtime.mjs";

import { discoverClaude, inspectAuthentication, prepareUxTask } from "./lib/local-cli.mjs";

const supervisorScript = fileURLToPath(new URL("./claude-supervisor.mjs", import.meta.url));

const DEFAULT_TIMEOUT_MS = 120000;
const SETUP_LOCAL_TIMEOUT_MS = 10000;
const SETUP_PRINT_TIMEOUT_MS = 60000;
const DEFAULT_TASK_MAX_TURNS = 20;
const DEFAULT_REVIEW_MAX_TURNS = 1;
const DEFAULT_MONITOR_INTERVAL_MS = 30000;
const DEFAULT_MONITOR_CHECKS = 20;
const MAX_MONITOR_CHECKS = 1000;
const MAX_MONITOR_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 120000;
const DEFAULT_CLAUDE_EFFORT = "xhigh";
const SUPPORTED_MAJOR = 2;
const MAX_DIAGNOSTIC_CHARS = 2000;
const DEFAULT_STDOUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const SUPERVISOR_LAUNCH_TIMEOUT_MS = 10000;

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (
      [
        "json",
        "background",
        "write",
        "resume",
        "fresh",
        "watch",
        "follow",
        "forever",
        "no-background-fallback",
        "allow-mcp",
        "allow-web"
      ].includes(key)
    ) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null) {
      throw new Error(`Missing value for --${key}.`);
    }
    options[key] = value;
    index += 1;
  }
  return { options, positionals };
}

function output(value, asJson) {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : renderHuman(value));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stripTerminalControl(value) {
  return String(value || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[78]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function normalizeLogLine(line) {
  return String(line || "")
    .trim()
    .replace(/^⏺\s*/, "")
    .trim();
}

function isMeaningfulLogLine(line) {
  const text = normalizeLogLine(line);
  if (!text) {
    return false;
  }
  const withoutSpinner = text.replace(/^[✢✳✶✻✽·\s]+/, "");
  if (/^[✢✳✶✻✽·]/.test(text)) {
    return false;
  }
  if (text.length < 3) {
    return false;
  }
  if (/^[━─▐▛▜▝▘▌█\s]+$/.test(text)) {
    return false;
  }
  if (text.includes("~/") || /^~?\//.test(text) || /\/effort\b/i.test(text)) {
    return false;
  }
  if (/codex-[a-z]+-/i.test(text)) {
    return false;
  }
  if (/^[❯>]+$/.test(text)) {
    return false;
  }
  if (/^❯/.test(text)) {
    return false;
  }
  if (/^claude code$/i.test(text)) {
    return false;
  }
  if (/^welcome back\b/i.test(text) || /^you:\s/i.test(text) || /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(text)) {
    return false;
  }
  if (/\b(?:claude pro|organization)\b/i.test(text)) {
    return false;
  }
  if (/claude codev?\d/i.test(text)) {
    return false;
  }
  if (/^warning: the 'NO_COLOR' env is ignored/i.test(text) || /^at\s+/.test(text) || /\binternal:/.test(text)) {
    return false;
  }
  if (/opus|sonnet|haiku|claude max/i.test(text)) {
    return false;
  }
  if (/thinking with .* effort/i.test(text)) {
    return false;
  }
  if (/^(zigzagging|hyperspacing|whisking|honking|thinking|cogitated|cooking|cooked|churned|worked)\b/i.test(withoutSpinner)) {
    return false;
  }
  if (/^[a-z]{1,3}$/i.test(withoutSpinner)) {
    return false;
  }
  if (/^[a-z]+…\d*$/i.test(withoutSpinner)) {
    return false;
  }
  if (/^\(\d+s\s+·\s+↓\d+\s+tokens\)$/i.test(withoutSpinner)) {
    return false;
  }
  if (/^running .* hook\b/i.test(withoutSpinner)) {
    return false;
  }
  if (/^ctx:\d+%/i.test(withoutSpinner)) {
    return false;
  }
  if (/^claude in chrome\b/i.test(withoutSpinner)) {
    return false;
  }
  if (/^try "/i.test(withoutSpinner)) {
    return false;
  }
  if (/plan mode on/i.test(text)) {
    return false;
  }
  if (/^(esc|ctrl|shift|enter|tab)\b/i.test(text)) {
    return false;
  }
  if (/^(mcp|warning: mcp|connecting|connected)\b/i.test(text)) {
    return false;
  }
  if (/^[.·*\-_=|/\\()[\]{}<>:;,'"~`!@#$%^&+\s]+$/.test(text)) {
    return false;
  }
  return true;
}

function extractMeaningfulLogLines(output) {
  return stripTerminalControl(output)
    .split(/\r?\n/)
    .map(normalizeLogLine)
    .filter(isMeaningfulLogLine);
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function runClaude(args, options = {}) {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const result = spawnSync(discoverClaude({ env }), args, {
    cwd: options.cwd || process.cwd(),
    env,
    encoding: options.rawOutput ? null : "utf8",
    input: options.input,
    killSignal: options.killSignal || "SIGTERM",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw Object.assign(new Error(`Claude command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`), {
      code: "ETIMEDOUT"
    });
  }
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`Claude command ended from signal ${result.signal}.`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    signal: result.signal || null
  };
}

function isTimeoutError(error) {
  return /timed out after \d+ms/i.test(String(error?.message || error || ""));
}

function isMaxTurnLimitOutput(value) {
  const text = String(value || "");
  return /\b(?:hit|reached)\s+(?:the\s+)?max[- ]turns?\b/i.test(text) || /\bmax[- ]turn limit\b/i.test(text);
}

function setupProbe(commandArgs, input, timeoutMs = SETUP_LOCAL_TIMEOUT_MS) {
  try {
    const result = runClaude(commandArgs, { input, timeoutMs });
    return result.status === 0 ? "passed" : "failed";
  } catch (error) {
    // Setup diagnostics must not include CLI output or exception text.
    return error?.code === "ETIMEDOUT" ? "timeout" : "error";
  }
}

function parseClaudeVersion(stdout) {
  const version = String(stdout || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!version) {
    return { raw: String(stdout || "").trim(), supported: false };
  }
  const major = Number(version[1]);
  return {
    raw: String(stdout || "").trim(),
    major,
    minor: Number(version[2]),
    patch: Number(version[3]),
    supported: major === SUPPORTED_MAJOR || process.env.CLAUDE_PLUGIN_CODEX_ALLOW_UNKNOWN_CLAUDE === "1"
  };
}

function currentContext(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateRoot = resolveStateRoot(process.env);
  const stateDir = resolveStateDir(workspaceRoot, process.env, stateRoot);
  const indexDir = resolveWorkspaceIndexDir(workspaceRoot, process.env, stateRoot);
  return {
    cwd,
    workspaceRoot,
    stateRoot,
    stateDir,
    indexDir,
    state: loadState(stateDir, { pathBoundary: stateRoot })
  };
}

function boundedDiagnostic(value) {
  return stripTerminalControl(value)
    .replaceAll(os.homedir(), "<home>")
    .replace(/(?:^|\s)\/?(?:Users|home)\/[\w.-]+\//g, " <path>/")
    .slice(0, MAX_DIAGNOSTIC_CHARS)
    .trim();
}

function classifyStructuredAgentFailure(error) {
  const classification = error instanceof Error ? error.message : "";
  if ([
    "structured-agent-json-empty",
    "structured-agent-json-invalid",
    "structured-agent-schema-invalid"
  ].includes(classification)) {
    return classification;
  }
  return "structured-agent-command-unavailable";
}

function findProjectMcpConfig(ctx) {
  const checked = new Set();
  let current = ctx.cwd;
  while (true) {
    const configPath = path.join(current, ".mcp.json");
    if (!checked.has(configPath) && fs.existsSync(configPath)) {
      return configPath;
    }
    checked.add(configPath);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function assertBackgroundMcpSafe(ctx, options = {}) {
  if (options["allow-mcp"]) {
    return;
  }
  const configPath = findProjectMcpConfig(ctx);
  if (!configPath) {
    return;
  }
  throw new Error(
    [
      `Refusing Claude background mode because ${configPath} exists.`,
      "Claude Code background mode can still open an MCP permission picker before noninteractive flags take effect.",
      "MCP is disabled unless the user explicitly asks for it.",
      "Run foreground, or pass --allow-mcp only after explicit user approval."
    ].join(" ")
  );
}

function persistContext(ctx, mutator) {
  const saved = transactState(ctx.stateDir, mutator, { pathBoundary: ctx.stateRoot });
  updateLatestStateDir(ctx.indexDir, ctx.stateDir, { pathBoundary: ctx.stateRoot });
  ctx.state = saved;
  return saved;
}

function isReviewJob(job) {
  return ["review", "adversarial-review"].includes(job?.kind);
}

function readValidatedReviewResult(job) {
  if (
    job.status !== "completed" ||
    (job.lifecycleState && job.lifecycleState !== "completed") ||
    job.resultState !== "available" ||
    job.resultSource !== "provider-json" ||
    typeof job.resultAuthoritativeAt !== "string" ||
    !Number.isFinite(Date.parse(job.resultAuthoritativeAt)) ||
    !isCanonicalResumeReference(job.resumeSessionId) ||
    job.canonicalSessionId !== job.resumeSessionId ||
    job.failureClassification || job.failureDiagnostic || job.resultDiagnostic
  ) return null;
  try {
    // Older foreground timeouts could create supervised review jobs. Their
    // envelope was validated, but their string result still needs a review check.
    if (isSupervisedJob(job)) {
      if (job.lifecycleState !== "completed" || typeof job.result !== "string") return null;
      const parsed = parseClaudeJsonResult(JSON.stringify({ result: job.result }));
      return validateReviewPayload(parsed.contentRaw);
    }
    if (job.claudeSessionId !== job.resumeSessionId ||
        !job.result || typeof job.result !== "object" || Array.isArray(job.result)) return null;
    return validateReviewPayload(JSON.stringify(job.result));
  } catch {
    return null;
  }
}

function reviewUnavailableDiagnostic(job) {
  // These labels describe recorded metadata, not independently proven provider
  // behaviour. Never copy stored diagnostic text or infer result authority.
  if (job.status === "failed" &&
      (job.lifecycleState == null || job.lifecycleState === "failed") &&
      job.resultState === "unavailable" && job.result == null &&
      job.resultSource == null && job.resultAuthoritativeAt == null) {
    let cause;
    switch (job.failureClassification) {
      case "command-failure": cause = "the Claude command failed."; break;
      case "invalid-result": cause = "the returned result failed validation."; break;
      case "timeout": cause = "the Claude command timed out."; break;
    }
    if (cause) return `Claude review result is unavailable. Recorded failure metadata: ${cause}`;
  }
  return "Claude review result is unavailable because validated review authority is missing.";
}

function publicJob(job) {
  if (isReviewJob(job)) {
    const result = readValidatedReviewResult(job);
    if (result) {
      // Even proven legacy reviews may retain an envelope with surrounding raw
      // output. Only the validated findings and their provenance are public.
      const fields = [
        "id", "kind", "status", "write", "codexThreadId", "workspaceRoot",
        "createdAt", "updatedAt", "lifecycleState", "result", "resultState",
        "resultSource", "resultAuthoritativeAt", "claudeSessionId",
        "canonicalSessionId", "resumeSessionId", "recordVersion", "transport",
        "lifecycleId", "cleanupStatus", "terminalAt"
      ];
      return { ...Object.fromEntries(fields.filter((field) => Object.hasOwn(job, field)).map((field) => [field, job[field]])), result };
    }
    // Readback must not turn a legacy completion flag or raw envelope into
    // review authority. Project a fixed diagnostic without rewriting evidence.
    const diagnostic = reviewUnavailableDiagnostic(job);
    return {
      id: job.id,
      kind: job.kind,
      status: ["created", "starting", "running", "cancelling", "cancelled", "failed", "interrupted", "timed_out"].includes(job.status)
        ? job.status : "interrupted",
      write: Boolean(job.write),
      result: null,
      resultState: "unavailable",
      resultDiagnostic: diagnostic,
      failureDiagnostic: diagnostic
    };
  }
  if (!job || !isSupervisedJob(job)) return job;
  const { supervisor: _supervisor, ...safe } = job;
  return safe;
}

function boundedPositiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Invalid bounded lifecycle configuration.");
  }
  return parsed;
}

function transitionManaged(ctx, jobId, transition) {
  const result = transitionSupervisedJob(ctx.stateDir, jobId, transition, { pathBoundary: ctx.stateRoot });
  ctx.state = loadState(ctx.stateDir, { pathBoundary: ctx.stateRoot });
  updateLatestStateDir(ctx.indexDir, ctx.stateDir, { pathBoundary: ctx.stateRoot });
  return result;
}

function sendSupervisorCommand(ctx, job, command, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const control = supervisorPaths(ctx.stateDir, job.id);
    const socket = net.createConnection(control.socket);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs);
    socket.on("connect", () => socket.end(JSON.stringify({
      token: job.supervisor?.token,
      command
    })));
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4096) finish({ ok: false });
      else chunks.push(Buffer.from(chunk));
    });
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish(parsed?.ok === true ? parsed : { ok: false });
      } catch {
        finish({ ok: false });
      }
    });
    socket.on("error", () => finish({ ok: false }));
  });
}

function launchSupervisor(config) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [supervisorScript], {
      cwd: config.cwd,
      env: process.env,
      detached: true,
      shell: false,
      stdio: ["pipe", "ignore", "ignore", "ipc"]
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      child.removeAllListeners("message");
      if (child.connected) child.disconnect();
      child.unref();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, classification: "interrupted-supervisor" }), SUPERVISOR_LAUNCH_TIMEOUT_MS);
    child.once("error", () => finish({ ok: false, classification: "spawn-failure" }));
    child.once("exit", () => finish({ ok: false, classification: "worker-failure" }));
    child.on("message", (message) => {
      if (message?.type === "ready") finish({ ok: true, pid: child.pid });
      if (message?.type === "failed") finish({ ok: false, classification: message.classification || "worker-failure" });
    });
    child.stdin.once("error", () => finish({ ok: false, classification: "spawn-failure" }));
    child.stdin.end(JSON.stringify(config));
  });
}

function runGit(cwd, args, label, maxBuffer = DEFAULT_DIFF_MAX_BYTES) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer });
  if (result.error) {
    const overflow = result.error.code === "ENOBUFS" || /maxbuffer|buffer/i.test(result.error.message || "");
    if (overflow) {
      throw new Error(
        `${label} exceeded the ${DEFAULT_DIFF_MAX_BYTES}-byte review limit. Narrow or split the change, then rerun the review.`
      );
    }
    throw new Error(`${label} could not be captured because Git failed to execute (${result.error.code || "unknown error"}).`);
  }
  if (result.signal) {
    throw new Error(`${label} could not be captured because Git ended from signal ${result.signal}.`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} could not be captured because Git exited with status ${result.status}.`);
  }
  const stdout = result.stdout || "";
  if (Buffer.byteLength(stdout, "utf8") > maxBuffer) {
    throw new Error(
      `${label} exceeded the ${DEFAULT_DIFF_MAX_BYTES}-byte review limit. Narrow or split the change, then rerun the review.`
    );
  }
  return stdout;
}

function gitContext(cwd, options = {}) {
  const target = options.base ? `${options.base}...HEAD` : null;
  if (!target) {
    const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard"], "Untracked-file check", 256 * 1024);
    const paths = untracked.trim().split(/\r?\n/).filter(Boolean);
    if (paths.length) {
      const shown = paths.slice(0, 20).map((file) => `- ${file}`).join("\n");
      const remaining = paths.length > 20 ? `\n- ...and ${paths.length - 20} more` : "";
      throw new Error(
        `Working-tree review cannot safely include untracked file contents. Stage the intended files first:\n${shown}${remaining}`
      );
    }
  }
  const args = target ? ["diff", "--stat", target] : ["status", "--short", "--untracked-files=all"];
  const first = runGit(cwd, args, "Git review summary", 256 * 1024);
  const diffArgs = target ? ["diff", target, "--"] : ["diff", "HEAD", "--"];
  const diff = runGit(cwd, diffArgs, target ? "Base review diff" : "Working-tree review diff");
  return [first, diff].join("\n").trim();
}

function detectCapabilities() {
  const versionResult = runClaude(["--version"], { timeoutMs: SETUP_LOCAL_TIMEOUT_MS });
  const version = parseClaudeVersion(versionResult.stdout || versionResult.stderr);
  const authProbe = setupProbe(["auth", "status", "--text"]);
  const authStatus = authProbe === "passed" ? "available" : authProbe === "failed" ? "unavailable" : "check-failed";
  let printProbe;
  if (!version.supported || authStatus !== "available") {
    printProbe = {
      status: "skipped",
      reason: !version.supported ? "unsupported-version" : `authentication-${authStatus}`
    };
  } else {
    const prompt = "Return {}";
    const outcome = setupProbe(buildClaudeArgs({
      mode: "review",
      prompt,
      maxTurns: 1,
      // This is a trivial readiness check, not substantive review work.
      effort: "low"
    }), prompt, SETUP_PRINT_TIMEOUT_MS);
    printProbe = {
      status: outcome === "passed" ? "passed" : "failed",
      reason: outcome === "passed" ? null
        : outcome === "failed" ? "command-failed"
          : outcome === "timeout" ? "command-timeout" : "command-error"
    };
  }
  const print = printProbe.status === "passed";
  const background = version.supported && print && process.platform === "darwin";
  return {
    version,
    auth: {
      loggedIn: authStatus === "available",
      status: authStatus,
      scope: "current-process"
    },
    print,
    printProbe,
    background
  };
}

function handleSetup(argv) {
  const { options } = parseArgs(argv);
  const ctx = currentContext(options);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const capabilities = detectCapabilities();
  const ready = nodeMajor >= 18 && capabilities.version.supported && capabilities.auth.loggedIn && capabilities.print;
  const state = persistContext(ctx, (current) => ({ ...current, capabilities }));
  output(
    {
      ready,
      node: { version: process.version, supported: nodeMajor >= 18 },
      capabilities: state.capabilities,
      stateDir: ctx.stateDir
    },
    options.json
  );
}

function createJob(ctx, kind, options = {}) {
  return {
    id: generateJobId(kind),
    kind,
    status: options.status || "running",
    write: Boolean(options.write),
    codexThreadId: process.env.CODEX_THREAD_ID || null,
    workspaceRoot: ctx.workspaceRoot,
    summary: options.summary || kind
  };
}

function insertJob(ctx, job) {
  const state = persistContext(ctx, (current) => {
    if (current.jobs.some((item) => item.id === job.id)) {
      throw new Error(`Claude job id collision: ${job.id}.`);
    }
    return upsertJob(current, job);
  });
  return state.jobs.find((item) => item.id === job.id);
}

function completeJob(ctx, job, patch) {
  const jobId = typeof job === "string" ? job : job.id;
  const state = persistContext(ctx, (current) => {
    const existing = current.jobs.find((item) => item.id === jobId);
    if (!existing) {
      throw new Error(`Claude job disappeared during state update: ${jobId}.`);
    }
    const nextPatch = { ...patch };
    if (existing.resultAuthoritativeAt && Object.hasOwn(nextPatch, "result")) {
      if (existing.result !== nextPatch.result) {
        throw new Error(`Refusing to overwrite authoritative result for Claude job ${jobId}.`);
      }
      delete nextPatch.result;
    }
    if (existing.resultAuthoritativeAt) {
      for (const field of ["resultState", "resultDiagnostic", "resultSource", "resultAuthoritativeAt"]) {
        delete nextPatch[field];
      }
    }
    if (
      (["completed", "cancelled"].includes(existing.status) && nextPatch.status !== existing.status) ||
      (["failed", "timed_out"].includes(existing.status) &&
        ["launching", "running", "active", "unknown", "unavailable"].includes(nextPatch.status)) ||
      (existing.status === "launch_uncertain" && ["unknown", "unavailable"].includes(nextPatch.status))
    ) {
      delete nextPatch.status;
    }
    if (
      ["completed", "cancelled"].includes(existing.lifecycleState) &&
      nextPatch.lifecycleState !== existing.lifecycleState
    ) {
      delete nextPatch.lifecycleState;
    }
    if (
      existing.lifecycleState === "launch_uncertain" &&
      ["unknown", "unavailable"].includes(nextPatch.lifecycleState)
    ) {
      delete nextPatch.lifecycleState;
    }
    return upsertJob(current, { id: jobId, ...nextPatch });
  });
  return state.jobs.find((item) => item.id === jobId);
}

function hasValidatedResumeAuthority(candidate) {
  return Boolean(candidate &&
    (!isReviewJob(candidate) || readValidatedReviewResult(candidate)) &&
    [candidate.lifecycleState, candidate.status].includes("completed") &&
    candidate.resultSource === "provider-json" &&
    isCanonicalResumeReference(candidate.resumeSessionId)
  );
}

function resolveJobResumeReference(ctx, candidate, options = {}) {
  if (hasValidatedResumeAuthority(candidate)) {
    return candidate.resumeSessionId;
  }
  void ctx;
  void options;
  throw new Error("Claude resume identity is unavailable because it was not validated from a provider JSON result.");
}

async function runForeground(ctx, kind, prompt, options = {}) {
  const isReview = kind === "review" || kind === "adversarial-review";
  const resume = options.resume
    ? selectResumeCandidate(ctx.state.jobs, process.env, {
        explicitJobId: options["job-id"] || null,
        write: Boolean(options.write)
      })
    : null;
  if (options.resume && !resume) {
    throw new Error("No safe Claude job is available to resume. Pass an exact --job-id or start fresh.");
  }
  const resumeSessionId = resume ? resolveJobResumeReference(ctx, resume, options) : null;
  const providerOutputFormat = resumeSessionId ? "json" : (options.outputFormat || "text");
  const job = createJob(ctx, kind, { write: options.write, summary: `${kind} task` });
  insertJob(ctx, job);
  const args = buildClaudeArgs({
    mode: kind,
    prompt,
    outputFormat: providerOutputFormat,
    maxTurns: Number(options.maxTurns || DEFAULT_TASK_MAX_TURNS),
    write: Boolean(options.write),
    resumeSessionId,
    model: options.model || null,
    effort: options.effort || DEFAULT_CLAUDE_EFFORT,
    allowMcp: Boolean(options["allow-mcp"]),
    allowWeb: Boolean(options["allow-web"])
  });
  let result;
  try {
    result = runClaude(args, {
      cwd: ctx.cwd,
      input: prompt,
      rawOutput: isReview,
      killSignal: kind === "ux" ? "SIGKILL" : "SIGTERM",
      timeoutMs: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    if (isReview) {
      return failReviewJob(ctx, job, error?.code === "ETIMEDOUT" ? "timeout" : "command-failure");
    }
    if (isTimeoutError(error) && !options["no-background-fallback"]) {
      completeJob(ctx, job, {
        status: "timed_out",
        failureDiagnostic: `Claude command timed out after ${Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)}ms.`,
        result: `Claude command timed out after ${Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)}ms.`
      });
      if (ctx.state.capabilities && !ctx.state.capabilities.background) {
        throw error;
      }
      return await runBackground(ctx, kind, prompt, {
        ...options,
        "timeout-ms": resolveBackgroundFallbackTimeout(options),
        fallbackFromJobId: job.id,
        fallbackReason: "foreground-timeout",
        fallbackMessage: `Foreground Claude timed out after ${Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)}ms; launched a background job.`
      });
    }
    completeJob(ctx, job, {
      status: "failed",
      failureDiagnostic: "Claude command failed before returning a supported result.",
      result: "Claude command failed before returning a supported result."
    });
    throw error;
  }
  if (isReview) {
    if (result.status !== 0) return failReviewJob(ctx, job, "command-failure");
    let envelope;
    let parsed;
    try {
      envelope = validateSupervisedClaudeResult(result.stdout, resumeSessionId);
      parsed = validateReviewPayload(parseClaudeJsonResult(result.stdout.toString("utf8")).contentRaw);
    } catch {
      return failReviewJob(ctx, job, "invalid-result");
    }
    return completeJob(ctx, job, {
      status: "completed",
      result: parsed,
      resultState: "available",
      resultSource: "provider-json",
      resultAuthoritativeAt: new Date().toISOString(),
      claudeSessionId: envelope.sessionId,
      canonicalSessionId: envelope.sessionId,
      resumeSessionId: envelope.sessionId,
      failureDiagnostic: null
    });
  }
  const status = result.status === 0 ? "completed" : "failed";
  const failedForMaxTurns = result.status !== 0 && isMaxTurnLimitOutput(`${result.stdout}\n${result.stderr}`);
  let validatedResume = null;
  if (result.status === 0 && resumeSessionId) {
    try {
      validatedResume = validateSupervisedClaudeResult(Buffer.from(result.stdout, "utf8"), resumeSessionId);
    } catch {
      const failed = completeJob(ctx, job, {
        status: "failed",
        failureDiagnostic: "Claude returned an invalid resumed result envelope.",
        result: "Claude returned an invalid resumed result envelope."
      });
      return { ...failed, stdout: "", stderr: "" };
    }
  }
  const completed = completeJob(ctx, job, {
    status,
    resumeSessionId: validatedResume?.sessionId || resumeSessionId,
    canonicalSessionId: validatedResume?.sessionId,
    resultSource: validatedResume ? "provider-json" : undefined,
    resultState: validatedResume ? "available" : undefined,
    resultAuthoritativeAt: validatedResume ? new Date().toISOString() : undefined,
    failureDiagnostic: result.status === 0
      ? null
      : failedForMaxTurns
        ? "Claude hit the max-turn limit."
        : `Claude command returned non-zero status ${result.status}.`,
    result: result.status === 0
      ? validatedResume?.result ?? result.stdout.trim()
      : failedForMaxTurns
        ? "Claude hit the max-turn limit. Rerun with `--max-turns <higher>` or narrow the task."
        : `Claude command failed with status ${result.status}.`
  });
  return { ...completed, stdout: result.stdout, stderr: result.stderr };
}

async function runBackground(ctx, kind, prompt, options = {}) {
  assertBackgroundMcpSafe(ctx, options);
  if (process.platform !== "darwin") {
    throw new Error("Claude supervised background mode is unavailable on this platform.");
  }
  if (!prompt || !String(prompt).trim()) throw new Error("A prompt is required.");
  const resume = options.resume
    ? selectResumeCandidate(ctx.state.jobs, process.env, {
        explicitJobId: options["job-id"] || null,
        write: Boolean(options.write)
      })
    : null;
  if (options.resume && !resume) {
    throw new Error("No safe Claude job is available to resume. Pass an exact --job-id or start fresh.");
  }
  const resumeSessionId = resume ? resolveJobResumeReference(ctx, resume, options) : null;
  const jobId = generateJobId(kind);
  const token = randomUUID();
  const lifecycleId = `supervisor-${randomUUID()}`;
  const job = {
    id: jobId,
    recordVersion: SUPERVISED_RECORD_VERSION,
    transport: SUPERVISED_TRANSPORT,
    stateGeneration: 0,
    lifecycleState: "created",
    status: "created",
    kind,
    authority: options.write ? "write" : "read",
    write: Boolean(options.write),
    codexThreadId: process.env.CODEX_THREAD_ID || null,
    lifecycleId,
    resultState: "unavailable",
    cleanupStatus: "pending",
    resumeSessionId,
    resumedFromJobId: resume?.id ?? null,
    notice: options.fallbackMessage || null,
    fallbackFromJobId: options.fallbackFromJobId || null,
    fallbackReason: options.fallbackReason || null,
    supervisor: { token, pid: null }
  };
  insertJob(ctx, job);
  const starting = transitionManaged(ctx, job.id, {
    expectedGeneration: 0,
    expectedStates: ["created"],
    toState: "starting",
    patch: { startingAt: new Date().toISOString() }
  });
  if (!starting.applied) throw new Error("Claude supervisor could not claim the created job.");
  const claudeArgs = buildSupervisedPrintArgs({
    mode: kind,
    write: Boolean(options.write),
    resumeSessionId,
    model: options.model || null,
    effort: options.effort || DEFAULT_CLAUDE_EFFORT,
    allowMcp: Boolean(options["allow-mcp"]),
    allowWeb: Boolean(options["allow-web"]),
    maxTurns: boundedPositiveInteger(options["max-turns"], DEFAULT_TASK_MAX_TURNS, 1, 1000)
  });
  const launched = await launchSupervisor({
    jobId,
    token,
    prompt,
    claudeArgs,
    cwd: ctx.cwd,
    stateDir: ctx.stateDir,
    stateRoot: ctx.stateRoot,
    expectedSessionId: resumeSessionId,
    timeoutMs: boundedPositiveInteger(options["timeout-ms"], DEFAULT_BACKGROUND_TIMEOUT_MS, 100, 24 * 60 * 60 * 1000),
    stdoutLimitBytes: boundedPositiveInteger(
      process.env.CLAUDE_COMPANION_STDOUT_LIMIT_BYTES,
      DEFAULT_STDOUT_LIMIT_BYTES,
      64,
      16 * 1024 * 1024
    ),
    stderrLimitBytes: boundedPositiveInteger(
      process.env.CLAUDE_COMPANION_STDERR_LIMIT_BYTES,
      DEFAULT_STDERR_LIMIT_BYTES,
      64,
      4 * 1024 * 1024
    )
  });
  ctx.state = loadState(ctx.stateDir, { pathBoundary: ctx.stateRoot });
  let current = ctx.state.jobs.find((item) => item.id === jobId);
  if (!launched.ok && current?.lifecycleState === "starting") {
    current = transitionManaged(ctx, jobId, {
      expectedStates: ["starting"],
      toState: "interrupted",
      patch: {
        failureClassification: launched.classification || "interrupted-supervisor",
        cleanupStatus: "failed",
        terminalAt: new Date().toISOString()
      }
    }).job;
  }
  if (!launched.ok && current?.lifecycleState !== "running") {
    throw new Error("Claude supervised background launch failed.");
  }
  return current;
}

async function handleTaskCommand(argv, kind) {
  const { options, positionals } = parseArgs(argv);
  const ctx = currentContext(options);
  let prompt = positionals.join(" ").trim();
  if (kind === "ux") {
    const prepared = prepareUxTask(options, prompt);
    Object.assign(options, prepared.options);
    prompt = prepared.prompt;
    let auth;
    try { auth = inspectAuthentication(runClaude(["auth", "status"], { timeoutMs: SETUP_LOCAL_TIMEOUT_MS, killSignal: "SIGKILL" })); }
    catch { throw new Error("UX authentication check failed; no advice call was made."); }
    if (!auth.loggedIn || auth.billingSource !== options["billing-source"]) {
      throw new Error(`UX authentication/billing check refused: loggedIn=${auth.loggedIn}, billingSource=${auth.billingSource}. No advice call was made.`);
    }
  }
  const job = options.background
    ? await runBackground(ctx, kind, prompt, options)
    : await runForeground(ctx, kind, prompt, {
        ...options,
        outputFormat: options["output-format"] || "text",
        maxTurns: options["max-turns"],
        timeoutMs: options["timeout-ms"]
      });
  output(
    {
      jobId: job.id,
      status: job.status,
      claudeSessionId: job.claudeSessionId ?? null,
      output: job.result ?? job.notice ?? job.stdout ?? ""
    },
    options.json
  );
  if (job.status === "failed") process.exitCode = 1;
}

async function handleAdvise(argv) {
  await handleTaskCommand(argv, "advise");
}

async function handleRescue(argv) {
  await handleTaskCommand(argv, "rescue");
}

async function handleDo(argv) {
  await handleTaskCommand(argv, "do");
}

function failReviewJob(ctx, job, classification) {
  const diagnostic = `Claude review failed: ${classification}.`;
  return completeJob(ctx, job, {
    status: "failed",
    result: null,
    resultState: "unavailable",
    failureClassification: classification,
    failureDiagnostic: diagnostic,
    resultDiagnostic: diagnostic
  });
}

async function handleReview(argv, kind) {
  const { options, positionals } = parseArgs(argv);
  if (options.write) {
    throw new Error(`${kind} is read-only and does not support --write. Use advise, do or rescue --write for write-capable work.`);
  }
  const ctx = currentContext(options);
  const focus = positionals.join(" ").trim();
  const prompt = buildReviewPrompt({
    kind,
    targetLabel: options.base ? `${options.base}...HEAD` : "working tree",
    gitContext: gitContext(ctx.cwd, options),
    focus
  });
  const reviewOptions = {
    ...options,
    outputFormat: "json",
    maxTurns: options["max-turns"] || DEFAULT_REVIEW_MAX_TURNS,
    timeoutMs: options["timeout-ms"]
  };
  let job = await runForeground(ctx, kind, prompt, reviewOptions);
  if (job.failureClassification === "invalid-result") {
    job = await runForeground(ctx, kind, `${prompt}\n\nYour previous response was invalid. Return JSON only with the required findings schema.`, {
      ...reviewOptions,
      maxTurns: 1
    });
  }
  if (job.status !== "completed") {
    output({ jobId: job.id, status: job.status, diagnostic: job.failureDiagnostic }, options.json);
    process.exitCode = 1;
    return;
  }
  output({ jobId: job.id, status: job.status, result: job.result }, options.json);
}

function findJob(ctx, reference) {
  if (!reference) {
    return ctx.state.jobs[0] || null;
  }
  const matches = ctx.state.jobs.filter(
    (job) =>
      job.id === reference ||
      job.lifecycleId === reference ||
      (!isCanonicalResumeReference(job.claudeSessionId) && job.claudeSessionId === reference)
  );
  if (matches.length > 1) {
    throw new Error("Claude lifecycle reference is ambiguous. Use the exact managed job ID.");
  }
  if (matches.length === 0 && isCanonicalResumeReference(reference)) {
    throw new Error("A canonical resume UUID cannot identify a lifecycle job. Use the exact managed job ID or lifecycle ID.");
  }
  return matches[0] || null;
}

function classifyAgentLifecycle(match) {
  if (!match) return "unavailable";
  const state = String(match.state || "").toLowerCase();
  const status = String(match.status || "").toLowerCase();
  if (
    ["done", "complete", "completed", "finished"].includes(state) ||
    ["done", "complete", "completed", "finished"].includes(status)
  ) return "completed";
  if (["cancelled", "canceled", "stopped"].includes(state) || ["cancelled", "canceled", "stopped"].includes(status)) {
    return "cancelled";
  }
  if (["failed", "error"].includes(state) || ["failed", "error"].includes(status)) return "unavailable";
  if (
    ["active", "running", "working", "busy", "starting", "blocked", "stalled"].includes(state) ||
    ["active", "running", "working", "busy", "starting", "blocked", "stalled"].includes(status)
  ) return "active";
  return "unknown";
}

function publicAgentMatch(match) {
  if (!match) return null;
  return {
    id: match.id ?? match.agentId ?? match.agent_id ?? null,
    sessionId: match.sessionId ?? match.session_id ?? null,
    name: match.name ?? match.title ?? null,
    kind: match.kind ?? null,
    status: match.status ?? null,
    state: match.state ?? null
  };
}

function readLiveStatus(job, options = {}) {
  void options;
  const available = Boolean(job.resultAuthoritativeAt && job.resultState === "available");
  return {
    checkedAt: new Date().toISOString(),
    jobId: job.id,
    lifecycleId: job.lifecycleId || null,
    resumeSessionId: job.resumeSessionId || null,
    lifecycleState: available ? "completed" : "interrupted",
    active: false,
    completed: available,
    available,
    result: available
      ? { state: "available", result: job.result, source: job.resultSource || "legacy-authoritative" }
      : { state: "unavailable", reason: "legacy-lifecycle-unsupported" },
    logs: { available: false, output: "", meaningfulOutput: "" },
    error: available ? null : "Legacy live lifecycle recovery is unsupported."
  };
}

function summarizeLiveStatus(snapshot, monitorState = {}, options = {}) {
  const staleAfterMs = Number(options["stale-after-ms"] ?? DEFAULT_STALE_AFTER_MS);
  const nowMs = Date.parse(snapshot.checkedAt) || Date.now();
  const meaningfulOutput = snapshot.logs?.meaningfulOutput || "";
  const meaningfulLines = meaningfulOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fingerprint = meaningfulLines.join("\n");
  const previousFingerprint = monitorState.meaningfulFingerprint || null;
  const isRepeatedMeaningfulOutput = Boolean(fingerprint && previousFingerprint === fingerprint);

  if (fingerprint && previousFingerprint !== fingerprint) {
    monitorState.meaningfulFingerprint = fingerprint;
    monitorState.meaningfulChangedAtMs = nowMs;
    monitorState.repeatedMeaningfulChecks = 0;
  } else if (fingerprint && previousFingerprint === fingerprint) {
    monitorState.repeatedMeaningfulChecks = (monitorState.repeatedMeaningfulChecks || 0) + 1;
  }

  const changedAtMs = monitorState.meaningfulChangedAtMs || nowMs;
  const staleForMs = isRepeatedMeaningfulOutput ? Math.max(0, nowMs - changedAtMs) : 0;
  const stale = Boolean(snapshot.active && fingerprint && isRepeatedMeaningfulOutput && staleForMs >= staleAfterMs);
  const lastMeaningfulLine = meaningfulLines.at(-1) || null;
  let state = snapshot.lifecycleState || (snapshot.active ? "active" : "unknown");
  if (stale) {
    state = "stale";
  }

  let suggestedAction = "Inspect the explicit lifecycle and result state.";
  if (state === "active") {
    suggestedAction = snapshot.result?.state === "available"
      ? "The final result is captured. Stop the still-active background session or keep monitoring it to a structured terminal state."
      : "Wait or keep monitoring.";
  } else if (state === "stale") {
    suggestedAction = "Claude may be stalled. Continue monitoring, inspect logs, or cancel the job.";
  } else if (state === "unavailable") {
    suggestedAction = "Check whether Claude Code is installed and the background session still exists.";
  } else if (state === "ambiguous") {
    suggestedAction = "Resolve the duplicate structured session match before monitoring or resuming.";
  } else if (state === "completed" && snapshot.result?.state !== "available") {
    suggestedAction = "The job completed, but its final answer is unavailable or ambiguous. Inspect diagnostics; do not treat progress as the result.";
  }

  return {
    ...snapshot,
    summary: {
      state,
      active: snapshot.active,
      lastMeaningfulLine,
      stale,
      staleForMs,
      staleFor: formatDuration(staleForMs),
      suggestedAction
    }
  };
}

function persistMonitorSnapshot(ctx, job, snapshot) {
  const summary = snapshot.summary || summarizeLiveStatus(snapshot).summary;
  const meaningfulOutput = String(snapshot.logs?.meaningfulOutput || "").trim();
  const patch = {
    lastMonitoredAt: snapshot.checkedAt,
    lifecycleState: snapshot.lifecycleState,
    lifecycleId: snapshot.lifecycleId || job.lifecycleId || job.claudeSessionId || null,
    claudeSessionId: snapshot.lifecycleId || job.lifecycleId || job.claudeSessionId || null,
    resumeSessionId: snapshot.resumeSessionId || job.resumeSessionId || null,
    lastMonitorSnapshot: {
      checkedAt: snapshot.checkedAt,
      active: snapshot.active,
      available: snapshot.available,
      lifecycleState: snapshot.lifecycleState,
      resultState: snapshot.result?.state || "unavailable",
      summary: {
        ...summary,
        lastMeaningfulLine: summary.lastMeaningfulLine ? "[progress available]" : null
      },
      logsAvailable: Boolean(snapshot.logs?.available),
      agentsAvailable: Boolean(snapshot.agents?.available)
    }
  };
  const statusByLifecycle = {
    active: "running",
    completed: "completed",
    cancelled: "cancelled",
    unavailable: "unavailable",
    ambiguous: "ambiguous",
    unknown: "unknown"
  };
  patch.status = statusByLifecycle[snapshot.lifecycleState] || job.status;
  if (meaningfulOutput) {
    patch.progressObservedAt = snapshot.checkedAt;
  }
  if (snapshot.completed || snapshot.result?.state === "available") {
    patch.resultState = snapshot.result?.state || "unavailable";
    patch.resultDiagnostic = snapshot.result?.reason || null;
    if (snapshot.result?.state === "available") {
      patch.result = snapshot.result.result;
      patch.resultSource = snapshot.result.source;
      patch.resultAuthoritativeAt = job.resultAuthoritativeAt || snapshot.checkedAt;
    }
  }
  return completeJob(ctx, job, patch);
}

function renderMonitorSnapshot(snapshot, review = false) {
  const summary = snapshot.summary || summarizeLiveStatus(snapshot).summary;
  const lines = [
    `[${snapshot.checkedAt}] Claude ${snapshot.claudeSessionId || snapshot.job?.id || "job"} is ${summary.state}.`
  ];
  if (snapshot.error) {
    lines.push(snapshot.error);
  }
  if (review && snapshot.result?.state === "unavailable") {
    lines.push(snapshot.result.reason);
  }
  if (summary.lastMeaningfulLine) {
    lines.push(`Last meaningful output: ${summary.lastMeaningfulLine}`);
  } else if (snapshot.logs?.output) {
    lines.push("Recent logs contained only Claude status output.");
  } else if (snapshot.agents?.error) {
    lines.push(snapshot.agents.error);
  }
  if (summary.stale) {
    lines.push(`No new meaningful output for ${summary.staleFor}.`);
  }
  lines.push(`Action: ${summary.suggestedAction}`);
  return `${lines.join("\n")}\n`;
}

function writeMonitorSnapshot(snapshot, asJson, review = false) {
  process.stdout.write(asJson ? `${JSON.stringify(snapshot)}\n` : renderMonitorSnapshot(snapshot, review));
}

function managedSnapshot(job) {
  const displayedJob = publicJob(job);
  const lifecycleState = isReviewJob(job) && job.lifecycleState === "completed" && displayedJob.resultState !== "available"
    ? "interrupted" : job.lifecycleState;
  const terminal = ["completed", "cancelled", "failed", "interrupted"].includes(lifecycleState);
  return {
    checkedAt: new Date().toISOString(),
    jobId: job.id,
    lifecycleId: job.lifecycleId,
    lifecycleState,
    active: !terminal,
    completed: lifecycleState === "completed",
    available: isReviewJob(job) ? displayedJob.resultState === "available" : true,
    result: displayedJob.resultState === "available"
      ? { state: "available", source: "provider-json", result: displayedJob.result }
      : { state: "unavailable", reason: displayedJob.resultDiagnostic || job.failureClassification || "result-pending" },
    logs: { available: false, output: "", meaningfulOutput: "" },
    summary: {
      state: lifecycleState,
      active: !terminal,
      lastMeaningfulLine: null,
      stale: false,
      staleForMs: 0,
      staleFor: "0s",
      suggestedAction: terminal ? "Inspect the immutable terminal result." : "Wait or keep monitoring."
    }
  };
}

async function reconcileSupervisedJob(ctx, job) {
  if (["completed", "cancelled", "failed", "interrupted"].includes(job.lifecycleState)) return job;
  const first = await sendSupervisorCommand(ctx, job, "ping", 500);
  if (first.ok) return job;
  await new Promise((resolve) => setTimeout(resolve, 100));
  ctx.state = loadState(ctx.stateDir, { pathBoundary: ctx.stateRoot });
  const refreshed = ctx.state.jobs.find((item) => item.id === job.id) || job;
  if (["completed", "cancelled", "failed", "interrupted"].includes(refreshed.lifecycleState)) return refreshed;
  const second = await sendSupervisorCommand(ctx, refreshed, "ping", 500);
  if (second.ok) return refreshed;
  return transitionManaged(ctx, refreshed.id, {
    expectedStates: ["starting", "running", "cancelling"],
    toState: "interrupted",
    patch: {
      failureClassification: "interrupted-supervisor",
      cleanupStatus: "failed",
      terminalAt: new Date().toISOString()
    }
  }).job;
}

async function handleMonitor(argv) {
  const { options, positionals } = parseArgs(argv);
  const { intervalMs, maxChecks } = validateMonitorBounds(options);
  const ctx = currentContext(options);
  let job = findJob(ctx, positionals[0]);
  if (!job) throw new Error("No Claude job found.");
  await monitorManagedJob(ctx, job, options, intervalMs, maxChecks);
}

function validateMonitorBounds(options) {
  if (options.forever) {
    throw new Error("Unbounded --forever monitoring is not supported. Use a finite --max-checks value.");
  }
  const intervalMs = Number(options["interval-ms"] ?? DEFAULT_MONITOR_INTERVAL_MS);
  const maxChecks = Number(options["max-checks"] ?? DEFAULT_MONITOR_CHECKS);
  if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > MAX_MONITOR_INTERVAL_MS) {
    throw new Error(`--interval-ms must be between 0 and ${MAX_MONITOR_INTERVAL_MS}.`);
  }
  if (!Number.isInteger(maxChecks) || maxChecks < 1 || maxChecks > MAX_MONITOR_CHECKS) {
    throw new Error(`--max-checks must be an integer between 1 and ${MAX_MONITOR_CHECKS}.`);
  }
  return { intervalMs, maxChecks };
}

async function monitorManagedJob(ctx, initialJob, options, intervalMs, maxChecks) {
  let job = initialJob;
  if (isSupervisedJob(job)) {
    for (let index = 0; index < maxChecks; index += 1) {
      job = await reconcileSupervisedJob(ctx, job);
      const snapshot = managedSnapshot(job);
      writeMonitorSnapshot(snapshot, options.json, isReviewJob(job));
      if (!snapshot.active) break;
      if (index < maxChecks - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      ctx.state = loadState(ctx.stateDir, { pathBoundary: ctx.stateRoot });
      job = ctx.state.jobs.find((item) => item.id === job.id) || job;
    }
    return;
  }
  job = publicJob(job);
  const legacyAvailable = Boolean(job.resultAuthoritativeAt && job.resultState === "available");
  writeMonitorSnapshot({
    checkedAt: new Date().toISOString(),
    jobId: job.id,
    lifecycleState: legacyAvailable ? "completed" : "interrupted",
    active: false,
    completed: legacyAvailable,
    available: legacyAvailable,
    result: legacyAvailable
      ? { state: "available", result: job.result, source: job.resultSource || "legacy-authoritative" }
      : { state: "unavailable", reason: isReviewJob(job) ? job.resultDiagnostic : "legacy-lifecycle-unsupported" },
    logs: { available: false, output: "", meaningfulOutput: "" },
    summary: {
      state: legacyAvailable ? "completed" : "interrupted",
      active: false,
      lastMeaningfulLine: null,
      stale: false,
      staleForMs: 0,
      staleFor: "0s",
      suggestedAction: "Legacy terminal logs are not re-read."
    }
  }, options.json, isReviewJob(job));
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv);
  if (options.watch || options.follow) {
    await handleMonitor(argv);
    return;
  }
  const ctx = currentContext(options);
  const reference = positionals[0];
  const job = findJob(ctx, reference);
  if (reference && !job) {
    throw new Error("No Claude job found for that lifecycle reference. Use the exact managed job ID or lifecycle ID.");
  }
  if (!job) {
    output({ jobs: ctx.state.jobs.map(publicJob) }, options.json);
    return;
  }
  if (isSupervisedJob(job)) {
    const updated = await reconcileSupervisedJob(ctx, job);
    output({ job: publicJob(updated), live: managedSnapshot(updated) }, options.json);
    return;
  }
  const displayedJob = publicJob(job);
  const legacyAvailable = Boolean(displayedJob.resultAuthoritativeAt && displayedJob.resultState === "available");
  output({
    job: displayedJob,
    live: {
      lifecycleState: legacyAvailable ? "completed" : "interrupted",
      result: legacyAvailable
        ? { state: "available", result: displayedJob.result, source: displayedJob.resultSource || "legacy-authoritative" }
        : { state: "unavailable", reason: isReviewJob(job) ? displayedJob.resultDiagnostic : "legacy-lifecycle-unsupported" }
    }
  }, options.json);
}

async function handleResult(argv) {
  const { options, positionals } = parseArgs(argv);
  const ctx = currentContext(options);
  let job = findJob(ctx, positionals[0]);
  if (!job) {
    throw new Error("No Claude job found.");
  }
  if (isSupervisedJob(job)) {
    job = await reconcileSupervisedJob(ctx, job);
    const displayedJob = publicJob(job);
    const available = job.lifecycleState === "completed" && displayedJob.resultState === "available";
    output({
      job: displayedJob,
      resultState: available ? "available" : "unavailable",
      result: available ? displayedJob.result : null,
      diagnostic: available ? null : displayedJob.resultDiagnostic || job.failureClassification || "No authoritative final assistant answer is available."
    }, options.json);
    return;
  }
  job = publicJob(job);
  const isBackground = Boolean(job.lifecycleId || job.claudeSessionId || job.sessionName || job.status === "launch_uncertain");
  const available = isBackground
    ? Boolean(job.resultAuthoritativeAt && job.resultState === "available")
    : job.status === "completed";
  output(
    {
      job,
      resultState: available ? "available" : job.resultState || "unavailable",
      result: available ? job.result ?? "" : null,
      diagnostic: available ? null : job.resultDiagnostic || "No authoritative final assistant answer is available."
    },
    options.json
  );
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv);
  const ctx = currentContext(options);
  const job = findJob(ctx, positionals[0]);
  if (!job) {
    throw new Error("No Claude job found.");
  }
  if (isSupervisedJob(job)) {
    if (["completed", "cancelled", "failed", "interrupted"].includes(job.lifecycleState)) {
      const terminalDeadline = Date.now() + boundedPositiveInteger(options["timeout-ms"], 10000, 100, 30000);
      let terminalJob = job;
      while (terminalJob.cleanupStatus === "pending" && Date.now() < terminalDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        ctx.state = loadState(ctx.stateDir, { pathBoundary: ctx.stateRoot });
        terminalJob = ctx.state.jobs.find((item) => item.id === job.id) || terminalJob;
      }
      if (terminalJob.cleanupStatus === "pending") {
        throw new Error("Claude cleanup did not reach a verified terminal status.");
      }
      output({ jobId: terminalJob.id, status: publicJob(terminalJob).status }, options.json);
      return;
    }
    const timeoutMs = boundedPositiveInteger(options["timeout-ms"], 10000, 100, 30000);
    const requested = await sendSupervisorCommand(ctx, job, "cancel", Math.min(timeoutMs, 6000));
    if (!requested.ok) {
      const interrupted = await reconcileSupervisedJob(ctx, job);
      output({ jobId: interrupted.id, status: publicJob(interrupted).status }, options.json);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    let current = job;
    while (Date.now() < deadline) {
      ctx.state = loadState(ctx.stateDir, { pathBoundary: ctx.stateRoot });
      current = ctx.state.jobs.find((item) => item.id === job.id) || current;
      if (
        ["completed", "cancelled", "failed", "interrupted"].includes(current.lifecycleState) &&
        current.cleanupStatus !== "pending"
      ) {
        output({ jobId: current.id, status: publicJob(current).status }, options.json);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Claude cancellation did not reach a verified terminal state.");
  }
  output({ jobId: job.id, status: publicJob(job).resultAuthoritativeAt ? "completed" : "interrupted" }, options.json);
}

function handleResumeCandidate(argv) {
  const { options } = parseArgs(argv);
  const ctx = currentContext(options);
  let candidate = null;
  try {
    candidate = selectResumeCandidate(ctx.state.jobs, process.env, { resume: true, write: Boolean(options.write) });
  } catch (error) {
    output({ available: false, error: error.message, candidates: ctx.state.jobs.map(publicJob) }, options.json);
    return;
  }
  output({
    available: hasValidatedResumeAuthority(candidate),
    candidate: publicJob(candidate),
    candidates: candidate ? [] : ctx.state.jobs.map(publicJob)
  }, options.json);
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  claude-companion setup [--json]",
      "  claude-companion ux --billing-source subscription|api|third-party [--timeout-ms <100–120000>] [--max-turns <1–6>] <question>",
      "  claude-companion advise [--background] [--write] [--max-turns <n>] [--effort <level>] [--allow-mcp] [--allow-web] [--no-background-fallback] [prompt]",
      "  claude-companion do [--background] [--write] [--model <model>] [--max-turns <n>] [--effort <level>] [--allow-mcp] [--allow-web] [prompt]",
      "  claude-companion rescue [--background] [--write] [--resume] [--model <model>] [--max-turns <n>] [--effort <level>] [--allow-mcp] [--allow-web] [--no-background-fallback] [prompt]",
      "  claude-companion review [--base <ref>] [--max-turns <n>] [--effort <level>] [--json]",
      "  claude-companion adversarial-review [--base <ref>] [--max-turns <n>] [--effort <level>] [focus] [--json]",
      "  claude-companion monitor [job-id] [--interval-ms <ms>] [--max-checks <n>] [--stale-after-ms <ms>] [--json]",
      "  claude-companion status [job-id] [--watch] [--json]",
      "  claude-companion result [job-id] [--json]",
      "  claude-companion cancel [job-id] [--json]",
      "  claude-companion resume-candidate [--json]"
    ].join("\n") + "\n"
  );
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }
  switch (command) {
    case "setup":
      handleSetup(argv);
      break;
    case "ux":
      await handleTaskCommand(argv, "ux");
      break;
    case "advise":
      await handleAdvise(argv);
      break;
    case "rescue":
      await handleRescue(argv);
      break;
    case "do":
      await handleDo(argv);
      break;
    case "review":
      await handleReview(argv, "review");
      break;
    case "adversarial-review":
      await handleReview(argv, "adversarial-review");
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "monitor":
      await handleMonitor(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "resume-candidate":
      handleResumeCandidate(argv);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
