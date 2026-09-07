import assert from "node:assert/strict";
import test from "node:test";

import { cycloneDx, licenseInventory } from "./windows-release-evidence.mjs";

const metadata = {
  components: [{ id: "backend", version: "1", source: "https://github.com/xuchen-cloud/penpot", license: "MPL-2.0" }],
  sources: [{ id: "node", version: "24", source: "https://nodejs.org/", license: "MIT" }],
};

test("builds a complete license inventory", () => {
  assert.deepEqual(licenseInventory(metadata).map((value) => value.id), ["backend", "node"]);
});

test("builds a CycloneDX document tied to the installer", () => {
  const result = cycloneDx(metadata, "C:/release/Penpot-Setup.exe", "a".repeat(64));
  assert.equal(result.bomFormat, "CycloneDX");
  assert.equal(result.metadata.component.hashes[0].content, "a".repeat(64));
  assert.equal(result.components.length, 2);
  assert.deepEqual(result.components[0].licenses, [{ license: { name: "MPL-2.0" } }]);
});
