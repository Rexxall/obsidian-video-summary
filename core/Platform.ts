/** Which platform a link belongs to. Kept free of Obsidian imports so it can be tested in Node. */
export function detectPlatform(url: string): string {
  const value = url.toLowerCase();
  if (value.includes('bilibili.com') || value.includes('b23.tv')) return 'bilibili';
  if (value.includes('youtube.com') || value.includes('youtu.be')) return 'youtube';
  if (value.includes('douyin.com')) return 'douyin';
  if (value.includes('tiktok.com')) return 'tiktok';
  if (value.includes('xiaohongshu.com') || value.includes('xhslink')) return 'xiaohongshu';
  return 'other';
}
