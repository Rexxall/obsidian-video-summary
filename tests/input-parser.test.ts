import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseInput } from '../core/InputParser';

// The shape of an article copied from a blog: headings with anchor links, long
// paragraphs with inline markdown links. Pasting one used to create a job per link.
const ARTICLE = [
  '# How to plan a long walk',
  '',
  '[](https://example.com/walk/#start)Start',
  '',
  'Most people plan a walk by looking at the map once and hoping for the best. A better habit is to',
  'read a few accounts from people who already did it ([see this report](https://news.example.org/walk-report?ref=example.com)),',
  'then decide how far you can go on a bad day rather than a good one.',
  '',
  '[](https://example.com/walk/#distance)Distance',
  '',
  'Distance matters less than rhythm. The research on goal setting ([Locke and Latham](https://papers.example.edu/goals.pdf?ref=example.com)).',
  'suggests that a clear, slightly hard target beats a vague one, and that feedback along the way keeps',
  'people going. There is also a nice talk about it: https://www.youtube.com/watch?v=abc123XYZ00 if you prefer video.',
  '',
  'Written by [the author](https://www.example.com/?ref=example.com)',
].join('\n');

void test('a pasted article with inline links becomes one transcript job', () => {
  const drafts = parseInput(ARTICLE);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].source, 'transcript');
  assert.equal(drafts[0].input.url, undefined);
  // The links stay inside the text so the summary can cite them.
  assert.ok(drafts[0].input.transcript?.includes('https://news.example.org/walk-report'));
  assert.ok(drafts[0].input.transcript?.startsWith('# How to plan a long walk'));
});

void test('a long Chinese passage with a couple of links stays one transcript', () => {
  const paragraph =
    '今天读到一篇关于长期主义的文章，作者把每天的小进步比作复利，讲了很多具体的例子，比如每天写三百字、每周跑两次步，' +
    '坚持一年以后回头看会发现变化很大。文中还引用了一段访谈 https://www.bilibili.com/video/BV1xx411c7mD 和一篇论文 ' +
    'https://papers.example.edu/compound.pdf ，我觉得最有用的是关于如何设计反馈的部分。';
  const drafts = parseInput(`${paragraph}\n\n${paragraph}`);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].source, 'transcript');
});

void test('one link per line still becomes one job per link', () => {
  const drafts = parseInput(
    [
      'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'https://youtu.be/bbbbbbbbbbb',
    ].join('\n'),
  );
  assert.deepEqual(
    drafts.map((draft) => draft.source),
    ['url', 'url', 'url'],
  );
  assert.equal(drafts[2].input.url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
});

void test('a single link with a short remark is still a link job', () => {
  for (const raw of [
    'https://www.youtube.com/watch?v=aaaaaaaaaaa 这个讲得很好，回头看',
    '这个讲得很好 https://www.youtube.com/watch?v=aaaaaaaaaaa',
    'Worth a watch:\nhttps://www.youtube.com/watch?v=aaaaaaaaaaa',
  ]) {
    const drafts = parseInput(raw);
    assert.equal(drafts.length, 1, raw);
    assert.equal(drafts[0].source, 'url', raw);
    assert.equal(drafts[0].input.url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa', raw);
  }
});

void test('a few links with a few lines of notes stay link jobs', () => {
  const drafts = parseInput(
    [
      '这周要看的：',
      '1. 第一集 https://www.bilibili.com/video/BV1aa411c7mD',
      '2. 第二集，讲得比较快 https://www.bilibili.com/video/BV1bb411c7mD',
      '- [Third talk](https://www.youtube.com/watch?v=ccccccccccc)',
      '看完记得整理。',
    ].join('\n'),
  );
  assert.equal(drafts.length, 3);
  assert.ok(drafts.every((draft) => draft.source === 'url'));
  assert.equal(drafts[2].input.url, 'https://www.youtube.com/watch?v=ccccccccccc');
});

void test('a long list of titled links is still a list, not an article', () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) =>
      `- [Lecture ${index + 1}: an introduction to the topic of this week](https://www.youtube.com/watch?v=lecture${String(index).padStart(4, '0')})`,
  );
  const drafts = parseInput(lines.join('\n'));
  assert.equal(drafts.length, 12);
  assert.ok(drafts.every((draft) => draft.source === 'url'));
});

void test('markdown and sentence punctuation are not glued onto links', () => {
  const drafts = parseInput(
    [
      '[a](https://example.com/one?ref=x),',
      '(https://example.com/two).',
      '[](https://example.com/three#part)Heading',
      'https://en.wikipedia.org/wiki/Goya_(painter)',
    ].join('\n'),
  );
  assert.deepEqual(
    drafts.map((draft) => draft.input.url),
    [
      'https://example.com/one?ref=x',
      'https://example.com/two',
      'https://example.com/three#part',
      'https://en.wikipedia.org/wiki/Goya_(painter)',
    ],
  );
});

void test('a separate manual transcript still applies to every link job', () => {
  const drafts = parseInput('https://www.youtube.com/watch?v=aaaaaaaaaaa', {
    transcript: '手动文稿',
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].input.transcript, '手动文稿');
});
