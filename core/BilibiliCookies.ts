/** Kept free of Obsidian imports so it can be unit-tested in Node. */
const LOGIN_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

/**
 * The poll answer's `url` carries the login cookies as query parameters; turn them into the
 * Netscape cookies.txt yt-dlp reads.
 */
export function cookiesFromLoginUrl(loginUrl: string, nowSeconds: number): string {
  let params: URLSearchParams;
  try {
    params = new URL(loginUrl).searchParams;
  } catch {
    return '';
  }
  if (!params.get('SESSDATA')) return '';
  const expires = Number(params.get('Expires')) || 0;
  const expiry = expires > nowSeconds ? expires : nowSeconds + 180 * 24 * 60 * 60;
  const lines = ['# Netscape HTTP Cookie File'];
  for (const name of LOGIN_COOKIES) {
    const value = params.get(name);
    if (!value || /[\t\r\n]/.test(value)) continue;
    const httpOnly = name === 'SESSDATA';
    lines.push(
      [
        httpOnly ? '#HttpOnly_.bilibili.com' : '.bilibili.com',
        'TRUE',
        '/',
        httpOnly ? 'TRUE' : 'FALSE',
        String(Math.floor(expiry)),
        name,
        value,
      ].join('\t'),
    );
  }
  return `${lines.join('\n')}\n`;
}
