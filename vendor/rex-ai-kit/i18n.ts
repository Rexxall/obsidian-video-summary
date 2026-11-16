// Generated from rex-ai-kit 0.1.0. Do not edit here.
export type Lang = 'en' | 'zh' | 'ja';

const en = {
	heading: 'AI service',
	provider: 'Provider',
	key: 'API key',
	keyDesc: 'Pick a key from Settings → Keychain. Every plugin uses the same key for this provider.',
	groups: { official: 'Official APIs', more: 'More providers', local: 'On this computer', custom: 'Custom' } as Record<'official' | 'more' | 'local' | 'custom', string>,
	modelError: (msg: string) => `Could not load the list: ${msg}`,
	keyNone: 'No key needed for a model on this computer.',
	check: 'Check',
	checking: 'Checking…',
	ok: 'Key works',
	missing: 'No key selected',
	invalid: 'Key rejected',
	error: 'Could not check',
	balance: 'Balance',
	usage: 'See usage',
	getKey: 'Get a key',
	model: 'Model',
	modelDesc: 'Recommended first. The full list comes from the provider.',
	recommended: 'Recommended',
	all: 'All',
	allCount: (n: number, ago: string) => `All · ${n} · ${ago}`,
	manual: 'Type a model name…',
	manualPh: 'model-id',
	refresh: 'Refresh list',
	cheap: 'cheap',
	balanced: 'balanced',
	strong: 'strong',
	advanced: 'Advanced',
	baseUrl: 'Server address',
	baseUrlDesc: 'Leave empty for the provider default. Use it for a proxy or a self-hosted server.',
	secretName: 'Keychain name',
	secretNameDesc: 'Only change this to use a different key than the shared one.',
	expiry: 'Free credit expires',
	expiryDesc: 'Optional. Within 30 days of this date the key row turns orange.',
	expiresSoon: (d: string) => `Free credit expires ${d}`,
	program: 'Program',
	notFound: 'Not found on this computer. Install it and sign in once in a terminal, or set its path under Advanced.',
	programPath: 'Program path',
	programPathDesc: 'Leave empty to look in the usual install folders.',
	justNow: 'just now',
	minAgo: (n: number) => `${n} min ago`,
	hAgo: (n: number) => `${n} h ago`,
	dAgo: (n: number) => `${n} d ago`,
};

export type Strings = typeof en;

const zh: Strings = {
	...en,
	heading: 'AI 服务',
	provider: '服务商',
	key: 'API 密钥',
	keyDesc: '从“设置 → 钥匙串”选一把密钥，各插件共用。',
	groups: { official: '官方 API', more: '更多服务商', local: '本机', custom: '自定义' },
	modelError: (msg) => `列表没取到：${msg}`,
	keyNone: '本机模型不需要密钥。',
	check: '检查',
	checking: '检查中…',
	ok: '密钥可用',
	missing: '还没选密钥',
	invalid: '密钥被拒绝',
	error: '检查失败',
	balance: '余额',
	usage: '去后台看用量',
	getKey: '获取密钥',
	model: '模型',
	modelDesc: '推荐的在最前，完整列表来自服务商。',
	recommended: '推荐',
	all: '全部',
	allCount: (n, ago) => `全部 · ${n} 个 · ${ago}`,
	manual: '手动输入模型名…',
	refresh: '刷新列表',
	cheap: '便宜',
	balanced: '均衡',
	strong: '强',
	advanced: '高级',
	baseUrl: '接口地址',
	baseUrlDesc: '留空用服务商默认地址。走代理或自建服务时再填。',
	secretName: '钥匙串名称',
	secretNameDesc: '只有想用和共享密钥不同的另一把时才改。',
	expiry: '赠送额度到期日',
	expiryDesc: '选填。离到期 30 天以内，密钥这一行会变成橙色。',
	expiresSoon: (d) => `赠送额度 ${d} 到期`,
	program: '程序',
	notFound: '这台电脑上没找到。先装好并在终端里登录一次，或在“高级”里填路径。',
	programPath: '程序路径',
	programPathDesc: '留空就在常见的安装位置里找。',
	justNow: '刚刚',
	minAgo: (n) => `${n} 分钟前`,
	hAgo: (n) => `${n} 小时前`,
	dAgo: (n) => `${n} 天前`,
};

const ja: Strings = {
	...en,
	heading: 'AI サービス',
	provider: 'プロバイダー',
	key: 'API キー',
	keyDesc: '「設定 → キーチェーン」からキーを選びます。プラグイン間で共有されます。',
	groups: { official: '公式 API', more: 'その他のプロバイダー', local: 'このパソコン', custom: 'カスタム' },
	modelError: (msg) => `一覧を取得できませんでした：${msg}`,
	keyNone: 'このパソコン上のモデルにはキーは不要です。',
	check: '確認',
	checking: '確認中…',
	ok: 'キーは有効です',
	missing: 'キーが未選択です',
	invalid: 'キーが拒否されました',
	error: '確認できませんでした',
	balance: '残高',
	usage: '利用状況を見る',
	getKey: 'キーを取得',
	model: 'モデル',
	modelDesc: 'おすすめが先頭に並びます。一覧はプロバイダーから取得します。',
	recommended: 'おすすめ',
	all: 'すべて',
	allCount: (n, ago) => `すべて · ${n} 件 · ${ago}`,
	manual: 'モデル名を入力…',
	refresh: '一覧を更新',
	cheap: '安い',
	balanced: 'バランス',
	strong: '高性能',
	advanced: '詳細',
	baseUrl: 'サーバーアドレス',
	baseUrlDesc: '空欄ならプロバイダーの既定値。プロキシや自前のサーバーを使うときだけ入力します。',
	secretName: 'キーチェーン名',
	secretNameDesc: '共有キーとは別のキーを使いたいときだけ変更します。',
	expiry: '無料クレジットの期限',
	expiryDesc: '任意。期限まで 30 日を切るとキーの行がオレンジになります。',
	expiresSoon: (d) => `無料クレジットは ${d} に期限切れ`,
	program: 'プログラム',
	notFound: 'このパソコンに見つかりません。インストールしてターミナルで一度ログインするか、「詳細」でパスを指定してください。',
	programPath: 'プログラムのパス',
	programPathDesc: '空欄なら一般的なインストール先を探します。',
	justNow: 'たった今',
	minAgo: (n) => `${n} 分前`,
	hAgo: (n) => `${n} 時間前`,
	dAgo: (n) => `${n} 日前`,
};

export const STRINGS: Record<Lang, Strings> = { en, zh, ja };

/** Map Obsidian's language code (getLanguage() or moment.locale()) to one of the kit's three. */
export function langFrom(code: string | undefined): Lang {
	const c = (code ?? '').toLowerCase();
	if (c.startsWith('zh')) return 'zh';
	if (c.startsWith('ja')) return 'ja';
	return 'en';
}

export function ago(s: Strings, ms: number): string {
	const m = Math.floor(ms / 60000);
	if (m < 1) return s.justNow;
	if (m < 60) return s.minAgo(m);
	const h = Math.floor(m / 60);
	if (h < 24) return s.hAgo(h);
	return s.dAgo(Math.floor(h / 24));
}
