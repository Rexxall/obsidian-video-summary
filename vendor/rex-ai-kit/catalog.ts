// Generated from rex-ai-kit 0.1.0. Do not edit here.
import type { AiSlot, Provider } from './types';

/**
 * Provider table. Order is the picker order: the three official APIs first, then other hosted
 * providers, then local runtimes, then a free-form custom endpoint.
 * Model picks follow the shared plan (AI服务商统一方案_2026-11-12); update them with each release,
 * never fetch them remotely on startup.
 */
export const PROVIDERS: Provider[] = [
	{
		id: 'openai',
		name: 'OpenAI',
		group: 'official',
		protocol: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		secretName: 'openai-api-key',
		needsKey: true,
		modelsPath: '/models',
		cors: true,
		consoleUrl: 'https://platform.openai.com/api-keys',
		usageUrl: 'https://platform.openai.com/usage',
		picks: [
			{ id: 'gpt-6-luna', scene: 'cheap', note: 'fast, reads images' },
			{ id: 'gpt-6.1-terra', scene: 'balanced', note: 'natural writing' },
			{ id: 'gpt-6.1-sol', scene: 'strong' },
		],
	},
	{
		id: 'anthropic',
		name: 'Anthropic (Claude)',
		group: 'official',
		protocol: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1',
		secretName: 'anthropic-api-key',
		needsKey: true,
		modelsPath: '/models',
		cors: true,
		consoleUrl: 'https://platform.claude.com/settings/keys',
		usageUrl: 'https://platform.claude.com/cost',
		picks: [
			{ id: 'claude-haiku-5-5', scene: 'cheap' },
			{ id: 'claude-sonnet-5-5', scene: 'balanced', note: 'structured long writing' },
			{ id: 'claude-opus-5-5', scene: 'strong' },
		],
	},
	{
		id: 'gemini',
		name: 'Google Gemini',
		group: 'official',
		protocol: 'gemini',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		secretName: 'gemini-api-key',
		needsKey: true,
		modelsPath: '/models',
		cors: true,
		consoleUrl: 'https://aistudio.google.com/apikey',
		usageUrl: 'https://aistudio.google.com/usage',
		hint: 'On the free tier Google may use your content to improve its products.',
		picks: [
			{ id: 'gemini-3.5-flash-lite', scene: 'cheap', note: 'free tier' },
			{ id: 'gemini-3.8-flash', scene: 'balanced', note: 'free tier' },
		],
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		group: 'more',
		protocol: 'openai',
		baseUrl: 'https://api.deepseek.com',
		secretName: 'deepseek-api-key',
		needsKey: true,
		modelsPath: '/models',
		balance: 'deepseek',
		consoleUrl: 'https://platform.deepseek.com/api_keys',
		picks: [{ id: 'deepseek-flash', scene: 'cheap' }],
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		group: 'more',
		protocol: 'openai',
		baseUrl: 'https://openrouter.ai/api/v1',
		secretName: 'openrouter-api-key',
		needsKey: true,
		modelsPath: '/models',
		balance: 'openrouter',
		cors: true,
		consoleUrl: 'https://openrouter.ai/keys',
		picks: [],
	},
	{
		id: 'qwen',
		name: 'Qwen (Alibaba Model Studio)',
		names: { zh: '通义千问（阿里云百炼）', ja: 'Qwen（Alibaba Model Studio）' },
		group: 'more',
		protocol: 'openai',
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		secretName: 'qwen-api-key',
		needsKey: true,
		modelsPath: '/models',
		consoleUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
		picks: [{ id: 'qwen-plus', scene: 'balanced' }],
	},
	{
		id: 'kimi',
		name: 'Kimi (Moonshot)',
		names: { zh: 'Kimi（Moonshot）', ja: 'Kimi（Moonshot）' },
		group: 'more',
		protocol: 'openai',
		baseUrl: 'https://api.moonshot.cn/v1',
		secretName: 'kimi-api-key',
		needsKey: true,
		modelsPath: '/models',
		balance: 'kimi',
		consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
		picks: [],
	},
	{
		id: 'zhipu',
		name: 'Zhipu GLM',
		names: { zh: '智谱 GLM' },
		group: 'more',
		protocol: 'openai',
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		secretName: 'zhipu-api-key',
		needsKey: true,
		modelsPath: null,
		consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
		picks: [
			{ id: 'glm-5.3-flash', scene: 'cheap' },
			{ id: 'glm-5.3', scene: 'balanced' },
		],
	},
	{
		id: 'siliconflow',
		name: 'SiliconFlow',
		names: { zh: '硅基流动' },
		group: 'more',
		protocol: 'openai',
		baseUrl: 'https://api.siliconflow.cn/v1',
		secretName: 'siliconflow-api-key',
		needsKey: true,
		modelsPath: '/models?sub_type=chat',
		balance: 'siliconflow',
		consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
		picks: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash', scene: 'cheap' }],
	},
	{
		id: 'ollama',
		name: 'Ollama',
		group: 'local',
		protocol: 'ollama',
		baseUrl: 'http://localhost:11434',
		secretName: '',
		needsKey: false,
		modelsPath: '/api/tags',
		cors: true,
		picks: [],
	},
	{
		id: 'lmstudio',
		name: 'LM Studio',
		group: 'local',
		protocol: 'openai',
		baseUrl: 'http://localhost:1234/v1',
		secretName: '',
		needsKey: false,
		modelsPath: '/models',
		cors: true,
		picks: [],
	},
	{
		id: 'claude-code',
		name: 'Claude Code (this computer)',
		names: { zh: 'Claude Code（本机）', ja: 'Claude Code（このパソコン）' },
		group: 'local',
		protocol: 'cli',
		baseUrl: '',
		secretName: '',
		needsKey: false,
		modelsPath: null,
		localAgent: 'claude',
		hint: 'Runs the Claude Code you installed and signed in to on this computer, one request at a time.',
		picks: [
			{ id: 'haiku', scene: 'cheap' },
			{ id: 'sonnet', scene: 'balanced' },
			{ id: 'opus', scene: 'strong' },
		],
	},
	{
		id: 'codex',
		name: 'Codex (this computer)',
		names: { zh: 'Codex（本机）', ja: 'Codex（このパソコン）' },
		group: 'local',
		protocol: 'cli',
		baseUrl: '',
		secretName: '',
		needsKey: false,
		modelsPath: null,
		localAgent: 'codex',
		hint: 'Runs the Codex CLI you installed and signed in to on this computer, one request at a time.',
		picks: [
			{ id: 'gpt-6-luna', scene: 'cheap' },
			{ id: 'gpt-6.1-terra', scene: 'balanced' },
			{ id: 'gpt-6.1-sol', scene: 'strong' },
		],
	},
	{
		id: 'custom',
		name: 'Other (OpenAI compatible)',
		names: { zh: '其他（OpenAI 兼容）', ja: 'その他（OpenAI 互換）' },
		group: 'custom',
		protocol: 'openai',
		baseUrl: '',
		secretName: 'custom-ai-api-key',
		needsKey: true,
		modelsPath: '/models',
		picks: [],
	},
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): Provider | undefined {
	return BY_ID.get(id);
}

