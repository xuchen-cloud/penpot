import { access, readdir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const REQUIRED_FRONTEND_FILES = [
  "index.html",
  "css/main.css",
  "js/main.js",
  "js/worker/main.js",
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resetFrontendOutput(publicRoot) {
  await rm(publicRoot, { recursive: true, force: true });
}

export async function validateFrontendOutput(publicRoot) {
  for (const required of REQUIRED_FRONTEND_FILES) {
    if (!(await exists(join(publicRoot, ...required.split("/"))))) {
      throw new Error(`Frontend build is incomplete; missing ${required}`);
    }
  }

  const entries = await readdir(publicRoot, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const portable = relative(publicRoot, path).split(sep).join("/");
    if (
      entry.isDirectory() &&
      (portable === "resources/public" ||
        portable.endsWith("/resources/public"))
    ) {
      throw new Error(
        `Frontend build contains nested resources/public output: ${portable}`,
      );
    }
    if (
      entry.isFile() &&
      entry.name.toLowerCase() === "main.css" &&
      portable.toLowerCase() !== "css/main.css"
    ) {
      throw new Error(`Frontend build contains duplicate main.css: ${portable}`);
    }
  }
}
