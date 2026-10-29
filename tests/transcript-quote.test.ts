import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_QUOTE_TEMPLATE, formatTranscriptQuote } from '../core/TranscriptQuote';

void test('default quote links back to the exact second on YouTube', () => {
  const quote = formatTranscriptQuote(DEFAULT_QUOTE_TEMPLATE, {
    text: 'Spaced  repetition\nbeats cramming.',
    start: 125.7,
    sourceUrl: 'https://www.youtube.com/watch?v=abc123',
  });
  assert.equal(
    quote,
    '> Spaced repetition beats cramming. ([2:05](https://www.youtube.com/watch?v=abc123&t=125s))',
  );
});

void test('quote without a playable source keeps the time as plain text', () => {
  const quote = formatTranscriptQuote('', { text: 'local clip', start: 3 });
  assert.equal(quote, '> local clip (0:03)');
});

void test('custom templates fill speaker, title, note link and line breaks', () => {
  const quote = formatTranscriptQuote(
    '> {{speaker}}: {{text}}\\n> — {{note}} {{time}} {{unknown}}',
    {
      text: 'hello',
      start: 61,
      speaker: 'Host',
      title: 'Lecture 1',
      notePath: 'Videos/Lecture 1.md',
    },
  );
  assert.equal(quote, '> Host: hello\n> — [[Videos/Lecture 1|Lecture 1]] 1:01 {{unknown}}');
});

void test('untrusted source URLs never become links', () => {
  const quote = formatTranscriptQuote('{{link}}|{{url}}', {
    text: 'x',
    start: 10,
    sourceUrl: 'javascript:alert(1)',
  });
  assert.equal(quote, '0:10|');
});
