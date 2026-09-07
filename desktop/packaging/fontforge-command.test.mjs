import assert from "node:assert/strict";
import test from "node:test";

import { fontForgeStringLiteral } from "../compatibility/fontforge-command.mjs";

test("quotes Windows paths for the FontForge scripting language", () => {
  assert.equal(
    fontForgeStringLiteral("C:\\Users\\O'Brien\\Penpot Desktop\\font.ttf"),
    "'C:/Users/O\\'Brien/Penpot Desktop/font.ttf'",
  );
});
