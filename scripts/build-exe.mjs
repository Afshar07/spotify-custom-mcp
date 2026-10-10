// Builds the standalone launcher: esbuild bundle -> Node SEA blob -> injected into a copy of node.
// Output: build/spotify-curator(.exe). End users need no Node.js, npm or Git.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const outDir = 'build';
const exeName = process.platform === 'win32' ? 'spotify-curator.exe' : 'spotify-curator';
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Prefer ESM entries: some UMD packages (jsonc-parser) use dynamic require, which SEA cannot resolve.
  mainFields: ['module', 'main'],
  outfile: join(outDir, 'cli.cjs'),
  logLevel: 'warning',
  legalComments: 'none',
});

writeFileSync(
  join(outDir, 'sea-config.json'),
  JSON.stringify({ main: join(outDir, 'cli.cjs'), output: join(outDir, 'sea.blob'), disableExperimentalSEAWarning: true }),
);
execFileSync(process.execPath, ['--experimental-sea-config', join(outDir, 'sea-config.json')], { stdio: 'inherit' });

const exe = join(outDir, exeName);
copyFileSync(process.execPath, exe);
if (process.platform !== 'win32') chmodSync(exe, 0o755);
const postject = require.resolve('postject/dist/cli.js');
const args = [postject, exe, 'NODE_SEA_BLOB', join(outDir, 'sea.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });
console.log(`Built ${exe} with Node ${process.version}`);
