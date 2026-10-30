import { SHORT_LINK_HOSTS } from '../constants';
import { desktopRequire, type DesktopHttp } from './desktop';

/**
 * 短链展开工具。
 *
 * 抖音/小红书/b23.tv 等短链经常在后端（yt-dlp）侧跳转失败或过期，
 * 在插件侧先展开成最终链接可以显著减少这类失败。
 *
 * 实现说明：
 * - Obsidian 渲染进程受 CORS 限制，普通 fetch 拿不到跨域重定向的最终地址，
 *   因此这里用 Node 的 http/https 模块（桌面端可用）手动跟随 Location。
 * - 全程 fail-open：任何一步失败都返回原始 URL，绝不阻塞正常处理。
 */
export class UrlResolver {
  private static readonly MAX_HOPS = 5;
  private static readonly USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

  /** URL 是否属于已知短链域名 */
  static isShortLink(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return SHORT_LINK_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  }

  /**
   * 展开短链为最终链接。非短链或任何失败场景都原样返回。
   */
  static async expandShortUrl(url: string, timeoutMs = 6000): Promise<string> {
    if (!this.isShortLink(url)) {
      return url;
    }

    let current = url;
    for (let hop = 0; hop < this.MAX_HOPS; hop++) {
      const location = await this.fetchRedirectLocation(current, timeoutMs);
      if (!location) {
        return current;
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        return current;
      }
      // 一旦跳出短链域名就认为已到达真实链接
      if (!this.isShortLink(current)) {
        return current;
      }
    }
    return current;
  }

  /**
   * 发起一次不跟随重定向的 GET，返回 Location 头（无重定向则返回 null）。
   * 仅桌面端可用（依赖 window.require）；移动端直接返回 null。
   */
  private static fetchRedirectLocation(url: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      let httpModule: DesktopHttp | undefined;
      try {
        // http and https share the get() shape used here; undefined on mobile
        httpModule = desktopRequire(url.startsWith('https:') ? 'https' : 'http') as
          | DesktopHttp
          | undefined;
      } catch {
        resolve(null);
        return;
      }

      let settled = false;
      const finish = (value: string | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      try {
        if (!httpModule) {
          finish(null);
          return;
        }
        const request = httpModule.get(
          url,
          { headers: { 'user-agent': this.USER_AGENT } },
          (response) => {
            const status = Number(response.statusCode) || 0;
            const location = response.headers.location;
            // 丢弃 body，避免连接悬挂
            try {
              response.resume();
            } catch {
              // ignore
            }
            if (status >= 300 && status < 400 && typeof location === 'string' && location) {
              finish(location);
            } else {
              finish(null);
            }
          },
        );
        request.setTimeout(timeoutMs, () => {
          try {
            request.destroy();
          } catch {
            // ignore
          }
          finish(null);
        });
        request.on('error', () => finish(null));
      } catch {
        finish(null);
      }
    });
  }
}
