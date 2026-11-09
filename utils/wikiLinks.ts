/**
 * Turns [[links]] whose target note does not exist into plain text, so an AI-written note does
 * not leave dangling links in the vault. Embeds (![[...]]), code blocks and inline code are left
 * alone. `[[target|shown]]` keeps the shown text; `[[target#heading]]` keeps the target name.
 */
export function unlinkMissingNotes(
  markdown: string,
  exists: (linkpath: string) => boolean,
): string {
  if (!markdown || !markdown.includes('[[')) return markdown;
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => (index % 2 === 1 ? part : unlinkPart(part, exists)))
    .join('');
}

function unlinkPart(text: string, exists: (linkpath: string) => boolean): string {
  return text.replace(
    /(!?)\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g,
    (match: string, bang: string, target: string, shown: string | undefined) => {
      if (bang) return match;
      const linkpath = target.split('#')[0].trim();
      if (!linkpath || exists(linkpath)) return match;
      const label = shown !== undefined && shown.trim() ? shown.trim() : target.trim();
      return label.replace(/#/g, ' › ');
    },
  );
}
