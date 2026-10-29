import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKEND_ROUTE_CONFIDENCE_THRESHOLD,
  buildContentRoutingPromptContract,
  CONTENT_PROMPT_PROFILES,
  LOCAL_ROUTE_MARGIN_THRESHOLD,
  resolveContentRoute,
  VIDEO_CONTENT_TYPES,
} from '../core/ContentRouter';
import { normalizeRichProcessingResult } from '../core/KnowledgeModel';

void test('Chinese tutorial fixture combines title, transcript, chapters, and structure', () => {
  const route = resolveContentRoute({
    title: '零基础教程：从零开始部署本地服务',
    author: '开源开发者工坊',
    transcript: [
      '准备工作：你需要 Node.js 和一个空目录。',
      '首先打开终端并安装依赖。',
      '接下来创建配置文件，然后运行服务。',
      '最后检查是否出现 ready。',
      '如果启动失败，按下面的方法排错并重新验证。',
    ].join('\n'),
    chapters: ['准备工作', '步骤 1 安装', '步骤 2 配置', '验证与排错'],
  });

  assert.equal(route.type, 'tutorial');
  assert.equal(route.source, 'local');
  assert.ok(route.confidence >= 0.6);
  assert.equal(route.prompt_profile.id, 'video-content-tutorial-v1');
  assert.ok(route.reasons.some((reason) => reason.signal === 'title'));
  assert.ok(route.reasons.some((reason) => reason.signal === 'transcript'));
  assert.ok(route.reasons.some((reason) => reason.signal === 'chapter'));
  assert.ok(route.reasons.some((reason) => reason.signal === 'structure'));
});

void test('English interview fixture preserves a multi-role question-and-answer signal', () => {
  const route = resolveContentRoute({
    title: 'Interview with a Neuroscience Researcher',
    author: 'The Research Talks Podcast',
    transcript: [
      'Host: Thanks for joining us.',
      'Guest: In my experience, reproducibility starts with the data model.',
      'Interviewer: Let me ask about your first study?',
      'Guest: From my perspective, the main limitation was sample size.',
      'Host: My next question is about replication?',
      'Guest: We changed the protocol in response.',
    ].join('\n'),
    chapters: ['Guest background', 'Questions about the study', 'Career experience'],
  });

  assert.equal(route.type, 'interview');
  assert.equal(route.source, 'local');
  assert.ok((route.candidate_scores?.interview || 0) > (route.candidate_scores?.course || 0));
});

void test('Japanese meeting fixture resolves decisions and action items as meeting structure', () => {
  const route = resolveContentRoute({
    title: '研究チーム 定例会議 議事録',
    author: '脳科学プロジェクトチーム',
    transcript: [
      '本日の議題はデータ収集と解析です。',
      '解析方法を変更することに合意しました。',
      'アクションアイテム一つ目、担当は田中さん、期限は金曜日です。',
      '次のアクションアイテムは資料更新、担当は佐藤さん、期限は来週です。',
    ].join('\n'),
    chapters: ['議題', '議論', '決定', 'アクションアイテムと次のステップ'],
  });

  assert.equal(route.type, 'meeting');
  assert.equal(route.source, 'local');
  assert.ok(route.confidence >= 0.6);
});

void test('a manual type always overrides backend and strong local evidence', () => {
  const route = resolveContentRoute({
    requestedType: 'course',
    backendType: 'news',
    backendConfidence: 0.99,
    title: 'Step-by-step deployment tutorial',
    transcript: 'First install it. Next configure it. Finally verify it.',
  });

  assert.equal(route.type, 'course');
  assert.equal(route.source, 'manual');
  assert.equal(route.confidence, 1);
  assert.equal(route.prompt_profile.content_type, 'course');
});

void test('a valid confident rich backend type wins, while its provenance remains explicit', () => {
  const route = resolveContentRoute({
    requestedType: 'auto',
    backendType: 'interview',
    backendConfidence: 92,
    backendReasons: ['Speaker turns and Q&A structure were returned by the backend.'],
    title: 'How to install a package',
    transcript: 'First click install. Next verify the result.',
  });

  assert.equal(route.type, 'interview');
  assert.equal(route.source, 'backend');
  assert.equal(route.confidence, 0.92);
  assert.ok(route.reasons.every((reason) => reason.signal === 'backend'));
});

void test('explicitly low backend confidence is rejected and weak local evidence falls back to general', () => {
  const route = resolveContentRoute({
    backendType: 'news',
    backendConfidence: BACKEND_ROUTE_CONFIDENCE_THRESHOLD - 0.01,
    title: 'News',
    transcript: 'A short unstructured personal update.',
  });

  assert.equal(route.type, 'general');
  assert.equal(route.source, 'fallback');
  assert.ok(route.reasons.some((reason) => reason.signal === 'backend'));
  assert.ok(route.reasons.some((reason) => reason.message.includes('关键词不单独决定类型')));
});

void test('a backend type without explicit confidence cannot override stronger local evidence', () => {
  const route = resolveContentRoute({
    backendType: 'news',
    title: 'Step-by-step deployment tutorial',
    transcript:
      'First install the package. Next configure it. Finally verify the result and troubleshoot errors.',
    chapters: ['Prerequisites', 'Install', 'Configure', 'Verify and troubleshoot'],
  });

  assert.equal(route.type, 'tutorial');
  assert.equal(route.source, 'local');
  assert.ok(route.reasons.some((reason) => reason.message.includes('没有显式置信度')));
});

