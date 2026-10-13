// Bundles the server into dist/index.js. Third-party packages stay external (resolved from node_modules,
// which matters for the native modules node-pty and better-sqlite3); only the workspace package
// @orch/shared (shipped as TypeScript source) is bundled in.
// The options are exported for the desktop dev supervisor (packages/desktop/scripts/dev.mjs), which watches them.
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { dependencies } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const external = Object.keys(dependencies).filter((name) => name !== '@orch/shared');

export const distDir = path.join(root, 'dist');

/** @type {import('esbuild').BuildOptions} */
export const buildOptions = {
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(distDir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  logLevel: 'info',
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await rm(distDir, { recursive: true, force: true });
  await build(buildOptions);
}
