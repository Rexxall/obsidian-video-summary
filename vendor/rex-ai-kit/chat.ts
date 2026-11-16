// Generated from rex-ai-kit 0.1.0. Do not edit here.
import { completeCli, type CliRunner } from './cli';
import { ndjsonLines, redact, sseData, toError } from './http';
import { at, list, num, str } from './json';
import {
	AiError,
	type ChatMessage,
	type CompleteOptions,
	type CompleteResult,
	type ContentPart,
	type HttpRequest,
	type Provider,
	type StreamTransport,
	type Transport,
	type Usage,
} from './types';

const DEFAULT_MAX_TOKENS = 4096;
export const ANTHROPIC_VERSION = '2023-06-01';

const parts = (c: ChatMessage['content']): ContentPart[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
const textOf = (c: ChatMessage['content']): string =>
	parts(c)
		.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
		.map((p) => p.text)
		.join('\n');

/** Headers that carry the key, per protocol. */
export function authHeaders(provider: Provider, key: string | null): Record<string, string> {
	if (!key) return {};
	switch (provider.protocol) {
		case 'anthropic':
			return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' };
		case 'gemini':
			return { 'x-goog-api-key': key };
		default:
			return { Authorization: `Bearer ${key}` };
	}
}

/** Build the HTTP request for one completion. Exported for tests. */
export function buildRequest(provider: Provider, key: string | null, o: CompleteOptions, stream: boolean): HttpRequest {
	const headers = { 'Content-Type': 'application/json', ...authHeaders(provider, key) };
	const maxTokens = o.maxTokens ?? DEFAULT_MAX_TOKENS;
	const base = provider.baseUrl;
	switch (provider.protocol) {
		case 'anthropic': {
			const body: Record<string, unknown> = {
				model: o.model,
				max_tokens: maxTokens,
				messages: o.messages.map((m) => ({
					role: m.role,
					content: parts(m.content).map((p) =>
						p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } },
					),
				})),
			};
			const system = [o.system, o.json ? 'Reply with a single JSON object and nothing else.' : ''].filter(Boolean).join('\n\n');
			// Long system prompts are cached (reads cost a tenth). Short ones stay plain: a cache write costs 1.25x and needs ~1k tokens to count.
			if (system) body.system = system.length >= 4000 ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
			if (o.temperature !== undefined) body.temperature = o.temperature;
			if (stream) body.stream = true;
			return { url: `${base}/messages`, method: 'POST', headers, body: JSON.stringify(body), signal: o.signal };
		}
		case 'gemini': {
			const gen: Record<string, unknown> = { maxOutputTokens: maxTokens };
			if (o.temperature !== undefined) gen.temperature = o.temperature;
			if (o.json) gen.responseMimeType = 'application/json';
			const body: Record<string, unknown> = {
				contents: o.messages.map((m) => ({
					role: m.role === 'assistant' ? 'model' : 'user',
					parts: parts(m.content).map((p) => (p.type === 'text' ? { text: p.text } : { inline_data: { mime_type: p.mime, data: p.data } })),
				})),
				generationConfig: gen,
			};
			if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
			const model = o.model.replace(/^models\//, '');
			const url = stream
				? `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
				: `${base}/models/${encodeURIComponent(model)}:generateContent`;
			return { url, method: 'POST', headers, body: JSON.stringify(body), signal: o.signal };
		}
		case 'ollama': {
			const messages: Record<string, unknown>[] = [];
			if (o.system) messages.push({ role: 'system', content: o.system });
			for (const m of o.messages) {
				const imgs = parts(m.content).filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image');
				messages.push({ role: m.role, content: textOf(m.content), ...(imgs.length ? { images: imgs.map((i) => i.data) } : {}) });
			}
			const options: Record<string, unknown> = { num_predict: maxTokens };
			if (o.temperature !== undefined) options.temperature = o.temperature;
			const body: Record<string, unknown> = { model: o.model, messages, stream, options };
			if (o.json) body.format = 'json';
			return { url: `${base}/api/chat`, method: 'POST', headers, body: JSON.stringify(body), signal: o.signal };
		}
		default: {
			const messages: Record<string, unknown>[] = [];
			if (o.system) messages.push({ role: provider.id === 'openai' ? 'developer' : 'system', content: o.system });
			for (const m of o.messages) {
				if (typeof m.content === 'string') messages.push({ role: m.role, content: m.content });
				else
					messages.push({
						role: m.role,
						content: m.content.map((p) =>
							p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } },
						),
					});
			}
			const body: Record<string, unknown> = { model: o.model, messages };
			// OpenAI's current models take max_completion_tokens; most compatible servers still read max_tokens.
			body[provider.id === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
			if (o.temperature !== undefined) body.temperature = o.temperature;
			if (o.json) body.response_format = { type: 'json_object' };
			if (stream) {
				body.stream = true;
				body.stream_options = { include_usage: true };
			}
			return { url: `${base}/chat/completions`, method: 'POST', headers, body: JSON.stringify(body), signal: o.signal };
		}
	}
}

const STOP: Record<string, string> = {
	stop: 'stop',
	end_turn: 'stop',
	stop_sequence: 'stop',
	STOP: 'stop',
	length: 'length',
	max_tokens: 'length',
	MAX_TOKENS: 'length',
	content_filter: 'filter',
	SAFETY: 'filter',
	refusal: 'filter',
};
const stopOf = (raw: unknown) => (typeof raw === 'string' ? STOP[raw] ?? raw : undefined);

/** Read a non-streamed reply. Exported for tests. */
export function parseResponse(provider: Provider, json: unknown): CompleteResult {
	switch (provider.protocol) {
		case 'anthropic': {
			const text = list(at(json, 'content'))
				.filter((b) => at(b, 'type') === 'text')
				.map((b) => str(at(b, 'text')) ?? '')
				.join('');
			return {
				text,
				stop: stopOf(at(json, 'stop_reason')),
				usage: { inputTokens: num(at(json, 'usage', 'input_tokens')), outputTokens: num(at(json, 'usage', 'output_tokens')), cachedTokens: num(at(json, 'usage', 'cache_read_input_tokens')) },
			};
		}
		case 'gemini': {
			const cand = at(json, 'candidates', 0);
			const text = list(at(cand, 'content', 'parts'))
				.filter((p) => typeof at(p, 'text') === 'string' && !at(p, 'thought'))
				.map((p) => str(at(p, 'text')) ?? '')
				.join('');
			return {
				text,
				stop: stopOf(at(cand, 'finishReason') ?? at(json, 'promptFeedback', 'blockReason')),
				usage: {
					inputTokens: num(at(json, 'usageMetadata', 'promptTokenCount')),
					outputTokens: num(at(json, 'usageMetadata', 'candidatesTokenCount')),
					cachedTokens: num(at(json, 'usageMetadata', 'cachedContentTokenCount')),
				},
			};
		}
		case 'ollama':
			return { text: str(at(json, 'message', 'content')) ?? '', stop: stopOf(at(json, 'done_reason')), usage: { inputTokens: num(at(json, 'prompt_eval_count')), outputTokens: num(at(json, 'eval_count')) } };
		default: {
			const choice = at(json, 'choices', 0);
			const content = at(choice, 'message', 'content');
			const text = typeof content === 'string' ? content : list(content).map((c) => str(at(c, 'text')) ?? '').join('');
			return {
				text,
				stop: stopOf(at(choice, 'finish_reason')),
				usage: {
					inputTokens: num(at(json, 'usage', 'prompt_tokens')),
					outputTokens: num(at(json, 'usage', 'completion_tokens')),
					cachedTokens: num(at(json, 'usage', 'prompt_tokens_details', 'cached_tokens')) ?? num(at(json, 'usage', 'prompt_cache_hit_tokens')),
				},
			};
		}
	}
}

/** Fold one streamed event into the running result; returns the new text piece, if any. */
function applyStreamEvent(provider: Provider, ev: unknown, acc: { usage: Usage; stop?: string }): string {
	const type = at(ev, 'type');
	switch (provider.protocol) {
		case 'anthropic':
			if (type === 'message_start') acc.usage.inputTokens = num(at(ev, 'message', 'usage', 'input_tokens'));
			if (type === 'message_delta') {
				acc.usage.outputTokens = num(at(ev, 'usage', 'output_tokens'));
				acc.stop = stopOf(at(ev, 'delta', 'stop_reason')) ?? acc.stop;
			}
			if (type === 'error') {
				const msg = str(at(ev, 'error', 'message')) ?? 'stream error';
				throw new AiError(`${provider.name}: ${msg}`, 'server', undefined, msg, provider.name);
			}
			return type === 'content_block_delta' && at(ev, 'delta', 'type') === 'text_delta' ? str(at(ev, 'delta', 'text')) ?? '' : '';
		case 'gemini': {
			const r = parseResponse(provider, ev);
			if (r.usage?.inputTokens !== undefined) acc.usage = r.usage;
			acc.stop = r.stop ?? acc.stop;
			return r.text;
		}
		case 'ollama':
			if (at(ev, 'done')) {
				acc.usage = { inputTokens: num(at(ev, 'prompt_eval_count')), outputTokens: num(at(ev, 'eval_count')) };
				acc.stop = stopOf(at(ev, 'done_reason'));
			}
			return str(at(ev, 'message', 'content')) ?? '';
		default: {
			if (at(ev, 'usage')) acc.usage = { inputTokens: num(at(ev, 'usage', 'prompt_tokens')), outputTokens: num(at(ev, 'usage', 'completion_tokens')) };
			const c = at(ev, 'choices', 0);
			const fin = at(c, 'finish_reason');
			if (fin) acc.stop = stopOf(fin);
			return str(at(c, 'delta', 'content')) ?? '';
		}
	}
}

export interface CompleteDeps {
	transport: Transport;
	/** Streaming transport; when absent, or the provider lacks CORS and the transport is not anyOrigin, replies come back in one piece. */
	stream?: StreamTransport;
	/** Runs local agents (Claude Code, Codex). Desktop only. */
	cli?: CliRunner;
	/** Path override for the local agent program. */
	cliPath?: string;
}

/** One completion against any provider. The caller passes the key; nothing here touches storage. */
export async function complete(provider: Provider, key: string | null, o: CompleteOptions, deps: CompleteDeps): Promise<CompleteResult> {
	if (!o.timeoutMs) return completeOnce(provider, key, o, deps);
	const ctl = new AbortController();
	let timedOut = false;
	const onAbort = () => ctl.abort();
	if (o.signal?.aborted) ctl.abort();
	o.signal?.addEventListener('abort', onAbort, { once: true });
	const timer = window.setTimeout(() => {
		timedOut = true;
		ctl.abort();
	}, o.timeoutMs);
	try {
		return await completeOnce(provider, key, { ...o, signal: ctl.signal }, deps);
	} catch (e) {
		if (timedOut) throw new AiError(`${provider.name}: no reply after ${Math.round(o.timeoutMs / 1000)} s`, 'timeout', undefined, undefined, provider.name);
		throw e;
	} finally {
		window.clearTimeout(timer);
		o.signal?.removeEventListener('abort', onAbort);
	}
}

async function completeOnce(provider: Provider, key: string | null, o: CompleteOptions, deps: CompleteDeps): Promise<CompleteResult> {
	if (provider.protocol === 'cli') return completeCli(provider, o, deps.cli, deps.cliPath);
	if (provider.needsKey && !key) throw new AiError(`${provider.name}: no API key. Add one in Settings → Keychain.`, 'no-key', undefined, undefined, provider.name);
	if (!provider.baseUrl) throw new AiError(`${provider.name}: no server address set`, 'bad-response');
	const canStream = !!(o.onText && deps.stream && (provider.cors || deps.stream.anyOrigin));
	if (!canStream) {
		const res = await deps.transport(buildRequest(provider, key, o, false)).catch((e) => {
			throw e instanceof AiError ? e : wrapNetwork(e, provider, o.signal);
		});
		if (res.status < 200 || res.status >= 300) throw toError(res, provider.name);
		const out = parseResponse(provider, res.json);
		if (o.onText && out.text) o.onText(out.text);
		return out;
	}
	const res = await deps.stream!(buildRequest(provider, key, o, true)).catch((e) => {
		throw wrapNetwork(e, provider, o.signal);
	});
	if (res.status < 200 || res.status >= 300) {
		const text = res.text ? await res.text().catch(() => '') : '';
		let json: unknown = null;
		try {
			json = JSON.parse(text);
		} catch {
			json = null;
		}
		throw toError({ status: res.status, text, json }, provider.name);
	}
	const acc: { usage: Usage; stop?: string } = { usage: {} };
	let text = '';
	const events = provider.protocol === 'ollama' ? ndjsonLines(res.chunks) : sseData(res.chunks);
	try {
		for await (const data of events) {
			if (data === '[DONE]') break;
			let ev: unknown;
			try {
				ev = JSON.parse(data);
			} catch {
				continue;
			}
			const piece = applyStreamEvent(provider, ev, acc);
			if (piece) {
				text += piece;
				o.onText!(piece);
			}
		}
	} catch (e) {
		throw e instanceof AiError ? e : wrapNetwork(e, provider, o.signal);
	}
	return { text, usage: acc.usage, stop: acc.stop };
}

function wrapNetwork(e: unknown, provider: Provider, signal?: AbortSignal): AiError {
	if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) return new AiError('Cancelled', 'aborted');
	const msg = e instanceof Error ? e.message : String(e);
	return new AiError(`${provider.name}: could not reach the server (${redact(msg)})`, 'network', undefined, redact(msg), provider.name);
}
