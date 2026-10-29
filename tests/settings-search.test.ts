import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SETTINGS_SEARCH_TERMS } from '../views/settingsSearch';

void test('every setting name on the settings page is searchable', () => {
  const source = readFileSync(new URL('../main.ts', `file://${process.cwd()}/tests/`), 'utf8');
  const page = source.slice(source.indexOf('class VideoSummarySettingTab'));
  const names = [
    ...page.matchAll(/\.setName\(\s*'([^'$]+)'\s*\)/g),
    ...page.matchAll(/this\.group\(\s*containerEl,\s*'([^']+)'/g),
    ...page.matchAll(/this\.sectionCard\(\s*\w+,\s*'[^']*',\s*'([^']+)'/g),
  ].map((match) => match[1]);
  const missing = names.filter((name) => !SETTINGS_SEARCH_TERMS.includes(name));
  assert.deepEqual(missing, [], 'add these to views/settingsSearch.ts');
});
