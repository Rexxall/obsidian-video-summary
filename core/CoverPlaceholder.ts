/**
 * YouTube 的 mqdefault/hqdefault 正常是 16:9；视频没有封面（或已删除）时，
 * 同一个地址会返回一张 120×90 的灰色占位图。侧栏把它当作没有封面，改显示平台图标。
 */
export function isPlaceholderCover(url: string, width: number, height: number): boolean {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return /(^|\.)ytimg\.com$/.test(host) && width === 120 && height === 90;
}