void test('one title keyword is a weak cue, not an absolute classification fact', () => {
  const route = resolveContentRoute({
    title: 'Tutorial',
    transcript: 'Today I want to share a few unrelated thoughts.',
  });

  assert.equal(route.type, 'general');
  assert.equal(route.source, 'fallback');
  assert.ok((route.candidate_scores?.tutorial || 0) > 0);
});

void test('strong but conflicting tutorial and review cues remain general when the margin is small', () => {
  const route = resolveContentRoute({
    title: 'Step-by-step Tutorial Review and Comparison',
    transcript: [
      'You will need the product and the app.',
      'First open settings, next install the update, then run the test, finally verify the result.',
      'The pros and cons depend on price, value and benchmark results.',
      'Our verdict explains whether it is worth buying and who should use it.',
    ].join('\n'),
    chapters: ['Step 1 Setup', 'Step 2 Test', 'Performance and price', 'Pros, cons and verdict'],
  });

  const tutorial = route.candidate_scores?.tutorial || 0;
  const review = route.candidate_scores?.review || 0;
  assert.equal(route.type, 'general');
  assert.ok(Math.abs(tutorial - review) < LOCAL_ROUTE_MARGIN_THRESHOLD);
});

void test('disabled auto routing without a manual type returns a deterministic general decision', () => {
  const route = resolveContentRoute({
    requestedType: 'auto',
    autoRoute: false,
    title: 'Full course lecture 1',
    transcript: 'Learning objectives, concepts, exercises and recap.',
  });

  assert.equal(route.type, 'general');
  assert.equal(route.source, 'fallback');
  assert.equal(route.confidence, 1);
});

void test('all seven prompt profiles expose distinct required section schemas and evidence guardrails', () => {
  assert.deepEqual(Object.keys(CONTENT_PROMPT_PROFILES).sort(), [...VIDEO_CONTENT_TYPES].sort());
  const profileIds = new Set<string>();
  const sectionSignatures = new Set<string>();

  for (const type of VIDEO_CONTENT_TYPES) {
    const profile = CONTENT_PROMPT_PROFILES[type];
    profileIds.add(profile.id);
    assert.equal(profile.content_type, type);
    assert.equal(profile.output_schema.properties.content_type.const, type);
    assert.ok(profile.output_schema.required.includes('sections'));
    assert.ok(profile.output_schema.required.includes('evidence_claims'));
    assert.deepEqual(
      profile.output_schema.properties.sections.required,
      profile.sections.filter((section) => section.required).map((section) => section.key),
    );
    assert.ok(profile.sections.every((section) => section.key && section.purpose));
    assert.ok(profile.guardrails.some((rule) => rule.includes('关键词')));
    assert.ok(profile.guardrails.some((rule) => rule.includes('evidence_segment_ids')));
    sectionSignatures.add(profile.sections.map((section) => section.key).join('|'));
  }

  assert.equal(profileIds.size, VIDEO_CONTENT_TYPES.length);
  assert.equal(sectionSignatures.size, VIDEO_CONTENT_TYPES.length);
});

void test('prompt contract sends one profile for manual routing and all profiles for auto routing', () => {
  const manual = buildContentRoutingPromptContract('review', true);
  assert.equal(manual.requested_type, 'review');
  assert.deepEqual(
    manual.profiles.map((profile) => profile.content_type),
    ['review'],
  );

  const automatic = buildContentRoutingPromptContract('auto', true);
  assert.equal(automatic.fallback_type, 'general');
  assert.deepEqual(
    automatic.profiles.map((profile) => profile.content_type),
    VIDEO_CONTENT_TYPES,
  );
  assert.ok(automatic.policies.some((policy) => policy.includes('单个关键词')));
});

void test('KnowledgeModel enforces manual precedence and records selected routing provenance', () => {
  const result = normalizeRichProcessingResult(
    {
      video_title: 'Breaking news report',
      video_transcript: 'According to officials, this is a developing story.',
    },
    {
      content_type: 'news',
      content_routing: {
        confidence: 0.98,
        reasons: ['Backend classified this as news.'],
      },
    },
    {
      requestedContentType: 'tutorial',
      autoRoute: true,
      promptVersion: 'fixture-v1',
    },
  );

  assert.equal(result.content_type, 'tutorial');
  assert.equal(result.content_routing?.source, 'manual');
  assert.equal(result.artifact?.prompt_profile, 'video-content-tutorial-v1');
  assert.equal(result.artifact?.content_routing?.source, 'manual');
  assert.equal(result.artifact?.content_routing?.prompt_profile, 'video-content-tutorial-v1');
});

void test('KnowledgeModel uses local fallback when backend content type is absent', () => {
  const result = normalizeRichProcessingResult(
    {
      video_title: 'Interview with the lab director',
      video_author: 'Science Talks Podcast',
      video_transcript: [
        'Host: Thanks for joining.',
        'Guest: In my experience the protocol is robust.',
        'Interviewer: Let me ask the next question?',
        'Guest: From my perspective, replication is the priority.',
      ].join('\n'),
    },
    {},
    {
      requestedContentType: 'auto',
      autoRoute: true,
    },
  );

  assert.equal(result.content_type, 'interview');
  assert.equal(result.content_routing?.source, 'local');
  assert.equal(result.artifact?.content_routing?.source, 'local');
});
