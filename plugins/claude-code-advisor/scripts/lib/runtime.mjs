import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { restrictPrivatePath } from "./private-path.mjs";

export const STATE_VERSION = 1;
export const DEFAULT_STATE_LOCK_TIMEOUT_MS = 5000;
export const DEFAULT_DIFF_MAX_BYTES = 1024 * 1024;
export const REVIEW_SEVERITIES = new Set(["BLOCKER", "MAJOR", "MINOR"]);
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
export const LOCAL_READ_TOOLS = "Read,Glob,Grep";
export const WEB_READ_TOOLS = `${LOCAL_READ_TOOLS},WebFetch,WebSearch`;
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 10 * 60 * 1000;
export const SUPERVISED_RECORD_VERSION = 2;
export const SUPERVISED_TRANSPORT = "supervised-print-json";
export const SUPERVISED_TERMINAL_STATES = new Set(["completed", "cancelled", "failed", "interrupted"]);
export const SUPERVISED_FAILURE_CLASSIFICATIONS = new Set([
  "cancellation",
  "cleanup-failure",
  "control-socket-error",
  "interrupted-supervisor",
  "invalid-result",
  "non-zero-exit",
  "output-limit",
  "provider-start-timeout",
  "signal-termination",
  "spawn-failure",
  "timeout",
  "unsupported-platform",
  "worker-exit-code",
  "worker-exit-signal",
  "worker-failure",
  "worker-ipc-disconnect",
  "worker-stdin-error"
]);

const SUPERVISED_TRANSITIONS = {
  created: new Set(["starting", "cancelled", "failed", "interrupted"]),
  starting: new Set(["running", "cancelling", "cancelled", "failed", "interrupted"]),
  running: new Set(["cancelling", "completed", "cancelled", "failed", "interrupted"]),
  cancelling: new Set(["completed", "cancelled", "failed", "interrupted"])
};

const SUPERVISED_PATCH_FIELDS = new Set([
  "authority",
  "canonicalSessionId",
  "cancelRequestedAt",
  "cleanupStatus",
  "failureClassification",
  "fallbackFromJobId",
  "fallbackReason",
  "kind",
  "launchAcknowledgedAt",
  "lifecycleId",
  "notice",
  "result",
  "resultAuthoritativeAt",
  "resultSource",
  "resultState",
  "resumeSessionId",
  "resumedFromJobId",
  "runningAt",
  "startingAt",
  "supervisor",
  "terminalAt"
]);

const SUPERVISED_PERSISTED_FIELDS = new Set([
  "authority",
  "canonicalSessionId",
  "cancelRequestedAt",
  "cleanupStatus",
  "codexThreadId",
  "createdAt",
  "failureClassification",
  "fallbackFromJobId",
  "fallbackReason",
  "id",
  "kind",
  "launchAcknowledgedAt",
  "lifecycleId",
  "lifecycleState",
  "notice",
  "recordVersion",
  "result",
  "resultAuthoritativeAt",
  "resultSource",
  "resultState",
  "resumeSessionId",
  "resumedFromJobId",
  "runningAt",
  "startingAt",
  "stateGeneration",
  "status",
  "supervisor",
  "terminalAt",
  "transport",
  "updatedAt",
  "write"
]);

function validateSupervisedStateRecord(job, stateFile) {
  for (const field of Object.keys(job)) {
    if (!SUPERVISED_PERSISTED_FIELDS.has(field)) {
      throw new Error(`State corruption in ${stateFile}: invalid supervised job field ${field}.`);
    }
  }
  if (!Number.isInteger(job.stateGeneration) || job.stateGeneration < 0) {
    throw new Error(`State corruption in ${stateFile}: invalid supervised job generation.`);
  }
  if (typeof job.lifecycleState !== "string" || job.status !== job.lifecycleState) {
    throw new Error(`State corruption in ${stateFile}: inconsistent supervised job lifecycle.`);
  }
  if (
    job.supervisor !== undefined &&
    (
      !job.supervisor ||
      typeof job.supervisor !== "object" ||
      Array.isArray(job.supervisor) ||
      Object.keys(job.supervisor).some((field) => !["pid", "token"].includes(field)) ||
      (job.supervisor.pid !== null && (!Number.isInteger(job.supervisor.pid) || job.supervisor.pid <= 0)) ||
      typeof job.supervisor.token !== "string" ||
      !job.supervisor.token
    )
  ) {
    throw new Error(`State corruption in ${stateFile}: invalid supervised job ownership metadata.`);
  }
  if (job.result !== undefined && typeof job.result !== "string") {
    throw new Error(`State corruption in ${stateFile}: invalid supervised job result.`);
  }
  if (
    job.failureClassification !== undefined &&
    !SUPERVISED_FAILURE_CLASSIFICATIONS.has(job.failureClassification)
  ) {
    throw new Error(`State corruption in ${stateFile}: invalid supervised failure classification.`);
  }
}

export function resolveBackgroundFallbackTimeout(options = {}) {
  return options["background-timeout-ms"] ?? options.backgroundTimeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS;
}

export function classifySupervisorFailureEvent(event = {}) {
  switch (event?.kind) {
    case "control-socket-error":
      return "control-socket-error";
    case "ipc-disconnect":
      return "worker-ipc-disconnect";
    case "spawn-error":
      return "spawn-failure";
    case "start-timeout":
      return "provider-start-timeout";
    case "supervisor-interruption":
      return "interrupted-supervisor";
    case "worker-exit":
      if (typeof event.signal === "string" && event.signal) return "worker-exit-signal";
      if (Number.isInteger(event.code)) return "worker-exit-code";
      return "worker-failure";
    case "worker-stdin-error":
      return "worker-stdin-error";
    case "termination-request":
      return SUPERVISED_FAILURE_CLASSIFICATIONS.has(event.classification)
        ? event.classification
        : "worker-failure";
    default:
      return "worker-failure";
  }
}

