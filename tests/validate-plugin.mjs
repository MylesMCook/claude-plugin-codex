import assert from "node:assert/strict";
import fs from "node:fs";
import { assertReleaseVersionAlignment } from "./lib/release-version.mjs";

const readText = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const manifest = JSON.parse(readText("plugins/claude-code-advisor/.codex-plugin/plugin.json"));
const marketplace = JSON.parse(readText(".agents/plugins/marketplace.json"));
const packageJson = JSON.parse(readText("package.json"));
const skill = readText("plugins/claude-code-advisor/skills/claude/SKILL.md");
const readme = readText("README.md");
const alphaGuide = readText("docs/alpha-testing.md");
const alphaReport = readText(".github/ISSUE_TEMPLATE/alpha_test_report.yml");
const bugReport = readText(".github/ISSUE_TEMPLATE/bug_report.yml");
const issueConfig = readText(".github/ISSUE_TEMPLATE/config.yml");
const commands = readText("docs/commands.md");
const e2e = readText("tests/e2e-codex-skill.mjs");
const smoke = readText("tests/smoke-installed-tools.mjs");
const companion = readText("plugins/claude-code-advisor/scripts/claude-companion.mjs");
const supervisor = readText("plugins/claude-code-advisor/scripts/claude-supervisor.mjs");
const groupWorker = readText("plugins/claude-code-advisor/scripts/claude-group-worker.mjs");
const runtime = readText("plugins/claude-code-advisor/scripts/lib/runtime.mjs");

assertReleaseVersionAlignment({
  packageVersion: packageJson.version,
  manifestVersion: manifest.version,
  readme,
});

