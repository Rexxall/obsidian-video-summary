import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { VideoSummaryAPI } from '../api/VideoSummaryAPI';

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
  globalThis.fetch = async () => {
    requests += 1;
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
    assert.equal(requests, 3);
    assert.notEqual(changedDepth.artifact?.fingerprint, changedModel.artifact?.fingerprint);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
