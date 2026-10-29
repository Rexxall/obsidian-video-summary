import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoNoteContent, DEMO_NOTE_NAME } from '../core/DemoNote';
import { setInterfaceLanguage } from '../utils/i18n';

test('the demo note is marked as a demo and carries a full processed result', () => {
  const note = demoNoteContent();
  const frontmatter = note.slice(4, note.indexOf('\n---\n', 4));
  assert.match(frontmatter, /^video_summary_demo: true$/m);
  assert.match(frontmatter, /^source_type: demo$/m);
  assert.match(frontmatter, /^video_transcript: \|\n {2}主持人：/m);
  assert.match(note, /演示笔记，没有连接任何后端/);
  assert.match(
    note,
    /<!-- video-summary-generated:start -->[\s\S]+<!-- video-summary-generated:end -->/,
  );
  assert.equal(DEMO_NOTE_NAME(), '视频总结示例（演示，可删除）.md');
});

test('the demo note explains itself in English when Obsidian is in English', () => {
  setInterfaceLanguage('en');
  try {
    assert.match(demoNoteContent(), /This is a Video Summary demo note/);
    assert.equal(DEMO_NOTE_NAME(), 'Video Summary example (demo, safe to delete).md');
  } finally {
    setInterfaceLanguage('zh');
  }
});
