/**
 * The reader's own way of writing notes, and the pictures of a video a note may place.
 * Both travel to the model in the request metadata (`note_style`, `note_images`), for the
 * light tier and the backend alike.
 */

/** Bumped with the note prompt; the style is folded in so a new style never reuses old notes. */
export const NOTE_PROMPT_VERSION = 'video-note-prompt-v6';

export interface NoteImage {
  url: string;
  label: string;
}

/**
 * A writing style for the vault theme "Ithaca 整本手账": its paper callouts, margin notes,
 * receipts, photo wall, stamps and stickers. Offered as a preset in settings; the reader can
 * edit it. {{channel}}, {{date}}, {{duration}} and {{video_id}} are filled in by the plugin.
 */
export const ITHACA_NOTE_STYLE = [
  'The vault uses the theme "Ithaca 整本手账". Its elements are drawn as paper, stamps and pen on the page; use them where they fit and skip any that do not.',
  'Order: postmark and sticker, photo wall, summary, diagram, body, pinned notes, quotes, barcode.',
  '- First line of the note: <span class="ih-postmark">{{channel}}<br>{{date}}</span> followed in the same paragraph by one sticker <span class="ih-sticker">值得看</span> (or 可略读 / 可跳过, by your attention judgement; add class is-red only for 值得看). The postmark lines hold at most 7 Chinese characters or 14 Latin letters each: shorten the channel name if needed. Leave the postmark out when the channel is empty.',
  '- Then a photo wall of the pictures offered above: "> [!photos]" with one line per picture, "> - ![](url) caption", the caption being its time like [04:30] or a few words; cover first.',
  '- Headings: no emoji; the theme numbers the ## headings itself. The summary callout is titled "核心摘要".',
  '- The single most important conclusion, or a misconception the video corrects: one "> [!important] <short title>" (black paper).',
  '- The one or two best concrete examples: "> [!example] <short name>", 2 or 3 sentences each (taped slips).',
  '- Stages in time (a story, a history, a career): "> [!timeline] <title>" with 2 to 6 lines "> - **<year or step>** <what happened>" (cards left and right). The title is required.',
  '- An exchange between people (interviews, debates): "> [!chat] <show or topic>" with one line per turn, "> - **<speaker>：** <words>", alternating sides; merge consecutive lines of the same speaker. The title is required. Use it for the best 4 to 8 turns, not the whole conversation.',
  '- Old background (a date long ago, where an idea came from): "> [!old] <era>" with one short paragraph (yellowed paper). Short facts instead: footnotes [^1], which the theme moves into the margin.',
  '- Where one block leads to the next (a cause, a so-what): a paragraph of its own, <span class="ih-arrow">所以</span>, 2 to 8 characters; at most twice.',
  '- Your own thoughts beside a line: <span class="ih-mg">a short sentence</span>; in red pen <span class="ih-mg is-red">…</span> where the argument is weak or lacks evidence. At most three in all.',
  '- Thoughts and things to try after the video: "> [!pinned]" with 1 to 5 lines "> - <a few words>" (pinned sticky notes). Things to do from the video: "> [!todo] 行动清单" with "- [ ]" items, only when the video gives them.',
  '- Quotes: "> [!receipt] 原话" callouts, one line each with its time; a translation on the next line when the languages differ.',
  '- Last line of the note, a paragraph of its own: <span class="ih-barcode">{{duration}} · {{video_id}}</span> (leave out an empty part).',
  '- Put <span class="ih-circ">...</span> around the single most important phrase, once. ==highlight== at most two other phrases.',
].join('\n');

export interface NoteStyleValues {
  channel?: string;
  date?: string;
  duration?: string;
  videoId?: string;
}

/** The style with the video's own details filled in; an unknown detail becomes empty. */
export function fillNoteStyle(style: string | undefined, values: NoteStyleValues): string {
  const text = (style || '').trim();
  if (!text) return '';
  const clean = (value: string | undefined) => (value || '').replace(/[<>\n]/g, ' ').trim();
  return text
    .replace(/\{\{channel\}\}/g, clean(values.channel))
    .replace(/\{\{date\}\}/g, clean(values.date))
    .replace(/\{\{duration\}\}/g, clean(values.duration))
    .replace(/\{\{video_id\}\}/g, clean(values.videoId));
}

