import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const bundle = fs.readFileSync(process.argv[2] || import.meta.dirname + '/main.js', 'utf8');
const ast = ts.createSourceFile(
  'bundle.js',
  bundle,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const names = [
  'cleanVideoScaffold',
  'renderTranscriptFold',
  'writeCleanVideoBody',
  'relinkVideoJobs',
  'writeManagedKnowledgeMarkdown',
  'parseTimestampPrefixedTranscript',
  'parseClock',
  'normalizeText2',
  'normalizeSource',
  'stableHash',
  'stableSegmentId',
  'buildTimestampUrl',
  'asText',
  'scalarText',
];
const context = { URL };
vm.createContext(context);
for (const name of names) {
  const node = ast.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(node, 'Shipped function: ' + name);
  vm.runInContext(node.getText(ast), context);
}
const block = (kind, text) =>
  `<!-- video-summary-${kind}:start -->\n${text}\n<!-- video-summary-${kind}:end -->`;
const scaffold =
  '# 临时标题\n\n## 基本信息\n- **视频链接**: （无）\n- **创建时间**: today\n- **处理状态**: 待处理\n\n## 笔记\n<!-- 个人笔记将在这里生成 -->\n\n## 文稿\n<!-- 视频文稿将在这里生成 -->\n\n';
const old =
  scaffold +
  block('generated', '旧总结') +
  '\n\n我的批注：保留 $&\n\n' +
  block('evidence', '重复文稿') +
  block('attention', '94%');
const result = { note: '作者观点 $&', video_transcript: '[00:00]甲[00:02]乙\n[00:05]丙' };
const clean = context.writeCleanVideoBody(old, result);
assert.ok(!/待处理|个人笔记将在|重复文稿|94%/.test(clean));
assert.ok(clean.includes('我的批注：保留 $&') && clean.includes('作者观点 $&'));
assert.equal(context.writeCleanVideoBody(clean, result), clean, 'Idempotent output');
assert.equal((clean.match(/原始文稿/g) || []).length, 1);
assert.ok(clean.includes('> [00:02]乙'));
const userEdited = scaffold.replace('<!-- 个人笔记将在这里生成 -->', '用户自己写的笔记');
assert.equal(context.cleanVideoScaffold(userEdited), userEdited);
const transcriptOnly = context.writeManagedKnowledgeMarkdown(
  clean,
  { video_transcript: '新文稿' },
  '',
  { updateGenerated: false, updateEvidence: true },
);
assert.ok(transcriptOnly.includes('作者观点 $&') && transcriptOnly.includes('新文稿'));
assert.equal(
  context.writeManagedKnowledgeMarkdown(old, result, '', {
    updateGenerated: false,
    updateEvidence: false,
  }),
  old,
);
const segments = context.parseTimestampPrefixedTranscript(result.video_transcript, '');
assert.deepEqual(
  JSON.parse(JSON.stringify(segments.map((s) => [s.start, s.end ?? null, s.text]))),
  [
    [0, 2, '甲'],
    [2, 5, '乙'],
    [5, null, '丙'],
  ],
);
assert.equal(new Set(segments.map((s) => s.id)).size, 3);
const jobs = [
  { id: 'one', notePath: 'old.md' },
  { id: 'two', notePath: 'else.md' },
];
const store = {
  getAll: () => jobs,
  update: (id, patch) =>
    Object.assign(
      jobs.find((j) => j.id === id),
      patch,
    ),
};
context.relinkVideoJobs(store, 'old.md', { path: 'new.md', basename: 'new' });
assert.equal(jobs[0].notePath, 'new.md');
assert.equal(jobs[0].title, 'new');
assert.equal(jobs[1].notePath, 'else.md');
const notices = [],
  opened = [],
  revealed = [];
class TFile {
  constructor(path) {
    this.path = path;
    this.basename = path.replace(/\.md$/, '');
  }
}
class ItemView {
  constructor() {
    this.app = context.app;
  }
}
// esbuild numbers the obsidian import per module; read the one the view class uses
context[bundle.match(/var VideoSummaryView = class extends (import_obsidian\d*)\.ItemView/)[1]] = {
  ItemView,
  TFile,
  Notice: class {
    constructor(message) {
      notices.push(message);
    }
  },
};
const file = new TFile('new.md');
const leaf = { openFile: async (f, options) => opened.push([f, options]) };
context.app = {
  vault: { getAbstractFileByPath: (p) => (p === file.path ? file : null) },
  workspace: { getLeaf: () => leaf, revealLeaf: async (l) => revealed.push(l) },
};
const start = bundle.lastIndexOf('// views/VideoSummaryView.ts\n');
const end = bundle.indexOf('\n// utils/FileProcessor.ts', start);
vm.runInContext(bundle.slice(start, end), context);
(async () => {
  const staleJob = {
    id: 'stale',
    notePath: 'old.md',
    result: { artifact: { artifact_id: 'artifact' } },
  };
  const plugin = {
    settings: {},
    jobs: { getAll: () => [staleJob], update: (_, patch) => Object.assign(staleJob, patch) },
    artifactStore: { load: async () => ({ source: { note_path: 'new.md' } }) },
  };
  const view = new context.VideoSummaryView({}, plugin);
  await view.openNote('old.md');
  assert.equal(opened[0][0], file);
  assert.equal(opened[0][1].active, true);
  assert.equal(revealed[0], leaf);
  assert.equal(staleJob.notePath, 'new.md');
  await view.openNote('missing.md');
  assert.equal(opened.length, 1, 'Missing file must not create a phantom note');
  assert.equal(notices.length, 1, 'Missing path is visible, not silent');
  process.stdout.write(
    'PASS: clean output, source preservation, inline captions, rename and navigation recovery\n',
  );
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
