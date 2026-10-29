/**
 * Scan-to-log-in for Bilibili, the same QR flow as bilibili.com's own login page.
 *
 * The login cookie is handed straight to the user's own backend (yt-dlp needs it for subtitles
 * and Bilibili's AI subtitles); the plugin does not keep it.
 */
import { requestUrl } from 'obsidian';

import { isRecord, scalarText } from '../utils/json';
import { cookiesFromLoginUrl } from './BilibiliCookies';

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };

export interface QrLoginTicket {
  /** What the QR code encodes. */
  url: string;
  key: string;
}

export type QrLoginState =
  | { state: 'waiting' }
  | { state: 'scanned' }
  | { state: 'expired' }
  | { state: 'done'; cookies: string }
  | { state: 'error'; message: string };

export async function startQrLogin(): Promise<QrLoginTicket> {
  const response = await requestUrl({ url: GENERATE_URL, headers: HEADERS, throw: false });
  const body: unknown = response.json;
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  if (response.status !== 200 || !data || typeof data.url !== 'string') {
    throw new Error(`B 站没有返回二维码（HTTP ${response.status}）`);
  }
  return { url: data.url, key: scalarText(data.qrcode_key) };
}

export async function pollQrLogin(key: string): Promise<QrLoginState> {
  const response = await requestUrl({
    url: `${POLL_URL}?qrcode_key=${encodeURIComponent(key)}`,
    headers: HEADERS,
    throw: false,
  });
  const body: unknown = response.json;
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  if (response.status !== 200 || !data) {
    return { state: 'error', message: `B 站登录接口返回 HTTP ${response.status}` };
  }
  switch (Number(data.code)) {
    case 86101:
      return { state: 'waiting' };
    case 86090:
      return { state: 'scanned' };
    case 86038:
      return { state: 'expired' };
    case 0: {
      const cookies = cookiesFromLoginUrl(scalarText(data.url), Date.now() / 1000);
      return cookies
        ? { state: 'done', cookies }
        : { state: 'error', message: 'B 站确认了登录，但没有给出登录 cookie。' };
    }
    default:
      return { state: 'error', message: scalarText(data.message) || '未知状态' };
  }
}
