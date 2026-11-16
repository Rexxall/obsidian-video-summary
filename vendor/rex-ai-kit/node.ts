// Generated from rex-ai-kit 0.1.0. Do not edit here.
import { AiError, type StreamTransport } from './types';

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
	request(url: URL, options: { method: string; headers: Record<string, string | number> }, onResponse: (response: NodeResponse) => void): NodeRequest;
}

/**
 * Streaming through Node's http(s), desktop only: no CORS rules, so every provider streams.
 * A connection that sends nothing for `idleMs` is dropped as a timeout. Returns undefined
 * where Node is not available (mobile); pass the result straight to AiClient's `stream`.
 */
export function nodeStream(idleMs = 120_000): StreamTransport | undefined {
	const req = (window as unknown as { require?: (id: string) => unknown }).require;
	if (typeof req !== 'function') return undefined;
	let http: NodeHttp, https: NodeHttp;
	try {
		http = req('http') as NodeHttp;
		https = req('https') as NodeHttp;
	} catch {
		return undefined;
	}
	const transport: StreamTransport = (request) =>
		new Promise((resolve, reject) => {
			if (request.signal?.aborted) {
				reject(new AiError('Cancelled', 'aborted'));
				return;
			}
			const url = new URL(request.url);
			const body = request.body ?? '';
			const headers: Record<string, string | number> = { ...request.headers };
			if (request.method === 'POST') headers['Content-Length'] = new TextEncoder().encode(body).length;
			// Chunks arrive before anyone iterates; a queue holds them until then.
			const queue: string[] = [];
			let finished = false;
			let failure: Error | null = null;
			let wake: (() => void) | null = null;
			const poke = () => {
				const w = wake;
				wake = null;
				w?.();
			};
			const client = (url.protocol === 'http:' ? http : https).request(url, { method: request.method, headers }, (response) => {
				const status = response.statusCode || 0;
				response.setEncoding('utf8');
				response.on('data', (chunk) => {
					queue.push(chunk);
					poke();
				});
				response.on('end', () => {
					finished = true;
					poke();
				});
				response.on('error', (error) => {
					failure = error;
					poke();
				});
				const chunks = (async function* () {
					for (;;) {
						if (queue.length) {
							yield queue.shift()!;
							continue;
						}
						if (failure) throw failure;
						if (finished) return;
						await new Promise<void>((r) => (wake = r));
					}
				})();
				resolve({
					status,
					chunks,
					text: async () => {
						let all = '';
						for await (const c of chunks) all += c;
						return all;
					},
				});
			});
			const fail = (error: Error) => {
				failure = error;
				poke();
				reject(error);
			};
			client.on('error', fail);
			client.setTimeout(idleMs, () => client.destroy(new AiError(`No data for ${Math.round(idleMs / 1000)} s`, 'timeout')));
			request.signal?.addEventListener('abort', () => client.destroy(new AiError('Cancelled', 'aborted')), { once: true });
			if (body) client.write(body);
			client.end();
		});
	transport.anyOrigin = true;
	return transport;
}
