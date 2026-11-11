/**
 * Plugin side of the light tier: which jobs it takes, the network layer for the
 * streamed model reply, and turning the model's JSON into a ProcessingResult like
 * the backend's.
 *
 * The light tier works from a transcript the job already carries: one the browser
 * extension read from the YouTube page the person is watching, or one pasted in.
 * A link on its own goes to the backend. The plugin does not fetch YouTube captions
 * itself: since 2026 caption URLs answer plain requests with an empty body
 * (youtube-transcript-api issue #592), and getting round that would mean getting
 * round YouTube's bot checks.
 */
import type { ProcessingMode, ProcessingResult, SupportedLanguage, VideoInput } from '../types';
import { detectPlatform } from './Platform';
import { type LiteSegment, type StreamTransport, generateNote, transcriptText } from './LiteTier';
import { normalizeRichProcessingResult, parseTranscriptSegments } from './KnowledgeModel';
import { desktopRequire } from '../utils/desktop';
import { tr } from '../utils/i18n';

export const LITE_PROMPT_VERSION = 'video-note-prompt-v5';

export type LiteDecision =
  | { lite: true }
  | { lite: false; why: 'off' | 'no-key' | 'no-transcript' | 'mode' | 'local' | 'reprocess' };

/**
 * Whether the light tier takes this job: it carries a transcript (from the extension
 * or pasted) and a summary key is set. Links alone, local files and reprocessing of
 * stored results stay with the backend.
 */
export function liteDecision(
  enabled: boolean,
  hasModel: boolean,
  input: VideoInput,
  mode: ProcessingMode,
): LiteDecision {
  if (!enabled) return { lite: false, why: 'off' };
  if (mode === 'info-only') return { lite: false, why: 'mode' };
  if (input.localFile || input.localFiles?.length) return { lite: false, why: 'local' };
  if (input.skipSourceFetch || input.persistedSegments?.length) {
    return { lite: false, why: 'reprocess' };
  }
  if (!input.transcript?.trim()) return { lite: false, why: 'no-transcript' };
  if (mode === 'summary' && !hasModel) return { lite: false, why: 'no-key' };
  return { lite: true };
}

export interface LiteDeps {
  transport: StreamTransport;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LiteProgress {
  stageLabel?: string;
  liveText?: string;
  message?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Runs one job in the light tier. */
export async function runLiteJob(
  deps: LiteDeps,
  input: VideoInput,
  mode: ProcessingMode,
  language: SupportedLanguage,
  report: (progress: LiteProgress) => void,
  signal?: AbortSignal,
  title?: string,
): Promise<ProcessingResult> {
  const sourceUrl = input.url || input.sourceUrl || '';
  const base: ProcessingResult = { transcript_source: 'provided_transcript' };
  if (sourceUrl) base.video_platform = detectPlatform(sourceUrl);
  report({ stageLabel: tr('读取文稿', 'Reading the transcript') });
  const segments: LiteSegment[] = parseTranscriptSegments(input.transcript || '', sourceUrl).map(
    (segment) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end ?? null,
      text: segment.text,
    }),
  );
  const timing = segments.some((segment) => segment.start !== null) ? 'exact' : 'none';
  if (segments.length === 0) throw new Error(tr('文稿是空的', 'The transcript is empty'));
  base.video_transcript = transcriptText(segments);

  const payload: Record<string, unknown> = {
    video_segments: segments.map((segment) => ({
      ...segment,
      source: 'speech',
      timing_quality: segment.start === null ? 'none' : timing,
    })),
    timing_quality: timing,
  };

  if (mode === 'summary') {
    const json = await generateNote({
      transport: deps.transport,
      baseUrl: deps.baseUrl,
      apiKey: deps.apiKey,
      model: deps.model,
      segments,
      title,
      language,
      metadata: {
        content_type: input.contentType || 'auto',
        attention_assessment: input.attentionAssessment !== false,
        generate_learning: input.generateLearning === true,
      },
      onProgress: ({ stage, live }) => report({ stageLabel: stage, liveText: live }),
      signal,
    });
    Object.assign(payload, json, {
      video_segments: payload.video_segments,
      timing_quality: timing,
    });
    base.note = str(json.note);
    base.summary = str(json.summary);
    base.note_title = str(json.note_title);
    base.tldr = str(json.tldr);
    base.video_title = base.video_title || str(json.video_title);
  }

  return normalizeRichProcessingResult(base, payload, {
    sourceUrl,
    model: deps.model,
    processingDepth: input.processingDepth,
    promptVersion: LITE_PROMPT_VERSION,
    requestedContentType: input.contentType,
    autoRoute: input.autoRoute,
  });
}

interface NodeResponse {
  statusCode?: number;
  setEncoding(encoding: string): void;
  on(event: 'data', listener: (chunk: string) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}
interface NodeRequest {
  on(event: 'error', listener: (error: Error) => void): void;
  setTimeout(ms: number, listener: () => void): void;
  destroy(error?: Error): void;
  write(body: string): void;
  end(): void;
}
interface NodeHttp {
  request(
    url: URL,
    options: { method: string; headers: Record<string, string | number> },
    onResponse: (response: NodeResponse) => void,
  ): NodeRequest;
}

/**
 * Streams the reply through Node's http(s) on desktop: requestUrl returns only the
 * whole body, and a renderer fetch is subject to the model service's CORS rules.
 * A connection that sends nothing for two minutes is dropped.
 */
export const nodeStreamTransport: StreamTransport = (request, onData, signal) =>
  new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const http = desktopRequire(url.protocol === 'http:' ? 'http' : 'https') as
      | NodeHttp
      | undefined;
    if (!http?.request) {
      reject(new Error(tr('轻量档需要桌面版 Obsidian', 'The light tier needs desktop Obsidian')));
      return;
    }
    const length = new TextEncoder().encode(request.body).length;
    const req = http.request(
      url,
      { method: 'POST', headers: { ...request.headers, 'Content-Length': length } },
      (response) => {
        const status = response.statusCode || 0;
        let errorText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (status >= 400) errorText += chunk;
          else onData(chunk);
        });
        response.on('end', () => resolve({ status, errorText }));
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(120_000, () =>
      req.destroy(
        new Error(tr('模型服务两分钟没有回应', 'The model service went quiet for two minutes')),
      ),
    );
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('请求被取消'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('请求被取消')), { once: true });
    }
    req.write(request.body);
    req.end();
  });
