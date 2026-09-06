import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareSharedArtifactManifests,
  createSharedArtifactManifest,
  installSharedArtifacts,
  validateSharedArtifactManifest,
  verifySharedArtifacts,
  writeSharedArtifactManifest,
} from "./shared-artifacts.mjs";

const SOURCE = {
  repository: "https://github.com/xuchen-cloud/penpot",
  revision: "0123456789abcdef0123456789abcdef01234567",
};

async function artifactRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "penpot-shared-artifacts-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "backend"));
  await mkdir(join(root, "frontend"));
  await writeFile(join(root, "backend/penpot.jar"), "jar");
  await writeFile(join(root, "frontend/index.html"), "html");
  return root;
}

function component(id, root, installRoot) {
  return {
    id,
    root,
    installRoot,
    version: "2.17.0-desktop.1",
    license: "MPL-2.0",
    buildCommand: ["build", id],
  };
}

test("creates and verifies a deterministic portable manifest", async (t) => {
  const root = await artifactRoot(t);
  const options = {
    artifactRoot: root,
    artifactVersion: "2.17.0-desktop.1",
    source: SOURCE,
    toolchains: { node: "24.19.0", rust: "1.91.0" },
    components: [
      component("frontend", "frontend", "frontend"),
      component("backend", "backend", "backend"),
    ],
  };

  const first = await createSharedArtifactManifest(options);
  const second = await createSharedArtifactManifest({
    ...options,
    components: [...options.components].reverse(),
  });
  await writeSharedArtifactManifest(root, first);

  assert.deepEqual(first, second);
  assert.deepEqual(await verifySharedArtifacts(root), first);
  assert.deepEqual(
    first.components.map((entry) => entry.id),
    ["backend", "frontend"],
  );
  assert.ok(
    first.components.every((entry) =>
      entry.files.every((file) => !file.path.includes("\\")),
    ),
  );
});

test("installs verified components at their portable runtime roots", async (t) => {
  const root = await artifactRoot(t);
  const runtime = join(root, "..", `runtime-${Date.now()}`);
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const manifest = await createSharedArtifactManifest({
    artifactRoot: root,
    artifactVersion: "2.17.0-desktop.1",
    source: SOURCE,
    toolchains: { node: "24.19.0" },
    components: [
      component("backend", "backend", "services/backend"),
      component("frontend", "frontend", "public"),
    ],
  });
  await writeSharedArtifactManifest(root, manifest);

  await installSharedArtifacts(root, runtime);

  assert.equal(
    await (
      await import("node:fs/promises")
    ).readFile(join(runtime, "services/backend/penpot.jar"), "utf8"),
    "jar",
  );
  assert.equal(
    await (
      await import("node:fs/promises")
    ).readFile(join(runtime, "public/index.html"), "utf8"),
    "html",
  );
});

test("rejects a modified declared artifact", async (t) => {
  const root = await artifactRoot(t);
  const manifest = await createSharedArtifactManifest({
    artifactRoot: root,
    artifactVersion: "2.17.0-desktop.1",
    source: SOURCE,
    toolchains: { node: "24.19.0" },
    components: [component("backend", "backend", "backend")],
  });
  await writeSharedArtifactManifest(root, manifest);
  await rm(join(root, "frontend"), { recursive: true });
  await writeFile(join(root, "backend/penpot.jar"), "changed");

  await assert.rejects(
    verifySharedArtifacts(root),
    /size mismatch|SHA-256 mismatch/,
  );
});

test("rejects undeclared files", async (t) => {
  const root = await artifactRoot(t);
  const manifest = await createSharedArtifactManifest({
    artifactRoot: root,
    artifactVersion: "2.17.0-desktop.1",
    source: SOURCE,
    toolchains: { node: "24.19.0" },
    components: [
      component("backend", "backend", "backend"),
      component("frontend", "frontend", "frontend"),
    ],
  });
  await writeSharedArtifactManifest(root, manifest);
  await writeFile(join(root, "unexpected.txt"), "unexpected");

  await assert.rejects(
    verifySharedArtifacts(root),
    /undeclared=.*unexpected\.txt/,
  );
});

test("rejects paths that are not portable", async (t) => {
  const root = await artifactRoot(t);

  await assert.rejects(
    createSharedArtifactManifest({
      artifactRoot: root,
      artifactVersion: "2.17.0-desktop.1",
      source: SOURCE,
      toolchains: { node: "24.19.0" },
      components: [component("backend", "..\\backend", "backend")],
    }),
    /portable relative path|unsafe segment/,
  );
  await assert.rejects(
    createSharedArtifactManifest({
      artifactRoot: root,
      artifactVersion: "2.17.0-desktop.1",
      source: SOURCE,
      toolchains: { node: "24.19.0" },
      components: [component("backend", "backend", "services/CON")],
    }),
    /not portable to Windows/,
  );
});

test("rejects case-only component and install destination collisions", async (t) => {
  const root = await artifactRoot(t);
  const manifest = await createSharedArtifactManifest({
    artifactRoot: root,
    artifactVersion: "2.17.0-desktop.1",
    source: SOURCE,
    toolchains: { node: "24.19.0" },
    components: [component("backend", "backend", "services")],
  });
  manifest.components.push({
    ...structuredClone(manifest.components[0]),
    id: "BACKEND",
    artifactRoot: "frontend",
    installRoot: "SERVICES",
    files: [
      { ...manifest.components[0].files[0], path: "frontend/PENPOT.JAR" },
    ],
  });

  assert.throws(
    () => validateSharedArtifactManifest(manifest),
    /component is repeated/,
  );
  manifest.components[1].id = "frontend";
  assert.throws(
    () => validateSharedArtifactManifest(manifest),
    /install destination is declared twice/,
  );
});

test("compares complete manifests from repeated builds", async (t) => {
  const root = await artifactRoot(t);
  const options = {
    artifactRoot: root,
    artifactVersion: "2.17.0-desktop.1",
    source: SOURCE,
    toolchains: { node: "24.19.0" },
    components: [
      component("backend", "backend", "backend"),
      component("frontend", "frontend", "frontend"),
    ],
  };
  const first = await createSharedArtifactManifest(options);
  const second = await createSharedArtifactManifest(options);

  assert.equal(compareSharedArtifactManifests(first, second), true);
  second.components[0].files[0].sha256 = "f".repeat(64);
  assert.throws(
    () => compareSharedArtifactManifests(first, second),
    /manifests differ/,
  );
});

test("requires a digest when artifacts come from a dirty worktree", async () => {
  assert.throws(
    () =>
      validateSharedArtifactManifest({
        schemaVersion: 1,
        artifactVersion: "2.17.0-desktop.1",
        source: { ...SOURCE, dirty: true },
        toolchains: { node: "24.19.0" },
        components: [],
      }),
    /worktree SHA-256/,
  );
});
