import { detectPlatform } from './Platform';

/**
 * A link to an ordinary web page: an article, a blog post, a paper's page. Its text is read
 * here and written up by the light tier, instead of being sent to the backend, which can only
 * download videos and fails on these.
 */
export function isArticleLink(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (detectPlatform(parsed.href) !== 'other') return false;
  // Media and documents the backend or a reader handles better than a page parser.
  return !/\.(mp4|m4a|mp3|wav|webm|mov|mkv|flac|ogg|pdf|zip)$/i.test(parsed.pathname);
}

/** Below this the page is a wall, a login or a shell rendered by script: leave it to the backend. */
export const MIN_ARTICLE_CHARS = 300;

const DROP = [
  'script, style, noscript, template, nav, header, footer, aside, form, iframe, svg, canvas',
  'button, dialog, [aria-hidden="true"], [hidden]',
  // Comments, sidebars and share or related blocks: on a short post they outweigh the post.
  '#comments, [id^="comment"], [class*="comment"], .sidebar, .widget, [class*="related"], [class*="share"]',
].join(', ');
/** Where blogs, CMSs and WeChat articles put the post itself. */
const CONTENT =
  '.entry-content, .post-content, .article-content, .post-body, .article-body, #js_content, .rich_media_content';
const BLOCKS = 'h1, h2, h3, h4, p, li, blockquote, pre, td';

const clean = (text: string | null | undefined) => (text || '').replace(/\s+/g, ' ').trim();

/** The page's title and its main text, as plain lines with headings, lists and quotes marked. */
export function extractArticle(doc: Document): { title: string; text: string } {
  const meta = (selector: string) => clean(doc.querySelector(selector)?.getAttribute('content'));
  const title =
    meta('meta[property="og:title"]') ||
    meta('meta[name="twitter:title"]') ||
    clean(doc.querySelector('h1')?.textContent) ||
    clean(doc.title);

  // A wrapper whose class only mentions comments or sharing (WordPress puts comments-open on
  // body) still holds the post: only blocks without the post in them go.
  doc.querySelectorAll(DROP).forEach((element) => {
    if (element === doc.body || element === doc.documentElement) return;
    if (element.querySelector(`${CONTENT}, article, main`)) return;
    element.remove();
  });
  const length = (element: Element) => clean(element.textContent).length;

  // The article element when the page marks one; otherwise the block holding the most paragraph text.
  const longest = (selector: string) =>
    Array.from(doc.querySelectorAll(selector)).sort((a, b) => length(b) - length(a))[0] || null;
  let root: Element | null = longest(CONTENT);
  if (!root || length(root) < 200) root = longest('article, main, [role="main"]');
  if (!root || length(root) < MIN_ARTICLE_CHARS) {
    const score = new Map<Element, number>();
    doc.querySelectorAll('p').forEach((paragraph) => {
      const parent = paragraph.parentElement;
      if (parent) score.set(parent, (score.get(parent) || 0) + length(paragraph));
    });
    root = Array.from(score).sort((a, b) => b[1] - a[1])[0]?.[0] || doc.body;
  }
  if (!root) return { title, text: '' };

  const lines: string[] = [];
  root.querySelectorAll(BLOCKS).forEach((element) => {
    // A paragraph inside a list item or quote is already part of that block's text.
    const outer = element.parentElement?.closest(BLOCKS);
    if (outer && root?.contains(outer)) return;
    const text = clean(element.textContent);
    if (!text) return;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-4]$/.test(tag)) lines.push(`${'#'.repeat(Number(tag[1]) + 1)} ${text}`);
    else if (tag === 'li') lines.push(`- ${text}`);
    else if (tag === 'blockquote') lines.push(`> ${text}`);
    else lines.push(text);
  });
  return { title, text: lines.join('\n\n') };
}