function readToolsForMode(mode, allowWeb = false) {
  if (allowWeb) {
    return WEB_READ_TOOLS;
  }
  return LOCAL_READ_TOOLS;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sanitizeSegment(value) {
  return String(value || "none")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "none";
}

export function resolveStateRoot(env = process.env) {
  return env.CLAUDE_COMPANION_STATE_ROOT || path.join(os.homedir(), ".codex", "claude-plugin-codex");
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }
    current = parent;
  }
}

export function resolveStateDir(workspaceRoot, env = process.env, stateRoot = resolveStateRoot(env)) {
  const canonical = path.resolve(workspaceRoot);
  const base = sanitizeSegment(path.basename(canonical) || "workspace");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const thread = env.CODEX_THREAD_ID ? `thread-${sanitizeSegment(env.CODEX_THREAD_ID)}` : "workspace";
  return path.join(stateRoot, `${base}-${hash}`, thread);
}

export function resolveWorkspaceIndexDir(workspaceRoot, env = process.env, stateRoot = resolveStateRoot(env)) {
  const canonical = path.resolve(workspaceRoot);
  const base = sanitizeSegment(path.basename(canonical) || "workspace");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return path.join(stateRoot, `${base}-${hash}`);
}

export function emptyState() {
  return { version: STATE_VERSION, jobs: [], capabilities: null };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function assertSafeManagedDirectory(directory, label = "state directory", pathBoundary = path.dirname(directory)) {
  const boundary = path.resolve(pathBoundary);
  const target = path.resolve(directory);
  const relative = path.relative(boundary, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe ${label}: ${target} is outside the configured state boundary ${boundary}.`);
  }
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 });
  const boundaryStat = fs.lstatSync(boundary);
  if (boundaryStat.isSymbolicLink() || !boundaryStat.isDirectory()) {
    throw new Error(`Refusing unsafe state boundary: ${boundary} must be a real directory, not a symlink.`);
  }
  let current = boundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing unsafe ${label}: ${current} must be a real directory, not a symlink.`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
        const racedStat = fs.lstatSync(current);
        if (racedStat.isSymbolicLink() || !racedStat.isDirectory()) {
          throw new Error(`Refusing unsafe ${label}: ${current} must be a real directory, not a symlink.`);
        }
      }
    }
    restrictPrivatePath(current, 0o700);
  }
}

