import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const files = {};

async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collect(path, name);
    else files[name] = new Uint8Array(await readFile(path));
  }
}

await collect(dist);
await mkdir(resolve(root, 'release'), { recursive: true });
await writeFile(
  resolve(root, 'release/web-to-penpot-plugin.zip'),
  zipSync(files, { level: 9 }),
);
