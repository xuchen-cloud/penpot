import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { sha256File } from "./download-cache.mjs";

export const SHARED_ARTIFACT_MANIFEST = "shared-artifacts.json";

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function portableRelativePath(root, path, label) {
  const value = relative(root, path);
  if (
    !value ||
    value === ".." ||
    value.startsWith(`..${sep}`) ||
    isAbsolute(value)
  ) {
    throw new Error(`${label} is outside the shared artifact root: ${path}`);
  }
  return value.split(sep).join("/");
}

function validatePortablePath(value, label) {
  requiredString(value, label);
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw new Error(`${label} must be a portable relative path: ${value}`);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} contains an unsafe segment: ${value}`);
  }
  const windowsDevice = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (
    segments.some(
      (segment) =>
        /[<>:"\\|?*\x00-\x1f]/.test(segment) ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        windowsDevice.test(segment),
    )
  ) {
    throw new Error(`${label} is not portable to Windows: ${value}`);
  }
  return value;
}

function portableKey(value) {
  return value.toLowerCase();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function walkFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(
        `Shared artifacts cannot contain symbolic links: ${path}`,
      );
    if (entry.isDirectory()) files.push(...(await walkFiles(root, path)));
    else if (entry.isFile()) files.push(path);
    else
      throw new Error(`Shared artifacts contain an unsupported entry: ${path}`);
  }
  return files;
}

function validateSource(source) {
  if (source?.repository !== "https://github.com/xuchen-cloud/penpot") {
    throw new Error(
      "Shared artifact source repository must be https://github.com/xuchen-cloud/penpot",
    );
  }
  if (!/^[a-f0-9]{40}$/.test(source.revision || "")) {
    throw new Error(
      "Shared artifact source revision must be a full Git commit ID",
    );
  }
  if (source.dirty !== undefined && typeof source.dirty !== "boolean") {
    throw new Error("Shared artifact source dirty flag must be a boolean");
  }
  if (source.dirty && !/^[a-f0-9]{64}$/.test(source.worktreeSha256 || "")) {
    throw new Error(
      "Dirty shared artifact source must include a worktree SHA-256",
    );
  }
  if (!source.dirty && source.worktreeSha256 !== undefined) {
    throw new Error(
      "Clean shared artifact source cannot include a worktree SHA-256",
    );
  }
}

function validateToolchains(toolchains) {
  if (
    !toolchains ||
    typeof toolchains !== "object" ||
    Array.isArray(toolchains)
  ) {
    throw new Error("Shared artifact toolchains must be an object");
  }
  if (Object.keys(toolchains).length === 0)
    throw new Error("Shared artifact toolchains cannot be empty");
  for (const [name, version] of Object.entries(toolchains)) {
    requiredString(name, "Toolchain name");
    requiredString(version, `Toolchain ${name}`);
  }
}

export async function createSharedArtifactManifest({
  artifactRoot,
  artifactVersion,
  source,
  toolchains,
  components,
}) {
  const root = resolve(artifactRoot);
  requiredString(artifactVersion, "Shared artifact version");
  validateSource(source);
  validateToolchains(toolchains);
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error("Shared artifact components must be a non-empty array");
  }
  const seenComponents = new Set();
  const seenFiles = new Set();
  const seenInstallFiles = new Set();
  const outputComponents = [];
  for (const component of components) {
    const id = requiredString(component.id, "Shared artifact component id");
    if (seenComponents.has(portableKey(id)))
      throw new Error(`Shared artifact component is repeated: ${id}`);
    seenComponents.add(portableKey(id));
    const artifactRoot = validatePortablePath(
      component.root,
      `Component ${id} artifactRoot`,
    );
    const installRoot = validatePortablePath(
      component.installRoot,
      `Component ${id} installRoot`,
    );
    const componentRoot = resolve(root, artifactRoot);
    portableRelativePath(root, componentRoot, `Component ${id} root`);
    const filePaths = await walkFiles(componentRoot);
    if (filePaths.length === 0)
      throw new Error(`Shared artifact component has no files: ${id}`);
    if (
      !Array.isArray(component.buildCommand) ||
      component.buildCommand.length === 0
    ) {
      throw new Error(`Component ${id} buildCommand must be a non-empty array`);
    }
    const files = [];
    for (const path of filePaths) {
      const artifactPath = portableRelativePath(
        root,
        path,
        `Component ${id} file`,
      );
      if (seenFiles.has(portableKey(artifactPath)))
        throw new Error(`Shared artifact file is owned twice: ${artifactPath}`);
      seenFiles.add(portableKey(artifactPath));
      const componentRelativePath = artifactPath.slice(artifactRoot.length + 1);
      const installPath = `${installRoot}/${componentRelativePath}`;
      if (seenInstallFiles.has(portableKey(installPath))) {
        throw new Error(
          `Shared artifact install destination is owned twice: ${installPath}`,
        );
      }
      seenInstallFiles.add(portableKey(installPath));
      const details = await stat(path);
      files.push({
        path: artifactPath,
        size: details.size,
        sha256: await sha256File(path),
      });
    }
    outputComponents.push({
      id,
      version: requiredString(component.version, `Component ${id} version`),
      license: requiredString(component.license, `Component ${id} license`),
      buildCommand: component.buildCommand.map((argument, index) =>
        requiredString(argument, `Component ${id} buildCommand ${index}`),
      ),
      artifactRoot,
      installRoot,
      files,
    });
  }
  outputComponents.sort((left, right) => compareText(left.id, right.id));
  return {
    schemaVersion: 1,
    artifactVersion,
    source,
    toolchains: Object.fromEntries(
      Object.entries(toolchains).sort(([left], [right]) =>
        compareText(left, right),
      ),
    ),
    components: outputComponents,
  };
}

export function validateSharedArtifactManifest(manifest) {
  if (manifest?.schemaVersion !== 1)
    throw new Error("Shared artifact schemaVersion must be 1");
  requiredString(manifest.artifactVersion, "Shared artifact version");
  validateSource(manifest.source);
  validateToolchains(manifest.toolchains);
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    throw new Error("Shared artifact components must be a non-empty array");
  }
  const componentIds = new Set();
  const filePaths = new Set();
  const installPaths = new Set();
  for (const component of manifest.components) {
    const id = requiredString(component?.id, "Shared artifact component id");
    if (componentIds.has(portableKey(id)))
      throw new Error(`Shared artifact component is repeated: ${id}`);
    componentIds.add(portableKey(id));
    requiredString(component.version, `Component ${id} version`);
    requiredString(component.license, `Component ${id} license`);
    const artifactRoot = validatePortablePath(
      component.artifactRoot,
      `Component ${id} artifactRoot`,
    );
    const installRoot = validatePortablePath(
      component.installRoot,
      `Component ${id} installRoot`,
    );
    if (
      !Array.isArray(component.buildCommand) ||
      component.buildCommand.length === 0
    ) {
      throw new Error(`Component ${id} buildCommand must be a non-empty array`);
    }
    component.buildCommand.forEach((argument, index) =>
      requiredString(argument, `Component ${id} buildCommand ${index}`),
    );
    if (!Array.isArray(component.files) || component.files.length === 0) {
      throw new Error(`Component ${id} files must be a non-empty array`);
    }
    for (const file of component.files) {
      const path = validatePortablePath(
        file?.path,
        `Component ${id} file path`,
      );
      if (path !== artifactRoot && !path.startsWith(`${artifactRoot}/`)) {
        throw new Error(
          `Component ${id} file is outside its artifactRoot: ${path}`,
        );
      }
      if (filePaths.has(portableKey(path)))
        throw new Error(`Shared artifact file is declared twice: ${path}`);
      filePaths.add(portableKey(path));
      const componentRelativePath = path.slice(artifactRoot.length + 1);
      const installPath = `${installRoot}/${componentRelativePath}`;
      if (installPaths.has(portableKey(installPath))) {
        throw new Error(
          `Shared artifact install destination is declared twice: ${installPath}`,
        );
      }
      installPaths.add(portableKey(installPath));
      if (!Number.isSafeInteger(file.size) || file.size < 0)
        throw new Error(`Invalid size for shared artifact file ${path}`);
      if (!/^[a-f0-9]{64}$/.test(file.sha256 || ""))
        throw new Error(`Invalid SHA-256 for shared artifact file ${path}`);
    }
  }
  return manifest;
}

export async function verifySharedArtifacts(artifactRoot, manifest = null) {
  const root = resolve(artifactRoot);
  const loaded = validateSharedArtifactManifest(
    manifest ||
      JSON.parse(await readFile(join(root, SHARED_ARTIFACT_MANIFEST), "utf8")),
  );
  const declared = new Set();
  for (const component of loaded.components) {
    for (const file of component.files) {
      declared.add(file.path);
      const path = resolve(root, ...file.path.split("/"));
      portableRelativePath(root, path, `Shared artifact file ${file.path}`);
      const details = await lstat(path);
      if (!details.isFile())
        throw new Error(`Shared artifact is not a regular file: ${file.path}`);
      if (details.size !== file.size)
        throw new Error(`Shared artifact size mismatch: ${file.path}`);
      const actual = await sha256File(path);
      if (actual !== file.sha256)
        throw new Error(`Shared artifact SHA-256 mismatch: ${file.path}`);
    }
  }
  const actualFiles = (await walkFiles(root))
    .map((path) =>
      portableRelativePath(root, path, "Shared artifact inventory"),
    )
    .filter((path) => path !== SHARED_ARTIFACT_MANIFEST);
  const undeclared = actualFiles.filter((path) => !declared.has(path));
  const missing = [...declared].filter((path) => !actualFiles.includes(path));
  if (undeclared.length || missing.length) {
    throw new Error(
      `Shared artifact inventory mismatch; undeclared=${JSON.stringify(undeclared)}; missing=${JSON.stringify(missing)}`,
    );
  }
  return loaded;
}

export function compareSharedArtifactManifests(left, right) {
  validateSharedArtifactManifest(left);
  validateSharedArtifactManifest(right);
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  if (leftJson !== rightJson) {
    throw new Error(
      "Shared artifact manifests differ; compare source revision, toolchains, component metadata, paths, sizes, and SHA-256 checksums",
    );
  }
  return true;
}

export async function writeSharedArtifactManifest(artifactRoot, manifest) {
  validateSharedArtifactManifest(manifest);
  const root = resolve(artifactRoot);
  const path = join(root, SHARED_ARTIFACT_MANIFEST);
  const temporary = `${path}.partial-${randomUUID()}`;
  let replaced;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  if (
    await readFile(path).then(
      () => true,
      () => false,
    )
  ) {
    replaced = `${path}.replaced-${randomUUID()}`;
    await rename(path, replaced);
  }
  try {
    await rename(temporary, path);
    if (replaced) await rm(replaced, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    if (
      replaced &&
      !(await readFile(path).then(
        () => true,
        () => false,
      ))
    ) {
      await rename(replaced, path);
    }
    throw error;
  }
  return path;
}

export async function installSharedArtifacts(artifactRoot, runtimeRoot) {
  const root = resolve(artifactRoot);
  const runtime = resolve(runtimeRoot);
  const manifest = await verifySharedArtifacts(root);
  for (const component of manifest.components) {
    const sourceRoot = resolve(root, ...component.artifactRoot.split("/"));
    const destinationRoot = resolve(
      runtime,
      ...component.installRoot.split("/"),
    );
    portableRelativePath(
      root,
      sourceRoot,
      `Component ${component.id} artifactRoot`,
    );
    portableRelativePath(
      runtime,
      destinationRoot,
      `Component ${component.id} installRoot`,
    );
    await mkdir(destinationRoot, { recursive: true });
    for (const file of component.files) {
      const source = resolve(root, ...file.path.split("/"));
      const sourceRelative = relative(sourceRoot, source);
      if (
        !sourceRelative ||
        sourceRelative === ".." ||
        sourceRelative.startsWith(`..${sep}`) ||
        isAbsolute(sourceRelative)
      ) {
        throw new Error(
          `Component ${component.id} file cannot be installed safely: ${file.path}`,
        );
      }
      const destination = resolve(destinationRoot, sourceRelative);
      portableRelativePath(
        runtime,
        destination,
        `Component ${component.id} destination`,
      );
      await mkdir(dirname(destination), { recursive: true });
      try {
        await access(destination);
        throw new Error(
          `Shared artifact destination already exists: ${destination}`,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await cp(source, destination, {
        dereference: true,
        errorOnExist: true,
        force: false,
      });
    }
  }
  return manifest;
}