function assertSafeRegularFile(file, label, { allowMissing = true } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing unsafe ${label}: ${file} must be a regular file, not a symlink.`);
  }
  return stat;
}

function validateStateShape(parsed, stateFile = "state.json") {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`State corruption in ${stateFile}: expected a JSON object.`);
  }
  if (parsed.version !== STATE_VERSION) {
    throw new Error(
      `Unsupported state schema version in ${stateFile}: expected ${STATE_VERSION}, received ${String(parsed.version)}.`
    );
  }
  if (!Array.isArray(parsed.jobs)) {
    throw new Error(`State corruption in ${stateFile}: jobs must be an array.`);
  }
  const ids = new Set();
  for (const job of parsed.jobs) {
    if (!job || typeof job !== "object" || Array.isArray(job) || typeof job.id !== "string" || !job.id) {
      throw new Error(`State corruption in ${stateFile}: every job must be an object with a non-empty string id.`);
    }
    if (ids.has(job.id)) {
      throw new Error(`State corruption in ${stateFile}: duplicate job id ${job.id}.`);
    }
    if (job.recordVersion === SUPERVISED_RECORD_VERSION || job.transport === SUPERVISED_TRANSPORT) {
      if (job.recordVersion !== SUPERVISED_RECORD_VERSION || job.transport !== SUPERVISED_TRANSPORT) {
        throw new Error(`State corruption in ${stateFile}: inconsistent supervised job record identity.`);
      }
      validateSupervisedStateRecord(job, stateFile);
    }
    ids.add(job.id);
  }
  if (!(
    parsed.capabilities === null ||
    parsed.capabilities === undefined ||
    (typeof parsed.capabilities === "object" && !Array.isArray(parsed.capabilities))
  )) {
    throw new Error(`State corruption in ${stateFile}: capabilities must be an object or null.`);
  }
  return {
    ...parsed,
    version: STATE_VERSION,
    jobs: [...parsed.jobs],
    capabilities: parsed.capabilities ?? null
  };
}

function readStateFile(stateFile) {
  if (!assertSafeRegularFile(stateFile, "state file")) {
    return emptyState();
  }
  restrictPrivatePath(stateFile, 0o600);
  let text;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const fd = fs.openSync(stateFile, fs.constants.O_RDONLY | noFollow);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        throw new Error(`Refusing unsafe state file: ${stateFile} is not regular.`);
      }
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`Refusing unsafe state file symlink: ${stateFile}.`);
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`State corruption in ${stateFile}: malformed JSON (${error.message}). Original data was preserved.`);
  }
  return validateStateShape(parsed, stateFile);
}

function lockOwnerAlive(owner) {
  if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return null;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return null;
  }
}

function acquireFileLock(lockFile, timeoutMs = DEFAULT_STATE_LOCK_TIMEOUT_MS) {
  const startedAt = Date.now();
  const token = randomUUID();
  const owner = { token, pid: process.pid, hostname: os.hostname(), createdAt: nowIso() };
  while (true) {
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        restrictPrivatePath(lockFile, 0o600, { newFile: true });
      } catch (error) {
        releaseFileLock(lockFile, owner);
        throw error;
      }
      return owner;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        assertSafeRegularFile(lockFile, "state lock", { allowMissing: false });
      } catch (lockError) {
        if (lockError?.code === "ENOENT") continue;
        throw lockError;
      }
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      } catch {
        // A malformed lock is not safe to break. Bounded timeout below is fail-closed.
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const staleHint = lockOwnerAlive(existing) === false
          ? " The recorded owner is not running; verify no process owns the lock, then remove that one stale lock manually."
          : "";
        throw new Error(`Timed out after ${timeoutMs}ms waiting for state lock ${lockFile}.${staleHint}`);
      }
      sleepSync(Math.min(50, Math.max(5, timeoutMs - (Date.now() - startedAt))));
    }
  }
}

function releaseFileLock(lockFile, owner) {
  try {
    assertSafeRegularFile(lockFile, "state lock", { allowMissing: false });
    const current = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (current.token !== owner.token) {
      throw new Error(`Refusing to release state lock not owned by this process: ${lockFile}.`);
    }
    fs.unlinkSync(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWritePrivateFile(file, content, options = {}) {
  const directory = path.dirname(file);
  const basename = path.basename(file);
  assertSafeRegularFile(file, basename);
  const tempFile = path.join(directory, `.${basename}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    restrictPrivatePath(tempFile, 0o600, { newFile: true });
    options.beforeRename?.({ file, tempFile });
    assertSafeRegularFile(file, basename);
    fs.renameSync(tempFile, file);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      const tempStat = fs.lstatSync(tempFile);
      if (tempStat.isFile() && !tempStat.isSymbolicLink()) fs.unlinkSync(tempFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function normaliseStateForWrite(state) {
  const validated = validateStateShape({ ...emptyState(), ...state });
  return {
    ...validated,
    jobs: [...validated.jobs].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
  };
}

export function loadState(stateDir, options = {}) {
  assertSafeManagedDirectory(stateDir, "state directory", options.pathBoundary);
  return readStateFile(path.join(stateDir, "state.json"));
}

export function transactState(stateDir, mutator, options = {}) {
  assertSafeManagedDirectory(stateDir, "state directory", options.pathBoundary);
  const stateFile = path.join(stateDir, "state.json");
  const lockFile = path.join(stateDir, ".state.lock");
  const owner = acquireFileLock(lockFile, Number(options.lockTimeoutMs ?? DEFAULT_STATE_LOCK_TIMEOUT_MS));
  try {
    const current = readStateFile(stateFile);
    const mutated = mutator(current);
    const next = normaliseStateForWrite(mutated === undefined ? current : mutated);
    atomicWritePrivateFile(stateFile, `${JSON.stringify(next, null, 2)}\n`, options);
    return next;
  } finally {
    releaseFileLock(lockFile, owner);
  }
}

export function saveState(stateDir, state, options = {}) {
  return transactState(stateDir, () => state, options);
}

export function updateLatestStateDir(indexDir, stateDir, options = {}) {
  assertSafeManagedDirectory(indexDir, "workspace state index directory", options.pathBoundary);
  const latestFile = path.join(indexDir, "latest-state-dir");
  const lockFile = path.join(indexDir, ".latest-state-dir.lock");
  const owner = acquireFileLock(lockFile, Number(options.lockTimeoutMs ?? DEFAULT_STATE_LOCK_TIMEOUT_MS));
  try {
    atomicWritePrivateFile(latestFile, `${stateDir}\n`, options);
    return latestFile;
  } finally {
    releaseFileLock(lockFile, owner);
  }
}

export function generateJobId(prefix = "claude") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function upsertJob(state, patch) {
  const timestamp = nowIso();
  const jobs = [...(state.jobs || [])];
  const index = jobs.findIndex((job) => job.id === patch.id);
  if (index === -1) {
    jobs.unshift({ createdAt: timestamp, updatedAt: timestamp, ...patch });
  } else {
    jobs[index] = { ...jobs[index], ...patch, updatedAt: timestamp };
  }
  return { ...state, jobs };
}

export function isSupervisedJob(job) {
  return job?.recordVersion === SUPERVISED_RECORD_VERSION && job?.transport === SUPERVISED_TRANSPORT;
}

export function transitionSupervisedJob(stateDir, jobId, transition, options = {}) {
  let outcome = null;
  const saved = transactState(stateDir, (current) => {
    const existing = current.jobs.find((job) => job.id === jobId);
    if (!existing || !isSupervisedJob(existing)) {
      throw new Error("supervised-job-unavailable");
    }
    const currentGeneration = Number(existing.stateGeneration || 0);
    const expectedGeneration = transition.expectedGeneration;
    const expectedStates = new Set(transition.expectedStates || []);
    if (
      SUPERVISED_TERMINAL_STATES.has(existing.lifecycleState) ||
      (expectedGeneration !== undefined && currentGeneration !== expectedGeneration) ||
      (expectedStates.size && !expectedStates.has(existing.lifecycleState))
    ) {
      outcome = { applied: false, job: existing };
      return current;
    }
    const nextState = transition.toState;
    if (!SUPERVISED_TRANSITIONS[existing.lifecycleState]?.has(nextState)) {
      throw new Error("invalid-supervised-state-transition");
    }
    const patch = transition.patch || {};
    for (const field of Object.keys(patch)) {
      if (!SUPERVISED_PATCH_FIELDS.has(field)) throw new Error("invalid-supervised-state-field");
    }
    if (
      patch.failureClassification !== undefined &&
      !SUPERVISED_FAILURE_CLASSIFICATIONS.has(patch.failureClassification)
    ) {
      throw new Error("invalid-supervised-failure-classification");
    }
    const next = {
      ...existing,
      ...patch,
      lifecycleState: nextState,
      status: nextState,
      stateGeneration: currentGeneration + 1
    };
    const state = upsertJob(current, next);
    outcome = { applied: true, job: state.jobs.find((job) => job.id === jobId) };
    return state;
  }, options);
  return outcome || { applied: false, job: saved.jobs.find((job) => job.id === jobId) || null };
}

export function updateSupervisedCleanup(stateDir, jobId, cleanupStatus, options = {}) {
  if (!["verified", "failed"].includes(cleanupStatus)) throw new Error("invalid-cleanup-status");
  let outcome = null;
  transactState(stateDir, (current) => {
    const existing = current.jobs.find((job) => job.id === jobId);
    if (!existing || !isSupervisedJob(existing)) throw new Error("supervised-job-unavailable");
    if (!SUPERVISED_TERMINAL_STATES.has(existing.lifecycleState)) throw new Error("cleanup-before-terminal");
    if (["verified", "failed"].includes(existing.cleanupStatus)) {
      outcome = { applied: false, job: existing };
      return current;
    }
    const state = upsertJob(current, { id: jobId, cleanupStatus });
    outcome = { applied: true, job: state.jobs.find((job) => job.id === jobId) };
    return state;
  }, options);
  return outcome;
}

export function selectResumeCandidate(jobs, env = process.env, options = {}) {
  const explicitJobId = options.explicitJobId || options.jobId || null;
  const codexThreadId = env.CODEX_THREAD_ID || null;
  const resumableStatuses = new Set(["completed", "cancelled", "failed", "timed_out"]);
  let candidate = null;

  if (explicitJobId) {
    candidate = jobs.find((job) => job.id === explicitJobId) || null;
  } else if (codexThreadId) {
    candidate =
      jobs.find(
        (job) =>
          job.codexThreadId === codexThreadId &&
          (job.resumeSessionId || job.claudeSessionId) &&
          resumableStatuses.has(job.status)
      ) || null;
  }

  if (!candidate) {
    return null;
  }

  if (!resumableStatuses.has(candidate.status)) {
    throw new Error("Refusing to resume a Claude session that is not in a proven terminal resumable state.");
  }

  if (candidate.write && !options.write) {
    throw new Error("Refusing to resume a write-capable Claude session from a read-only command. Pass --write --resume.");
  }

  return candidate;
}

export function buildClaudeArgs(options) {
  const {
    mode,
    prompt,
    outputFormat = "text",
    maxTurns = 3,
    write = false,
    resumeSessionId = null,
    model = null,
    effort = null,
    allowMcp = false,
    allowWeb = false
  } = options;

  if (write === "implicit") {
    throw new Error("Write-capable Claude work requires explicit --write.");
  }
  if (write && (mode === "review" || mode === "adversarial-review" || mode === "ux")) {
    throw new Error(`${mode} is read-only and does not support --write. Use advise, do or rescue --write for write-capable work.`);
  }
  if (!prompt || !String(prompt).trim()) {
    throw new Error("A prompt is required.");
  }

  const args = [];
  if (resumeSessionId) {
    assertCanonicalResumeReference(resumeSessionId);
    args.push("--resume", resumeSessionId);
  }
  args.push("-p");
  args.push("--output-format", outputFormat);
  args.push("--max-turns", String(maxTurns));
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (!allowMcp) {
    args.push("--mcp-config", EMPTY_MCP_CONFIG, "--strict-mcp-config");
  }
  args.push("--no-chrome");

  if (write) {
    args.push("--permission-mode", "default");
  } else if (mode === "ux") {
    args.push("--tools", "Read,Glob,Grep,Skill", "--allowedTools", "Read,Glob,Grep,Skill(frontend-design:frontend-design)", "--permission-mode", "dontAsk");
  } else if (mode === "review" || mode === "adversarial-review") {
    // With no built-in tools and isolated MCP, reviews need no interactive
    // planning workflow. Preserve Plan Mode for explicitly allowed MCP tools.
    args.push("--tools", "", "--permission-mode", allowMcp ? "plan" : "default");
  } else {
    args.push("--tools", readToolsForMode(mode, allowWeb), "--permission-mode", "plan");
  }

  return args;
}

export function buildBackgroundArgs({
  prompt,
  name,
  mode = "advise",
  write = false,
  resumeSessionId = null,
  model = null,
  effort = null,
  allowMcp = false,
  allowWeb = false
}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("A prompt is required.");
  }
  const args = [];
  if (resumeSessionId) {
    assertCanonicalResumeReference(resumeSessionId);
    args.push("--resume", resumeSessionId);
  }
  args.push("--bg", "--ax-screen-reader");
  if (name) {
    args.push("--name", name);
  }
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (!allowMcp) {
    args.push("--mcp-config", EMPTY_MCP_CONFIG, "--strict-mcp-config");
  }
  args.push("--no-chrome");
  if (write) {
    args.push("--permission-mode", "default");
  } else {
    args.push("--tools", readToolsForMode(mode, allowWeb), "--permission-mode", "plan");
  }
  args.push(prompt);
  return args;
}

export function buildSupervisedPrintArgs({
  mode = "advise",
  write = false,
  resumeSessionId = null,
  model = null,
  effort = null,
  maxTurns = 20,
  allowMcp = false,
  allowWeb = false
}) {
  const args = [];
  if (resumeSessionId) {
    assertCanonicalResumeReference(resumeSessionId);
    args.push("--resume", resumeSessionId);
  }
  args.push("-p", "--output-format", "json", "--max-turns", String(maxTurns));
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (!allowMcp) args.push("--mcp-config", EMPTY_MCP_CONFIG, "--strict-mcp-config");
  args.push("--no-chrome");
  if (write) {
    args.push("--permission-mode", "default");
  } else {
    args.push("--tools", readToolsForMode(mode, allowWeb), "--permission-mode", "plan");
  }
  return args;
}

export function parseBackgroundLaunch(stdout) {
  const text = String(stdout || "");
  return text.match(/backgrounded\s+.\s+([a-zA-Z0-9_-]+)/)?.[1] ?? null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCanonicalResumeReference(value) {
  return UUID_PATTERN.test(String(value || ""));
}

export function assertCanonicalResumeReference(value) {
  if (!isCanonicalResumeReference(value)) {
    throw new Error(
      "Refusing to pass a short or ambiguous Claude identifier to --resume. Resolve an exact full session UUID first."
    );
  }
  return value;
}

function skipJsonWhitespace(text, index) {
  while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) index += 1;
  return index;
}

function scanJsonString(text, index) {
  if (text[index] !== '"') throw new Error("invalid-result");
  const start = index;
  index += 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      const end = index + 1;
      return { index: end, value: JSON.parse(text.slice(start, end)) };
    }
    if (code === 0x5c) {
      index += 1;
      if (index >= text.length) throw new Error("invalid-result");
      if (text[index] === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) throw new Error("invalid-result");
        index += 4;
      }
    } else if (code < 0x20) {
      throw new Error("invalid-result");
    }
    index += 1;
  }
  throw new Error("invalid-result");
}

