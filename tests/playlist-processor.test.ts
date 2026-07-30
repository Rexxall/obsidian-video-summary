import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PlaylistProcessor,
  PlaylistRequest,
  PlaylistRequester,
  canonicalizeVideoUrl,
} from '../utils/PlaylistProcessor';

test('YouTube public playlist fixture paginates and canonical-dedupes videos', async () => {
  const requests: PlaylistRequest[] = [];
  const requester: PlaylistRequester = async (request) => {
    requests.push(request);
    if (request.method === 'POST') {
      return jsonResponse({
        onResponseReceivedActions: [
          {
            appendContinuationItemsAction: {
              continuationItems: [
                youtubeVideo('yt_video_1', 'Duplicate', 'Channel'),
                youtubeVideo('yt_video_2', 'Lesson 2', 'Channel'),
              ],
            },
          },
        ],
      });
    }
    return {
      status: 200,
      text: youtubeHtmlFixture(),
    };
  };

  const result = await PlaylistProcessor.extract(
    'https://www.youtube.com/watch?v=ignored&list=PL_fixture_123&utm_source=x',
    { requester, maxItems: 20, maxPages: 5 },
  );

  assert.equal(result.platform, 'youtube');
  assert.equal(result.sourceId, 'PL_fixture_123');
  assert.equal(result.title, 'Public course');
  assert.equal(result.fetchedPages, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.items.map((item) => item.canonicalKey),
    ['youtube:yt_video_1', 'youtube:yt_video_2'],
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, 'POST');
  assert.ok(requests[1].body?.includes('"continuation":"CONTINUE_2"'));
  assert.equal(requests[1].headers?.['X-Youtube-Client-Version'], 'fixture-client');
});

test('Bilibili favorites fixture paginates with bounded page size', async () => {
  const requests: PlaylistRequest[] = [];
  const requester: PlaylistRequester = async (request) => {
    requests.push(request);
    if (request.url.includes('/folder/info')) {
      return jsonResponse({
        code: 0,
        data: { title: '收藏课程', intro: '公开收藏夹' },
      });
    }
    if (request.url.includes('pn=1')) {
      return jsonResponse({
        code: 0,
        data: {
          has_more: true,
          medias: [biliVideo('BV1xx411c7mD', '第一课'), biliVideo('BV1yy411c7mE', '第二课')],
        },
      });
    }
    return jsonResponse({
      code: 0,
      data: {
        has_more: false,
        medias: [biliVideo('BV1yy411c7mE', '重复'), biliVideo('BV1zz411c7mF', '第三课')],
      },
    });
  };

  const result = await PlaylistProcessor.extract('https://space.bilibili.com/123/favlist?fid=987', {
    requester,
    pageSize: 2,
    maxPages: 3,
    maxItems: 10,
  });

  assert.equal(result.sourceType, 'favorites');
  assert.equal(result.fetchedPages, 2);
  assert.equal(result.itemCount, 3);
  assert.deepEqual(
    result.items.map((item) => item.canonicalKey),
    ['bilibili:BV1xx411c7mD', 'bilibili:BV1yy411c7mE', 'bilibili:BV1zz411c7mF'],
  );
  assert.equal(requests.length, 3);
  assert.ok(requests[1].url.includes('ps=2'));
  assert.ok(requests[2].url.includes('pn=2'));
});

test('Bilibili collection pagination stops at the configured maximum', async () => {
  const requester: PlaylistRequester = async (request) => {
    if (request.url.includes('/medialist/info')) {
      return jsonResponse({ code: 0, data: { title: '合集' } });
    }
    const second = request.url.includes('offset_index=1');
    return jsonResponse({
      code: 0,
      data: {
        has_more: true,
        mediaList: [biliVideo(second ? 'BV1yy411c7mE' : 'BV1xx411c7mD', '课')],
      },
    });
  };
  const result = await PlaylistProcessor.extract(
    'https://space.bilibili.com/123/channel/collectiondetail?sid=321',
    { requester, pageSize: 1, maxPages: 2, maxItems: 10 },
  );

  assert.equal(result.fetchedPages, 2);
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
});

test('canonical video URLs collapse tracking and short-link variants', () => {
  const short = canonicalizeVideoUrl('https://youtu.be/yt_video_1?t=30');
  const watch = canonicalizeVideoUrl('https://www.youtube.com/watch?v=yt_video_1&utm_source=test');
  const bili = canonicalizeVideoUrl(
    'https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333',
  );

  assert.deepEqual(short, watch);
  assert.equal(short.canonicalUrl, 'https://www.youtube.com/watch?v=yt_video_1');
  assert.equal(bili.canonicalKey, 'bilibili:BV1xx411c7mD');
  assert.equal(bili.canonicalUrl, 'https://www.bilibili.com/video/BV1xx411c7mD');
});

test('an empty or structurally changed YouTube page fails explicitly', async () => {
  const requester: PlaylistRequester = async () => ({
    status: 200,
    text: `<script>var ytInitialData = ${JSON.stringify({
      metadata: { playlistMetadataRenderer: { title: 'Private or empty' } },
    })};</script>`,
  });

  await assert.rejects(
    () =>
      PlaylistProcessor.extract('https://www.youtube.com/playlist?list=PL_empty_fixture', {
        requester,
      }),
    /没有可读取的公开视频/,
  );
});

function jsonResponse(json: unknown) {
  return {
    status: 200,
    text: JSON.stringify(json),
    json,
  };
}

function youtubeHtmlFixture(): string {
  const initialData = {
    metadata: {
      playlistMetadataRenderer: {
        title: 'Public course',
        description: 'Fixture description',
      },
    },
    contents: [
      youtubeVideo('yt_video_1', 'Lesson 1', 'Channel'),
      {
        continuationItemRenderer: {
          continuationEndpoint: {
            continuationCommand: { token: 'CONTINUE_2' },
          },
        },
      },
    ],
  };
  return `<html><script>var ytInitialData = ${JSON.stringify(
    initialData,
  )};</script><script>ytcfg.set({"INNERTUBE_API_KEY":"fixture-key","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"fixture-client"}}});</script></html>`;
}

function youtubeVideo(videoId: string, title: string, author: string) {
  return {
    playlistVideoRenderer: {
      videoId,
      title: { runs: [{ text: title }] },
      shortBylineText: { runs: [{ text: author }] },
      lengthText: { simpleText: '12:34' },
    },
  };
}

function biliVideo(bvid: string, title: string) {
  return {
    bvid,
    title,
    duration: 123,
    author: { name: 'UP' },
    owner: { name: 'UP' },
  };
}
