/**
 * The light tier: a transcript becomes a note by calling the person's own
 * OpenAI-compatible model directly, with no backend. Same prompt (v5) and the same
 * JSON fields as the backend, so notes look alike whichever tier made them.
 *
 * Everything here is pure or takes its network layer as a parameter, so tests run
 * on recorded responses.
 */
import { NOTE_SYSTEM_MESSAGE, buildNotePrompt } from '../tools/note-prompt.mjs';

/** One passage of the transcript with a stable id the model can cite. */
export interface LiteSegment {
  id: string;
  /** null for a pasted transcript without times. */
  start: number | null;
  end: number | null;
  text: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  jsonMode: boolean;
}

/**
 * Network layer for one streamed chat call. It calls onData with each piece of the
 * response body as it arrives and resolves with the status code; for an error status
 * the body is in `errorText`.
 */
export type StreamTransport = (
  request: { url: string; headers: Record<string, string>; body: string },
  onData: (chunk: string) => void,
  signal?: AbortSignal,
) => Promise<{ status: number; errorText?: string }>;

/** Above this many characters of transcript the text is condensed first (see below). */
export const SINGLE_PASS_CHARS = 80_000;
/** Size of each part when condensing. */
export const CHUNK_CHARS = 40_000;

export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function stamp(segment: LiteSegment): string {
  return segment.start === null ? '' : `[${clock(segment.start)}] `;
}

/** The transcript as the note shows it: one `[mm:ss] text` line per passage. */
export function transcriptText(segments: LiteSegment[]): string {
  return segments.map((segment) => `${stamp(segment)}${segment.text}`).join('\n');
}

function promptLength(segments: LiteSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.text.length + 20, 0);
}

/** Splits passages into parts of at most `size` characters, never inside a passage. */
export function chunkSegments(segments: LiteSegment[], size = CHUNK_CHARS): LiteSegment[][] {
  const parts: LiteSegment[][] = [];
  let current: LiteSegment[] = [];
  let length = 0;
  for (const segment of segments) {
    const add = segment.text.length + 20;
    if (current.length && length + add > size) {
      parts.push(current);
      current = [];
      length = 0;
    }
    current.push(segment);
    length += add;
  }
  if (current.length) parts.push(current);
  return parts;
}

export interface NoteRequest {
  segments: LiteSegment[];
  title?: string;
  author?: string;
  language: string;
  metadata: Record<string, unknown>;
  retryCount?: number;
  parseError?: string;
}

export function noteMessages(request: NoteRequest): ChatMessage[] {
  return [
    { role: 'system', content: NOTE_SYSTEM_MESSAGE },
    {
      role: 'user',
      content: buildNotePrompt({
        segments: request.segments,
        transcript: transcriptText(request.segments),
        title: request.title,
        author: request.author,
        language: request.language,
        metadata: request.metadata,
        retryCount: request.retryCount,
        parseError: request.parseError,
      }),
    },
  ];
}

/**
 * For one part of a very long transcript: the passages worth keeping, each still
 * carrying its time and id, so the final note can cite the real transcript.
 */
