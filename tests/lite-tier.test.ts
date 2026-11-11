import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  SINGLE_PASS_CHARS,
  SseReader,
  type StreamTransport,
  chunkSegments,
  generateNote,
  modelErrorText,
  parseCondensed,
  parseNoteJson,
  partialJsonString,
  streamChat,
} from '../core/LiteTier';
import { liteDecision, pageVideoDetails, runLiteJob } from '../core/LiteRunner';
import { JobStore } from '../core/JobStore';
import { readableLive } from '../views/liveText';
import { statusClass, statusWord } from '../views/backendText';

// Tests run from the project root (tests/run-tests.mjs).
const sse = readFileSync('tests/fixtures/lite/stream-note.sse', 'utf8');

/** Replays a body in pieces of `size` characters, the way a socket splits it. */
function replay(body: string, size: number, status = 200): StreamTransport {
  return async (_request, onData) => {
    if (status >= 400) return { status, errorText: body };
    for (let i = 0; i < body.length; i += size) onData(body.slice(i, i + size));
    return { status };
  };
}

function sseOf(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
}

const NOTE = {
  video_title: 'Rules',
  note_title: '规则与承诺',
  tldr: '讲的是承诺。',
  summary: '一首关于承诺的歌。',
  note: '> [!summary] 摘要\n> 歌手承诺不放弃。',
  content_type: 'general',
  evidence_claims: [],
};

void test('the stream decodes the same whatever size the network pieces are', () => {
  for (const size of [1, 7, 64, 4096]) {
    const reader = new SseReader();
    for (let i = 0; i < sse.length; i += size) reader.push(sse.slice(i, i + size));
    const json = parseNoteJson(reader.text);
    assert.equal(json.note_title, '规则与承诺');
    assert.equal(
      json.note,
      '> [!summary] 摘要\n> 歌手承诺不放弃。\n\n## 要点\n- [00:08] (vs-1) "规则"',
    );
    assert.equal(reader.done, true);
  }
});

void test('the note shows while its JSON is still arriving', () => {
  const full = JSON.stringify(NOTE);
  const cut = full.indexOf('不放弃');
  assert.equal(partialJsonString(full.slice(0, 20), 'note'), '');
  assert.equal(partialJsonString(full.slice(0, cut), 'note'), '> [!summary] 摘要\n> 歌手承诺');
  // A cut inside an escape never shows a stray backslash.
  const escape = full.indexOf('\\n');
  assert.equal(partialJsonString(full.slice(0, escape + 1), 'note'), '> [!summary] 摘要');
  assert.equal(partialJsonString(full, 'tldr'), '讲的是承诺。');
});

void test('replies in a code fence or with text around them still parse; one without a note does not', () => {
  assert.equal(parseNoteJson('```json\n' + JSON.stringify(NOTE) + '\n```').tldr, '讲的是承诺。');
  assert.equal(
    parseNoteJson('Here you go: ' + JSON.stringify(NOTE) + ' Done.').tldr,
    '讲的是承诺。',
  );
  assert.throws(() => parseNoteJson('{"tldr":"x"}'), /note/);
  assert.throws(() => parseNoteJson('no json'), /JSON/);
});

void test('a service that rejects JSON mode is asked again without it', async () => {
  const bodies: Record<string, unknown>[] = [];
  const transport: StreamTransport = async (request, onData) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    bodies.push(body);
    assert.equal(request.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    if (body.response_format) return { status: 400, errorText: '{"error":"no json mode"}' };
    onData(sseOf('{"note":"ok"}'));
    return { status: 200 };
  };
  const text = await streamChat(
    transport,
    {
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'test-key',
      model: 'm',
      messages: [],
      jsonMode: true,
    },
    () => undefined,
  );
  assert.equal(text, '{"note":"ok"}');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].stream, true);
});

void test('model errors say what to do and never repeat a key', async () => {
  await assert.rejects(
    streamChat(
      replay(
        '{"error":{"message":"Authentication Fails, your api key: sk-abcdef1234567890 is invalid"}}',
        10,
        401,
      ),
      { baseUrl: 'https://x', apiKey: 'k', model: 'm', messages: [], jsonMode: false },
      () => undefined,
    ),
    /密钥无效/,
  );
  const text = modelErrorText(500, '{"error":{"message":"bad key sk-abcdef1234567890"}}');
  assert.equal(text.includes('sk-abcdef'), false);
  assert.match(modelErrorText(402), /余额/);
  assert.match(modelErrorText(429), /限流/);
});

