import { buildTimestampUrl, formatTimestamp } from './KnowledgeModel';

/** 默认引用格式：一行引用，后面跟可点回视频该时刻的链接 */
export const DEFAULT_QUOTE_TEMPLATE = '> {{text}} ({{link}})';

export interface QuoteSource {
  text: string;
  start: number | null;
  speaker?: string;
  sourceUrl?: string;
  title?: string;
  notePath?: string;
}

/**
 * 把一段文稿按模板变成 Markdown 引用。
 * 可用占位符：{{text}} {{time}} {{url}} {{link}} {{speaker}} {{title}} {{note}}。
 * {{link}} 有可跳转地址时是 [时间](地址)，否则只写时间；{{note}} 是指回结果笔记的双链。
 */
export function formatTranscriptQuote(template: string, source: QuoteSource): string {
  const text = source.text.replace(/\s+/g, ' ').trim();
  const time = formatTimestamp(source.start);
  const url = (source.sourceUrl && buildTimestampUrl(source.sourceUrl, source.start)) || '';
  const link = url ? `[${time}](${url})` : time;
  const noteTarget = (source.notePath || '').replace(/\.md$/i, '');
  const note = noteTarget ? `[[${noteTarget}|${source.title || noteTarget}]]` : '';
  const values: Record<string, string> = {
    text,
    time,
    url,
    link,
    speaker: source.speaker || '',
    title: source.title || '',
    note,
  };
  const body = (template.trim() ? template : DEFAULT_QUOTE_TEMPLATE).replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (match, key: string) => (key in values ? values[key] : match),
  );
  return body.replace(/\\n/g, '\n');
}
