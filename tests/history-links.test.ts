import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { followRename, resolveHistoryPath, type HistoryLookup } from '../core/HistoryLinks';
import type { ProcessingHistory } from '../types';

const lookup = (
  files: string[],
  titles: Record<string, string> = {},
  urls: Record<string, string> = {},
): HistoryLookup => ({
  exists: (path) => files.includes(path),
  byName: (name) => files.find((path) => path.replace(/^.*\//, '').replace(/\.md$/, '') === name),
  byTitle: (title) => titles[title],
  byUrl: (url) => urls[url],
});

test('a record finds its note by path, name, the copy name, video title, then link', () => {
  const vault = lookup(
    ['a/Renamed.md', 'b/Same name.md', 'c/Lesson 10.md'],
    { 'i asked professors': 'a/Renamed.md' },
    { 'https://youtu.be/x': 'b/Same name.md' },
  );
  assert.equal(resolveHistoryPath({ file: 'old', path: 'a/Renamed.md' }, vault), 'a/Renamed.md');
  assert.equal(resolveHistoryPath({ file: 'Same name' }, vault), 'b/Same name.md');
  assert.equal(resolveHistoryPath({ file: 'Lesson 10 (1)' }, vault), 'c/Lesson 10.md');
  assert.equal(resolveHistoryPath({ file: 'i asked professors' }, vault), 'a/Renamed.md');
  assert.equal(
    resolveHistoryPath({ file: 'gone', url: 'https://youtu.be/x' }, vault),
    'b/Same name.md',
  );
  assert.equal(resolveHistoryPath({ file: 'deleted long ago' }, vault), undefined);
  // A stored path that no longer exists falls back to the name.
  assert.equal(
    resolveHistoryPath({ file: 'Same name', path: 'x/moved.md' }, vault),
    'b/Same name.md',
  );
});

test('renaming a note carries its history records along', () => {
  const history: ProcessingHistory[] = [
    { file: 'Old', path: 'in/Old.md', time: 't', result: 'success', mode: 'summary' },
    { file: 'Other', path: 'in/Other.md', time: 't', result: 'success', mode: 'summary' },
  ];
  assert.equal(followRename(history, 'in/Old.md', 'out/New.md', 'New'), true);
  assert.deepEqual([history[0].file, history[0].path], ['New', 'out/New.md']);
  assert.equal(history[1].path, 'in/Other.md');
  assert.equal(followRename(history, 'none.md', 'x.md', 'x'), false);
});
