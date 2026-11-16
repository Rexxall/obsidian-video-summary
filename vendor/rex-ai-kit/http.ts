// Generated from rex-ai-kit 0.1.0. Do not edit here.
import { at, str } from './json';
import { AiError, type AiErrorKind, type HttpRequest, type HttpResponse, type StreamTransport, type Transport } from './types';

const parse = (text: string): unknown => {
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return null;
	}
};

/**
 * Transport over Obsidian's requestUrl: no CORS limits, works on mobile, but no streaming.
 * Pass the function itself so this file stays free of the obsidian import:
 *   requestUrlTransport(requestUrl)
 */
export function requestUrlTransport(
	requestUrl: (p: { url: string; method: string; headers: Record<string, string>; body?: string; throw: boolean }) => Promise<{ status: number; text: string }>,
): Transport {
	return async (req) => {
		if (req.signal?.aborted) throw new AiError('Cancelled', 'aborted');
		const run = requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
		const res = await (req.signal ? raceAbort(run, req.signal) : run);
		return { status: res.status, text: res.text, json: parse(res.text) };
	};
}

/** Transport over fetch. Used in tests and for CORS-friendly providers. */
export function fetchTransport(f: typeof fetch): Transport {
	return async (req) => {
		const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
		const text = await res.text();
		return { status: res.status, text, json: parse(text) };
	};
}

/** Streaming over fetch: yields decoded text chunks as they arrive. */
export function fetchStream(f: typeof fetch): StreamTransport {
	return async (req) => {
		const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal });
		const body = res.body;
		if (!res.ok || !body) return { status: res.status, chunks: (async function* () {})(), text: () => res.text() };
		const reader = body.getReader();
		const decoder = new TextDecoder();
		return {
			status: res.status,
			chunks: (async function* () {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					yield decoder.decode(value, { stream: true });
				}
			})(),
		};
	};
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new AiError('Cancelled', 'aborted'));
		signal.addEventListener('abort', onAbort, { once: true });
		p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}

/** Pull the provider's own error message out of the usual response shapes. */
export function errorText(res: Pick<HttpResponse, 'json' | 'text'>): string {
	const j = res.json;
	const err = at(j, 'error');
	const msg = str(at(err, 'message')) ?? str(err) ?? str(at(j, 'message')) ?? str(at(j, 'detail')) ?? str(at(j, 0, 'error', 'message'));
	if (typeof msg === 'string' && msg.trim()) return redact(msg.trim()).slice(0, 300);
	return redact(res.text?.trim() ?? '').slice(0, 200);
}

/** Remove anything that looks like a key, so error text is safe to show and copy. */
export function redact(text: string, secrets: (string | null | undefined)[] = []): string {
	let out = text;
	for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[key]');
	return out
		.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [key]')
		.replace(/\bsk-[A-Za-z0-9_*-]{8,}/g, '[key]')
		.replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[key]')
		.replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1[key]');
}

const QUOTA_WORDS = /insufficient|balance|quota|billing|arrearage|exceeded your current|credit|余额|额度|欠费/i;
const MISSING_MODEL = /model.{0,40}(not.?exist|not.?found|does not exist|unknown|no such|invalid)|(invalid|unknown) model|模型.{0,10}(不存在|无效)/i;

/** Work out what went wrong from the status and the provider's words. */
export function classifyHttp(status: number, detail: string): AiErrorKind {
	if (status === 402) return 'quota';
	if (status === 401 || status === 403) return QUOTA_WORDS.test(detail) ? 'quota' : 'auth';
	if (status === 429) return QUOTA_WORDS.test(detail) ? 'quota' : 'rate';
	if (status === 404) return 'model';
	if ((status === 400 || status === 422) && MISSING_MODEL.test(detail)) return 'model';
	if (status === 400 && /api.?key/i.test(detail)) return 'auth';
	if (status === 408 || status === 504) return 'timeout';
	if (status === 0) return 'network';
	if (status >= 500) return 'server';
	return 'bad-response';
}

/** Map an HTTP failure to an AiError with a kind the UI can act on. */
export function toError(res: HttpResponse, providerName: string): AiError {
	const detail = errorText(res);
	const s = res.status;
	const kind = classifyHttp(s, detail);
	const tail = detail ? ` (${detail})` : '';
	const head: Record<AiErrorKind, string> = {
		auth: 'key rejected',
		quota: 'out of balance or quota',
		rate: 'too many requests',
		model: 'model not available',
		timeout: 'timed out',
		network: 'could not reach the server',
		server: `server error ${s}`,
		'bad-response': `HTTP ${s}`,
		'no-key': 'no API key',
		aborted: 'cancelled',
	};
	return new AiError(`${providerName}: ${head[kind]}${tail}`, kind, s, detail || undefined, providerName);
}

/** Split a server-sent-events stream into data payloads. Handles events cut across chunks. */
export async function* sseData(chunks: AsyncIterable<string>): AsyncGenerator<string> {
	let buf = '';
	for await (const chunk of chunks) {
		buf += chunk;
		let i: number;
		while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
			const event = buf.slice(0, i);
			buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
			const data = event
				.split(/\r?\n/)
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).replace(/^ /, ''))
				.join('\n');
			if (data) yield data;
		}
	}
	const tail = buf
		.split(/\r?\n/)
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).replace(/^ /, ''))
		.join('\n');
	if (tail) yield tail;
}

/** Split a newline-delimited JSON stream (Ollama) into lines. */
export async function* ndjsonLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
	let buf = '';
	for await (const chunk of chunks) {
		buf += chunk;
		let i: number;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (line) yield line;
		}
	}
	if (buf.trim()) yield buf.trim();
}

export type { HttpRequest };
