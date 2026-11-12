import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { isArticleLink } from '../core/ArticleReader';
import { isArticleNote } from '../utils/noteProperties';

test('ordinary web pages are read as articles; video sites, media and documents are not', () => {
  assert.equal(isArticleLink('https://felixrieseberg.com/how-to-be-more-ambitious/'), true);
  assert.equal(isArticleLink('https://en.wikipedia.org/wiki/Self-efficacy?ref=x'), true);
  assert.equal(isArticleLink('https://www.youtube.com/watch?v=K4tpvbkIkL4'), false);
  assert.equal(isArticleLink('https://www.bilibili.com/video/BV1Jgf6YvE8e'), false);
  assert.equal(isArticleLink('https://example.com/talk.mp4'), false);
  assert.equal(isArticleLink('https://example.com/paper.pdf'), false);
  assert.equal(isArticleLink('file:///Users/x/a.html'), false);
  assert.equal(isArticleLink('not a link'), false);
  assert.equal(isArticleLink(undefined), false);
});

test('a note made from a web page is an article even though it keeps the link', () => {
  assert.equal(isArticleNote({ link: 'https://example.com/post', source_type: 'article' }), true);
  assert.equal(isArticleNote({ link: 'https://www.youtube.com/watch?v=x' }), false);
  assert.equal(isArticleNote({}), true);
});
