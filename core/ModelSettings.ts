/**
 * The summary model and the two API keys chosen in settings. One place for every part of the
 * plugin that needs them: the managed backend, and anything that calls a model directly.
 *
 * Settings hold the *name* of a secret in Obsidian's secret storage, never the key itself.
 */
import type { App } from 'obsidian';

export type LlmProviderId = 'deepseek' | 'siliconflow' | 'qwen' | 'kimi' | 'gemini' | 'custom';

export interface LlmProvider {
  id: LlmProviderId;
  /** Shown in the provider list; names of services are not translated. */
  label: string;
  labelZh?: string;
  /** OpenAI-compatible base address; '' for custom. */
  baseUrl: string;
  /** Used when settings.llmModel is empty; '' when the service has no stable default. */
  defaultModel: string;
  /** Other model names offered in the list. */
  models: string[];
  /** Where a person gets a key for this service. */
  keyUrl: string;
}

/** The services in INSTALL.md's "change the model" table. */
export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    labelZh: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
    models: ['deepseek-ai/DeepSeek-V4.1-Flash'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'qwen',
    label: 'Qwen (DashScope)',
    labelZh: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus'],
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: '',
    models: [],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-flash-latest',
    models: ['gemini-flash-latest'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'custom',
    label: 'Other',
    labelZh: '其他',
    baseUrl: '',
    defaultModel: '',
    models: [],
    keyUrl: '',
  },
];

export const SPEECH_DEFAULTS = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'FunAudioLLM/SenseVoiceSmall',
  keyUrl: 'https://cloud.siliconflow.cn/account/ak',
};

/** The settings fields this module reads. */
export interface ModelSettingsFields {
  llmProvider: LlmProviderId;
  llmModel: string;
  llmBaseUrl: string;
  llmKeySecret: string;
  speechKeySecret: string;
  speechBaseUrl: string;
  speechModel: string;
}

export function llmProvider(id: string): LlmProvider {
  return LLM_PROVIDERS.find((provider) => provider.id === id) ?? LLM_PROVIDERS[0];
}

/** Base address and model name for summaries. Either can be '' when a custom service is half filled in. */
export function resolveLlm(
  settings: Pick<ModelSettingsFields, 'llmProvider' | 'llmModel' | 'llmBaseUrl'>,
): {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
} {
  const provider = llmProvider(settings.llmProvider);
  const baseUrl = (provider.id === 'custom' ? settings.llmBaseUrl : provider.baseUrl)
    .trim()
    .replace(/\/+$/, '');
  return { provider, baseUrl, model: (settings.llmModel || '').trim() || provider.defaultModel };
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
  const llm = resolveLlm(settings);
  const chatKey = readSecret(app, settings.llmKeySecret);
  const speechKey = readSecret(app, settings.speechKeySecret);
  const config: BackendModelConfig = { chat: {}, speech: {} };
  // Model and address follow the key: without a key chosen here, the backend keeps its own.
  if (chatKey) {
    config.chat.key = chatKey;
    if (llm.baseUrl) config.chat.base = llm.baseUrl;
    if (llm.model) config.chat.model = llm.model;
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
