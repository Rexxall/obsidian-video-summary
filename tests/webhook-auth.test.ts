import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { VideoSummaryAPI } from '../api/VideoSummaryAPI';
import { useFetchTransport } from './fetch-transport';

// n8n webhook calls now use the native request layer; tests drive it through mocked fetch.
useFetchTransport();

class MemoryAdapter {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.directories.delete(path);
  }
}

function createApi(secret = 'test-secret') {
  const adapter = new MemoryAdapter();
  const vault = { configDir: '.obsidian', adapter };
  return new VideoSummaryAPI(
    'https://example.invalid/webhook',
    vault as never,
    '.obsidian/plugins/video-summary/data',
    undefined,
    'n8n',
    { headerName: 'X-Video-Summary-Token', secret },
  );
}

void test('n8n processing, health, and connection-test requests consistently send Header Auth', async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(init || {});
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { name?: string };
    if (body.name === 'test') {
      return new Response(
        JSON.stringify({
          workflow: {
            name: 'Video Summary Advanced Workflow',
            version: '2.1.5',
            variant: 'advanced',
            webhookPath: 'obsidian-video-summary',
            models: ['Gemini 3.1', 'Gemini 3.0'],
            requiredTools: ['yt-dlp', 'ffmpeg'],
            uploadsPath: '/home/node/uploads',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        summary: 'Authenticated fixture',
        video_title: 'Authenticated fixture',
        video_transcript: '[00:00] fixture',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const api = createApi();
    await api.processVideoSimple({ transcript: 'fixture' }, 'summary', 'zh', false);
    assert.equal((await api.quickHealthCheck()).ok, true);
    assert.equal((await api.testConnection()).success, true);

    assert.equal(requests.length, 3);
    for (const request of requests) {
      const headers = new Headers(request.headers);
      assert.equal(headers.get('content-type'), 'application/json');
      assert.equal(headers.get('x-video-summary-token'), 'test-secret');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('static n8n endpoint probes receive auth while empty secrets remain backward compatible', async () => {
  const originalFetch = globalThis.fetch;
  const seenHeaders: Headers[] = [];
  globalThis.fetch = async (_input, init) => {
    seenHeaders.push(new Headers(init?.headers));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const authenticated = await VideoSummaryAPI.probeEndpoint(
      'https://example.invalid/webhook',
      'n8n',
      4000,
      undefined,
      { headerName: 'Authorization', secret: 'Bearer fixture' },
    );
    const legacy = await VideoSummaryAPI.probeEndpoint(
      'https://example.invalid/webhook',
      'n8n',
      4000,
      undefined,
      { headerName: 'X-Video-Summary-Token', secret: '' },
    );

    assert.equal(authenticated.ok, true);
    assert.equal(legacy.ok, true);
    assert.equal(seenHeaders[0].get('authorization'), 'Bearer fixture');
    assert.equal(seenHeaders[1].has('x-video-summary-token'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('webhook secrets are redacted from connection diagnostics and invalid headers fail safely', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('backend echoed test-secret', {
      status: 500,
      statusText: 'Failure',
      headers: { 'content-type': 'text/plain' },
    });

  try {
    const api = createApi();
    const connection = await api.testConnection();
    assert.equal(connection.success, false);
    assert.doesNotMatch(connection.error || '', /test-secret/);
    assert.doesNotMatch(connection.bodySnippet || '', /test-secret/);
    assert.match(connection.error || '', /\[REDACTED\]/);

    const invalid = await VideoSummaryAPI.probeEndpoint(
      'https://example.invalid/webhook',
      'n8n',
      4000,
      undefined,
      { headerName: 'Bad Header', secret: 'test-secret' },
    );
    assert.equal(invalid.ok, false);
    assert.match(invalid.error || '', /Header 名称无效/);
    assert.doesNotMatch(invalid.error || '', /test-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
