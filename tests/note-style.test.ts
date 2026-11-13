import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { noteMessages } from '../core/LiteTier';
import {
  ITHACA_NOTE_STYLE,
  LEGACY_ITHACA_NOTE_STYLE,
  fillNoteStyle,
  NOTE_PROMPT_VERSION,
  linkTimestamps,
  separateTables,
  noteImagesFor,
  promptVersionFor,
} from '../core/NoteStyle';
import { markNoteBody } from '../utils/themeMarks';

test('a YouTube video offers its cover and three frames; other links offer none', () => {
  const images = noteImagesFor('https://www.youtube.com/watch?v=NNnIGh9g6fA&t=95');
  assert.deepEqual(
    images.map((image) => image.url.replace('https://i.ytimg.com/vi/NNnIGh9g6fA/', '')),
    ['hqdefault.jpg', 'hq1.jpg', 'hq2.jpg', 'hq3.jpg'],
  );
  assert.equal(noteImagesFor('https://youtu.be/NNnIGh9g6fA').length, 4);
  assert.equal(noteImagesFor('https://www.youtube.com/shorts/NNnIGh9g6fA').length, 4);
  assert.deepEqual(noteImagesFor('https://www.bilibili.com/video/BV1xx411c7mD'), []);
  assert.deepEqual(noteImagesFor(undefined), []);
});

