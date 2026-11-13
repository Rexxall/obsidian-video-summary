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
import { parseSheetFrames } from './BilibiliRef';
import {
  fillNoteStyle,
  noteImagesFor,
  promptVersionFor,
  stampDate,
  youTubeVideoId,
  type NoteImage,
} from './NoteStyle';
import type { ProcessingMode, ProcessingResult, SupportedLanguage, VideoInput } from '../types';
import { detectPlatform } from './Platform';
import { type LiteSegment, type StreamTransport, generateNote, transcriptText } from './LiteTier';
import { normalizeRichProcessingResult, parseTranscriptSegments } from './KnowledgeModel';
import { desktopRequire } from '../utils/desktop';
import { tr } from '../utils/i18n';

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

/**
 * A YouTube link with nothing else, while the light tier is ready: sent from the video's own
 * page with the browser extension, it would carry the captions and need no backend.
 */
export function linkWantsPageCapture(
  input: VideoInput,
  liteReady: boolean,
  mode: ProcessingMode = 'summary',
): boolean {
  if (!liteReady || mode === 'info-only') return false;
  if (input.transcript?.trim() || input.localFile || input.localFiles?.length) return false;
  if (input.skipSourceFetch || input.persistedSegments?.length) return false;
  if (youTubeVideoId(input.url)) return true;
  // A Bilibili video page: the extension reads its subtitles there too.
  return /^https?:\/\/(www\.|m\.)?bilibili\.com\/video\/(BV|av)/i.test(input.url || '');
}

/** The extension's shortcut as this computer writes it. */
export function captureShortcut(isMac: boolean): string {
  return isMac ? '⌘⇧S' : 'Ctrl+Shift+S';
}

export interface LiteDeps {
  transport: StreamTransport;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** The reader's writing style, followed over the prompt's defaults. */
  noteStyle?: string;
  /** Pictures already saved for this video (Bilibili); otherwise the ones its link offers. */
  images?: NoteImage[];
}

/** Video details the note already has: title, uploader, duration as yt-dlp writes it, cover. */
export interface LiteVideoMeta {
  title?: string;
  author?: string;
  duration?: string;
  cover?: string;
  /** Bilibili: where three frames sit in its preview sheets, as the extension found them. */
  frames?: string;
}

/** Video details the browser extension read from the page, kept only when they look right. */
export function pageVideoDetails(params: Record<string, string>): Record<string, string> {
  const details: Record<string, string> = {};
  const author = (params.author || '').trim();
  if (author && author.length <= 200 && !/[\r\n]/.test(author)) details.video_author = author;
  const duration = (params.duration || '').trim();
  if (/^\d{1,3}(?::\d{2}){1,2}$/.test(duration)) details.video_duration = duration;
  const cover = (params.cover || '').trim();
  if (
    /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/[\w.-]+$/.test(cover) ||
    /^https:\/\/i\d\.hdslb\.com\/bfs\/[\w/.-]+\.(jpe?g|png|webp)$/i.test(cover)
  ) {
    details.video_cover = cover;
  }
  const frames = parseSheetFrames(params.frames);
  if (frames.length) details.video_frames = JSON.stringify(frames);
  return details;
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
  meta: LiteVideoMeta = {},
): Promise<ProcessingResult> {
  const sourceUrl = input.url || input.sourceUrl || '';
  // What the backend gets from yt-dlp, here from the note (the extension wrote it from the page).
  const base: ProcessingResult = { transcript_source: 'provided_transcript' };
  if (meta.author) base.video_author = meta.author;
  if (meta.duration) base.video_duration = meta.duration;
  if (meta.cover) base.video_cover = meta.cover;
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
      title: meta.title,
      author: meta.author,
      language,
      metadata: {
        content_type: input.contentType || 'auto',
        attention_assessment: input.attentionAssessment !== false,
        generate_learning: input.generateLearning === true,
        ...(deps.noteStyle?.trim()
          ? {
              note_style: fillNoteStyle(deps.noteStyle, {
                channel: meta.author,
                date: stampDate(),
                duration: meta.duration,
                videoId: youTubeVideoId(sourceUrl) || '',
                language,
              }),
            }
          : {}),
        note_images: deps.images?.length ? deps.images : noteImagesFor(sourceUrl, meta.duration),
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
    // Like the backend, a video keeps its own title (yt-dlp's there, the page's here); a pasted
    // text gets the model's.
    base.video_title = (sourceUrl && meta.title) || str(json.video_title);
  }

  return normalizeRichProcessingResult(base, payload, {
    sourceUrl,
    model: deps.model,
    processingDepth: input.processingDepth,
    promptVersion: promptVersionFor(deps.noteStyle),
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