function scanJsonValue(text, index, rejectDuplicateKeys = false) {
  index = skipJsonWhitespace(text, index);
  if (text[index] === '"') return scanJsonString(text, index).index;
  if (text[index] === "{") {
    index = skipJsonWhitespace(text, index + 1);
    if (text[index] === "}") return index + 1;
    const keys = new Set();
    while (index < text.length) {
      const key = scanJsonString(text, index);
      if (rejectDuplicateKeys && keys.has(key.value)) throw new Error("invalid-result");
      keys.add(key.value);
      index = skipJsonWhitespace(text, key.index);
      if (text[index] !== ":") throw new Error("invalid-result");
      index = scanJsonValue(text, index + 1, rejectDuplicateKeys);
      index = skipJsonWhitespace(text, index);
      if (text[index] === "}") return index + 1;
      if (text[index] !== ",") throw new Error("invalid-result");
      index = skipJsonWhitespace(text, index + 1);
    }
  }
  if (text[index] === "[") {
    index = skipJsonWhitespace(text, index + 1);
    if (text[index] === "]") return index + 1;
    while (index < text.length) {
      index = scanJsonValue(text, index, rejectDuplicateKeys);
      index = skipJsonWhitespace(text, index);
      if (text[index] === "]") return index + 1;
      if (text[index] !== ",") throw new Error("invalid-result");
      index = skipJsonWhitespace(text, index + 1);
    }
  }
  const token = text.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
  if (!token) throw new Error("invalid-result");
  return index + token.length;
}

