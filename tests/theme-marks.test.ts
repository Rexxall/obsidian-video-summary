import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SETTINGS } from '../constants';
import {
  addDoneStamp,
  circleFirstHighlight,
  circleText,
  markNoteBody,
  readExistingMarks,
} from '../utils/themeMarks';

const START = '<!-- video-summary-generated:start -->';
const END = '<!-- video-summary-generated:end -->';

void test('theme marks are off by default', () => {
  assert.equal(DEFAULT_SETTINGS.themeMarks, false);
});

void test('the takeaway becomes the subtitle on the first line, in the toolkit span shape', () => {
  const body = markNoteBody('> [!summary] 摘要\n> 内容', '  用 <小步>  反馈\n养成习惯 ');
  assert.equal(
    body,
    '<span class="ih-sub">用 &lt;小步&gt; 反馈 养成习惯</span>\n\n> [!summary] 摘要\n> 内容',
  );
  // One line, no nesting: the shape the notebook toolkit matches.
  assert.match(body.split('\n')[0], /^<span class="ih-sub">[^<]*<\/span>$/);
  // No takeaway, no subtitle: the summary is never cut down to make one.
  assert.equal(markNoteBody('正文'), '正文');
});

void test('only the first highlight outside code, links and other marks gets the circle', () => {
  assert.equal(
    circleFirstHighlight(
      '`==代码==` [[==链接==]] <span class="ih-mg">==批注==</span> 先是 ==第一处== 然后 ==第二处==\n```\n==块里==\n```',
    ),
    '`==代码==` [[==链接==]] <span class="ih-mg">==批注==</span> 先是 <span class="ih-circ">第一处</span> 然后 ==第二处==\n```\n==块里==\n```',
  );
  assert.equal(circleFirstHighlight('没有高亮'), '没有高亮');
});

void test('existing marks are read apart: the person’s own, and the generated part', () => {
  const body = [
    '<span class="ih-sub">我写的副题</span>',
    '',
    START,
    '<span class="ih-sub">上次的结论</span>',
    '一段 <span class="ih-circ">挪过来的圈</span> 文字',
    END,
    '我的笔记里 <span class="ih-mg ih-sticky">想法</span>',
  ].join('\n');
  assert.deepEqual(readExistingMarks(body), {
    subOutside: true,
    subInside: '上次的结论',
    circleOutside: false,
    circleInside: '挪过来的圈',
  });
  assert.deepEqual(readExistingMarks('普通笔记'), {
    subOutside: false,
    subInside: undefined,
    circleOutside: false,
    circleInside: undefined,
  });
});

void test('a circle or subtitle the person added outside the generated part is never doubled', () => {
  const note = '摘要 ==重点== 其余';
  const marked = markNoteBody(note, '结论', {
    subOutside: true,
    circleOutside: true,
  });
  assert.equal(marked, note);
});

void test('marks edited by hand inside the generated part come back on the next run', () => {
  const note = '摘要 ==重点== 其余，还有 ==另一处== 和一句话里的关键词';
  const marked = markNoteBody(note, '新的结论', {
    subOutside: false,
    subInside: '我改过的副题',
    circleOutside: false,
    circleInside: '关键词',
  });
  assert.equal(
    marked,
    '<span class="ih-sub">我改过的副题</span>\n\n摘要 ==重点== 其余，还有 ==另一处== 和一句话里的<span class="ih-circ">关键词</span>',
  );
  // The words moved to a highlight: circle the highlight; gone entirely: no circle at all.
  assert.equal(
    circleText('先 ==另一处== 再', '另一处'),
    '先 <span class="ih-circ">另一处</span> 再',
  );
  assert.equal(circleText('都换了', '关键词'), '都换了');
});

void test('the done stamp joins a ✅ page only when no stamp is there, and is never taken off', () => {
  const done: Record<string, unknown> = { status: '✅', cssclasses: ['ih-film'] };
  addDoneStamp(done);
  addDoneStamp(done);
  assert.deepEqual(done.cssclasses, ['ih-film', 'ih-stamp-done']);

  // One stamp per page: a stamp the person chose wins.
  const waiting: Record<string, unknown> = { status: '✅', cssclasses: ['ih-stamp-wait'] };
  addDoneStamp(waiting);
  assert.deepEqual(waiting.cssclasses, ['ih-stamp-wait']);

  // Not ✅: nothing added, and a stamp put on by hand stays.
  const manual: Record<string, unknown> = { status: '🔍', cssclasses: ['ih-stamp-done'] };
  addDoneStamp(manual);
  assert.deepEqual(manual.cssclasses, ['ih-stamp-done']);

  const legacy: Record<string, unknown> = { status: '✅', cssclass: 'wide' };
  addDoneStamp(legacy);
  assert.deepEqual(legacy, { status: '✅', cssclasses: ['wide', 'ih-stamp-done'] });
});
