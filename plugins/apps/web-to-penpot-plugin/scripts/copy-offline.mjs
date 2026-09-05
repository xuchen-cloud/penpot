import { cp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';

const targetArgument = process.argv
  .slice(2)
  .find((argument) => argument !== '--');
if (!targetArgument) {
  throw new Error(
    'Usage: pnpm copy:offline -- /absolute/path/to/static/plugins/web-to-penpot',
  );
}
if (!isAbsolute(targetArgument))
  throw new Error('Offline plugin target must be an absolute path');

const root = resolve(import.meta.dirname, '..');
const target = resolve(targetArgument);
if (
  basename(target) !== 'web-to-penpot' ||
  basename(dirname(target)) !== 'plugins'
) {
  throw new Error('Target must end with /plugins/web-to-penpot');
}

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(resolve(root, 'dist'), target, { recursive: true });
