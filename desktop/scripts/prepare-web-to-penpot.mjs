import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const desktopRoot = resolve(import.meta.dirname, '..');
const pluginsRoot = resolve(desktopRoot, '..', 'plugins');
const target = resolve(desktopRoot, 'ui', 'plugins', 'web-to-penpot');
const pnpmArgs = [
  '--dir',
  pluginsRoot,
  '--filter',
  'web-to-penpot-plugin',
  'copy:offline',
  '--',
  target,
];

const result =
  process.platform === 'win32'
    ? spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/c', 'pnpm.cmd', ...pnpmArgs],
        { stdio: 'inherit' },
      )
    : spawnSync('pnpm', pnpmArgs, { stdio: 'inherit' });

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