void test('a reply that is not JSON is retried once with the parse error, like the backend', async () => {
  const prompts: string[] = [];
  let call = 0;
  const transport: StreamTransport = async (request, onData) => {
    const body = JSON.parse(request.body) as { messages: { content: string }[] };
    prompts.push(body.messages[1].content);
    call += 1;
    onData(sseOf(call === 1 ? 'Sure! The note is below.' : JSON.stringify(NOTE)));
    return { status: 200 };
  };
  const stages: string[] = [];
  const json = await generateNote({
    transport,
    baseUrl: 'https://x',
    apiKey: 'k',
    model: 'm',
    segments: [{ id: 'vs-1', start: 8, end: 12, text: 'you know the rules' }],
    language: 'zh',
    metadata: {},
    onProgress: ({ stage }) => stages.push(stage),
  });
  assert.equal(json.note_title, '规则与承诺');
  assert.equal(call, 2);
  assert.match(prompts[0], /VIDEO_NOTE_PROMPT_V5/);
  assert.match(prompts[0], /\[00:08\] \(vs-1\) you know the rules/);
  assert.match(prompts[1], /could not be parsed/);
  assert.ok(stages.includes('回复格式不对，重写一次'));
});

void test('a very long transcript is condensed part by part, keeping the real passage ids', async () => {
  const segments = Array.from({ length: 900 }, (_, i) => ({
    id: `vs-${String(i).padStart(4, '0')}`,
    start: i * 20,
    end: i * 20 + 20,
    text: `passage ${i} `.repeat(10),
  }));
  const parts = chunkSegments(segments);
  assert.ok(parts.length >= 3);
  assert.equal(parts.flat().length, segments.length);
  const known = new Map(segments.map((s) => [s.id, s]));
  let finalPrompt = '';
  const transport: StreamTransport = async (request, onData) => {
    const body = JSON.parse(request.body) as { messages: { content: string }[] };
    const prompt = body.messages[1].content;
    if (prompt.includes('VIDEO_NOTE_PROMPT_V5')) {
      finalPrompt = prompt;
      onData(sseOf(JSON.stringify(NOTE)));
    } else {
      const first = prompt.match(/\((vs-\d{4})\)/)?.[1] ?? '';
      onData(sseOf(`[00:00] (${first}) the main point of this part\nnoise line`));
    }
    return { status: 200 };
  };
  const json = await generateNote({
    transport,
    baseUrl: 'https://x',
    apiKey: 'k',
    model: 'm',
    segments,
    language: 'en',
    metadata: {},
    onProgress: () => undefined,
  });
  assert.equal(json.tldr, '讲的是承诺。');
  assert.ok(finalPrompt.length < SINGLE_PASS_CHARS);
  assert.match(finalPrompt, /\(vs-0000\) the main point of this part/);
  assert.equal(parseCondensed('[01:00] (vs-9999) unknown id', known).length, 0);
});

void test('the light tier takes jobs that carry a transcript; links alone go to the backend', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  assert.deepEqual(liteDecision(true, true, { url, transcript: '[00:01] hi' }, 'summary'), {
    lite: true,
  });
  assert.deepEqual(liteDecision(true, true, { transcript: 'pasted' }, 'summary'), { lite: true });
  assert.deepEqual(liteDecision(true, true, { url }, 'summary'), {
    lite: false,
    why: 'no-transcript',
  });
  assert.deepEqual(
    liteDecision(
      true,
      true,
      { url: 'https://www.bilibili.com/video/BV1', transcript: 'x' },
      'summary',
    ),
    { lite: true },
  );
  assert.deepEqual(liteDecision(false, true, { transcript: 'x' }, 'summary'), {
    lite: false,
    why: 'off',
  });
  assert.deepEqual(liteDecision(true, false, { transcript: 'x' }, 'summary'), {
    lite: false,
    why: 'no-key',
  });
  // Transcript only needs no model.
  assert.deepEqual(liteDecision(true, false, { transcript: 'x' }, 'transcript-only'), {
    lite: true,
  });
  assert.deepEqual(liteDecision(true, true, { transcript: 'x' }, 'info-only'), {
    lite: false,
    why: 'mode',
  });
  assert.deepEqual(liteDecision(true, true, { transcript: 'x', localFile: 'a.mp4' }, 'summary'), {
    lite: false,
    why: 'local',
  });
  assert.deepEqual(
    liteDecision(true, true, { transcript: 'x', skipSourceFetch: true }, 'summary'),
    { lite: false, why: 'reprocess' },
  );
});

