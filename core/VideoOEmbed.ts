import { titleForUrl } from './InputParser';
import { youTubeVideoId } from './NoteStyle';

/** What YouTube's public oEmbed endpoint tells about a video: no key, no page scraping. */
export interface OEmbedInfo {
  title?: string;
  author?: string;
}

/** A title the plugin made up from the link (YouTube视频_<id>), not the video's own. */
export function isPlaceholderTitle(title: string | undefined, url: string | undefined): boolean {
  const text = (title || '').trim();
  if (!text) return true;
  return !!url && text === titleForUrl(url);
}

/**
 * The title and channel of a YouTube video, or {} when the link is not YouTube, the video is
 * private, or the request fails. Never throws.
 */
export async function youTubeOEmbed(
  url: string | undefined,
  get: (endpoint: string) => Promise<unknown>,
): Promise<OEmbedInfo> {
  const id = youTubeVideoId(url);
  if (!id) return {};
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${id}`,
  )}`;
  try {
    const json = (await get(endpoint)) as { title?: unknown; author_name?: unknown } | null;
    const text = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const info: OEmbedInfo = {};
    const title = text(json?.title);
    const author = text(json?.author_name);
    if (title) info.title = title;
    if (author) info.author = author;
    return info;
  } catch {
    return {};
  }
}
