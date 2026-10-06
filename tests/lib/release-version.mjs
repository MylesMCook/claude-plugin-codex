import assert from "node:assert/strict";

const CURRENT_RELEASE_PATTERN =
  /^Current public release: \[`v([^`\]\s]+)`\]\(https:\/\/github\.com\/MylesMCook\/claude-plugin-codex\/releases\/tag\/v([^\s)]+)\)\.$/;

export function extractDocumentedCurrentRelease(readme) {
  const declarations = readme
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Current public release:"));

  assert.equal(
    declarations.length,
    1,
    "README.md must contain exactly one canonical 'Current public release' line"
  );
  const match = declarations[0].match(CURRENT_RELEASE_PATTERN);

  assert.ok(
    match,
    "README.md current public release must use the canonical version label and release URL"
  );
  assert.equal(
    match[1],
    match[2],
    "README.md current-release label and tag link must agree"
  );

  return match[1];
}

export function assertReleaseVersionAlignment({ packageVersion, manifestVersion, readme }) {
  const documentedVersion = extractDocumentedCurrentRelease(readme);

  assert.equal(
    manifestVersion,
    packageVersion,
    "plugin manifest version must match package.json version"
  );
  assert.equal(
    documentedVersion,
    packageVersion,
    "README.md current public release must match package.json version"
  );

  return documentedVersion;
}
