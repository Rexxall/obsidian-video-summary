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
 * A writing style for the vault theme "Ithaca 整本手账": its callout paper, margin notes,
 * receipts, photos and red pen. Offered as a preset in settings; the reader can edit it.
 */
export const ITHACA_NOTE_STYLE = [
  'The vault uses the theme "Ithaca 整本手账". Use its elements wherever they fit; each draws something different on the page.',
  '- Headings: no emoji; the theme numbers the ## headings itself.',
  '- The summary callout is titled "核心摘要".',
  '- The single most important conclusion, or a common misconception the video corrects: one "> [!important] <short title>" callout (black paper).',
  '- The one or two best concrete examples (a story, an experiment, a case): "> [!example] <short name>", 2 or 3 sentences each, under the section they prove (taped slips of paper).',
  '- Short background (who a person is, a date, where a study comes from): footnotes [^1] with the text at the end; the theme moves them into the right margin in handwriting. A longer mechanism a reader may skip: a folded "> [!info]- <topic>" callout.',
  '- Your own thoughts as handwritten margin notes right after the line they are about: <span class="ih-mg">a short sentence</span> for a connection or open question; <span class="ih-mg is-red">a short sentence</span> in red pen where the argument is weak, overstated or lacks evidence; <span class="ih-mg ih-sticky">a few words</span> for something small to try. At most three in all, and none when nothing is worth saying.',
  '- Things to do from the video: one "> [!todo] 行动清单" callout with "- [ ]" items. A question the video leaves open: one "> [!question] 留给自己的问题" callout. Both only when the video gives them.',
  '- Quotes: "> [!receipt] 原话" callouts at the end, one line each, with its time; a translation on the next line when the languages differ.',
  '- Pictures: the cover as ![照片 right <channel>|260](url) under the summary; a frame as ![照片 <what is happening>|320](url) in the section it belongs to.',
  '- Between two big parts you may put a line with --- (a ❧ ornament); at most twice.',
  '- Put <span class="ih-circ">...</span> around the single most important phrase of the note, once. ==highlight== at most two other phrases.',
].join('\n');

/** The cover and three frames YouTube keeps for every video (about a quarter, half and three quarters in). */
export function noteImagesFor(url: string | undefined): NoteImage[] {
  const id = youTubeId(url);
  if (!id) return [];
  const base = `https://i.ytimg.com/vi/${id}/`;
  return [
    { url: `${base}hqdefault.jpg`, label: 'cover' },
    { url: `${base}hq1.jpg`, label: 'frame about a quarter into the video' },
    { url: `${base}hq2.jpg`, label: 'frame about halfway' },
    { url: `${base}hq3.jpg`, label: 'frame about three quarters in' },
  ];
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