function assertNoDuplicateCriticalRootKeys(text) {
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") throw new Error("invalid-result");
  index = skipJsonWhitespace(text, index + 1);
  const seen = new Set();
  const critical = new Set(["type", "subtype", "is_error", "result", "session_id"]);
  if (text[index] === "}") return;
  while (index < text.length) {
    const key = scanJsonString(text, index);
    if (critical.has(key.value) && seen.has(key.value)) throw new Error("invalid-result");
    seen.add(key.value);
    index = skipJsonWhitespace(text, key.index);
    if (text[index] !== ":") throw new Error("invalid-result");
    index = scanJsonValue(text, index + 1);
    index = skipJsonWhitespace(text, index);
    if (text[index] === "}") return;
    if (text[index] !== ",") throw new Error("invalid-result");
    index = skipJsonWhitespace(text, index + 1);
  }
  throw new Error("invalid-result");
}

export function validateSupervisedClaudeResult(bytes, expectedSessionId = null) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid-result");
  }
  if (!/^[\u0009\u000a\u000d\u0020]*\{[\s\S]*\}[\u0009\u000a\u000d\u0020]*$/.test(text)) {
    throw new Error("invalid-result");
  }
  assertNoDuplicateCriticalRootKeys(text);
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("invalid-result");
  }
  if (
    !envelope ||
    Array.isArray(envelope) ||
    envelope.type !== "result" ||
    envelope.subtype !== "success" ||
    envelope.is_error !== false ||
    typeof envelope.result !== "string" ||
    !isCanonicalResumeReference(envelope.session_id)
  ) {
    throw new Error("invalid-result");
  }
  if (expectedSessionId && envelope.session_id !== assertCanonicalResumeReference(expectedSessionId)) {
    throw new Error("invalid-result");
  }
  return { result: envelope.result, sessionId: envelope.session_id };
}

export function supervisorPaths(stateDir, jobId) {
  const digest = createHash("sha256").update(`${path.resolve(stateDir)}\0${jobId}`).digest("hex").slice(0, 24);
  const directory = path.join(os.tmpdir(), `cpc-${digest}`);
  return { directory, socket: path.join(directory, "control.sock") };
}

function sessionLifecycleId(session) {
  return session?.id ?? session?.agentId ?? session?.agent_id ?? null;
}

function sessionResumeId(session) {
  return session?.sessionId ?? session?.session_id ?? session?.sessionUUID ?? session?.session_uuid ?? null;
}

function sessionName(session) {
  return session?.name ?? session?.title ?? session?.displayName ?? session?.display_name ?? null;
}

export function parseAgentsPayload(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error("structured-agent-json-empty");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("structured-agent-json-invalid");
  }
  const sessions = Array.isArray(parsed) ? parsed : parsed?.sessions ?? parsed?.agents;
  if (!Array.isArray(sessions)) {
    throw new Error("structured-agent-schema-invalid");
  }
  return sessions;
}

export function reconcileBackgroundIdentity(sessions, job) {
  const lifecycleReference = job?.lifecycleId ?? job?.claudeSessionId ?? null;
  const resumeReference = job?.resumeSessionId ?? null;
  const nameReference = job?.sessionName ?? job?.backgroundName ?? null;
  const exactBy = (selector, reference) => reference ? sessions.filter((session) => selector(session) === reference) : [];
  const byName = exactBy(sessionName, nameReference);
  const byLifecycle = exactBy(sessionLifecycleId, lifecycleReference);
  const byResume = exactBy(sessionResumeId, resumeReference);
  const strongEvidence = [
    [nameReference, byName],
    [lifecycleReference, byLifecycle]
  ].filter(([reference]) => Boolean(reference));
  if (strongEvidence.some(([, matches]) => matches.length !== 1)) {
    const matches = distinct(strongEvidence.flatMap(([, values]) => values));
    return { state: matches.length ? "ambiguous" : "missing", matches };
  }
  const strongMatches = distinct(strongEvidence.map(([, matches]) => matches[0]));
  if (strongMatches.length > 1) {
    return { state: "ambiguous", matches: strongMatches };
  }
  let matches;
  if (strongMatches.length === 1) {
    const selected = strongMatches[0];
    if (resumeReference && (byResume.length === 0 || !byResume.includes(selected))) {
      return { state: "ambiguous", matches: distinct([selected, ...byResume]) };
    }
    matches = [selected];
  } else {
    matches = byResume;
  }
  if (matches.length === 0) {
    return { state: "missing", matches: [] };
  }
  if (matches.length !== 1) {
    return { state: "ambiguous", matches };
  }
  const match = matches[0];
  const lifecycleId = sessionLifecycleId(match);
  const resumeSessionId = sessionResumeId(match);
  return {
    state: isCanonicalResumeReference(resumeSessionId) ? "resolved" : "unavailable",
    match,
    matches,
    lifecycleId: typeof lifecycleId === "string" && lifecycleId ? lifecycleId : null,
    resumeSessionId: isCanonicalResumeReference(resumeSessionId) ? resumeSessionId : null,
    sessionName: sessionName(match)
  };
}