export function condenseMessages(part: LiteSegment[], index: number, total: number): ChatMessage[] {
  const lines = part.map((s) => `${stamp(s)}(${s.id}) ${s.text}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You shorten part of a long video transcript so a later step can write one note from all parts. Keep facts, names, numbers, steps and conclusions; drop filler and repetition.',
    },
    {
      role: 'user',
      content: [
        `Part ${index + 1} of ${total}. Each line: time, segment id in parentheses, words.`,
        '---',
        lines,
        '---',
        'Reply with plain lines, about a fifth of the length above, in the language of the transcript.',
        'Each line: the time and the id of the passage it comes from, exactly as given, then the point. Example: [12:34] (seg-0042) The speaker compares A and B and prefers B because it is cheaper.',
      ].join('\n'),
    },
  ];
}

/** Reads condensed lines back into passages; lines without a known id are skipped. */
export function parseCondensed(text: string, known: Map<string, LiteSegment>): LiteSegment[] {
  const out: LiteSegment[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/\(([A-Za-z0-9_-]{4,})\)\s*(.+)$/);
    if (!match) continue;
    const source = known.get(match[1]);
    const point = match[2].trim();
    if (source && point) out.push({ ...source, text: point });
  }
  return out;
}

/** Pulls the content deltas out of an SSE stream as it arrives. */
export class SseReader {
  private buffer = '';
  text = '';
  /** Characters of a reasoning model's thinking (`reasoning_content`), which comes before the reply. */
  reasoning = 0;
  done = false;

  push(chunk: string): string {
    this.buffer += chunk;
    let added = '';
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        this.done = true;
        continue;
      }
      try {
        const parsed = JSON.parse(data) as {
          choices?: {
            delta?: { content?: string; reasoning_content?: string };
            message?: { content?: string };
          }[];
        };
        const thinking = parsed.choices?.[0]?.delta?.reasoning_content;
        if (thinking) {
          this.reasoning += thinking.length;
          added += ' ';
        }
        const piece =
          parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
        if (piece) {
          added += piece;
          this.text += piece;
        }
      } catch {
        // A keep-alive comment or a partial line that the next chunk completes.
      }
    }
    return added;
  }
}

export class ModelCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}

/** A short, key-free reason from an error body. */
export function modelErrorText(status: number, body = ''): string {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    detail =
      (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ||
      parsed.message ||
      '';
  } catch {
    detail = body.slice(0, 200);
  }
  // Never echo anything that looks like a key back to the screen.
  detail = detail.replace(/\b(sk|key)[-_][A-Za-z0-9_-]{8,}/gi, '••••');
  if (status === 401 || status === 403) return `密钥无效或没有权限（HTTP ${status}）`;
  if (status === 402) return `模型服务余额不足（HTTP ${status}）`;
  if (status === 429) return `模型服务限流，稍后再试（HTTP ${status}）`;
  return `模型服务返回 HTTP ${status}${detail ? `：${detail}` : ''}`;
}

/**
 * One streamed chat call. Falls back to plain mode once if the service rejects JSON mode.
 * onText gets the reply so far and how much the model has thought before it.
 */
/** OpenAI reasoning models (o-series, gpt-5 and later); keep in step with backend/init/configure.mjs. */
export function isReasoningModel(model: string | undefined): boolean {
  const name = (model ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(openai|anthropic)\//, '');
  // Claude 5 and later reject `temperature` like OpenAI's reasoning models do.
  return /^(o\d|gpt-([5-9]|\d{2,})|claude-[a-z]+-([5-9]|\d{2,}))/.test(name);
}

export async function streamChat(
  transport: StreamTransport,
  request: ChatRequest,
  onText: (full: string, reasoning: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const attempt = async (jsonMode: boolean) => {
    const reader = new SseReader();
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: true,
    };
    // Same as the backend's chat model node. Reasoning models only take the default and answer 400.
    if (!isReasoningModel(request.model)) body.temperature = 0.4;
    if (jsonMode) body.response_format = { type: 'json_object' };
    const response = await transport(
      {
        url: `${request.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      (chunk) => {
        if (reader.push(chunk)) onText(reader.text, reader.reasoning);
      },
      signal,
    );
    reader.push('\n');
    return { response, text: reader.text };
  };
  let { response, text } = await attempt(request.jsonMode);
  if (request.jsonMode && response.status === 400) {
    ({ response, text } = await attempt(false));
  }
  if (response.status >= 400) {
    throw new ModelCallError(response.status, modelErrorText(response.status, response.errorText));
  }
  if (!text.trim()) throw new ModelCallError(response.status, '模型没有回内容');
  return text;
}

