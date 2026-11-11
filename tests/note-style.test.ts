import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { noteMessages } from '../core/LiteTier';
import {
  ITHACA_NOTE_STYLE,
  NOTE_PROMPT_VERSION,
  linkTimestamps,
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
      note_style: ITHACA_NOTE_STYLE,
      note_images: noteImagesFor('https://youtu.be/NNnIGh9g6fA'),
    },
  });
  assert.match(user.content, /WRITING STYLE/);
  assert.match(user.content, /\[!receipt\] 原话/);
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