export function resolveResumeReference(job, sessions = []) {
  const existing = job?.resumeSessionId ?? (isCanonicalResumeReference(job?.claudeSessionId) ? job.claudeSessionId : null);
  if (existing) {
    return assertCanonicalResumeReference(existing);
  }
  const reconciled = reconcileBackgroundIdentity(sessions, job);
  if (reconciled.state === "ambiguous") {
    throw new Error("Claude resume identity is ambiguous. Select a job with one exact structured agents match.");
  }
  if (reconciled.state !== "resolved") {
    throw new Error(
      "Claude resume identity is unavailable. Run status to reconcile the legacy job, then retry with an exact job ID."
    );
  }
  return reconciled.resumeSessionId;
}

export function buildBackgroundResultPrompt(prompt, marker) {
  const token = sanitizeSegment(marker);
  return [
    prompt,
    "",
    "Claude Code Advisor result transport V1:",
    "Return exactly one versioned result envelope on one line and no other final-answer text.",
    `Use the nonce-bound envelope name CODEX_RESULT_V1_${token} for both the opening and closing names.`,
    `The exact shape is <CODEX_RESULT_V1_${token}:DECIMAL_BYTE_LENGTH:CANONICAL_BASE64></CODEX_RESULT_V1_${token}>; replace both uppercase placeholders with their values.`,
    "The opening tag has three colon-separated fields: the envelope name, the decoded byte length in decimal, and the canonical RFC 4648 base64 payload. Immediately follow it with the matching closing tag.",
    "UTF-8 encode the complete final answer exactly as requested, without trimming, folding, newline conversion or added commentary, then canonical-base64 encode those bytes.",
    "The decimal length is the number of decoded UTF-8 bytes. Empty output has length zero and an empty base64 field.",
    "Do not repeat, nest, mismatch or add another result envelope. Do not use Markdown fences.",
    "The companion persists and returns only the decoded payload, never the transport envelope."
  ].join("\n");
}

function stripControlForResult(value) {
  return String(value || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[78]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "");
}

function distinct(values) {
  return [...new Set(values)];
}

function classifyMarkedLine(line) {
  const text = String(line || "");
  const assistantBoundary = /^[⏺●]/u.test(text);
  const content = assistantBoundary ? text.replace(/^[⏺●]\s*/u, "").trim() : text.trim();
  const markerTag = /^<\/?CODEX_RESULT_[a-zA-Z0-9._-]+>$/.test(content) ? content : null;
  return { assistantBoundary, markerTag };
}

export function analyseEncodedBackgroundResult(raw, marker) {
  if (!marker) return null;
  const token = sanitizeSegment(marker);
  const tagLikePattern = /<\/?CODEX_RESULT_V[a-zA-Z0-9._:-]*/g;
  const assistantLines = [];
  const assistantTags = [];
  const assistantContentLines = [];
  let unboundedTagCount = 0;
  let role = "unbounded";
  for (const rawLine of stripControlForResult(raw).split("\n")) {
    const line = String(rawLine || "");
    const trimmed = rawLine.trim();
    let content = trimmed;
    const assistantBoundary = line.match(/^[⏺●]/u);
    const userBoundary = trimmed.match(/^[❯$](?:\s|$)/u);
    if (assistantBoundary) {
      role = "assistant";
      content = line.replace(/^[⏺●]\s*/u, "").trim();
    } else if (userBoundary) {
      role = "user";
      content = trimmed.replace(/^[❯$]\s*/u, "");
    } else if (/^[✢✳✶✻✽·]/u.test(trimmed) || /^\s*(?:plan mode|effort:|\/rc active|ctx:)/i.test(trimmed)) {
      role = "unbounded";
    }
    if (role === "assistant" && content) {
      assistantContentLines.push(content);
    }
    const tags = [...content.matchAll(tagLikePattern)].map((match) => match[0]);
    if (!tags.length || role === "user") continue;
    if (role !== "assistant") {
      unboundedTagCount += tags.length;
      continue;
    }
    assistantLines.push(content);
    assistantTags.push(...tags);
  }
  if (!assistantTags.length) {
    if (!unboundedTagCount) return null;
    return {
      state: "ambiguous",
      reason: "Versioned result framing had no reliable assistant source boundary.",
      openerCount: 0,
      closerCount: 0
    };
  }
  const envelopePattern =
    /^<CODEX_RESULT_V1_([a-zA-Z0-9._-]+):([0-9]+):([a-zA-Z0-9+/]*={0,2})><\/CODEX_RESULT_V1_([a-zA-Z0-9._-]+)>$/;
  const candidates = assistantLines.filter((line) => envelopePattern.test(line));
  const openerCount = assistantTags.filter((tag) => !tag.startsWith("</")).length;
  const closerCount = assistantTags.filter((tag) => tag.startsWith("</")).length;
  if (
    unboundedTagCount !== 0 ||
    assistantTags.length !== 2 ||
    assistantContentLines.length !== 1 ||
    candidates.length !== 1 ||
    openerCount !== 1 ||
    closerCount !== 1
  ) {
    return {
      state: "ambiguous",
      reason: "Versioned result envelopes were repeated, malformed or ambiguous.",
      openerCount,
      closerCount
    };
  }
  const [, openingNonce, lengthText, encoded, closingNonce] = candidates[0].match(envelopePattern);
  if (openingNonce !== token || closingNonce !== token) {
    return {
      state: "ambiguous",
      reason: "Versioned result envelope nonces were mismatched.",
      openerCount: 1,
      closerCount: 1
    };
  }
  const expectedLength = Number(lengthText);
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0 || expectedLength > 4 * 1024 * 1024) {
    return {
      state: "ambiguous",
      reason: "Versioned result envelope declared an invalid byte length.",
      openerCount: 1,
      closerCount: 1
    };
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length !== expectedLength) {
    return {
      state: "ambiguous",
      reason: "Versioned result envelope base64 or decoded length was invalid.",
      openerCount: 1,
      closerCount: 1
    };
  }
  let result;
  try {
    result = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      state: "ambiguous",
      reason: "Versioned result envelope payload was not valid UTF-8.",
      openerCount: 1,
      closerCount: 1
    };
  }
  return { state: "available", result, source: "encoded-v1", openerCount: 1, closerCount: 1 };
}

