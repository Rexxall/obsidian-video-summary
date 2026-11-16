// Generated from rex-ai-kit 0.1.0. Do not edit here.
/**
 * Local agents: run the Claude Code or Codex CLI the user installed and signed in to.
 *
 * Rules (from the shared plan, decided 2026-11-12), enforced here:
 * 1. Run the user's own unmodified program; never bundle or download it.
 * 2. Never read, store or forward login data (~/.claude, ~/.codex are not touched).
 * 3. One request at a time, started by the user; no batches.
 * 4. The UI says "Claude Code on this computer", never "free with your subscription".
 *
 * Desktop only. Node modules are loaded lazily so the kit still loads on mobile.
 */
import { at, num, str } from './json';
import { AiError, type CompleteOptions, type CompleteResult, type Provider, type Usage } from './types';

export interface CliSpec {
	command: string;
	/** `{tmp}` is replaced with the system temp folder by the runner. */
	args: string[];
	stdin: string;
	/** Small files the runner writes into the temp folder before starting. */
	files?: { name: string; content: string }[];
}

/**
 * A short system prompt replaces each agent's long built-in one. Measured 2026-11-15:
 * Claude Code drops from ~3,900 to ~880 input tokens per call; Codex from ~28k to ~25k.
 */
export const DEFAULT_AGENT_SYSTEM = 'Do what the user asks and reply with the answer only. Do not use tools.';

/** Turn a request into the command line and stdin. Exported for tests. */
export function cliSpec(provider: Provider, o: CompleteOptions, exe: string): CliSpec {
	const turns = o.messages.map((m) => {
		if (typeof m.content !== 'string' && m.content.some((p) => p.type === 'image'))
			throw new AiError(`${provider.name}: images are not supported here. Pick an API provider for image input.`, 'bad-response', undefined, 'images', provider.name);
		const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
		return o.messages.length > 1 ? `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}` : text;
	});
	const json = o.json ? '\n\nReply with a single JSON object and nothing else.' : '';
	if (provider.localAgent === 'claude') {
		const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--no-session-persistence', '--setting-sources', 'project'];
		if (o.model) args.push('--model', o.model);
		args.push('--system-prompt', o.system || DEFAULT_AGENT_SYSTEM);
		return { command: exe, args, stdin: turns.join('\n\n') + json };
	}
	const file = 'rex-ai-kit-codex-instructions.md';
	const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-c', `model_instructions_file={tmp}/${file}`];
	if (o.model) args.push('-m', o.model);
	args.push('-');
	return { command: exe, args, stdin: turns.join('\n\n') + json, files: [{ name: file, content: o.system || DEFAULT_AGENT_SYSTEM }] };
}

/** Fold one JSON line of CLI output into the result; returns new text, if any. Exported for tests. */
export function applyCliLine(provider: Provider, ev: unknown, acc: { text: string; usage: Usage; stop?: string; error?: string; streamed: boolean }): string {
	const type = at(ev, 'type');
	if (provider.localAgent === 'claude') {
		if (type === 'stream_event' && at(ev, 'event', 'type') === 'content_block_delta' && at(ev, 'event', 'delta', 'type') === 'text_delta') {
			acc.streamed = true;
			return str(at(ev, 'event', 'delta', 'text')) ?? '';
		}
		if (type === 'result') {
			const u = (k: string) => num(at(ev, 'usage', k));
			acc.usage = { inputTokens: (u('input_tokens') ?? 0) + (u('cache_creation_input_tokens') ?? 0) + (u('cache_read_input_tokens') ?? 0), outputTokens: u('output_tokens'), cachedTokens: u('cache_read_input_tokens') };
			const isError = !!at(ev, 'is_error');
			const result = at(ev, 'result');
			acc.stop = isError ? 'error' : 'stop';
			if (isError) acc.error = str(result) ?? str(at(ev, 'subtype')) ?? 'error';
			// Without partial messages, the whole reply only arrives here.
			if (!acc.streamed && typeof result === 'string' && !isError) return result;
		}
		return '';
	}
	if (type === 'item.completed' && at(ev, 'item', 'type') === 'agent_message') return (acc.text ? '\n\n' : '') + (str(at(ev, 'item', 'text')) ?? '');
	if (type === 'turn.completed') {
		acc.usage = { inputTokens: num(at(ev, 'usage', 'input_tokens')), outputTokens: num(at(ev, 'usage', 'output_tokens')), cachedTokens: num(at(ev, 'usage', 'cached_input_tokens')) };
		acc.stop = 'stop';
	}
	if (type === 'turn.failed' || type === 'error') acc.error = str(at(ev, 'error', 'message')) ?? str(at(ev, 'message')) ?? 'failed';
	return '';
}

/** What actually starts a process. Injected so tests never spawn anything. */
export interface CliRunner {
	/** Path of the program, or null when it is not installed where we look. */
	find(agent: 'claude' | 'codex', override?: string): Promise<string | null>;
	run(spec: CliSpec, onLine: (line: string) => void, signal?: AbortSignal): Promise<{ code: number; stderr: string }>;
}

let busy = false;

