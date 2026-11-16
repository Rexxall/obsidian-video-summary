/**
 * The summary model and the speech key chosen in settings. One place for every part of the
 * plugin that needs them: the managed backend, and the light tier that calls a model directly.
 *
 * The summary model is a rex-ai-kit slot (provider, model, Keychain name). Settings hold the
 * *name* of a secret in Obsidian's Keychain, never the key itself.
 */
import type { App } from 'obsidian';
import {
  defaultModel,
  getProvider,
  readKey,
  resolveProvider,
  slotFromEndpoint,
  type AiSlot,
  type KeyStore,
  type Provider,
} from '../vendor/rex-ai-kit/index';

/** What a new install uses when no key is in the Keychain yet. */
export const DEFAULT_AI_SLOT: AiSlot = { provider: 'anthropic', model: 'claude-sonnet-5-5' };

/**
 * A new install takes the first of these whose key another plugin already put in the
 * Keychain, so someone who set up one plugin fills in nothing here. Only names are read.
 */
const FIRST_KEYED = ['anthropic', 'openai', 'gemini', 'deepseek'];

/** The balanced pick of a provider, or the default slot's model for Anthropic. */
function balancedModel(provider: string): string {
  const p = getProvider(provider);
  return p ? defaultModel(p, 'balanced') : '';
}

export function firstKeyedSlot(keys: KeyStore | undefined): AiSlot {
  const listed = new Set(safeList(keys));
  for (const id of FIRST_KEYED) {
    const p = getProvider(id);
    if (!p) continue;
    if (listed.has(p.secretName) || !!readKey(keys, p)) {
      return {
        provider: id,
        model: id === 'anthropic' ? DEFAULT_AI_SLOT.model : balancedModel(id),
      };
    }
  }
  return { ...DEFAULT_AI_SLOT };
}

function safeList(keys: KeyStore | undefined): string[] {
  try {
    return keys?.listSecrets?.() ?? [];
  } catch {
    return [];
  }
}

/** Addresses of the providers 2.13 offered, for turning its settings into a slot. */
const OLD_BASES: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  siliconflow: 'https://api.siliconflow.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  kimi: 'https://api.moonshot.cn/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

/**
 * The slot for settings saved before 2.14 (llmProvider, llmModel, llmBaseUrl, llmKeySecret).
 * The Keychain name chosen then keeps working. Settings never touched (the old default with
 * no key) count as a new install. Returns null when the settings already have a slot.
 */
export function migrateAiSlot(
  stored: Record<string, unknown>,
  keys: KeyStore | undefined,
): AiSlot | null {
  const ai = stored.ai as Partial<AiSlot> | undefined;
  if (ai && typeof ai.provider === 'string' && ai.provider) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const oldProvider = text(stored.llmProvider) || 'deepseek';
  const oldModel = text(stored.llmModel);
  const oldKey = text(stored.llmKeySecret);
  if (!oldKey && !oldModel && oldProvider === 'deepseek') return firstKeyedSlot(keys);
  const slot = slotFromEndpoint({
    url: oldProvider === 'custom' ? text(stored.llmBaseUrl) : OLD_BASES[oldProvider] || '',
    provider: oldProvider === 'custom' ? undefined : oldProvider,
    model: oldModel,
    secretName: oldKey,
  });
  if (!slot.model) slot.model = balancedModel(slot.provider);
  return slot;
}

/** The fields 2.13 kept for the summary model; removed from settings once migrated. */
export const LEGACY_LLM_FIELDS = ['llmProvider', 'llmModel', 'llmBaseUrl', 'llmKeySecret'];

/**
 * Where the backend reaches this provider with the OpenAI chat format it speaks, or '' when it
 * cannot (Claude Code and Codex run on this computer, not in the backend).
 */
export function openAiCompatibleBase(provider: Provider): string {
  switch (provider.protocol) {
    case 'openai':
    case 'anthropic':
      return provider.baseUrl;
    case 'gemini':
      return provider.baseUrl ? `${provider.baseUrl}/openai` : '';
    case 'ollama':
      return provider.baseUrl ? `${provider.baseUrl}/v1` : '';
    default:
      return '';
  }
}

export const SPEECH_DEFAULTS = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'FunAudioLLM/SenseVoiceSmall',
  keyUrl: 'https://cloud.siliconflow.cn/account/ak',
};

/** The settings fields this module reads. */
export interface ModelSettingsFields {
  ai: AiSlot;
  speechKeySecret: string;
  speechBaseUrl: string;
  speechModel: string;
}

export function resolveSpeech(
  settings: Pick<ModelSettingsFields, 'speechBaseUrl' | 'speechModel'>,
): {
  baseUrl: string;
  model: string;
} {
  return {
    baseUrl: ((settings.speechBaseUrl || '').trim() || SPEECH_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: (settings.speechModel || '').trim() || SPEECH_DEFAULTS.model,
  };
}

/** Obsidian 1.11.4 added secret storage; older versions have none. */
export function hasSecretStorage(app: App): boolean {
  return (
    typeof (app as { secretStorage?: { getSecret?: unknown } }).secretStorage?.getSecret ===
    'function'
  );
}

/** The key stored under `name`, or null when the name is empty, unknown, or there is no secret storage. */
export function readSecret(app: App, name: string): string | null {
  const id = (name || '').trim();
  if (!id || !hasSecretStorage(app)) return null;
  try {
    return app.secretStorage.getSecret(id)?.trim() || null;
  } catch {
    return null;
  }
}

/** What the managed backend is given: only non-empty values, so an unset key leaves .env in charge. */
export interface BackendModelConfig {
  chat: { base?: string; model?: string; key?: string };
  speech: { base?: string; model?: string; key?: string };
}

export function backendModelConfig(app: App, settings: ModelSettingsFields): BackendModelConfig {
  const provider = resolveProvider(settings.ai);
  const keys = hasSecretStorage(app) ? app.secretStorage : undefined;
  const chatKey = readKey(keys, provider);
  const chatBase = openAiCompatibleBase(provider);
  const speechKey = readSecret(app, settings.speechKeySecret);
  const config: BackendModelConfig = { chat: {}, speech: {} };
  // Model and address follow the key: without a key chosen here, the backend keeps its own.
  if (chatKey && chatBase) {
    config.chat = { key: chatKey, base: chatBase };
    if (settings.ai.model) config.chat.model = settings.ai.model;
  }
  if (speechKey) {
    const speech = resolveSpeech(settings);
    config.speech = { key: speechKey, base: speech.baseUrl, model: speech.model };
  }
  return config;
}

/**
 * Changes whenever the model, the address or a key changes, without containing a key:
 * the plugin compares it with the last one it applied to know whether the backend is current.
 */
export async function modelConfigFingerprint(config: BackendModelConfig): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