export function analyseMarkedBackgroundResult(raw, marker) {
  if (!marker) return null;
  const token = sanitizeSegment(marker);
  const start = `<CODEX_RESULT_${token}>`;
  const end = `</CODEX_RESULT_${token}>`;
  const original = String(raw || "");
  const screenReaderText = stripControlForResult(original);
  const rawLines = original.split("\n");
  const lines = screenReaderText.split("\n");
  if (rawLines.length !== lines.length) {
    return {
      state: "ambiguous",
      reason: "Terminal control data made the assistant-output boundary ambiguous.",
      openerCount: 0,
      closerCount: 0
    };
  }
  const classified = lines.map(classifyMarkedLine);
  const assistantOpeners = classified.flatMap((line, index) =>
    line.assistantBoundary && line.markerTag === start ? [index] : []
  );
  if (!assistantOpeners.length) {
    return {
      state: "unavailable",
      reason: "No assistant-bounded result marker pair was present.",
      openerCount: 0,
      closerCount: 0
    };
  }
  if (assistantOpeners.length !== 1) {
    return {
      state: "ambiguous",
      reason: "Repeated assistant result openers were present.",
      openerCount: assistantOpeners.length,
      closerCount: classified.filter((line) => line.markerTag === end).length
    };
  }

  const openIndex = assistantOpeners[0];
  let lastPromptIndex = -1;
  for (let index = 0; index < openIndex; index += 1) {
    if (/^\s*[❯$](?:\s|$)/u.test(lines[index])) lastPromptIndex = index;
  }
  if (lastPromptIndex === -1 && classified.slice(0, openIndex).some((line) => line.markerTag)) {
    return {
      state: "ambiguous",
      reason: "A stray or reversed result marker preceded the assistant result.",
      openerCount: 1,
      closerCount: classified.filter((line) => line.markerTag === end).length
    };
  }

  let regionEnd = lines.length;
  for (let index = openIndex + 1; index < lines.length; index += 1) {
    if (/^\s*[❯$](?:\s|$)/u.test(lines[index])) {
      regionEnd = index;
      break;
    }
  }
  const events = classified
    .slice(openIndex, regionEnd)
    .flatMap((line, offset) => line.markerTag ? [{ index: openIndex + offset, tag: line.markerTag }] : []);
  const openerCount = events.filter((event) => event.tag === start).length;
  const closerCount = events.filter((event) => event.tag === end).length;
  const exactShape = events.length === 2 && events[0].tag === start && events[1].tag === end;
  if (!exactShape || openerCount !== 1 || closerCount !== 1) {
    return {
      state: "ambiguous",
      reason: "Marked result framing was repeated, nested, mismatched, overlapping or out of order.",
      openerCount,
      closerCount
    };
  }

  const closeIndex = events[1].index;
  const rawFrame = rawLines.slice(openIndex, closeIndex + 1).join("\n");
  if (/\r/.test(rawFrame)) {
    return {
      state: "ambiguous",
      reason: "Marked-human result framing is LF-only; carriage returns and CRLF are unsupported.",
      openerCount,
      closerCount
    };
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(rawFrame)) {
    return {
      state: "ambiguous",
      reason: "Terminal control data appeared inside the marked result frame.",
      openerCount,
      closerCount
    };
  }
  return {
    state: "available",
    result: rawLines.slice(openIndex + 1, closeIndex).join("\n"),
    source: "marked-human",
    openerCount,
    closerCount
  };
}

function parseLegacyHumanResult(text) {
  const lines = text.split("\n");
  const blocks = [];
  let role = "unbounded";
  let block = null;
  const finishBlock = () => {
    if (block) blocks.push(block.join("\n").replace(/\s+$/, ""));
    block = null;
  };
  for (const line of lines) {
    if (/^[❯$](?:\s|$)/u.test(line)) {
      finishBlock();
      role = "user";
      continue;
    }
    if (/^\s*[✢✳✶✻✽·]/.test(line) || /^\s*(?:plan mode|effort:|\/rc active|ctx:)/i.test(line)) {
      finishBlock();
      role = "unbounded";
      continue;
    }
    const assistant = line.match(/^⏺\s{0,2}(.*)$/u);
    if (assistant) {
      finishBlock();
      role = "assistant";
      block = [assistant[1]];
      continue;
    }
    if (role === "assistant" && block) {
      block.push(line);
    }
  }
  finishBlock();
  if (!blocks.length) return { state: "unavailable", reason: "Logs contained no uniquely bounded assistant result." };
  if (blocks.length !== 1) {
    return { state: "ambiguous", reason: "Logs contained repeated or conflicting assistant result blocks." };
  }
  return { state: "available", result: blocks[0], source: "legacy-human" };
}

export function parseBackgroundResult(raw, options = {}) {
  const original = String(raw || "");
  if (!original.trim()) return { state: "unavailable", reason: "Claude logs were empty." };
  for (const candidate of [original.trim(), stripControlForResult(original).trim()]) {
    try {
      const envelope = JSON.parse(candidate);
      if (
        envelope?.type === "result" &&
        envelope.subtype === "success" &&
        envelope.is_error !== true &&
        typeof envelope.result === "string"
      ) {
        return { state: "available", result: envelope.result, source: "json" };
      }
    } catch {
      // Human terminal output is handled below.
    }
  }
  const encoded = analyseEncodedBackgroundResult(original, options.marker);
  if (encoded) {
    const { openerCount: _openerCount, closerCount: _closerCount, ...result } = encoded;
    return result;
  }
  const marked = analyseMarkedBackgroundResult(original, options.marker);
  if (marked) {
    const { openerCount: _openerCount, closerCount: _closerCount, ...result } = marked;
    return result;
  }
  return parseLegacyHumanResult(stripControlForResult(original).replace(/\r+/g, "\n"));
}

