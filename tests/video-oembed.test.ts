import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPlaceholderTitle, youTubeOEmbed } from '../core/VideoOEmbed';

const URL = 'https://www.youtube.com/watch?v=6VqG3Jazrfs';

test("a pasted YouTube link gets the video's own title and channel", async () => {
  let asked = '';
  const info = await youTubeOEmbed(URL, async (endpoint) => {
    asked = endpoint;
    return {
      title: 'An Introduction to the James Webb Space Telescope Mission',
      author_name: 'NASA Goddard',
    };
  });
  assert.match(asked, /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=/);
  assert.deepEqual(info, {
    title: 'An Introduction to the James Webb Space Telescope Mission',
    author: 'NASA Goddard',
  });
});

test('a failed lookup or a link that is not YouTube changes nothing', async () => {
  assert.deepEqual(
    await youTubeOEmbed(URL, async () => {
      throw new Error('offline');
    }),
    {},
  );
  assert.deepEqual(await youTubeOEmbed(URL, async () => null), {});
  let called = false;
  assert.deepEqual(
    await youTubeOEmbed('https://www.bilibili.com/video/BV1xx411c7mD', async () => {
      called = true;
      return {};
    }),
    {},
  );
  assert.equal(called, false);
});

test('only a title the plugin made up from the link counts as missing', () => {
  assert.equal(isPlaceholderTitle('YouTube视频_6VqG3Jazrfs', URL), true);
  assert.equal(isPlaceholderTitle('', URL), true);
  assert.equal(isPlaceholderTitle('My own title', URL), false);
});
