import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleaseVersionAlignment,
  extractDocumentedCurrentRelease,
} from "./lib/release-version.mjs";

const currentReleaseLine = (labelVersion, tagVersion = labelVersion) =>
  `Current public release: [\`v${labelVersion}\`](https://github.com/MylesMCook/claude-plugin-codex/releases/tag/v${tagVersion}).`;

test("extracts one canonical documented current release", () => {
  assert.equal(extractDocumentedCurrentRelease(currentReleaseLine("1.2.3")), "1.2.3");
  assert.equal(
    extractDocumentedCurrentRelease(`${currentReleaseLine("1.2.3")}\r\n`),
    "1.2.3"
  );
});

test("rejects missing, duplicate or internally inconsistent release documentation", () => {
  assert.throws(
    () => extractDocumentedCurrentRelease("No release declared."),
    /exactly one canonical/
  );
  assert.throws(
    () =>
      extractDocumentedCurrentRelease(
        `${currentReleaseLine("1.2.3")}\n${currentReleaseLine("1.2.3")}`
      ),
    /exactly one canonical/
  );
  assert.throws(
    () => extractDocumentedCurrentRelease(currentReleaseLine("1.2.3", "1.2.2")),
    /label and tag link must agree/
  );
  assert.throws(
    () => extractDocumentedCurrentRelease("Current public release: v1.2.3"),
    /must use the canonical version label and release URL/
  );
});

test("rejects package, manifest and documented release drift", () => {
  assert.doesNotThrow(() =>
    assertReleaseVersionAlignment({
      packageVersion: "1.2.3",
      manifestVersion: "1.2.3",
      readme: currentReleaseLine("1.2.3"),
    })
  );
  assert.throws(
    () =>
      assertReleaseVersionAlignment({
        packageVersion: "1.2.3",
        manifestVersion: "1.2.2",
        readme: currentReleaseLine("1.2.3"),
      }),
    /manifest version must match package\.json version/
  );
  assert.throws(
    () =>
      assertReleaseVersionAlignment({
        packageVersion: "1.2.3",
        manifestVersion: "1.2.3",
        readme: currentReleaseLine("1.2.2"),
      }),
    /current public release must match package\.json version/
  );
});