void test('a light-tier result has the note, the timed transcript and segments the claims can cite', async () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const transcript =
    "[00:01] we're no strangers to love\n[00:25] a full commitment's what I'm thinking of";
  let prompt = '';
  const transport: StreamTransport = async (request, onData) => {
    prompt = (JSON.parse(request.body) as { messages: { content: string }[] }).messages[1].content;
    const id = prompt.match(/\((vs-[0-9a-f]{8})\) a full/)?.[1];
    const reply = {
      ...NOTE,
      evidence_claims: [
        {
          id: 'claim-1',
          claim: '承诺',
          evidence: [
            { segment_id: id, source: 'speech', quote: "a full commitment's what I'm thinking of" },
          ],
          start: 25,
          confidence: 0.9,
          review_state: 'supported',
        },
      ],
    };
    const text = JSON.stringify(reply);
    for (let i = 0; i < text.length; i += 9)
      onData(sseOf(text.slice(i, i + 9)).replace('data: [DONE]\n\n', ''));
    onData('data: [DONE]\n\n');
    return { status: 200 };
  };
  const live: string[] = [];
  const result = await runLiteJob(
    { transport, baseUrl: 'https://x', apiKey: 'k', model: 'deepseek-flash' },
    { url, transcript },
    'summary',
    'zh',
    (progress) => {
      if (progress.liveText) live.push(progress.liveText);
    },
    undefined,
    { title: 'Never Gonna Give You Up', author: 'Rick Astley', duration: '3:33' },
  );
  assert.match(prompt, /Title: Never Gonna Give You Up/);
  assert.match(prompt, /Author: Rick Astley/);
  assert.equal(result.video_author, 'Rick Astley');
  assert.equal(result.video_duration, '3:33');
  assert.equal(result.note_title, '规则与承诺');
  assert.equal(result.tldr, '讲的是承诺。');
  assert.equal(result.video_platform, 'youtube');
  assert.equal(result.transcript_source, 'provided_transcript');
  assert.equal(result.video_transcript, transcript);
  assert.equal(result.video_segments?.length, 2);
  assert.equal(result.video_segments?.[1].start, 25);
  assert.equal(result.video_segments?.[1].timing_quality, 'exact');
  assert.equal(result.evidence_claims?.[0].evidence[0].segment_id, result.video_segments?.[1].id);
  assert.ok(live.length > 3, 'the note appears in steps');
  assert.ok(live[live.length - 1].startsWith('讲的是承诺。'));
});

void test('transcript-only needs no model call', async () => {
  const transport: StreamTransport = async () => {
    throw new Error('should not be called');
  };
  const result = await runLiteJob(
    { transport, baseUrl: '', apiKey: '', model: '' },
    { transcript: 'a pasted transcript without times. It has two sentences.' },
    'transcript-only',
    'en',
    () => undefined,
  );
  assert.equal(result.note, undefined);
  assert.equal(result.video_segments?.[0].timing_quality, 'none');
});

void test('while the queue waits for the backend, light-tier jobs still run', async () => {
  const jobs = new JobStore();
  const ran: string[] = [];
  jobs.setRunner(async (job) => {
    ran.push(job.title);
    return { summary: 'ok' };
  });
  jobs.setHeld(true);
  const base = { mode: 'summary' as const, language: 'zh' as const, useCache: false };
  const backendJob = jobs.enqueue({
    ...base,
    title: 'needs backend',
    input: { url: 'https://b23.tv/x' },
  });
  const liteJob = jobs.enqueue({ ...base, title: 'light', input: { transcript: 'x' }, lite: true });
  assert.equal((await jobs.waitFor(liteJob.id))?.state, 'success');
  assert.deepEqual(ran, ['light']);
  assert.equal(jobs.get(backendJob.id)?.state, 'queued');
  jobs.setHeld(false);
  assert.equal((await jobs.waitFor(backendJob.id))?.state, 'success');
});

