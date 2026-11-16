// Generated from rex-ai-kit 0.1.0. Do not edit here.
import { checkKey, fetchBalance } from './account';
import { resolveProvider } from './catalog';
import { complete } from './chat';
import { ModelCache, fetchModels } from './models';
import type { CliRunner } from './cli';
import type { Lang } from './i18n';
import type { AiSlot, Balance, CompleteOptions, CompleteResult, KeyCheck, ModelInfo, Provider, StreamTransport, Transport } from './types';

/** The two calls of Obsidian's SecretStorage the kit needs. app.secretStorage satisfies it. */
export interface KeyStore {
	getSecret(id: string): string | null;
	setSecret?(id: string, secret: string): void;
	listSecrets?(): string[];
}

/** Read the key for a slot when it is used. Never cache it in settings or memory beyond the call. */
export function readKey(store: KeyStore | undefined, provider: Provider): string | null {
	if (!provider.needsKey || !provider.secretName) return null;
	try {
		return store?.getSecret(provider.secretName)?.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Move an old plain-text key into the Keychain under the shared name without overwriting a key
 * another plugin saved there. Returns the name it ended up under.
 */
export function migrateKey(store: Required<Pick<KeyStore, 'getSecret' | 'setSecret'>>, sharedName: string, value: string, ownPrefix: string): string {
	const v = value.trim();
	const candidates = [sharedName, `${ownPrefix}-${sharedName}`, ...Array.from({ length: 20 }, (_, i) => `${ownPrefix}-${sharedName}-${i + 2}`)];
	const name = candidates.find((c) => {
		const existing = store.getSecret(c);
		return !existing || existing === v;
	})!;
	if (store.getSecret(name) !== v) store.setSecret(name, v);
	return name;
}

export interface AiClientOptions {
	keys?: KeyStore;
	transport: Transport;
	stream?: StreamTransport;
	/** Saved model lists; persist `client.cache.toJSON()` with the plugin data. */
	cache?: ModelCache;
	/** Runner for local agents; pass nodeCliRunner() on desktop, leave out on mobile. */
	cli?: CliRunner;
	/** Language for provider names in the settings and in error messages. Default English. */
	lang?: Lang;
}

/** What plugins hold: one object that knows the keys, the transport and the model cache. */
export class AiClient {
	readonly cache: ModelCache;
	constructor(private o: AiClientOptions) {
		this.cache = o.cache ?? new ModelCache();
	}

	provider(slot: AiSlot): Provider {
		return resolveProvider(slot, this.o.lang);
	}

	get lang(): Lang {
		return this.o.lang ?? 'en';
	}

	hasKey(slot: AiSlot): boolean {
		const p = this.provider(slot);
		if (p.localAgent) return true;
		return !p.needsKey || !!readKey(this.o.keys, p);
	}

	complete(slot: AiSlot, opts: Omit<CompleteOptions, 'model'> & { model?: string }): Promise<CompleteResult> {
		const p = this.provider(slot);
		return complete(p, readKey(this.o.keys, p), { ...opts, model: opts.model ?? slot.model }, { transport: this.o.transport, stream: this.o.stream, cli: this.o.cli, cliPath: slot.baseUrl });
	}

	/** Cached list unless stale or forced. Only call from settings UI or a user action. */
	async models(slot: AiSlot, force = false, signal?: AbortSignal): Promise<ModelInfo[]> {
		const p = this.provider(slot);
		if (!force && this.cache.fresh(p)) return this.cache.get(p)!;
		const list = await fetchModels(p, readKey(this.o.keys, p), this.o.transport, signal);
		this.cache.set(p, list);
		return list;
	}

	/** True when this client can run local agents (desktop with a runner). */
	get canRunLocal(): boolean {
		return !!this.o.cli;
	}

	async check(slot: AiSlot, signal?: AbortSignal): Promise<KeyCheck> {
		const p = this.provider(slot);
		if (p.localAgent) {
			const exe = await this.o.cli?.find(p.localAgent, slot.baseUrl);
			return exe ? { status: 'ok', detail: exe } : { status: 'missing', detail: 'not found' };
		}
		const r = await checkKey(p, readKey(this.o.keys, p), this.o.transport, signal);
		if (r.status === 'ok' && r.models?.length) this.cache.set(p, r.models);
		return r;
	}

	balance(slot: AiSlot, signal?: AbortSignal): Promise<Balance | null> {
		const p = this.provider(slot);
		return fetchBalance(p, readKey(this.o.keys, p), this.o.transport, signal);
	}
}
