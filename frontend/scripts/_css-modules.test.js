import assert from "node:assert/strict";
import test from "node:test";

import { generateScopedName } from "./_css-modules.js";

test("generates the same scoped name for Windows and POSIX paths", () => {
  const selector = "workspace";
  const posixPath = "/project/frontend/src/app/main/ui/workspace.css";
  const windowsPath =
    "D:\\project\\frontend\\src\\app\\main\\ui\\workspace.css";

  assert.equal(
    generateScopedName(selector, windowsPath),
    generateScopedName(selector, posixPath),
  );
  assert.equal(
    generateScopedName(selector, windowsPath),
    "main_ui_workspace__workspace",
  );
});
