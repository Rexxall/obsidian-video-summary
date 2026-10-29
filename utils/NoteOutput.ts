/** Remove only the plugin's exact empty scaffold, never sections containing user text. */
export function cleanVideoScaffold(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n');
  return normalized.replace(
    /^\s*# [^\n]+\n+## 基本信息\n- \*\*视频链接\*\*: [^\n]*\n- \*\*创建时间\*\*: [^\n]*\n- \*\*处理状态\*\*: 待处理\n+(?:## 视频内容\n<!-- 视频总结将在这里生成 -->\n+)?## 笔记\n<!-- 个人笔记将在这里生成 -->\n+## 文稿\n<!-- 视频文稿将在这里生成 -->\s*/,
    '',
  );
}

/** A single folded source section; keep the source text, not a fabricated evidence claim. */
export function renderTranscriptFold(transcript: string): string {
  if (!transcript.trim()) return '';
  const lines = transcript
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/([^\n])(?=\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?\])/g, '$1\n');
  return (
    '> [!quote]- 原始文稿\n' +
    lines
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n')
  );
}

/** Replace only plugin-owned blocks; keep prose and annotations outside them intact. */
export function writeCleanVideoBody(
  body: string,
  result: { note?: string; summary?: string; video_transcript?: string },
  updateSummary = true,
): string {
  const replace = (text: string, kind: string, value: string) => {
    const start = `<!-- video-summary-${kind}:start -->`;
    const end = `<!-- video-summary-${kind}:end -->`;
    const regex = new RegExp(`${start}[\\s\\S]*?${end}`, 'g');
    const block = value.trim() ? `${start}\n${value.trim()}\n${end}` : '';
    if (regex.test(text)) return text.replace(regex, () => block);
    return block ? `${text.trimEnd()}\n\n${block}`.trimStart() : text;
  };
  let next = cleanVideoScaffold(body);
  // These diagnostics remain in the artifact/reader, not in the default note.
  next = replace(next, 'evidence', '');
  next = replace(next, 'attention', '');
  if (updateSummary && (result.note || result.summary)) {
    next = replace(next, 'generated', result.note || result.summary || '');
  }
  if (result.video_transcript?.trim()) {
    next = replace(next, 'transcript', renderTranscriptFold(result.video_transcript));
  }
  return next.trim() + '\n';
}

/** Automatic rename and user rename must update all live task links together. */
export function relinkVideoJobs(
  store: {
    getAll(): { id: string; notePath?: string }[];
    update(id: string, patch: { notePath: string; title: string }): void;
  },
  oldPath: string,
  file: { path: string; basename: string },
) {
  if (oldPath === file.path) return;
  for (const job of store.getAll()) {
    if (job.notePath === oldPath)
      store.update(job.id, { notePath: file.path, title: file.basename });
  }
}
