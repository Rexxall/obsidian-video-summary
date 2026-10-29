#!/usr/bin/env node
// Regenerate browser-extension/vendor/ from shared/ so the plugin and the extension use the same code.
//   node tools/sync-extension-shared.mjs          write vendor files
//   node tools/sync-extension-shared.mjs --check  exit 1 if vendor files are out of date
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'shared');
const VENDOR = join(ROOT, 'browser-extension', 'vendor');
const CHECK = process.argv.includes('--check');

const BANNER = '// Generated from shared/ by tools/sync-extension-shared.mjs. Do not edit.\n';
const MODULES = ['platforms.mjs', 'status.mjs', 'url.mjs', 'payload.mjs'];
const EXPORTS = [
  'SUPPORTED_PLATFORMS',
  'PLATFORMS',
  'isVideoUrl',
  'detectPlatform',
  'STATUS',
  'STATUS_EMOJI',
  'normalizeStatus',
  'statusText',
  'canonicalizeVideoUrl',
  'appendTimestamp',
  'stripTimestamp',
  'formatTimestamp',
  'MODES',
  'LANGUAGES',
  'ACTIONS',
  'buildUnifiedPayload',
  'normalizeRequest',
  'buildLegacyN8nPayload',
  'safeTitle',
  'normalizeText',
];

const read = (name) => readFileSync(join(SHARED, name), 'utf8');

function bundle() {
  let body = '';
  for (const name of MODULES) {
    const source = read(name)
      .split('\n')
      .filter((line) => !/^\s*import\s.*from\s.*;?\s*$/.test(line))
      .join('\n')
      .replace(/^export\s+/gm, '');
    body += `\n// ---- ${name} ----\n${source}\n`;
  }
  const exposed = EXPORTS.map((key) => `    ${key},`).join('\n');
  return `${BANNER}(function (global) {\n  "use strict";\n${body}\n  global.VideoSummaryShared = {\n${exposed}\n  };\n})(typeof self !== "undefined" ? self : this);\n`;
}

const files = { 'shared.global.js': bundle() };
for (const name of [...MODULES, 'index.mjs']) files[name] = BANNER + read(name);

let stale = 0;
if (!CHECK) mkdirSync(VENDOR, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  const target = join(VENDOR, name);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current === content) continue;
  stale += 1;
  if (CHECK) process.stderr.write(`out of date: browser-extension/vendor/${name}\n`);
  else writeFileSync(target, content);
}
if (CHECK && stale) process.exit(1);
process.stdout.write(
  `${CHECK ? 'browser-extension/vendor is up to date' : `wrote ${stale} file(s)`}\n`,
);