/** Today as the theme's stamps write it: 2026.11.11. */
export function stampDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
}

/**
 * The cover and three frames YouTube keeps for every video, about a quarter, half and three
 * quarters in; with the duration known, each frame is labelled with its approximate time.
 */
export function noteImagesFor(url: string | undefined, duration?: string): NoteImage[] {
  const id = youTubeId(url);
  if (!id) return [];
  const base = `https://i.ytimg.com/vi/${id}/`;
  const total = durationSeconds(duration);
  const at = (part: number, words: string) =>
    total ? `frame near [${clockOf(Math.round(total * part))}]` : `frame ${words}`;
  return [
    { url: `${base}hqdefault.jpg`, label: 'cover' },
    { url: `${base}hq1.jpg`, label: at(0.25, 'about a quarter into the video') },
    { url: `${base}hq2.jpg`, label: at(0.5, 'about halfway') },
    { url: `${base}hq3.jpg`, label: at(0.75, 'about three quarters in') },
  ];
}

/** The 11-character id of a YouTube link, or null. */
export function youTubeVideoId(url: string | undefined): string | null {
  return youTubeId(url);
}

function durationSeconds(text: string | undefined): number {
  const parts = String(text || '')
    .trim()
    .split(':')
    .map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function clockOf(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

function youTubeId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\.|^m\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = parsed.pathname.slice(1);
    else if (host === 'youtube.com' || host === 'music.youtube.com') {
      id =
        parsed.searchParams.get('v') ||
        parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1] ||
        null;
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The prompt version a request is cached under: the prompt, plus the style when there is one. */
export function promptVersionFor(style: string | undefined): string {
  const text = (style || '').trim();
  if (!text) return NOTE_PROMPT_VERSION;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${NOTE_PROMPT_VERSION}+style-${(hash >>> 0).toString(16)}`;
}

/** Times written as [12:34] or [1:02:03] become links to that second of the video. */
export function linkTimestamps(note: string, url: string | undefined): string {
  const link = timeLinker(url);
  if (!link) return note;
  // Code and diagrams stay as written: the odd parts of a split on fences are inside one.
  return note
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(
            /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\](?!\()/g,
            (match: string, a: string, b: string, c: string | undefined) => {
              const seconds = c ? +a * 3600 + +b * 60 + +c : +a * 60 + +b;
              return `[${match.slice(1, -1)}](${link(seconds)})`;
            },
          ),
    )
    .join('');
}

function timeLinker(url: string | undefined): ((seconds: number) => string) | null {
  const id = youTubeId(url);
  if (id) return (s) => `https://www.youtube.com/watch?v=${id}&t=${s}`;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (/(^|\.)bilibili\.com$/.test(parsed.hostname) && /^\/video\//.test(parsed.pathname)) {
      const page = parsed.searchParams.get('p');
      const base = `https://www.bilibili.com${parsed.pathname.replace(/\/$/, '')}`;
      return (s) => `${base}?${page ? `p=${page}&` : ''}t=${s}`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * A table needs a blank line before it, or Obsidian shows its pipes as text; models often
 * put one right under a bold line. Code and diagrams stay as written.
 */
export function separateTables(note: string): string {
  return note
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      const lines = part.split('\n');
      const out: string[] = [];
      lines.forEach((line, i) => {
        const prev = i > 0 ? lines[i - 1] : '';
        const isRow = /^\s*\|/.test(line);
        const prevRow = /^\s*\|/.test(prev);
        if (isRow && !prevRow && prev.trim() && !/^\s*>/.test(line)) out.push('');
        if (!isRow && prevRow && line.trim() && !/^\s*>/.test(prev)) out.push('');
        out.push(line);
      });
      return out.join('\n');
    })
    .join('');
}