void test('the text being written is shown on the job and cleared when it ends', async () => {
  const jobs = new JobStore();
  const seen: (string | undefined)[] = [];
  jobs.subscribe(() => seen.push(jobs.getAll()[0]?.liveText));
  jobs.setRunner(async (_job, report) => {
    report({ liveText: '> [!summary]' });
    return { note: 'done' };
  });
  const job = jobs.enqueue({
    title: 't',
    input: { transcript: 'x' },
    mode: 'summary',
    language: 'zh',
    useCache: false,
    lite: true,
  });
  const finished = await jobs.waitFor(job.id);
  assert.ok(seen.includes('> [!summary]'));
  assert.equal(finished?.liveText, undefined);
});

void test('a reasoning model shows that it is reading before the note starts', async () => {
  const think = (text: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`;
  const transport: StreamTransport = async (_request, onData) => {
    onData(think('Let me read the transcript. '));
    onData(think('The speaker explains rules.'));
    onData(sseOf(JSON.stringify(NOTE)));
    return { status: 200 };
  };
  const seen: { stage: string; live?: string }[] = [];
  await generateNote({
    transport,
    baseUrl: 'https://x',
    apiKey: 'k',
    model: 'm',
    segments: [{ id: 'vs-1', start: 0, end: 5, text: 'hello' }],
    language: 'zh',
    metadata: {},
    onProgress: (progress) => seen.push(progress),
  });
  const reading = seen.findIndex((p) => p.stage === '正在读文稿' && p.live === undefined);
  const writing = seen.findIndex((p) => p.stage === '正在写笔记' && !!p.live);
  assert.ok(reading >= 0 && writing > reading);
  // The thinking never reaches the note.
  assert.equal(
    seen.some((p) => p.live?.includes('Let me read')),
    false,
  );
});

void test('more text for a note on screen updates only that text, not the whole panel', async () => {
  const jobs = new JobStore();
  let redraws = 0;
  const pieces: string[] = [];
  jobs.subscribe(() => (redraws += 1));
  jobs.subscribeLive((_id, text) => pieces.push(text));
  jobs.setRunner(async (_job, report) => {
    report({ stageLabel: '正在写笔记', liveText: 'a' });
    report({ stageLabel: '正在写笔记', liveText: 'ab' });
    report({ stageLabel: '正在写笔记', liveText: 'abc' });
    return { note: 'abc' };
  });
  const before = redraws;
  const job = jobs.enqueue({
    title: 't',
    input: { transcript: 'x' },
    mode: 'summary',
    language: 'zh',
    useCache: false,
    lite: true,
  });
  await jobs.waitFor(job.id);
  assert.deepEqual(pieces, ['ab', 'abc']);
  // enqueue, start, first text, finish: no redraw for the two later pieces.
  assert.equal(redraws - before, 4);
});

void test('the note being written reads as text, not Markdown', () => {
  const md = [
    '> [!summary] 摘要',
    '> 歌手承诺==不放弃==。',
    '',
    '## 要点',
    '- **规则**很重要',
    '| 术语 | 含义 |',
    '| --- | --- |',
    '| 绝缘体 | 不导电 |',
  ].join('\n');
  assert.equal(
    readableLive(md),
    ['摘要', '歌手承诺不放弃。', '', '要点', '- 规则很重要', '术语 · 含义', '绝缘体 · 不导电'].join(
      '\n',
    ),
  );
});

void test('with the light tier ready, a backend that was never set up is not shown as a fault', () => {
  const never = {
    status: 'offline' as const,
    diagnosis: { ok: false, fault: 'not-configured' as const, checkedAt: 0 },
  };
  const down = {
    status: 'offline' as const,
    diagnosis: { ok: false, fault: 'unreachable' as const, checkedAt: 0 },
  };
  assert.equal(statusClass(never, true), 'is-unknown');
  assert.equal(statusWord(never, true), '未安装 · 轻量档可用');
  assert.equal(statusClass(never, false), 'is-offline');
  assert.equal(statusWord(never), '未安装');
  // A backend that is set up but down is still a fault.
  assert.equal(statusClass(down, true), 'is-offline');
});

void test('details from the page are kept only when they look like what yt-dlp writes', () => {
  assert.deepEqual(
    pageVideoDetails({
      author: 'Rick Astley',
      duration: '3:33',
      cover: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    }),
    {
      video_author: 'Rick Astley',
      video_duration: '3:33',
      video_cover: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    },
  );
  assert.deepEqual(
    pageVideoDetails({ author: 'a\nb', duration: 'soon', cover: 'https://evil.example/x.jpg' }),
    {},
  );
});
