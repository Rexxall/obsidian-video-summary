// Generated from rex-ai-kit 0.1.0. Do not edit here.
import { redact } from './http';
import { PROVIDERS } from './catalog';
import type { Lang } from './i18n';
import { AiError, type AiErrorKind } from './types';

type Advice = Record<AiErrorKind, string> & { localMissing: string; localAuth: string; busy: string; images: string; desktopOnly: string; said: string };

const ADVICE: Record<Lang, Advice> = {
	en: {
		'no-key': 'No API key selected. Pick one from the Keychain in the plugin’s AI service settings, or use “Get a key”.',
		auth: 'The key was rejected. Check that it belongs to this provider and has not expired, then press Check.',
		quota: 'Out of balance or quota. Top up on the provider’s site, or switch to another provider.',
		rate: 'Too many requests right now. Wait a moment and try again.',
		model: 'This model does not exist or the key cannot use it. Refresh the model list and pick another.',
		timeout: 'No reply in time. The service may be busy: try again later, and if it keeps happening check your network or server address.',
		network: 'Could not reach the service. Check your network, proxy and server address.',
		server: 'The provider had an error. Try again in a moment, or switch to another provider.',
		'bad-response': 'The service replied in a form the plugin cannot read. Try another model.',
		aborted: 'Cancelled.',
		localMissing: 'Not found on this computer. Install it and sign in once in a terminal, or set its path under Advanced.',
		localAuth: 'The program is not signed in. Run it once in a terminal and sign in.',
		busy: 'Another request is still running. Wait for it to finish, then try again.',
		images: 'Programs on this computer cannot read images. Pick an API provider for this.',
		desktopOnly: 'This only works in Obsidian on a computer. Pick an API provider on this device.',
		said: 'The service said',
	},
	zh: {
		'no-key': '还没选密钥。到插件设置的“AI 服务”里，从钥匙串选一把，或点“获取密钥”。',
		auth: '密钥被拒绝。核对它是否属于这家服务商、有没有过期，再点“检查”。',
		quota: '余额或额度不足。去服务商后台充值，或换一家服务商。',
		rate: '请求太频繁，稍等一会儿再试。',
		model: '这个模型不存在，或这把密钥不能用它。刷新模型列表，换一个。',
		timeout: '等了太久没有回复。服务可能繁忙，稍后再试；一直这样就检查网络或接口地址。',
		network: '连不上服务。检查网络、代理和接口地址。',
		server: '服务商那边出错了。稍后再试，或先换一家。',
		'bad-response': '服务有回复，但格式读不出来。换一个模型试试。',
		aborted: '已取消。',
		localMissing: '这台电脑上没找到这个程序。装好并在终端里登录一次，或在“高级”里填路径。',
		localAuth: '程序还没登录。在终端里运行一次并登录。',
		busy: '上一条请求还在跑，等它结束再试。',
		images: '本机程序不收图片。识图请选一家 API 服务商。',
		desktopOnly: '只能在电脑上的 Obsidian 里用。这台设备请选一家 API 服务商。',
		said: '服务商原话',
	},
	ja: {
		'no-key': 'キーが選ばれていません。プラグイン設定の「AI サービス」でキーチェーンから選ぶか、「キーを取得」を押してください。',
		auth: 'キーが拒否されました。このプロバイダーのキーか、期限切れでないかを確かめて「確認」を押してください。',
		quota: '残高またはクォータが足りません。プロバイダーのサイトでチャージするか、別のプロバイダーに切り替えてください。',
		rate: 'リクエストが多すぎます。少し待ってからもう一度試してください。',
		model: 'このモデルは存在しないか、このキーでは使えません。モデル一覧を更新して別のものを選んでください。',
		timeout: '時間内に返事がありませんでした。混んでいる可能性があります。後で試し、続くならネットワークかサーバーアドレスを確認してください。',
		network: 'サービスに接続できません。ネットワーク、プロキシ、サーバーアドレスを確認してください。',
		server: 'プロバイダー側でエラーが起きました。少し待つか、別のプロバイダーに切り替えてください。',
		'bad-response': '返事はありましたが読み取れませんでした。別のモデルを試してください。',
		aborted: 'キャンセルしました。',
		localMissing: 'このパソコンに見つかりません。インストールしてターミナルで一度ログインするか、「詳細」でパスを指定してください。',
		localAuth: 'プログラムがログインしていません。ターミナルで一度起動してログインしてください。',
		busy: '前のリクエストがまだ動いています。終わってからもう一度試してください。',
		images: 'このパソコンのプログラムは画像を読めません。画像には API プロバイダーを選んでください。',
		desktopOnly: 'パソコン版の Obsidian でだけ使えます。この端末では API プロバイダーを選んでください。',
		said: 'プロバイダーの返答',
	},
};

/**
 * One sentence for the user: who failed, what it means and what to do next, in their language.
 * The provider's own words follow when there are any, keys already removed.
 */
export function explainError(e: unknown, lang: Lang = 'en'): string {
	const a = ADVICE[lang];
	if (!(e instanceof AiError)) return e instanceof Error ? e.message : String(e);
	if (e.kind === 'aborted') return a.aborted;
	const local = PROVIDERS.some((p) => p.localAgent && [p.name, p.names?.zh, p.names?.ja].includes(e.provider));
	let advice: string = a[e.kind];
	if (e.detail === 'images') advice = a.images;
	else if (e.detail === 'desktop-only') advice = a.desktopOnly;
	else if (e.detail === 'busy') advice = a.busy;
	else if (local && e.kind === 'no-key') advice = a.localMissing;
	else if (local && e.kind === 'auth') advice = a.localAuth;
	const who = e.provider ? `${e.provider}${lang === 'en' ? ': ' : '：'}` : '';
	// Redacted again here: an AiError built outside the kit may carry the provider's raw words.
	const detail = e.detail ? redact(e.detail) : '';
	const said = detail && !['images', 'desktop-only', 'busy'].includes(detail) ? (lang === 'en' ? ` ${a.said}: ${detail}` : `${a.said}：${detail}`) : '';
	return `${who}${advice}${said}`;
}