/**
 * The value of a string field in JSON that is still arriving: everything decoded so far,
 * or '' before the field starts. Used to show the note while it is being written.
 */
export function partialJsonString(buffer: string, key: string): string {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(buffer);
  if (!match) return '';
  let out = '';
  for (let i = match.index + match[0].length; i < buffer.length; i += 1) {
    const char = buffer[i];
    if (char === '"') return out;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = buffer[i + 1];
    if (next === undefined) return out;
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') continue;
    else if (next === 'u') {
      const hex = buffer.slice(i + 1, i + 5);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += next;
  }
  return out;
}

/** Parses the model's reply: plain JSON, JSON in a code fence, or JSON with text around it. */
export function parseNoteJson(text: string): Record<string, unknown> {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('回复里没有 JSON');
  const value: unknown = JSON.parse(trimmed.slice(first, last + 1));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('回复不是 JSON 对象');
  }
  const note = (value as Record<string, unknown>).note;
  if (typeof note !== 'string' || !note.trim()) throw new Error('回复里没有 note');
  return value as Record<string, unknown>;
}

export interface GenerateOptions {
  transport: StreamTransport;
  baseUrl: string;
  apiKey: string;
  model: string;
  segments: LiteSegment[];
  title?: string;
  author?: string;
  language: string;
  metadata: Record<string, unknown>;
  /** Called with a short stage text and, while the note is written, the text so far. */
  onProgress: (progress: { stage: string; live?: string }) => void;
  signal?: AbortSignal;
}

/**
 * Transcript → note fields. A transcript that fits goes in one call (most videos:
 * 40 minutes of speech is 10–40k characters). A longer one is condensed part by part
 * first, keeping the passage ids, then written as one note.
 */
export async function generateNote(options: GenerateOptions): Promise<Record<string, unknown>> {
  const chat = (
    messages: ChatMessage[],
    jsonMode: boolean,
    onText: (full: string, reasoning: number) => void,
  ) =>
    streamChat(
      options.transport,
      {
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
        messages,
        jsonMode,
      },
      onText,
      options.signal,
    );

  let segments = options.segments;
  if (promptLength(segments) > SINGLE_PASS_CHARS) {
    const known = new Map(segments.map((segment) => [segment.id, segment]));
    const parts = chunkSegments(segments);
    const condensed: LiteSegment[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      options.onProgress({ stage: `长视频，先压缩第 ${i + 1}/${parts.length} 段` });
      const text = await chat(condenseMessages(parts[i], i, parts.length), false, () => undefined);
      const lines = parseCondensed(text, known);
      // A part the model answered in another shape keeps its first passages instead of vanishing.
      condensed.push(...(lines.length ? lines : parts[i].slice(0, 20)));
    }
    segments = condensed;
  }

  const request: NoteRequest = {
    segments,
    title: options.title,
    author: options.author,
    language: options.language,
    metadata: options.metadata,
  };
  options.onProgress({ stage: '正在读文稿', live: '' });
  const show = (full: string, reasoning: number) => {
    const tldr = partialJsonString(full, 'tldr');
    const note = partialJsonString(full, 'note');
    const live = [tldr, note].filter(Boolean).join('\n\n');
    // A reasoning model thinks first, often for half a minute; say so instead of looking stuck.
    if (!live && reasoning > 0) {
      options.onProgress({ stage: '正在读文稿' });
      return;
    }
    options.onProgress({ stage: '正在写笔记', live });
  };
  const reply = await chat(noteMessages(request), true, show);
  try {
    return parseNoteJson(reply);
  } catch (error) {
    // Same retry as the backend: tell the model what failed and ask once more.
    options.onProgress({ stage: '回复格式不对，重写一次', live: '' });
    const again = await chat(
      noteMessages({
        ...request,
        retryCount: 1,
        parseError: error instanceof Error ? error.message : String(error),
      }),
      true,
      show,
    );
    return parseNoteJson(again);
  }
}