test('times in a note link to that second of the video, outside code and diagrams', () => {
  const note = [
    '- the claim [06:16]',
    '- an hour in [1:02:03]',
    '- already a link [07:00](https://example.com)',
    '```mermaid',
    'A["at [00:10]"]',
    '```',
  ].join('\n');
  const linked = linkTimestamps(note, 'https://www.youtube.com/watch?v=NNnIGh9g6fA');
  assert.match(linked, /\[06:16\]\(https:\/\/www\.youtube\.com\/watch\?v=NNnIGh9g6fA&t=376\)/);
  assert.match(linked, /\[1:02:03\]\(https:\/\/www\.youtube\.com\/watch\?v=NNnIGh9g6fA&t=3723\)/);
  assert.match(linked, /\[07:00\]\(https:\/\/example\.com\)/);
  assert.match(linked, /A\["at \[00:10\]"\]/);
  const bilibili = linkTimestamps('- [01:05]', 'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
  assert.equal(bilibili, '- [01:05](https://www.bilibili.com/video/BV1xx411c7mD?p=2&t=65)');
  assert.equal(linkTimestamps('- [01:05]', undefined), '- [01:05]');
  assert.equal(
    linkTimestamps('- range [00:26–00:52]', 'https://www.youtube.com/watch?v=NNnIGh9g6fA'),
    '- range [00:26–00:52](https://www.youtube.com/watch?v=NNnIGh9g6fA&t=26)',
  );
});

test('two times written side by side stay apart, and a range may use a wave dash', () => {
  const url = 'https://www.youtube.com/watch?v=NNnIGh9g6fA';
  const linked = linkTimestamps('- 発言 [01:41][01:46]', url);
  assert.equal(linked, `- 発言 [01:41](${url}&t=101) [01:46](${url}&t=106)`);
  assert.equal(linkTimestamps('- 範囲 [01:41〜01:46]', url), `- 範囲 [01:41〜01:46](${url}&t=101)`);
  assert.equal(linkTimestamps('- [01:41～01:46]', url), `- [01:41～01:46](${url}&t=101)`);
});

test('the Ithaca style writes its stickers and labels in the note language', () => {
  const chinese = /值得看|可略读|可跳过|核心摘要|原话|行动清单|所以/;
  const zh = fillNoteStyle(ITHACA_NOTE_STYLE, { language: 'zh' });
  for (const word of ['值得看', '可略读', '可跳过', '核心摘要', '原话', '行动清单', '所以']) {
    assert.ok(zh.includes(word), word);
  }
  const ja = fillNoteStyle(ITHACA_NOTE_STYLE, { language: 'ja' });
  assert.doesNotMatch(ja, chinese);
  assert.match(ja, /<span class="ih-sticker">必見<\/span>/);
  assert.match(ja, /> > \[!receipt\] 発言/);
  const en = fillNoteStyle(ITHACA_NOTE_STYLE, { language: 'en' });
  assert.doesNotMatch(en, chinese);
  assert.match(en, /titled "Summary"/);
  assert.doesNotMatch(en, /\{\{/);
  // Without a language the labels stay Chinese, as before.
  assert.ok(fillNoteStyle(ITHACA_NOTE_STYLE, {}).includes('核心摘要'));
});

test('a style saved from the old preset gets the labels of the note language too', () => {
  const ja = fillNoteStyle(LEGACY_ITHACA_NOTE_STYLE, { language: 'ja' });
  assert.doesNotMatch(ja, /值得看|核心摘要|原话|行动清单/);
  assert.match(ja, /必見/);
  // A style the reader wrote is left as written.
  assert.equal(fillNoteStyle('用中文标签「原话」', { language: 'ja' }), '用中文标签「原话」');
});

test('a writing style changes the cache version, so notes in an old style are not reused', () => {
  assert.equal(promptVersionFor(''), NOTE_PROMPT_VERSION);
  assert.equal(promptVersionFor('   '), NOTE_PROMPT_VERSION);
  const ithaca = promptVersionFor(ITHACA_NOTE_STYLE);
  assert.notEqual(ithaca, NOTE_PROMPT_VERSION);
  assert.equal(ithaca, promptVersionFor(ITHACA_NOTE_STYLE));
  assert.notEqual(ithaca, promptVersionFor(`${ITHACA_NOTE_STYLE}.`));
});

test('the light tier sends the style and the pictures to the model', () => {
  const [, user] = noteMessages({
    segments: [{ id: 's1', start: 1, end: 2, text: 'hello' }],
    title: 'T',
    language: 'zh',
    metadata: {
      note_style: fillNoteStyle(ITHACA_NOTE_STYLE, { language: 'zh' }),
      note_images: noteImagesFor('https://youtu.be/NNnIGh9g6fA'),
    },
  });
  assert.match(user.content, /WRITING STYLE/);
  assert.match(user.content, /> > \[!receipt\] 原话/);
  assert.match(user.content, /\[!receipts\]/);
  assert.match(user.content, /flowchart LR/);
  assert.match(user.content, /hq2\.jpg \(frame about halfway\)/);
});

test('a note the model already circled keeps one circle', () => {
  const note = 'A <span class="ih-circ">key phrase</span> and ==another==.';
  const marked = markNoteBody(note, 'takeaway');
  assert.equal(marked.match(/class="ih-circ"/g)?.length, 1);
  // The reader moved the circle last time: theirs wins.
  const moved = markNoteBody(note, 'takeaway', {
    subOutside: false,
    circleOutside: false,
    circleInside: 'another',
  });
  assert.equal(moved.match(/class="ih-circ"/g)?.length, 1);
  assert.match(moved, /<span class="ih-circ">another<\/span>/);
});

test('a table right under a line gets the blank line Obsidian needs', () => {
  const note = '**The point.**\n| a | b |\n|---|---|\n| 1 | 2 |\n- after';
  assert.equal(
    separateTables(note),
    '**The point.**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- after',
  );
  const quoted = '> [!info] x\n> | a |\n> |---|';
  assert.equal(separateTables(quoted), quoted);
  const fenced = 'x\n```\n| a |\n```';
  assert.equal(separateTables(fenced), fenced);
});

test("the Ithaca style gets the video's channel, date, length and id; frames get their times", () => {
  const filled = fillNoteStyle(ITHACA_NOTE_STYLE, {
    channel: 'バイエンス',
    date: '2026.11.11',
    duration: '9:46',
    videoId: 'lAxKiwd1QLo',
  });
  assert.match(filled, /<span class="ih-postmark">バイエンス<br>2026\.11\.11<\/span>/);
  assert.match(filled, /<span class="ih-barcode">9:46 · lAxKiwd1QLo<\/span>/);
  assert.doesNotMatch(filled, /\{\{/);
  assert.equal(fillNoteStyle('{{channel}}', { channel: '<b>x\ny' }), 'b x y');
  assert.equal(fillNoteStyle('', { channel: 'x' }), '');
  const frames = noteImagesFor('https://youtu.be/lAxKiwd1QLo', '9:46');
  assert.deepEqual(
    frames.map((f) => f.label),
    ['cover', 'frame near [02:27]', 'frame near [04:53]', 'frame near [07:20]'],
  );
});
