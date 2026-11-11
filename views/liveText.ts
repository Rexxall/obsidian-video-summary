/**
 * The Markdown being written, as text to read: no heading marks, callout markers,
 * highlight or bold marks, and table rows as "a · b".
 */
export function readableLive(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => {
      let text = line.replace(/^(\s*>)+\s?/, '');
      text = text.replace(/^\[![\w-]+\][-+]?\s*/, '');
      text = text.replace(/^#{1,6}\s+/, '');
      if (/^\|?\s*:?-{3,}/.test(text)) return null;
      if (/^\|.*\|\s*$/.test(text)) {
        text = text
          .replace(/^\||\|\s*$/g, '')
          .split('|')
          .map((cell) => cell.trim())
          .join(' · ');
      }
      return text.replace(/==([^=]+)==/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
    })
    .filter((line): line is string => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