function assertString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Review finding is missing ${field}.`);
  }
}

export function validateReviewPayload(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed.startsWith("{")) {
    throw new Error("Invalid JSON review output.");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
    scanJsonValue(trimmed, 0, true);
  } catch {
    throw new Error("Invalid JSON review output.");
  }

  if (!Array.isArray(parsed.findings)) {
    throw new Error("Review output must include a findings array.");
  }
  if (Object.keys(parsed).some((key) => key !== "findings")) {
    throw new Error("Review output has unsupported fields.");
  }

  for (const finding of parsed.findings) {
    if (!REVIEW_SEVERITIES.has(finding?.severity)) {
      throw new Error("Review finding has unsupported severity.");
    }
    assertString(finding.title, "title");
    assertString(finding.fact, "fact");
    assertString(finding.recommendation, "recommendation");
    if (Object.keys(finding).some((key) => !["severity", "title", "fact", "recommendation"].includes(key))) {
      throw new Error("Review finding has unsupported fields.");
    }
  }

  return parsed;
}

export function parseClaudeJsonResult(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("{")) {
    throw new Error("Invalid JSON Claude output.");
  }
  const envelope = JSON.parse(text);
  const sessionId = envelope.session_id || envelope.sessionId || null;
  const contentRaw = typeof envelope.result === "string" ? normalizeClaudeResult(envelope.result) : text;
  const content = typeof envelope.result === "string" ? JSON.parse(contentRaw) : envelope;
  return {
    envelope,
    content,
    contentRaw,
    sessionId
  };
}

function normalizeClaudeResult(raw) {
  const trimmed = String(raw || "").trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const candidates = extractJsonObjects(trimmed);
    if (candidates.length > 1) {
      throw new Error("Ambiguous JSON Claude result: multiple complete objects were returned.");
    }
    if (candidates.length !== 1) throw new Error("Invalid JSON Claude result.");
    const candidate = candidates[0];
    const prefix = trimmed.slice(0, candidate.start);
    const suffix = trimmed.slice(candidate.end);
    const framing = prefix + suffix;
    for (const line of [prefix, suffix].flatMap((part) => part.split(/\r?\n/))) {
      const fragment = line.trim();
      if (!fragment.startsWith("[")) continue;
      let end;
      try {
        end = scanJsonValue(fragment, 0);
      } catch {
        // A standalone array fragment can be a truncated competing result.
        // Ordinary links and bracketed prose do not start with a JSON value.
        if (/^\[\s*(?:$|[\[\]{"\d-]|true\b|false\b|null\b)/.test(fragment)) {
          throw new Error("Invalid JSON Claude result.");
        }
        continue;
      }
      if (skipJsonWhitespace(fragment, end) === fragment.length) {
        throw new Error("Ambiguous JSON Claude result: an additional array was returned.");
      }
    }
    // Inspect framing outside the object; finding strings may quote markup.
    if (/<\/?function_calls/.test(framing)) {
      const toolCalls = prefix.match(/^<function_calls>[\s\S]*?<\/function_calls>/);
      if (
        !toolCalls ||
        /<\/?function_calls/.test(toolCalls[0].slice("<function_calls>".length, -"</function_calls>".length)) ||
        /<\/?function_calls/.test(framing.slice(toolCalls[0].length))
      ) throw new Error("Invalid Claude result wrapper.");
    }
    if (framing.includes("```")) {
      if (
        (framing.match(/```/g) || []).length !== 2 ||
        !/(?:^|[^`])```(?:json)?[ \t]*\r?\n\s*$/i.test(prefix) ||
        !/^\s*```(?!`)/.test(suffix)
      ) throw new Error("Invalid Claude result wrapper.");
    }
    return candidate.raw;
  }
}

function extractJsonObjects(value) {
  const text = String(value || "");
  const objects = [];
  let start = -1;
  let depth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        // Brackets in surrounding prose are harmless, but an object nested
        // inside an array must not become a standalone review payload.
        if (bracketDepth > 0) throw new Error("Invalid JSON Claude result.");
        start = index;
      }
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) throw new Error("Invalid JSON Claude result.");
      depth -= 1;
      if (depth === 0) {
        objects.push({ raw: text.slice(start, index + 1), start, end: index + 1 });
        start = -1;
      }
    } else if (depth === 0 && char === "[") {
      bracketDepth += 1;
    } else if (depth === 0 && char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    }
  }
  if (depth !== 0 || inString || escaped) throw new Error("Invalid JSON Claude result.");
  return objects;
}

export function buildReviewPrompt({ kind, targetLabel, gitContext, focus = "" }) {
  const reviewKind = kind === "adversarial-review" ? "adversarial reviewer" : "code reviewer";
  const focusLine = focus ? `Focus: ${focus}\n` : "";
  return [
    `You are a skeptical ${reviewKind}.`,
    "This is a read-only review. Do not edit files, run commands, or suggest you are about to make changes.",
    "Return JSON only with this exact shape:",
    '{"findings":[{"severity":"BLOCKER|MAJOR|MINOR","title":"...","fact":"...","recommendation":"..."}]}',
    "Use BLOCKER only for issues that must be resolved or explicitly waived before proceeding.",
    focusLine,
    `Target: ${targetLabel}`,
    "Git context:",
    gitContext || "No git context was available."
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderHuman(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "jobId" in value && "status" in value && "output" in value) {
    const output = String(value.output || "").trim();
    if (value.status === "completed") {
      return output ? `${output}\n` : `Claude job ${value.jobId} completed.\n`;
    }
    if (value.status === "running") {
      return `Claude job ${value.jobId} is running${value.claudeSessionId ? ` as ${value.claudeSessionId}` : ""}.\n`;
    }
    return [`Claude job ${value.jobId} ${value.status}.`, output].filter(Boolean).join("\n") + "\n";
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}