assert.equal(manifest.name, "claude-code-advisor");
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.interface?.displayName, "Claude Code Advisor");
assert.deepEqual(manifest.interface?.capabilities, ["Read", "Write"]);
assert.ok(manifest.interface?.defaultPrompt?.length <= 3);
assert.ok(manifest.interface.defaultPrompt.every((prompt) => prompt.length <= 128));
assert.equal(manifest.homepage, "https://github.com/MylesMCook/claude-plugin-codex");
assert.equal(manifest.repository, "https://github.com/MylesMCook/claude-plugin-codex");
assert.equal(manifest.interface?.developerName, "Myles Cook");
assert.equal(manifest.interface?.websiteURL, "https://github.com/MylesMCook/claude-plugin-codex");
assert.equal(manifest.interface?.privacyPolicyURL, "https://github.com/MylesMCook/claude-plugin-codex/blob/main/PRIVACY.md");
assert.equal(manifest.interface?.termsOfServiceURL, "https://github.com/MylesMCook/claude-plugin-codex/blob/main/TERMS.md");
assert.match(readme, /codex plugin marketplace add MylesMCook\/claude-plugin-codex/);
assert.match(readme, /codex plugin add claude-code-advisor@claude-plugin-codex/);
assert.match(readme, /maintained fork/);
assert.doesNotMatch(readme, /codex plugin marketplace add yanchuk\/claude-plugin-codex/);
assert.equal(marketplace.interface?.displayName, "Claude Code Advisor for Codex");
assert.ok(fs.existsSync("plugins/claude-code-advisor/com.openai/assets/icon.svg"));
assert.ok(fs.existsSync("plugins/claude-code-advisor/com.openai/assets/logo.svg"));
for (const publicPath of [
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
  "TERMS.md",
  "docs/alpha-testing.md",
  "docs/commands.md",
  "docs/assets/social-preview.png",
  "docs/assets/claude-code-advisor-demo.png",
  ".github/ISSUE_TEMPLATE/alpha_test_report.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/pull_request_template.md",
]) {
  assert.ok(fs.existsSync(publicPath), `missing public-release file: ${publicPath}`);
}
assert.equal(fs.lstatSync("CLAUDE.md").isSymbolicLink(), false);
assert.equal(readText("CLAUDE.md").trim(), "@AGENTS.md");
assert.ok(marketplace.plugins.some((plugin) => plugin.name === "claude-code-advisor"));
assert.equal(packageJson.scripts["test:e2e:codex"], "node tests/e2e-codex-skill.mjs");
assert.ok(fs.existsSync("tests/e2e-codex-skill.mjs"));
assert.match(skill, /^---\nname: claude\n/m);
assert.match(skill, /claude-companion\.mjs/);
assert.match(skill, /\/claude:rescue/);
assert.match(skill, /\/claude:do/);
assert.match(skill, /tasks-for-sonnet/);
assert.match(skill, /\$claude do --model opus/);
assert.match(skill, /complex\/high-judgment/);
assert.match(skill, /What Must Be True/);
assert.match(skill, /Mechanical Verification/);
assert.match(skill, /\$claude monitor/);
assert.match(skill, /Do not pass `--model sonnet`/);
assert.match(skill, /`--effort xhigh`/);
assert.match(skill, /--stale-after-ms 120000/);
assert.match(skill, /--mcp-config/);
assert.match(skill, /--no-chrome/);
assert.match(skill, /--allow-mcp/);
assert.match(skill, /--allow-web/);
assert.match(skill, /Do not use project MCP servers/);
assert.match(skill, /Read,Glob,Grep/);
assert.match(skill, /automatically launches one supervised background job/);
assert.match(skill, /Plugin job IDs and supervisor lifecycle IDs are never passed to `--resume`/);
assert.match(skill, /`claude -p --output-format json`/);
assert.match(skill, /Never use\s+terminal logs or stderr as a result source/);
assert.match(skill, /diff exceeds 1 MiB/);
assert.match(readme, /--no-background-fallback/);
assert.match(readme, /--mcp-config/);
assert.match(readme, /--no-chrome/);
assert.match(readme, /--allow-mcp/);
assert.match(readme, /--allow-web/);
assert.match(readme, /ancestor directories/);
assert.match(readme, /Unable to load skill contents/);
assert.match(readme, /\$claude do/);
assert.match(readme, /tasks-for-sonnet/);
assert.match(readme, /\$claude do --model opus/);
assert.match(readme, /\$claude advise --effort xhigh/);
assert.match(readme, /Web tools are denied unless `--allow-web` is explicit/);
assert.match(readme, /Malformed JSON and unsupported schema/);
assert.match(readme, /diff exceeds 1 MiB/);
assert.match(readme, /Supervised background mode currently requires macOS/);
assert.match(readme, /Abrupt supervisor `SIGKILL`/);
const alphaReportUrl = "https://github.com/MylesMCook/claude-plugin-codex/issues/new?template=alpha_test_report.yml";
assert.ok(readme.includes(alphaReportUrl));
assert.ok(alphaGuide.includes(alphaReportUrl));
assert.match(readme, /Deterministic tests alone do not establish\s+authenticated use/);
assert.match(readme, /that outcome verifies routing only/);
assert.match(alphaGuide, /Reporting is entirely optional/);
assert.match(alphaGuide, /native Windows/);
assert.match(alphaGuide, /WSL/);
assert.match(alphaGuide, /Optional 15–20-minute check/);
assert.match(alphaGuide, /public, disposable or otherwise non-sensitive Git repository/);
assert.doesNotMatch(readme, /three-person pilot/);
assert.doesNotMatch(alphaGuide, /three independent testers|10 external installations|repeat use by at least five testers/);
assert.doesNotMatch(alphaGuide, /bug form or the alpha feedback issue/);
assert.match(alphaReport, /- Pass\n/);
assert.match(alphaReport, /- Failure\n/);
assert.match(alphaReport, /- Inconclusive\n/);
assert.match(alphaReport, /id: install_outcome/);
assert.match(alphaReport, /id: setup_outcome/);
assert.match(alphaReport, /id: review_outcome/);
assert.ok(
  alphaReport.indexOf("id: overall_outcome") > alphaReport.indexOf("id: review_outcome"),
  "overall outcome must follow the stage outcomes"
);
assert.doesNotMatch(alphaReport, /Outcome stage:/);
assert.match(alphaReport, /technically successful review that was not useful is equally welcome/);
assert.match(alphaReport, /fixed test should take about 15–20 minutes/);
assert.match(alphaReport, /public, disposable or otherwise non-sensitive repository/);
assert.match(alphaReport, /confidential or private source code, credentials, tokens, cookies, session data, private prompts, personal information, unredacted screenshots or full unsanitised logs/);
assert.match(bugReport, /confidential or private source code, credentials, tokens, cookies, session data, private prompts, personal information, unredacted screenshots or full unsanitised logs/);
assert.match(issueConfig, /blank_issues_enabled: true/);
assert.match(issueConfig, /alpha_test_report\.yml is the sole alpha-test reporting route/);
assert.match(commands, /Resume uses only a canonical full Claude session UUID/);
assert.match(commands, /exactly one schema-valid UTF-8 JSON document/);
assert.match(commands, /complete diff exceeds 1 MiB/);
assert.match(smoke, /mkdtempSync/);
assert.match(smoke, /randomUUID/);
assert.match(smoke, /verifyCompletedJob/);
assert.match(smoke, /verifyIdempotence/);
assert.match(smoke, /strictEnvelope/);
assert.match(smoke, /cleanupActiveJobs/);
assert.match(smoke, /resultAuthoritativeAt/);
assert.match(smoke, /canonicalSessionId/);
assert.match(smoke, /supervisorPaths/);
assert.match(smoke, /if \(cleanupVerified\)/);
assert.doesNotMatch(
  smoke,
  /console\.(?:log|error)\([^\n]*(?:firstNonce|secondNonce|thirdNonce|canonicalSessionId|jobId|stderr|stdout)/,
  "authenticated smoke must not print provider data or identifiers"
);
assert.match(smoke, /Authenticated smoke FAIL: \$\{cleanupVerified \? failureClassification : "cleanup-unverified"\}/);
assert.match(smoke, /Skipping authenticated background smoke/);
assert.match(companion, /spawn\(process\.execPath, \[supervisorScript\]/);
assert.doesNotMatch(companion, /runClaude\(\["(?:agents|logs|stop)"/);
assert.match(supervisor, /claude-group-worker\.mjs/);
assert.doesNotMatch(supervisor, /spawn\("claude"/);
assert.match(groupWorker, /spawn\(discoverClaude\(\), config\.claudeArgs/);
assert.match(groupWorker, /stdio: \["pipe", "pipe", "pipe"\]/);
assert.match(groupWorker, /process\.kill\(-process\.pid, "SIGTERM"\)/);
assert.match(groupWorker, /process\.kill\(-process\.pid, "SIGKILL"\)/);
assert.match(runtime, /validateSupervisedClaudeResult/);
assert.match(runtime, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
assert.match(runtime, /SUPERVISED_PERSISTED_FIELDS/);
assert.match(e2e, /configured default Claude model/);
assert.doesNotMatch(e2e, /--model sonnet/);
assert.match(e2e, /"--sandbox", "workspace-write"/);
assert.doesNotMatch(smoke, /"--model", "sonnet"/);
assert.match(smoke, /env: \{ \.\.\.process\.env, CLAUDE_COMPANION_STATE_ROOT: stateRoot \}/);
assert.match(readme, /inherits the\s+invoking process environment/);
assert.match(e2e, /export function classifyRoutedOutput/);
assert.match(e2e, /export function renderE2eFailure/);
assert.doesNotMatch(e2e, /args\.join\(" "\)/);
assert.doesNotMatch(e2e, /aggregated_output\}`/);
assert.doesNotMatch(e2e, /unexpected companion result:\\n\$\{routedOutput\}/);

console.log("plugin metadata ok");
