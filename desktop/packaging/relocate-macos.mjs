import { copyFile, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const cellar = "/opt/homebrew/Cellar";

function output(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

async function files(root) {
  const result = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result.push(child);
    }
  }
  await walk(root);
  return result;
}

async function isMachO(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    if (bytesRead !== 4) return false;
    return new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "cafebabf", "bebafeca", "bfbafeca"])
      .has(buffer.toString("hex"));
  } finally {
    await handle.close();
  }
}

function dependencies(path) {
  const value = output("otool", ["-L", path]);
  if (!value) return [];
  return value.split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
}

export async function relocateMacos(root) {
  const canonicalRoot = await realpath(root);
  const queue = [];
  for (const path of await files(canonicalRoot)) if (await isMachO(path)) queue.push(path);
  const queued = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    const binary = queue[index];
    for (const dependency of dependencies(binary)) {
      if (!dependency.startsWith("/opt/homebrew/")) continue;
      const source = await realpath(dependency);
      if (!source.startsWith(`${cellar}/`)) {
        throw new Error(`Homebrew dependency is outside Cellar: ${dependency}`);
      }
      const destination = resolve(canonicalRoot, "native", relative(cellar, source));
      if (!destination.startsWith(`${canonicalRoot}/`)) throw new Error(`Unsafe dependency: ${source}`);
      try { await lstat(destination); } catch {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
      }
      const loaderPath = relative(dirname(binary), destination).replaceAll("\\", "/");
      const replacement = `@loader_path/${loaderPath}`;
      const changed = spawnSync("install_name_tool", ["-change", dependency, replacement, binary], { encoding: "utf8" });
      if (changed.status !== 0) throw new Error(`Could not relocate ${binary}: ${changed.stderr}`);
      if (!queued.has(destination)) { queued.add(destination); queue.push(destination); }
    }
  }
  for (const binary of queue) {
    const external = dependencies(binary).find((path) => path.startsWith("/opt/homebrew/"));
    if (external) throw new Error(`Unrelocated dependency ${external} in ${binary}`);
  }
}
