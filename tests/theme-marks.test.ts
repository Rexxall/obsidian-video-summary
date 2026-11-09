import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SETTINGS } from '../constants';
import { circleFirstHighlight, markNoteBody, syncDoneStamp } from '../utils/themeMarks';

void test('theme marks are off by default', () => {
  assert.equal(DEFAULT_SETTINGS.themeMarks, false);
});

void test('the takeaway becomes the subtitle on the first line, escaped', () => {
  const body = markNoteBody('> [!summary] 摘要\n> 内容', '  用 <小步>  反馈\n养成习惯 ');
  assert.equal(
    body,
    '<span class="ih-sub">用 &lt;小步&gt; 反馈 养成习惯</span>\n\n> [!summary] 摘要\n> 内容',
  );
  // No takeaway, no subtitle: the summary is never cut down to make one.
  assert.equal(markNoteBody('正文'), '正文');
});

void test('only the first highlight outside code gets the circle', () => {
  assert.equal(
    circleFirstHighlight('`==代码==` 先是 ==第一处== 然后 ==第二处==\n```\n==块里==\n```'),
    '`==代码==` 先是 <span class="ih-circ">第一处</span> 然后 ==第二处==\n```\n==块里==\n```',
  );
  assert.equal(circleFirstHighlight('没有高亮'), '没有高亮');
});

void test('the done stamp follows a ✅ status and leaves other classes alone', () => {
  const done: Record<string, unknown> = { status: '✅', cssclasses: ['ih-film'] };
  syncDoneStamp(done);
  syncDoneStamp(done);
  assert.deepEqual(done.cssclasses, ['ih-film', 'ih-stamp-done']);

  done.status = '🔍';
  syncDoneStamp(done);
  assert.deepEqual(done.cssclasses, ['ih-film']);

  const bare: Record<string, unknown> = { status: '❌' };
  syncDoneStamp(bare);
  assert.equal('cssclasses' in bare, false);

  const onlyStamp: Record<string, unknown> = { status: 'success', cssclasses: ['ih-stamp-done'] };
  syncDoneStamp(onlyStamp);
  assert.equal('cssclasses' in onlyStamp, false);
});
