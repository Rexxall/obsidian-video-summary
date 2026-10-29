import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';

const projectRoot = new URL('../', import.meta.url);
const testsDirectory = new URL('./', import.meta.url);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'video-summary-tests-'));

try {
  await run(process.execPath, [
    join(projectRoot.pathname, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(projectRoot.pathname, 'tsconfig.test.json'),
  ]);

  const testFiles = await readdir(testsDirectory);
  const entries = testFiles
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => join(testsDirectory.pathname, name));
  const javascriptTests = testFiles
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(testsDirectory.pathname, name));

  if (entries.length === 0 && javascriptTests.length === 0) {
    throw new Error('No tests/*.test.ts or tests/*.test.mjs files were found.');
  }

  if (entries.length > 0) {
    await esbuild.build({
      entryPoints: entries,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outdir: temporaryDirectory,
      external: ['obsidian'],
      // CommonJS dependencies (yaml) call require() for Node built-ins; give the ESM bundle one.
      // Plugin code uses window timers (Obsidian popout windows); in Node, window is the global.
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url); globalThis.window ??= globalThis;",
      },
      sourcemap: 'inline',
      logLevel: 'silent',
    });
  }

  const bundledTests = (await readdir(temporaryDirectory))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join(temporaryDirectory, name));
  await run(process.execPath, ['--test', ...bundledTests, ...javascriptTests]);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} exited after signal ${signal}`
            : `${command} exited with code ${String(code)}`,
        ),
      );
    });
  });
}
