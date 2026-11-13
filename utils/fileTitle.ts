const CJK = /[぀-ヿ㐀-鿿＀-￯]/;

/**
 * A video title as a file name people can still read. The characters Windows and macOS forbid
 * become what a person would write instead: "Asks: why?" → "Asks - why", and in Chinese or
 * Japanese the full-width forms (：？), which are allowed. Returns '' when nothing is left.
 */
export function fileTitle(title: string): string {
  const cjkBefore = (text: string, offset: number) =>
    CJK.test(text.slice(Math.max(0, offset - 1), offset));
  return (
    title
      // A clock time keeps its digits together: 12:30 → 12-30.
      .replace(/(\d):(\d)/g, '$1-$2')
      .replace(/\s*:\s*/g, (match, offset: number, text: string) =>
        cjkBefore(text, offset) ? '：' : ' - ',
      )
      .replace(/\?/g, (match, offset: number, text: string) =>
        cjkBefore(text, offset) ? '？' : '',
      )
      .replace(/\s*[/\\|]\s*/g, ' - ')
      .replace(/["<>*]/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s.-]+|[\s.]+$/g, '')
      .trim()
  );
}