export async function completeCli(provider: Provider, o: CompleteOptions, runner: CliRunner | undefined, exeOverride?: string): Promise<CompleteResult> {
	if (!runner) throw new AiError(`${provider.name} only works in Obsidian on a computer.`, 'bad-response', undefined, 'desktop-only', provider.name);
	const exe = await runner.find(provider.localAgent!, exeOverride);
	if (!exe) throw new AiError(`${provider.name}: not found on this computer. Install it and sign in once in a terminal, or set its path under Advanced.`, 'no-key', undefined, undefined, provider.name);
	if (busy) throw new AiError(`${provider.name}: another request is still running. Local agents run one request at a time.`, 'rate', undefined, 'busy', provider.name);
	busy = true;
	const acc = { text: '', usage: {} as Usage, stop: undefined as string | undefined, error: undefined as string | undefined, streamed: false };
	try {
		const spec = cliSpec(provider, o, exe);
		const { code, stderr } = await runner.run(
			spec,
			(line) => {
				let ev: unknown;
				try {
					ev = JSON.parse(line);
				} catch {
					return; // not a JSON line
				}
				const piece = applyCliLine(provider, ev, acc);
				if (piece) {
					acc.text += piece;
					o.onText?.(piece);
				}
			},
			o.signal,
		);
		if (o.signal?.aborted) throw new AiError('Cancelled', 'aborted');
		if (acc.error) throw new AiError(`${provider.name}: ${acc.error.slice(0, 300)}`, /log ?in|auth|sign/i.test(acc.error) ? 'auth' : 'server', undefined, acc.error.slice(0, 300), provider.name);
		if (code !== 0 && !acc.text) {
			const msg = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
			throw new AiError(`${provider.name}: exited with code ${code}${msg ? ` (${msg})` : ''}`, /log ?in|auth|sign/i.test(msg) ? 'auth' : 'server', undefined, msg || undefined, provider.name);
		}
		return { text: acc.text, usage: acc.usage, stop: acc.stop ?? 'stop' };
	} finally {
		busy = false;
	}
}

/**
 * Real runner over child_process. Obsidian started from the Dock has a short PATH, so common
 * install folders are searched too. Runs in the system temp folder so no vault files or
 * project instructions are picked up.
 */
export function nodeCliRunner(timeoutMs = 5 * 60 * 1000): CliRunner | undefined {
	const req = (window as unknown as { require?: (id: string) => unknown }).require;
	if (typeof req !== 'function') return undefined;
	let cp: NodeChildProcess, fs: NodeFs, os: NodeOs, path: NodePath, proc: { env: Record<string, string | undefined> };
	try {
		cp = req('child_process') as NodeChildProcess;
		fs = req('fs') as NodeFs;
		os = req('os') as NodeOs;
		path = req('path') as NodePath;
		proc = req('process') as typeof proc;
	} catch {
		return undefined;
	}
	const home = os.homedir();
	const dirs = [
		...String(proc.env.PATH ?? '').split(path.delimiter),
		path.join(home, '.local/bin'),
		path.join(home, '.claude/local'),
		path.join(home, '.npm-global/bin'),
		path.join(home, '.bun/bin'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
		path.join(home, 'AppData/Roaming/npm'),
	].filter(Boolean);
	const env = { ...proc.env, PATH: Array.from(new Set(dirs)).join(path.delimiter) };
	return {
		find(agent, override) {
			const candidates = override?.trim() ? [override.trim()] : dirs.flatMap((d) => [path.join(d, agent), path.join(d, `${agent}.cmd`), path.join(d, `${agent}.exe`)]);
			for (const c of candidates) {
				try {
					fs.accessSync(c, fs.constants.X_OK);
					return Promise.resolve(c);
				} catch {
					// Not here; try the next folder.
				}
			}
			return Promise.resolve(null);
		},
		run(spec, onLine, signal) {
			const tmp = os.tmpdir();
			for (const f of spec.files ?? []) fs.writeFileSync(path.join(tmp, f.name), f.content);
			const args = spec.args.map((a) => a.split('{tmp}').join(tmp));
			return new Promise((resolve, reject) => {
				const child = cp.spawn(spec.command, args, { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
				let buf = '';
				let stderr = '';
				const kill = () => child.kill('SIGTERM');
				const timer = window.setTimeout(kill, timeoutMs);
				signal?.addEventListener('abort', kill, { once: true });
				child.stdout.setEncoding('utf8');
				child.stdout.on('data', (d: unknown) => {
					buf += String(d);
					let i: number;
					while ((i = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, i).trim();
						buf = buf.slice(i + 1);
						if (line) onLine(line);
					}
				});
				child.stderr.on('data', (d: unknown) => {
					stderr = (stderr + String(d)).slice(-4000);
				});
				child.on('error', (e: unknown) => {
					window.clearTimeout(timer);
					reject(new AiError(`Could not start ${path.basename(spec.command)}: ${e instanceof Error ? e.message : String(e)}`, 'network'));
				});
				child.on('close', (code: unknown) => {
					window.clearTimeout(timer);
					signal?.removeEventListener('abort', kill);
					if (buf.trim()) onLine(buf.trim());
					resolve({ code: typeof code === 'number' ? code : -1, stderr });
				});
				child.stdin.end(spec.stdin);
			});
		},
	};
}

/** The few Node APIs the runner touches, typed here so the kit needs no Node typings. */
interface NodeStream {
	setEncoding(enc: string): void;
	on(event: string, fn: (arg: unknown) => void): void;
}
interface NodeChild {
	stdout: NodeStream;
	stderr: NodeStream;
	stdin: { end(data: string): void };
	kill(signal: string): void;
	on(event: string, fn: (arg: unknown) => void): void;
}
interface NodeChildProcess {
	spawn(cmd: string, args: string[], opts: Record<string, unknown>): NodeChild;
}
interface NodeFs {
	accessSync(path: string, mode: number): void;
	writeFileSync(path: string, data: string): void;
	constants: { X_OK: number };
}
interface NodeOs {
	homedir(): string;
	tmpdir(): string;
}
interface NodePath {
	join(...parts: string[]): string;
	basename(p: string): string;
	delimiter: string;
}
