import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compareSharedArtifactManifests,
  verifySharedArtifacts,
} from "./shared-artifacts.mjs";

async function main() {
  const [, , firstArgument, secondArgument] = process.argv;
  if (!firstArgument) {
    throw new Error(
      "usage: node verify-shared-artifacts.mjs <artifact-directory> [second-artifact-directory]",
    );
  }
  const firstRoot = resolve(firstArgument);
  const first = await verifySharedArtifacts(firstRoot);
  if (secondArgument) {
    const secondRoot = resolve(secondArgument);
    const second = await verifySharedArtifacts(secondRoot);
    compareSharedArtifactManifests(first, second);
    console.log(
      `Shared artifact manifests match: ${firstRoot} and ${secondRoot}`,
    );
    return;
  }
  console.log(`Verified shared artifacts: ${firstRoot}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
