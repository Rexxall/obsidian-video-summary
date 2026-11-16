// Generated from rex-ai-kit 0.1.0. Do not edit here.
import { authHeaders } from './chat';
import { errorText } from './http';
import { at, list, numLike, str } from './json';
import { fetchModels } from './models';
import { AiError, type Balance, type KeyCheck, type Provider, type Transport } from './types';

/**
 * Check a key by listing models: cheap, no tokens spent. Only runs when the user presses "Check".
 * Statuses follow Copilot's four: ok / missing / invalid / error.
 */
export async function checkKey(provider: Provider, key: string | null, transport: Transport, signal?: AbortSignal): Promise<KeyCheck> {
	if (provider.needsKey && !key) return { status: 'missing' };
	if (!provider.modelsPath) return { status: 'ok', detail: 'This provider has no endpoint to test keys; it will be checked on first use.' };
	try {
		const models = await fetchModels(provider, key, transport, signal);
		return { status: 'ok', models };
	} catch (e) {
		if (e instanceof AiError && e.kind === 'auth') return { status: 'invalid', detail: e.message };
		if (e instanceof AiError && e.kind === 'no-key') return { status: 'missing' };
		return { status: 'error', detail: e instanceof Error ? e.message : String(e) };
	}
}

const money = (amount: number, currency: string) => {
	const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
	return sym ? `${sym}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
};

const BALANCE_PATH: Record<NonNullable<Provider['balance']>, string> = {
	deepseek: '/user/balance',
	openrouter: '/key',
	siliconflow: '/user/info',
	kimi: '/users/me/balance',
};

/** Read the balance where the provider offers it. Returns null for providers without one. */
export async function fetchBalance(provider: Provider, key: string | null, transport: Transport, signal?: AbortSignal): Promise<Balance | null> {
	if (!provider.balance || !key) return null;
	const res = await transport({ url: `${provider.baseUrl}${BALANCE_PATH[provider.balance]}`, method: 'GET', headers: authHeaders(provider, key), signal });
	if (res.status < 200 || res.status >= 300) throw new AiError(`${provider.name}: balance unavailable${errorText(res) ? ` (${errorText(res)})` : ''}`, 'bad-response', res.status);
	return parseBalance(provider, res.json);
}

/** Exported for tests. */
export function parseBalance(provider: Provider, j: unknown): Balance | null {
	switch (provider.balance) {
		case 'deepseek': {
			const info = list(at(j, 'balance_infos'))[0];
			const amount = numLike(at(info, 'total_balance'));
			if (amount === undefined) return null;
			const currency = str(at(info, 'currency')) ?? 'CNY';
			return { amount, currency, text: money(amount, currency) };
		}
		case 'openrouter': {
			const d = at(j, 'data');
			if (!d || typeof d !== 'object') return null;
			const usage = numLike(at(d, 'usage')) ?? 0;
			const limit = numLike(at(d, 'limit'));
			if (limit === undefined) return { amount: undefined, currency: 'USD', text: `$${usage.toFixed(2)} used, no limit` };
			const left = numLike(at(d, 'limit_remaining')) ?? limit - usage;
			return { amount: left, currency: 'USD', text: `$${left.toFixed(2)} left of $${limit.toFixed(2)}` };
		}
		case 'siliconflow': {
			const amount = numLike(at(j, 'data', 'totalBalance')) ?? numLike(at(j, 'data', 'balance'));
			if (amount === undefined) return null;
			return { amount, currency: 'CNY', text: money(amount, 'CNY') };
		}
		case 'kimi': {
			const amount = numLike(at(j, 'data', 'available_balance'));
			if (amount === undefined) return null;
			return { amount, currency: 'CNY', text: money(amount, 'CNY') };
		}
		default:
			return null;
	}
}
