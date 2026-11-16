#!/usr/bin/env node
// Copy vendor/rex-ai-kit/rex-ai-kit.css into styles.css between the markers below.
//   node tools/sync-ai-kit-style.mjs          write styles.css
//   node tools/sync-ai-kit-style.mjs --check  exit 1 if styles.css is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = join(ROOT, 'styles.css');
const START = '/* ---- rex-ai-kit (generated from vendor/rex-ai-kit/rex-ai-kit.css) ---- */';
const END = '/* ---- end of rex-ai-kit ---- */';

const options = { ...(await prettier.resolveConfig(STYLES)), parser: 'css' };
const kit = await prettier.format(
  readFileSync(join(ROOT, 'vendor/rex-ai-kit/rex-ai-kit.css'), 'utf8'),
  options,
);
const block = `${START}\n${kit.trim()}\n${END}`;
const current = readFileSync(STYLES, 'utf8');
const at = current.indexOf(START);
const next =
  at < 0
    ? `${current.trimEnd()}\n\n${block}\n`
    : `${current.slice(0, at)}${block}${current.slice(current.indexOf(END, at) + END.length)}`;
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error(
      'styles.css is out of date with rex-ai-kit: run node tools/sync-ai-kit-style.mjs',
    );
    process.exit(1);
  }
} else if (next !== current) {
  writeFileSync(STYLES, next);
  console.log('styles.css ← rex-ai-kit.css');
}
