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

test('API uses one exact fingerprint for lookup, storage, and returned provenance', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const requestBodies: any[] = [];
  globalThis.fetch = async (_input, init) => {
    requests += 1;
    requestBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(
      JSON.stringify({
        summary: `backend result ${requests}`,
        video_title: 'Fingerprint fixture',
        video_transcript: '[00:00] fixture',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const adapter = new MemoryAdapter();
    const vault = { configDir: '.obsidian', adapter };
    const api = new VideoSummaryAPI(
      'https://example.invalid/webhook',
      vault as never,
      '.obsidian/plugins/video-summary/data',
      undefined,
      'n8n',
    );
    api.setAiModel('Gemini 3.1');
    api.setAnalysisDefaults({
      processingDepth: 'evidence',
      contentType: 'auto',
      autoRoute: true,
      attentionAssessment: true,
      generateLearning: false,
    });

    const input = { url: 'https://youtu.be/dQw4w9WgXcQ?t=10' };
    const first = await api.processVideoSimple(input, 'summary', 'zh', true);
    const cached = await api.processVideoSimple(input, 'summary', 'zh', true);

    assert.equal(requests, 1);
    assert.equal(requestBodies[0].metadata.prompt_profile, 'content-routing-v1');
    assert.equal(requestBodies[0].metadata.content_router_contract.requested_type, 'auto');
    assert.equal(requestBodies[0].metadata.content_router_contract.profiles.length, 7);
    assert.equal(requestBodies[0].metadata.content_router_contract.fallback_type, 'general');
    assert.match(first.artifact?.fingerprint || '', /^video-summary:fingerprint:v2:/);
    assert.equal(cached.artifact?.fingerprint, first.artifact?.fingerprint);
    assert.equal(cached.summary, first.summary);

    api.setAiModel('Gemini 3.2');
    const changedModel = await api.processVideoSimple(input, 'summary', 'zh', true);
    assert.equal(requests, 2);
    assert.notEqual(changedModel.artifact?.fingerprint, first.artifact?.fingerprint);

    const changedDepth = await api.processVideoSimple(
      { ...input, processingDepth: 'deep-visual' },
      'summary',
      'zh',
      true,
    );
    assert.equal(
      requests,
      2,
      'n8n deep-visual is explicitly downgraded and may reuse evidence cache',
    );
    assert.equal(changedDepth.artifact?.fingerprint, changedModel.artifact?.fingerprint);
    assert.equal(requestBodies[1].metadata.processing_depth, 'evidence');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reproducible reprocessing sends stored transcript without any source fetch field', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<{ metadata: Record<string, unknown> }> = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body || '{}')));
    return new Response(
      JSON.stringify({
        summary: 'Reprocessed from local transcript',
        video_title: 'Reproducibility fixture',
        video_transcript: '[00:00] local transcript',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const adapter = new MemoryAdapter();
    const vault = { configDir: '.obsidian', adapter };
    const api = new VideoSummaryAPI(
      'https://example.invalid/webhook',
      vault as never,
      '.obsidian/plugins/video-summary/data',
      undefined,
      'n8n',
    );

    await api.processVideoSimple(
      {
        sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        transcript: '[00:00] local transcript',
        skipSourceFetch: true,
        processingDepth: 'evidence',
        persistedSegments: [
          {
            id: 'stored-segment',
            start: 0,
            text: 'local transcript',
            source: 'speech',
            timing_quality: 'exact',
          },
        ],
        persistedEvidenceClaims: [
          {
            id: 'stored-claim',
            claim: 'The transcript is local.',
            evidence: [{ segment_id: 'stored-segment', source: 'speech' }],
          },
        ],
        persistedRun: {
          backend: 'codex-worker',
          model: 'stored-model',
          prompt: 'stored-prompt',
          version: 'stored-v1',
        },
      },
      'summary',
      'zh',
      false,
    );
    await api.processVideoSimple(
      {
        localFile: '/Users/example/Videos/private-lesson.mp4',
        localFiles: [
          '/Users/example/Videos/private-lesson.mp4',
          '/Users/example/Videos/private-lesson-2.mp4',
        ],
        transcript: '[00:00] local transcript',
        skipSourceFetch: true,
        processingDepth: 'evidence',
      },
      'summary',
      'zh',
      false,
    );

    assert.equal(requestBodies.length, 2);
    assert.equal(
      requestBodies[0].metadata.source_url_for_citation,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    assert.equal(
      (requestBodies[0].metadata.persisted_video_segments as any[])[0].id,
      'stored-segment',
    );
    assert.equal(
      (requestBodies[0].metadata.persisted_evidence_claims as any[])[0].id,
      'stored-claim',
    );
    assert.equal(
      (requestBodies[0].metadata.persisted_run as Record<string, unknown>).model,
      'stored-model',
    );
    for (const body of requestBodies) {
      assert.equal(body.metadata.provided_transcript, '[00:00] local transcript');
      assert.equal(body.metadata.skip_source_fetch, true);
      assert.equal('link' in body.metadata, false);
      assert.equal('local_file' in body.metadata, false);
      assert.equal('local_files' in body.metadata, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cancelling a Codex Worker task aborts its task-level wait immediately', async () => {
  const originalFetch = globalThis.fetch;
  let signalFetchStarted = () => {};
  const fetchStarted = new Promise<void>((resolve) => {
    signalFetchStarted = resolve;
  });
  const calls: string[] = [];
  const restoreTransport = useFetchTransport();
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method || 'GET'} ${String(input)}`);
    signalFetchStarted();
    return new Response(JSON.stringify({ id: 'worker-cancel-fixture', status: 'queued' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const adapter = new MemoryAdapter();
    const vault = { configDir: '.obsidian', adapter };
    const api = new VideoSummaryAPI(
      'http://127.0.0.1:8787/video-summary/jobs',
      vault as never,
      '.obsidian/plugins/video-summary/data',
      undefined,
      'codex-worker',
    );
    const processing = api.processVideo(
      'cancel-me',
      { transcript: 'cancel fixture transcript' },
      'summary',
      'zh',
      false,
    );
    const rejected = assert.rejects(processing, /请求已取消/);
    await fetchStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const cancelledAt = Date.now();
    api.cancelByNoteName('cancel-me');
    await rejected;

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(
      calls.filter((call) => call.startsWith('GET')).length,
      0,
      'cancellation should interrupt the poll sleep before a status request',
    );
    assert.ok(
      calls.some((call) => call.startsWith('POST') && call.includes('cancel')),
      'the job is cancelled on the Worker too',
    );
    assert.ok(Date.now() - cancelledAt < 250, 'cancellation should not wait for the poll interval');
  } finally {
    globalThis.fetch = originalFetch;
    restoreTransport();
  }
});

test('Codex Worker deadline stops waiting on a hanging request instead of overrunning the timeout', async () => {
  const originalFetch = globalThis.fetch;
  const restoreTransport = useFetchTransport();
  globalThis.fetch = async () => new Promise<Response>(() => {});

  try {
    const adapter = new MemoryAdapter();
    const vault = { configDir: '.obsidian', adapter };
    const api = new VideoSummaryAPI(
      'http://127.0.0.1:8787/video-summary/jobs',
      vault as never,
      '.obsidian/plugins/video-summary/data',
      undefined,
      'codex-worker',
    );
    (api as unknown as { timeout: number }).timeout = 30;

    const startedAt = Date.now();
    await assert.rejects(
      api.processVideo(
        'timeout-me',
        { transcript: 'timeout fixture transcript' },
        'summary',
        'zh',
        false,
      ),
      /Codex Worker 任务超时/,
    );

    assert.ok(
      Date.now() - startedAt < 500,
      'a hanging fetch must be bounded by the total deadline',
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreTransport();
  }
});

test('batch processing waits for asynchronous artifact and note post-processing callbacks', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        summary: 'Batch result',
        video_title: 'Batch fixture',
        video_transcript: '[00:00] batch transcript',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  try {
    const adapter = new MemoryAdapter();
    const vault = { configDir: '.obsidian', adapter };
    const api = new VideoSummaryAPI(
      'https://example.invalid/webhook',
      vault as never,
      '.obsidian/plugins/video-summary/data',
      undefined,
      'n8n',
    );
    let releaseCallback = () => {};
    let signalEntered = () => {};
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const callbackEntered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const completedCallbacks: number[] = [];
    let batchSettled = false;

    const batch = api
      .batchProcess(
        [
          {
            noteName: 'Batch fixture',
            input: { url: 'https://example.invalid/video/batch' },
            mode: 'summary',
            language: 'zh',
          },
        ],
        1,
        async (result) => {
          signalEntered();
          await callbackGate;
          completedCallbacks.push(result.index);
        },
        false,
      )
      .then((results) => {
        batchSettled = true;
        return results;
      });

    await callbackEntered;
    await Promise.resolve();
    assert.equal(batchSettled, false);
    releaseCallback();
    const results = await batch;
    assert.equal(batchSettled, true);
    assert.deepEqual(completedCallbacks, [0]);
    assert.equal(results[0].success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
