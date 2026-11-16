// Generated from rex-ai-kit 0.1.0. Do not edit here.
import { authHeaders } from './chat';
import { toError } from './http';
import { at, isoSeconds, list, num, str } from './json';
import { AiError, type ModelInfo, type ModelPick, type Provider, type Scene, type Transport } from './types';

/** Models that are not for chat: embeddings, speech, images, moderation. */
const NOT_CHAT = /(embed|whisper|tts|transcribe|dall-e|gpt-image|imagen|moderation|audio|realtime|search-preview|davinci|babbage|rerank|veo|aqa)/i;

/** Turn each provider's /models reply into one list. Exported for tests. */
export function normaliseModels(provider: Provider, json: unknown): ModelInfo[] {
	let out: ModelInfo[] = [];
	switch (provider.protocol) {
		case 'gemini':
			out = list(at(json, 'models'))
				.filter((m) => list(at(m, 'supportedGenerationMethods')).includes('generateContent'))
				.map((m) => ({ id: (str(at(m, 'name')) ?? '').replace(/^models\//, ''), label: str(at(m, 'displayName')) }));
			break;
		case 'ollama':
			out = list(at(json, 'models')).map((m) => ({ id: str(at(m, 'name')) ?? str(at(m, 'model')) ?? '', created: isoSeconds(at(m, 'modified_at')) }));
			break;
		case 'anthropic':
			out = list(at(json, 'data')).map((m) => {
				const vision = at(m, 'capabilities', 'image_input');
				return {
					id: str(at(m, 'id')) ?? '',
					label: str(at(m, 'display_name')),
					created: isoSeconds(at(m, 'created_at')),
					vision: typeof vision === 'boolean' ? vision : undefined,
				};
			});
			break;
		default:
			out = list(at(json, 'data')).map((m) => {
				const input = list(at(m, 'architecture', 'input_modalities'));
				return {
					id: str(at(m, 'id')) ?? '',
					label: str(at(m, 'name')),
					created: num(at(m, 'created')),
					vision: Array.isArray(at(m, 'architecture', 'input_modalities')) ? input.includes('image') : undefined,
				};
			});
	}
	const seen = new Set<string>();
	return out
		.filter((m) => m.id && !NOT_CHAT.test(m.id) && !seen.has(m.id) && seen.add(m.id))
		.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
}

/** Fetch the live model list. Anthropic pages at 1000; one page is plenty. */
export async function fetchModels(provider: Provider, key: string | null, transport: Transport, signal?: AbortSignal): Promise<ModelInfo[]> {
	if (!provider.modelsPath) return provider.picks.map((p) => ({ id: p.id }));
	if (provider.needsKey && !key) throw new AiError(`${provider.name}: no API key`, 'no-key', undefined, undefined, provider.name);
	const sep = provider.modelsPath.includes('?') ? '&' : '?';
	const url = `${provider.baseUrl}${provider.modelsPath}${provider.protocol === 'anthropic' ? `${sep}limit=1000` : provider.protocol === 'gemini' ? `${sep}pageSize=1000` : ''}`;
	const res = await transport({ url, method: 'GET', headers: authHeaders(provider, key), signal });
	if (res.status < 200 || res.status >= 300) throw toError(res, provider.name);
	return normaliseModels(provider, res.json);
}

export interface PickerRow {
	id: string;
	/** Recommended for this scene, shown in the top group. */
	pick?: ModelPick;
}

/** Recommended picks first (scene order puts the plugin's preferred scene on top), then the rest of the live list. */
export function pickerRows(provider: Provider, live: ModelInfo[] | undefined, prefer: Scene = 'balanced'): PickerRow[] {
	const order: Scene[] = [prefer, ...(['cheap', 'balanced', 'strong'] as Scene[]).filter((s) => s !== prefer)];
	const picks = [...provider.picks].sort((a, b) => order.indexOf(a.scene) - order.indexOf(b.scene));
	const ids = new Set(picks.map((p) => p.id));
	return [...picks.map((pick) => ({ id: pick.id, pick })), ...(live ?? []).filter((m) => !ids.has(m.id)).map((m) => ({ id: m.id }))];
}

/** Default model for a provider and scene: the matching pick, else any pick, else the newest live model. */
export function defaultModel(provider: Provider, prefer: Scene = 'balanced', live?: ModelInfo[]): string {
	return provider.picks.find((p) => p.scene === prefer)?.id ?? provider.picks[0]?.id ?? live?.[0]?.id ?? '';
}

interface CacheEntry {
	at: number;
	models: ModelInfo[];
}

/** What `ModelCache.toJSON()` returns; store it in plugin data as is. */
export type ModelCacheData = Record<string, CacheEntry>;

/**
 * Model lists cached per provider + base URL, kept in plugin data so opening settings is instant.
 * Plugins persist `toJSON()` and pass it back to the constructor.
 */
export class ModelCache {
	private map: Record<string, CacheEntry>;
	constructor(
		saved?: ModelCacheData | null,
		private ttlMs = 24 * 60 * 60 * 1000,
		private now: () => number = Date.now,
	) {
		this.map = { ...(saved ?? {}) };
	}
	private k(p: Provider) {
		return `${p.id}|${p.baseUrl}`;
	}
	get(p: Provider): ModelInfo[] | undefined {
		return this.map[this.k(p)]?.models;
	}
	fresh(p: Provider): boolean {
		const e = this.map[this.k(p)];
		return !!e && this.now() - e.at < this.ttlMs;
	}
	/** Milliseconds since the list was fetched, or null when there is none. */
	age(p: Provider): number | null {
		const e = this.map[this.k(p)];
		return e ? this.now() - e.at : null;
	}
	set(p: Provider, models: ModelInfo[]): void {
		this.map[this.k(p)] = { at: this.now(), models };
	}
	toJSON(): ModelCacheData {
		return this.map;
	}
}
