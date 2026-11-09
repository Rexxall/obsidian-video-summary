import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyDefaultProperties, parseDefaultProperties } from '../utils/noteProperties';
import {
  normalizeSuccessStatusText,
  shouldMirrorStatus,
  writePluginStatus,
} from '../utils/successStatus';

void test('default properties parse one name: value per line', () => {
  const parsed = parseDefaultProperties(
    [
      'learning_status: raw',
      'tags: Type/笔记/视频笔记, #C/待分类',
      '',
      '# a comment line',
      'not a property',
      'tldr:',
      'tags: Type/笔记/视频笔记, Tool/VideoSummary',
      '学习状态: 待学',
    ].join('\n'),
  );
  assert.deepEqual(parsed, [
    { key: 'learning_status', values: ['raw'], list: false },
    {
      key: 'tags',
      values: ['Type/笔记/视频笔记', 'C/待分类', 'Tool/VideoSummary'],
      list: true,
    },
    { key: '学习状态', values: ['待学'], list: false },
  ]);
});

void test('default properties never shadow fields the plugin owns', () => {
  const parsed = parseDefaultProperties(
    ['status: ❌', 'video_title: x', 'summary: y', 'link: z', 'learning_status: raw'].join('\n'),
  );
  assert.deepEqual(
    parsed.map((property) => property.key),
    ['learning_status'],
  );
});

void test('applying defaults fills gaps, keeps existing values and merges tags', () => {
  const fm: Record<string, unknown> = {
    learning_status: 'to-learn',
    tldr: '',
    tags: ['C/艺术/音乐', 'Type/笔记/视频笔记'],
  };
  const changed = applyDefaultProperties(
    fm,
    parseDefaultProperties(
      'learning_status: raw\ntldr: 待补\ntags: Type/笔记/视频笔记, Tool/VideoSummary\naliases: 视频',
    ),
  );
  assert.equal(changed, true);
  assert.deepEqual(fm, {
    learning_status: 'to-learn',
    tldr: '待补',
    tags: ['C/艺术/音乐', 'Type/笔记/视频笔记', 'Tool/VideoSummary'],
    aliases: ['视频'],
  });
  // A second run changes nothing.
  assert.equal(
    applyDefaultProperties(fm, parseDefaultProperties('tags: Tool/VideoSummary')),
    false,
  );
});

void test('a single tag string becomes a list when a default tag is added', () => {
  const fm: Record<string, unknown> = { tags: 'C/医学' };
  applyDefaultProperties(fm, parseDefaultProperties('tags: Type/笔记/视频笔记'));
  assert.deepEqual(fm.tags, ['C/医学', 'Type/笔记/视频笔记']);
});

void test('the success text may be a vault mark such as ❌ but not a pending or running one', () => {
  assert.equal(normalizeSuccessStatusText('❌'), '❌');
  assert.equal(normalizeSuccessStatusText(' 已处理 '), '已处理');
  for (const reserved of ['pending', 'Running', 'error', '⏳', '处理中', '⛔️', '']) {
    assert.equal(normalizeSuccessStatusText(reserved), 'success', reserved);
  }
});

void test('success with a ❌ display mark keeps the plugin state readable as success', () => {
  const fm: Record<string, unknown> = { status: 'running', video_summary_status: 'running' };
  writePluginStatus(fm, 'success', '❌', '❌');
  assert.equal(fm.video_summary_status, 'success');
  assert.equal(fm.status, '❌');
  // Re-running the note moves status through the plugin states again.
  writePluginStatus(fm, 'running', 'running', '❌');
  assert.equal(fm.status, 'running');
});

void test('status values a person set by hand are kept', () => {
  for (const own of ['🔍', '✅', '▶️', '📌', 'reference']) {
    const fm: Record<string, unknown> = { status: own };
    writePluginStatus(fm, 'running', 'running', '❌');
    assert.equal(fm.status, own, own);
    assert.equal(fm.video_summary_status, 'running');
  }
  assert.equal(shouldMirrorStatus('已归档', '已归档'), true);
  assert.equal(shouldMirrorStatus(''), true);
});
