import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as yaml from 'js-yaml';
import {
  buildRichFrontmatterFields,
  escapeUntrustedMarkdownInline,
  renderAttentionMarkdown,
  renderEvidenceMarkdown,
  sanitizeGeneratedMarkdownActiveResources,
  serializeScalarFrontmatter,
  writeManagedKnowledgeMarkdown,
} from '../core/KnowledgeMarkdown';
import type { ProcessingResult } from '../types';

const SOURCE_URL = 'https://www.youtube.com/watch?v=markdown-contract';

test('model-authored Markdown cannot auto-load remote or embedded resources', () => {
  const input = [
    '普通 [链接](https://example.com/page) 保留。',
    '![追踪像素](http://127.0.0.1:8787/private.png)',
    '![[Vault/Secret.png]]',
    '<img src="https://example.com/pixel.png">',
    '<iframe src="https://example.com/frame"></iframe>',
    '<svg><image href="https://example.com/vector.png"></image></svg>',
    '\\\\![偶数反斜杠](http://127.0.0.1:8787/private.png)',
    '<div style="background-image:url(http://127.0.0.1:8787/private.png)">背景</div>',
  ].join('\n');
  const safe = sanitizeGeneratedMarkdownActiveResources(input);

  assert.match(safe, /\[链接\]\(https:\/\/example\.com\/page\)/);
  assert.doesNotMatch(safe, /!/);
  assert.doesNotMatch(safe, /</);
  assert.match(safe, /&#33;\[追踪像素\]/);
  assert.match(safe, /&lt;img/);
  assert.match(safe, /&lt;div style=/);

  const inline = escapeUntrustedMarkdownInline(
    '标题 ![像素](http://127.0.0.1/p.png)\n<div style="background:url(http://127.0.0.1)">',
  );
  assert.doesNotMatch(inline, /[!<\n]/);
  assert.match(inline, /&#33;\\\[像素\\\]/);
});

test('with diagnostics on, new rich notes contain all four marker-delimited managed blocks', () => {
  const markdown = writeManagedKnowledgeMarkdown('', richResult('第一版总结'), SOURCE_URL, {
    includeDiagnostics: true,
  });

  for (const kind of ['generated', 'evidence', 'attention', 'learning']) {
    assert.equal(count(markdown, `<!-- video-summary-${kind}:start -->`), 1);
    assert.equal(count(markdown, `<!-- video-summary-${kind}:end -->`), 1);
  }
  assert.match(markdown, /第一版总结/);
  assert.match(markdown, /## 证据地图/);
  assert.match(markdown, /## 观看价值判断/);
  assert.match(markdown, /## 学习练习/);
});

test('reprocessing replaces only managed blocks and preserves user-authored Markdown', () => {
  const generated = writeManagedKnowledgeMarkdown('', richResult('将被替换的旧总结'), SOURCE_URL);
  const userMarkdown = [
    '',
    '## 我的笔记',
    '这是我追加的段落，含 [[手工链接|别名]]。',
    '- [ ] 我自己的任务',
    '- ==我自己的高亮==',
    '',
    '',
    '> 用户保留的引用',
    '',
  ].join('\n');
  const before = `${generated}${userMarkdown}`;

  const after = writeManagedKnowledgeMarkdown(before, richResult('重处理后的新总结'), SOURCE_URL);

  assert.doesNotMatch(after, /将被替换的旧总结/);
  assert.match(after, /重处理后的新总结/);
  assert.ok(after.endsWith(userMarkdown), 'user-authored suffix must remain byte-for-byte intact');
  assert.match(after, /\[\[手工链接\|别名\]\]/);
  assert.match(after, /- \[ \] 我自己的任务/);
  assert.match(after, /==我自己的高亮==/);
  assert.equal(count(after, '<!-- video-summary-generated:start -->'), 1);
  assert.equal(count(after, '<!-- video-summary-evidence:start -->'), 0);
});

test('by default a note gets the summary and learning blocks, not diagnostics', () => {
  const markdown = writeManagedKnowledgeMarkdown('', richResult('默认总结'), SOURCE_URL);
  assert.equal(count(markdown, '<!-- video-summary-generated:start -->'), 1);
  assert.equal(count(markdown, '<!-- video-summary-learning:start -->'), 1);
  assert.equal(count(markdown, '<!-- video-summary-evidence:start -->'), 0);
  assert.equal(count(markdown, '<!-- video-summary-attention:start -->'), 0);
  assert.match(markdown, /默认总结/);
});

test('untimed material never renders a fabricated clickable 0:00 timestamp', () => {
  const result: ProcessingResult = {
    summary: '无时间材料',
    timing_quality: 'none',
    video_segments: [
      {
        id: 'untimed-segment',
        start: null,
        text: '只有文字，没有时间轴。',
        source: 'speech',
        timing_quality: 'none',
      },
    ],
    evidence_claims: [
      {
        id: 'defensive-zero-claim',
        claim: '即使异常载荷给了零，也不能伪装成可靠时间。',
        start: 0,
        evidence: [{ segment_id: 'untimed-segment', source: 'speech' }],
      },
    ],
    visual_evidence: [
      {
        id: 'defensive-zero-visual',
        start: 0,
        description: '未对齐画面',
      },
    ],
    attention: {
      action: 'skim',
      rationale: '只有文本可用。',
      must_watch: [{ start: 0, end: 30, reason: '异常的未对齐范围' }],
    },
  };

  const markdown = [
    renderEvidenceMarkdown(result, SOURCE_URL),
    renderAttentionMarkdown(result, SOURCE_URL),
  ].join('\n');

  assert.doesNotMatch(markdown, /\[0:00(?:–[^\]]+)?\]\(/);
  assert.doesNotMatch(markdown, /[?&]t=0s/);
  assert.doesNotMatch(markdown, /0:00/);
  assert.match(markdown, /文本证据/);
  assert.match(markdown, /时间未对齐/);
});

test('evidence block ids are stable across identical renders and distinct for unicode ids', () => {
  const first = richResult('稳定 ID');
  first.evidence_claims = [
    {
      id: '核心论点一',
      claim: '第一个主张',
      evidence: [{ segment_id: 'segment-core', source: 'speech' }],
    },
    {
      id: '核心论点二',
      claim: '第二个主张',
      evidence: [{ segment_id: 'segment-core', source: 'speech' }],
    },
  ];

  const renderedOnce = renderEvidenceMarkdown(first, SOURCE_URL);
  const renderedTwice = renderEvidenceMarkdown(first, SOURCE_URL);
  const idsOnce = claimBlockIds(renderedOnce);
  const idsTwice = claimBlockIds(renderedTwice);

  assert.deepEqual(idsOnce, idsTwice);
  assert.equal(idsOnce.length, 2);
  assert.notEqual(idsOnce[0], idsOnce[1]);
});

test('only localized worker keyframes render inline', () => {
  const result = richResult('真实关键帧');
  result.visual_evidence = [
    {
      id: 'visual-remote',
      start: 14,
      description: '由真实抽帧支持的画面说明。',
      keyframe: {
        id: 'frame-000014000',
        path: '/private/tmp/codex-video-worker/frame-000014000.jpg',
        url: 'http://127.0.0.1:8787/video-summary/assets/visual-abc/frame-000014000.jpg',
        mime_type: 'image/jpeg',
      },
    },
    {
      id: 'visual-localized',
      start: 16,
      description: '已经过哈希和根目录校验的本地化画面。',
      keyframe: {
        id: 'frame-000016000',
        path: '课程/_video-summary-assets/artifact-visual-test/frame-000016000.jpg',
        mime_type: 'image/jpeg',
      },
    },
  ];

  const markdown = renderEvidenceMarkdown(result, SOURCE_URL);

  assert.doesNotMatch(markdown, /127\.0\.0\.1/);
  assert.doesNotMatch(markdown, /!\[\[\/private\/tmp/);
  assert.match(
    markdown,
    /!\[\[课程\/_video-summary-assets\/artifact-visual-test\/frame-000016000\.jpg\]\]/,
  );
});

test('rich frontmatter projects only scalar values and round-trips as safe YAML', () => {
  const result = richResult('第一行\n第二行: #仍是总结文本');
  result.video_title = '标题: [需要安全转义]\n下一行';
  result.video_author = '作者 #1';
  result.video_transcript = '文稿第一行\n---\n文稿第三行';
  result.artifact = {
    ...result.artifact!,
    warnings: ['不应写入 frontmatter 的数组'],
  };

  const fields = buildRichFrontmatterFields(result);
  for (const value of Object.values(fields)) {
    assert.ok(
      value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean',
    );
  }
  assert.equal('artifact' in fields, false);
  assert.equal('attention' in fields, false);
  assert.equal('learning' in fields, false);
  assert.equal(fields.video_learning_items, 2);
  assert.equal('evidence_claims' in fields, false);

  const serialized = serializeScalarFrontmatter({
    video_summary: true,
    source_type: 'video',
    ...fields,
  });
  const parsed = yaml.load(serialized) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    video_summary: true,
    source_type: 'video',
    ...fields,
  });
  assert.throws(
    () =>
      serializeScalarFrontmatter({
        unsafe: ['nested'] as unknown as string,
      }),
    /must be a scalar value/,
  );
});

function richResult(summary: string): ProcessingResult {
  return {
    summary,
    note: `# 自动生成内容\n\n${summary}`,
    video_title: '契约测试视频',
    video_author: '测试作者',
    video_duration: '12:34',
    video_cover: 'https://example.com/cover.jpg',
    video_transcript: '[00:12] 这是核心证据。',
    timing_quality: 'exact',
    video_segments: [
      {
        id: 'segment-core',
        start: 12,
        end: 18,
        text: '这是核心证据。',
        source: 'speech',
        timing_quality: 'exact',
      },
    ],
    evidence_claims: [
      {
        id: 'claim-core',
        claim: '核心主张有原文支持。',
        evidence: [
          {
            segment_id: 'segment-core',
            source: 'speech',
            quote: '这是核心证据。',
          },
        ],
      },
    ],
    visual_evidence: [
      {
        id: 'visual-core',
        start: 14,
        description: '屏幕展示关键图表。',
        ocr_text: '关键指标',
      },
    ],
    content_type: 'course',
    attention: {
      action: 'watch',
      score: 0.88,
      confidence: 0.9,
      rationale: '信息密度高。',
      must_watch: [{ start: 12, end: 18, reason: '核心论证' }],
    },
    learning: {
      flashcards: [
        {
          id: 'card-core',
          front: '核心主张是什么？',
          back: '核心主张有原文支持。',
          evidence_segment_ids: ['segment-core'],
        },
      ],
      questions: [
        {
          id: 'question-core',
          prompt: '哪一项最准确？',
          choices: ['A', 'B'],
          answer: 'A',
        },
      ],
      feynman_prompts: ['用自己的话解释核心主张。'],
    },
    artifact: {
      schema_version: 3,
      artifact_id: 'artifact-contract',
      processing_depth: 'evidence',
      media_asset_root: '课程/_video-summary-assets',
      warnings: ['测试限制'],
    },
  };
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function claimBlockIds(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.includes('主张'))
    .map((line) => line.match(/\s\^([a-zA-Z0-9_-]+)$/)?.[1])
    .filter((value): value is string => !!value);
}
