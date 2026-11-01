import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { VideoSummaryAPI } from '../api/VideoSummaryAPI';
import { JobStore } from '../core/JobStore';
import { diagnoseSource } from '../core/SourceHealth';

function friendly(raw: string): string {
  const vault = { configDir: '.obsidian', adapter: {} };
  const api = new VideoSummaryAPI(
    'https://example.invalid/webhook',
    vault as never,
    '.obsidian/plugins/video-summary/data',
  );
  return api.formatUserFacingError(new Error(raw));
}

// The card reads the message the job stored, which is the friendly text, not yt-dlp's stderr.
void test('each cause gets its own next step, and a route that cannot work is not retried', () => {
  const douyin = diagnoseSource(
    friendly('ERROR: [Douyin] 1: Fresh cookies (not necessarily logged in) are needed'),
    { isLink: true },
  );
  assert.equal(douyin?.problem, 'blocked');
  assert.equal(douyin?.retryUseless, true);
  assert.equal(douyin?.canPaste, true);

  const youtube = diagnoseSource(
    friendly("ERROR: [youtube] x: Sign in to confirm you're not a bot."),
    { isLink: true },
  );
  assert.equal(youtube?.problem, 'rate-limit');
  assert.equal(
    diagnoseSource('HTTP 429 Too Many Requests', { isLink: true })?.problem,
    'rate-limit',
  );

  const bilibili = diagnoseSource(
    friendly(
      'ERROR: [BiliBili] BV1: Unable to download webpage: HTTP Error 412: Precondition Failed',
    ),
    { isLink: true },
  );
  assert.equal(bilibili?.problem, 'login');
  assert.equal(bilibili?.retryUseless, false);
});

void test('no subtitles: speech-to-text decides whether the problem is the key or the video', () => {
  const off = diagnoseSource('No subtitles found for this video', {
    isLink: true,
    speechConfigured: false,
  });
  assert.equal(off?.problem, 'speech-off');
  assert.equal(off?.speech, 'off');

  const on = diagnoseSource('No subtitles found for this video', {
    isLink: true,
    speechConfigured: true,
  });
  assert.equal(on?.problem, 'no-subtitles');
  assert.equal(on?.speech, 'on');

  const unknown = diagnoseSource('没有字幕', { isLink: true });
  assert.equal(unknown?.speech, 'unknown');
  assert.equal(unknown?.retryUseless, true);
});

void test('a local file cannot take a pasted transcript, the backend being down is not a source problem', () => {
  const local = diagnoseSource('Speech to text failed: SiliconFlow 401', { isLink: false });
  assert.equal(local?.problem, 'speech-off');
  assert.equal(local?.canPaste, false);

  const down = diagnoseSource(friendly('Failed to fetch'), { isLink: true });
  assert.equal(down?.problem, 'backend');
  assert.equal(down?.canPaste, false);

  assert.equal(diagnoseSource('The model returned invalid JSON', { isLink: true }), null);
});

void test('a pasted transcript finishes the same job and keeps its link as the source', async () => {
  const jobs = new JobStore();
  const inputs: Array<Record<string, unknown>> = [];
  jobs.setRunner(async (job) => {
    inputs.push({ ...job.input, useCache: job.useCache });
    if (!job.input.transcript) throw new Error('No subtitles found for this video');
    return { summary: 'done' };
  });

  const job = jobs.enqueue({
    title: 'A video without subtitles',
    input: { url: 'https://www.youtube.com/watch?v=abc' },
    mode: 'summary',
    language: 'zh',
    useCache: true,
    notePath: 'Videos/A video.md',
  });
  assert.equal((await jobs.waitFor(job.id))?.state, 'error');

  jobs.retryWithTranscript(job.id, '  the words of the video  ');
  const done = await jobs.waitFor(job.id);

  assert.equal(done?.id, job.id);
  assert.equal(done?.state, 'success');
  assert.equal(done?.notePath, 'Videos/A video.md');
  assert.equal(jobs.getAll().length, 1);
  assert.deepEqual(inputs[1], {
    url: undefined,
    localFile: undefined,
    localFiles: undefined,
    sourceUrl: 'https://www.youtube.com/watch?v=abc',
    transcript: 'the words of the video',
    useCache: false,
  });
});
