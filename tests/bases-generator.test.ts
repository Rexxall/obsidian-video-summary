import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from 'js-yaml';
import {
  VIDEO_SUMMARY_BASE_MARKER,
  generateVideoSummaryBase,
  normalizeVideoSummaryBaseFolder,
  parseManagedBaseHeader,
  upsertVideoSummaryBase,
} from '../core/BasesGenerator';

test('generated .base is valid YAML with standard properties and five table views', () => {
  const content = generateVideoSummaryBase({ folder: 'Video Inbox' });
  const parsed = load(content) as any;

  assert.ok(parsed && typeof parsed === 'object');
  assert.ok(parsed.filters);
  assert.ok(parsed.properties);
  assert.equal(parsed.properties.video_summary.displayName, 'Video Summary');
  assert.equal(parsed.properties.source_type.displayName, 'Source Type');
  assert.equal(parsed.properties.video_summary_status.displayName, 'Status');
  assert.equal(parsed.properties.video_review_due.displayName, 'Review Due');
  assert.equal(parsed.properties.video_learning_items.displayName, 'Learning Items');
  assert.deepEqual(
    parsed.views.map((view: any) => view.name),
    ['Inbox', 'Processing', 'Ready', 'Error', 'Review'],
  );
  assert.ok(parsed.views.every((view: any) => view.type === 'table'));

  const serialized = JSON.stringify(parsed);
  assert.match(serialized, /video_summary == true/);
  assert.match(serialized, /source_type == \\"video\\"/);
  assert.match(serialized, /video_summary_status == \\"inbox\\"/);
  assert.match(serialized, /video_summary_status == \\"pending\\"/);
  assert.match(serialized, /video_summary_status == \\"processing\\"/);
  assert.match(serialized, /video_summary_status == \\"running\\"/);
  assert.match(serialized, /video_summary_status == \\"ready\\"/);
  assert.match(serialized, /video_summary_status == \\"success\\"/);
  assert.match(serialized, /video_artifact_id != null/);
  assert.match(serialized, /video_summary_status == \\"error\\"/);
  assert.match(serialized, /video_review_due <= now\(\)/);
  assert.doesNotMatch(serialized, /video_review_due <= today\(\)/);
  assert.doesNotMatch(serialized, /video_learning_items > 0/);
  assert.match(serialized, /file\.inFolder\(\\"Video Inbox\\"\)/);
});

test('upsert creates missing files and leaves current managed output unchanged', () => {
  const created = upsertVideoSummaryBase(null);
  const unchanged = upsertVideoSummaryBase(created.content);

  assert.equal(created.status, 'created');
  assert.ok(created.content.startsWith(VIDEO_SUMMARY_BASE_MARKER));
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.content, created.content);
});

test('upsert preserves unmarked user-authored Bases by default', () => {
  const custom = [
    'filters:',
    '  and:',
    `    - 'file.inFolder("My Custom Folder")'`,
    'views:',
    '  - type: cards',
    '    name: My layout',
    '',
  ].join('\n');
  const result = upsertVideoSummaryBase(custom);

  assert.equal(result.status, 'preserved');
  assert.equal(result.content, custom);
  assert.notEqual(result.generated_content, custom);
  assert.match(result.reason, /保留用户文件/);
});

test('upsert detects manual edits to a managed Base and requires explicit replacement', () => {
  const generated = generateVideoSummaryBase();
  const modified = `${generated}# user custom column\n`;
  const preserved = upsertVideoSummaryBase(modified);
  const replaced = upsertVideoSummaryBase(modified, {}, 'replace-managed');

  assert.equal(parseManagedBaseHeader(modified)?.version, 1);
  assert.equal(preserved.status, 'preserved');
  assert.equal(preserved.content, modified);
  assert.match(preserved.reason, /用户修改/);
  assert.equal(replaced.status, 'updated');
  assert.equal(replaced.content, generated);
});

test('force is the only strategy that replaces an unmarked custom Base', () => {
  const custom = 'views:\n  - type: cards\n    name: Mine\n';
  const forced = upsertVideoSummaryBase(custom, {}, 'force');

  assert.equal(forced.status, 'updated');
  assert.notEqual(forced.content, custom);
  assert.ok(forced.content.startsWith(VIDEO_SUMMARY_BASE_MARKER));
});

test('Base folder validation rejects traversal before any Vault write adapter is involved', () => {
  assert.equal(normalizeVideoSummaryBaseFolder('Videos//Courses/'), 'Videos/Courses');
  assert.equal(normalizeVideoSummaryBaseFolder(''), '');
  assert.throws(() => normalizeVideoSummaryBaseFolder('../Outside'), /safe vault-relative/);
  assert.throws(() => normalizeVideoSummaryBaseFolder('Videos/./Course'), /safe vault-relative/);
  assert.throws(
    () => normalizeVideoSummaryBaseFolder('/Users/example/Videos'),
    /safe vault-relative/,
  );
  assert.throws(() => normalizeVideoSummaryBaseFolder('C:\\Videos'), /safe vault-relative/);
});
