import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { markReadingView, wantsReadingView } from '../core/ReadingViewRule';

test('a finished video note opens in reading view once per tab; others are left alone', () => {
  const done = {
    video_summary: true,
    link: 'https://www.youtube.com/watch?v=NNnIGh9g6fA',
    video_summary_status: 'success',
    summary: 'x',
  };
  assert.equal(wantsReadingView(true, done, false), true);
  assert.equal(wantsReadingView(true, done, true), false);
  assert.equal(wantsReadingView(false, done, false), false);
  assert.equal(
    wantsReadingView(true, { ...done, video_summary_status: 'pending', summary: undefined }, false),
    false,
  );
  assert.equal(wantsReadingView(true, { title: 'plain note' }, false), false);
  assert.equal(wantsReadingView(true, undefined, false), false);
});

test('a finished note asks view plugins for reading view, keeping a choice already made', () => {
  const fm: Record<string, unknown> = { video_summary: true };
  markReadingView(fm);
  assert.equal(fm.obsidianUIMode, 'preview');
  const chosen: Record<string, unknown> = { obsidianUIMode: 'source' };
  markReadingView(chosen);
  assert.equal(chosen.obsidianUIMode, 'source');
});
