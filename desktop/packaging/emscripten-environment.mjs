import { access, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

async function required(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
  return path;
}

async function findUniqueExecutable(parent, relativeCandidates, label) {
  const directories = await readdir(parent, { withFileTypes: true });
  const matches = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    for (const relativePath of relativeCandidates) {
      const candidate = join(parent, directory.name, relativePath);
      try {
        await access(candidate);
        matches.push(candidate);
      } catch {
        // Try the next supported SDK layout.
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${label} in ${parent}, found ${matches.length}`,
    );
  }
  return matches[0];
}

export async function buildEmscriptenEnvironment({
  emsdkRoot,
  cacheRoot,
  baseEnv = process.env,
  platform = process.platform,
}) {
  const root = resolve(emsdkRoot);
  const windows = platform === "win32";
  const python = await findUniqueExecutable(
    await required(join(root, "python"), "Emscripten Python directory"),
    windows ? ["python.exe"] : ["bin/python3", "bin/python"],
    "Emscripten Python executable",
  );
  const node = await findUniqueExecutable(
    await required(join(root, "node"), "Emscripten Node directory"),
    windows ? ["bin/node.exe"] : ["bin/node"],
    "Emscripten Node executable",
  );
  const emscripten = await required(
    join(root, "upstream/emscripten"),
    "Emscripten compiler directory",
  );
  const llvm = await required(
    join(root, "upstream/bin"),
    "Emscripten LLVM directory",
  );
  const config = await required(
    join(root, ".emscripten"),
    "Emscripten configuration",
  );
  const pathDelimiter = windows ? ";" : ":";
  const basePathKey = Object.keys(baseEnv).find(
    (name) => name.toLowerCase() === "path",
  );
  const basePath = basePathKey ? baseEnv[basePathKey] : "";
  const normalizedEnv = Object.fromEntries(
    Object.entries(baseEnv).filter(([name]) => name.toLowerCase() !== "path"),
  );
  const path = [
    root,
    emscripten,
    llvm,
    dirname(python),
    dirname(node),
    basePath,
  ]
    .filter(Boolean)
    .join(pathDelimiter);
  return {
    ...normalizedEnv,
    PATH: path,
    EMSDK: root,
    EMSDK_NODE: node,
    EMSDK_PYTHON: python,
    EMSDK_QUIET: "1",
    EM_CONFIG: config,
    EM_CACHE: resolve(cacheRoot),
  };
}
