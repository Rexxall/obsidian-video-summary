import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { VideoSummaryAPI } from '../api/VideoSummaryAPI';

function createApi() {
  const vault = { configDir: '.obsidian', adapter: {} };
  return new VideoSummaryAPI(
    'https://example.invalid/webhook',
    vault as never,
    '.obsidian/plugins/video-summary/data',
  );
}

// The last line of yt-dlp's stderr reaches the plugin as the backend's error.
void test('platform blocks say what to do next without asking for browser cookies', () => {
  const api = createApi();
  const douyin = api.formatUserFacingError(
    new Error(
      'ERROR: [Douyin] 6961737553342991651: Fresh cookies (not necessarily logged in) are needed',
    ),
  );
  assert.match(douyin, /抖音目前读不到|Douyin can't be read/);
  assert.match(douyin, /拖进侧栏|drop it into the side panel/);

  const xiaohongshu = api.formatUserFacingError(
    new Error('ERROR: [XiaoHongShu] 6411cf99000000001300b6d9: No video formats found!'),
  );
  assert.match(xiaohongshu, /小红书目前读不到|Xiaohongshu can't be read/);

  const youtube = api.formatUserFacingError(
    new Error("ERROR: [youtube] arj7oStGLkU: Sign in to confirm you're not a bot."),
  );
  assert.match(youtube, /不是机器人|not a bot/);

  for (const message of [douyin, xiaohongshu, youtube]) {
    assert.doesNotMatch(message, /cookie/i);
  }
});