/** The provider's name in one of the kit's languages. */
export function providerName(p: Pick<Provider, 'name' | 'names'>, lang: 'en' | 'zh' | 'ja' = 'en'): string {
	return (lang !== 'en' && p.names?.[lang]) || p.name;
}

/** Provider with the slot's overrides applied (custom base URL, own Keychain name), named in `lang`. */
export function resolveProvider(slot: { provider: string; baseUrl?: string; secretName?: string }, lang: 'en' | 'zh' | 'ja' = 'en'): Provider {
	const base = BY_ID.get(slot.provider) ?? BY_ID.get('custom')!;
	return {
		...base,
		name: providerName(base, lang),
		baseUrl: (slot.baseUrl?.trim() || base.baseUrl).replace(/\/+$/, ''),
		secretName: slot.secretName?.trim() || base.secretName,
	};
}

export const GROUP_LABELS: Record<Provider['group'], string> = {
	official: 'Official APIs',
	more: 'More providers',
	local: 'On this computer',
	custom: 'Custom',
};

/** Guess the provider from an endpoint URL, for migrating old settings. */
export function inferProviderId(url: string): string {
	const u = url.toLowerCase();
	if (!u) return 'custom';
	if (u.includes('api.openai.com')) return 'openai';
	if (u.includes('anthropic.com')) return 'anthropic';
	if (u.includes('generativelanguage.googleapis.com')) return 'gemini';
	if (u.includes('deepseek.com')) return 'deepseek';
	if (u.includes('openrouter.ai')) return 'openrouter';
	if (u.includes('dashscope') || u.includes('aliyuncs.com')) return 'qwen';
	if (u.includes('moonshot')) return 'kimi';
	if (u.includes('bigmodel.cn')) return 'zhipu';
	if (u.includes('siliconflow')) return 'siliconflow';
	if (u.includes(':11434')) return 'ollama';
	if (u.includes(':1234')) return 'lmstudio';
	return 'custom';
}

const hostOf = (url: string): string => {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return '';
	}
};

/**
 * Turn an old "address + model + key name" setting into a slot. The provider comes from the address;
 * the address is kept only when it points somewhere other than the provider's own server (a proxy,
 * a local port), so Gemini's OpenAI-compatible address becomes native Gemini with the same key.
 * The old Keychain name is kept unless it is the shared one.
 */
export function slotFromEndpoint(old: { url?: string; provider?: string; model?: string; secretName?: string }): AiSlot {
	const url = (old.url ?? '').trim();
	const named = old.provider && old.provider !== 'custom' && BY_ID.has(old.provider) ? old.provider : undefined;
	const provider = named ?? inferProviderId(url);
	const p = BY_ID.get(provider)!;
	// Old settings reached Ollama through its OpenAI-compatible /v1 path; the kit speaks Ollama's own API at the root.
	const clean = url.replace(/\/+$/, '').replace(provider === 'ollama' ? /\/v1$/ : /$^/, '');
	const sameServer = !!clean && !!p.baseUrl && hostOf(clean) === hostOf(p.baseUrl) && p.group !== 'local';
	const keepUrl = !!clean && !sameServer && clean !== p.baseUrl;
	const secret = old.secretName?.trim();
	return {
		provider,
		model: old.model?.trim() ?? '',
		...(secret && secret !== p.secretName ? { secretName: secret } : {}),
		...(keepUrl ? { baseUrl: clean } : {}),
	};
}
