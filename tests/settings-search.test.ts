import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SETTINGS_SEARCH_TERMS } from '../views/settingsSearch';

void test('every setting name on the settings page is searchable', () => {
  const source = readFileSync(new URL('../main.ts', `file://${process.cwd()}/tests/`), 'utf8');
  const page = source.slice(source.indexOf('class VideoSummarySettingTab'));
  const names = [...page.matchAll(/\.setName\(\s*'([^'$]+)'\s*\)/g)].map((match) => match[1]);
  // Names are written as tr('中文', 'English'); both languages must be searchable.
  const pair = String.raw`tr\(\s*(['"])(.*?)\1\s*,\s*(['"])(.*?)\3\s*\)`;
  for (const prefix of [
    String.raw`\.setName\(\s*`,
    String.raw`this\.group\(\s*containerEl,\s*`,
    String.raw`this\.sectionCard\(\s*\w+,\s*'[^']*',\s*`,
  ]) {
    for (const match of page.matchAll(new RegExp(prefix + pair, 'gs'))) {
      if (!match[2].includes('${')) names.push(match[2], match[4]);
    }
  }
  assert.ok(names.length > 60, 'the pattern still finds the setting names');
  const missing = names.filter((name) => !SETTINGS_SEARCH_TERMS.includes(name));
  assert.deepEqual(missing, [], 'add these to views/settingsSearch.ts');
});
