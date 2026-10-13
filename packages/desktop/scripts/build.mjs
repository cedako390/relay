// Bundles the Electron main and preload scripts to CommonJS (the sandboxed preload cannot be ESM).
// The options are exported for the dev supervisor (scripts/dev.mjs), which watches them.
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const distDir = path.join(root, 'dist');

/** @type {import('esbuild').BuildOptions} */
export const buildOptions = {
  entryPoints: { main: path.join(root, 'src/main.ts'), preload: path.join(root, 'src/preload.ts') },
  outdir: distDir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await rm(distDir, { recursive: true, force: true });
  await build(buildOptions);
}
