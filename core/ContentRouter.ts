import type {
  ContentPromptOutputSchema,
  ContentPromptProfile,
  ContentPromptSection,
  ContentRoutingDecision,
  ContentRoutingReason,
  RequestedContentType,
  VideoContentType,
} from '../types';

import { scalarText } from '../utils/json';
export const CONTENT_ROUTER_CONTRACT_VERSION = 'content-routing-v1';
export const LOCAL_ROUTE_SCORE_THRESHOLD = 0.52;
export const LOCAL_ROUTE_MARGIN_THRESHOLD = 0.08;
export const BACKEND_ROUTE_CONFIDENCE_THRESHOLD = 0.55;

const ROUTABLE_TYPES: Exclude<VideoContentType, 'general'>[] = [
  'course',
  'interview',
  'tutorial',
  'news',
  'meeting',
  'review',
];

export const VIDEO_CONTENT_TYPES: VideoContentType[] = [...ROUTABLE_TYPES, 'general'];

export interface ContentRouteInput {
  requestedType?: string;
  autoRoute?: boolean;
  backendType?: unknown;
  backendConfidence?: unknown;
  backendReasons?: unknown;
  title?: string;
  author?: string;
  transcript?: string;
  chapters?: unknown;
}

export interface ContentRoutingPromptContract {
  contract_version: string;
  requested_type: RequestedContentType;
  auto_route: boolean;
  allowed_types: VideoContentType[];
  fallback_type: 'general';
  minimum_local_score: number;
  minimum_margin: number;
  policies: string[];
  profiles: ContentPromptProfile[];
}

interface Cue {
  pattern: RegExp;
  label: string;
}

interface CueSet {
  title?: Cue[];
  author?: Cue[];
  transcript?: Cue[];
  chapter?: Cue[];
}

interface WeightedCandidate {
  type: Exclude<VideoContentType, 'general'>;
  score: number;
  reasons: ContentRoutingReason[];
}

const CHANNEL_WEIGHTS = {
  title: { perCue: 0.13, cap: 0.26 },
  author: { perCue: 0.07, cap: 0.07 },
  transcript: { perCue: 0.09, cap: 0.27 },
  chapter: { perCue: 0.12, cap: 0.24 },
} as const;

const CUES: Record<Exclude<VideoContentType, 'general'>, CueSet> = {
  course: {
    title: [
      cue(/\b(?:course|lecture|class|seminar)\b|课程|講義|授業|セミナー/i, '课程或讲授形式'),
      cue(
        /\b(?:lesson|module|week)\s*\d+\b|第\s*\d+\s*(?:课|講|回|章)|第[一二三四五六七八九十]+课/i,
        '连续课次或模块编号',
      ),
      cue(/\bsyllabus\b|教学大纲|シラバス|学習目標/i, '教学大纲或学习目标'),
    ],
    author: [
      cue(/\b(?:academy|university|school|education)\b|大学|学院|教育|アカデミー/i, '教育机构署名'),
    ],
    transcript: [
      cue(
        /\b(?:learning objectives?|by the end of (?:this )?lesson)\b|学习目标|本节课(?:将|要)|学習目標|この講義では/i,
        '明确学习目标',
      ),
      cue(
        /\b(?:concept|theory|definition)\b|概念|理论|定义|概念|理論|定義/i,
        '概念、理论或定义讲解',
      ),
      cue(
        /\b(?:exercise|assignment|recap|review questions?)\b|练习|作业|复习题|演習|課題|復習/i,
        '练习、作业或复习安排',
      ),
    ],
    chapter: [
      cue(/\b(?:lesson|module|week|lecture)\s*\d+\b|第\s*\d+\s*(?:课|講|回|章)/i, '章节呈课程序列'),
      cue(
        /\b(?:objectives?|recap|exercise)\b|学习目标|复习|练习|学習目標|復習|演習/i,
        '教学型章节',
      ),
    ],
  },
  interview: {
    title: [
      cue(
        /\b(?:interview|conversation|fireside chat)\b|访谈|采访|对谈|专访|インタビュー|対談/i,
        '访谈或对谈形式',
      ),
      cue(/\b(?:with|featuring|guest)\b|嘉宾|做客|ゲスト|〜に聞く/i, '标题突出受访者或嘉宾'),
    ],
    author: [
      cue(/\b(?:podcast|talks?|dialogue)\b|播客|访谈|ポッドキャスト|トーク/i, '对话型频道署名'),
    ],
    transcript: [
      cue(
        /\b(?:interviewer|host|guest|question|answer)\s*[:：]|主持人|嘉宾|采访者|提问[:：]|司会|ゲスト|質問[:：]/i,
        '主持人、嘉宾或问答标签',
      ),
      cue(
        /\b(?:let me ask|my next question|thanks for joining)\b|想请问|下一个问题|感谢.*(?:做客|接受采访)|お聞きしたい|次の質問/i,
        '采访式提问衔接',
      ),
      cue(
        /\b(?:in my experience|from my perspective)\b|我的经历|我的看法|経験から|私の考え/i,
        '受访者个人观点或经历',
      ),
    ],
    chapter: [
      cue(/\b(?:q\s*&\s*a|question|conversation)\b|问答|提问|对谈|質疑応答|質問/i, '问答型章节'),
      cue(/\b(?:guest|career|experience)\b|嘉宾|经历|生涯|ゲスト|経験/i, '人物经历型章节'),
    ],
  },
  tutorial: {
    title: [
      cue(
        /\b(?:tutorial|how to|step[- ]by[- ]step|guide)\b|教程|如何|手把手|チュートリアル|やり方|方法/i,
        '操作教程或指南形式',
      ),
      cue(
        /\b(?:from scratch|beginner'?s? guide)\b|从零开始|零基础|初心者|ゼロから/i,
        '从零或新手导向',
      ),
    ],
    author: [
      cue(
        /\b(?:developer|maker|workshop|lab)\b|开发者|工坊|实验室|開発|ワークショップ/i,
        '实作型频道署名',
      ),
    ],
    transcript: [
      cue(
        /\b(?:prerequisite|you will need|requirements?)\b|准备工作|你需要|前提条件|必要なもの|事前準備/i,
        '前置条件或材料清单',
      ),
      cue(
        /\b(?:first|next|then|finally),?\s+(?:open|click|install|run|select|create|add)\b|首先.*(?:打开|点击|安装)|然后.*(?:运行|选择|创建)|まず.*(?:開く|クリック|インストール)|次に/i,
        '连续操作步骤',
      ),
      cue(
        /\b(?:verify|check that|troubleshoot|if .* fails?)\b|验证|检查是否|故障排除|如果.*失败|確認|トラブルシュート|うまくいかない/i,
        '结果验证或故障排查',
      ),
    ],
    chapter: [
      cue(
        /\b(?:setup|installation|step)\s*\d*\b|安装|配置|步骤|セットアップ|インストール|手順/i,
        '安装或步骤章节',
      ),
      cue(
        /\b(?:verify|test|troubleshoot|finish)\b|验证|测试|排错|確認|テスト|トラブル/i,
        '验证或排错章节',
      ),
    ],
  },
  news: {
    title: [
      cue(
        /\b(?:breaking|news|news update|report)\b|新闻|快讯|报道|ニュース|速報|報道/i,
        '新闻或快讯形式',
      ),
      cue(
        /\b(?:latest|today|live updates?)\b|最新|今日|突发|現地|きょう|ライブ更新/i,
        '时效性更新措辞',
      ),
    ],
    author: [
      cue(
        /\b(?:news|times|post|press|broadcast)\b|新闻|日报|电视台|通讯社|新聞|放送|通信社/i,
        '新闻媒体署名',
      ),
    ],
    transcript: [
      cue(
        /\b(?:according to|officials? said|in a statement)\b|据.*(?:称|表示)|官方表示|声明称|によると|発表しました/i,
        '来源归因或官方声明',
      ),
      cue(
        /\b(?:reporting from|our correspondent|at \d{1,2}(?::\d{2})?\s*(?:am|pm))\b|记者.*报道|当地时间|現地から|記者/i,
        '记者、地点或时间线索',
      ),
      cue(
        /\b(?:developing story|we will continue to update)\b|持续更新|后续报道|続報|随時更新/i,
        '持续事件更新',
      ),
    ],
    chapter: [
      cue(
        /\b(?:timeline|what happened|latest)\b|事件经过|最新进展|時系列|何が起きた|最新情報/i,
        '事件时间线章节',
      ),
      cue(
        /\b(?:reaction|impact|what next)\b|各方回应|影响|后续|反応|影響|今後/i,
        '回应、影响或后续章节',
      ),
    ],
  },
  meeting: {
    title: [
      cue(
        /\b(?:meeting|standup|sync|retrospective|town hall)\b|会议|例会|复盘会|全员会|会議|ミーティング|振り返り/i,
        '会议或同步形式',
      ),
      cue(/\b(?:minutes|agenda)\b|会议纪要|议程|会議録|議事録|アジェンダ/i, '议程或会议纪要'),
    ],
    author: [
      cue(
        /\b(?:team|project|working group)\b|团队|项目组|工作组|チーム|プロジェクト/i,
        '团队或项目组署名',
      ),
    ],
    transcript: [
      cue(
        /\b(?:agenda|today'?s topics?)\b|今天的议程|本次议题|本日の議題|アジェンダ/i,
        '明确会议议程',
      ),
      cue(
        /\b(?:we decided|decision|approved)\b|决定|决议|通过|合意しました|決定|承認/i,
        '决策或决议表述',
      ),
      cue(
        /\b(?:action item|owner|due date|deadline)\b|行动项|负责人|截止日期|待办|アクションアイテム|担当|期限/i,
        '行动项、负责人或期限',
      ),
    ],
    chapter: [
      cue(
        /\b(?:agenda|discussion|decision)\b|议程|讨论|决策|議題|議論|決定/i,
        '议程、讨论或决策章节',
      ),
      cue(
        /\b(?:action items?|next steps?)\b|行动项|下一步|待办|アクション|次のステップ/i,
        '行动项或下一步章节',
      ),
    ],
  },
  review: {
    title: [
      cue(
        /\b(?:review|hands[- ]on|unboxing|tested)\b|测评|评测|开箱|体验|レビュー|実機|使ってみた/i,
        '评测、体验或开箱形式',
      ),
      cue(/\b(?:vs\.?|versus|comparison)\b|对比|比较|横评|比較|どっち/i, '对比评测形式'),
    ],
    author: [
      cue(/\b(?:reviews?|testing|tech)\b|测评|评测|科技|レビュー|検証|テック/i, '评测型频道署名'),
    ],
    transcript: [
      cue(
        /\b(?:pros? and cons?|advantages? and disadvantages?)\b|优点|缺点|利弊|メリット|デメリット|長所|短所/i,
        '优缺点或权衡',
      ),
      cue(
        /\b(?:price|value|specifications?|benchmark)\b|价格|性价比|参数|跑分|価格|コスパ|仕様|ベンチマーク/i,
        '价格、规格或测试数据',
      ),
      cue(
        /\b(?:recommend|worth (?:it|buying)|verdict)\b|推荐|值不值得|购买建议|结论|おすすめ|買うべき|結論/i,
        '适用人群或购买结论',
      ),
    ],
    chapter: [
      cue(
        /\b(?:design|performance|battery|camera)\b|外观|性能|续航|相机|デザイン|性能|バッテリー|カメラ/i,
        '产品维度章节',
      ),
      cue(
        /\b(?:pros?|cons?|verdict|comparison)\b|优缺点|结论|对比|長所|短所|結論|比較/i,
        '优缺点、结论或对比章节',
      ),
    ],
  },
};

const SECTION_DEFINITIONS: Record<VideoContentType, ContentPromptSection[]> = {
  course: [
    section('learning_goals', '学习目标', '列出学完后应能解释或完成的事项。', true, 'recommended'),
    section('concept_map', '概念地图', '组织核心概念、定义及其关系。', true, 'required'),
    section('lesson_outline', '课程结构', '按讲授顺序还原章节脉络。', true, 'required'),
    section('key_explanations', '重点讲解', '提炼关键解释、例子与推导。', true, 'required'),
    section(
      'practice_and_review',
      '练习与复习',
      '保留练习、作业和复习提示。',
      false,
      'recommended',
    ),
  ],
  interview: [
    section(
      'participants_and_context',
      '人物与语境',
      '说明主持人、受访者及访谈背景。',
      true,
      'recommended',
    ),
    section('themes', '对谈主题', '归纳实际讨论的主题，不把问题当作回答。', true, 'required'),
    section('viewpoints_by_speaker', '人物观点', '按说话者分离观点和经历。', true, 'required'),
    section('notable_exchanges', '关键问答', '保留重要提问、回答及上下文。', true, 'required'),
    section('open_questions', '未决问题', '记录回避、分歧或仍未回答的问题。', false, 'recommended'),
  ],
  tutorial: [
    section(
      'outcome_and_prerequisites',
      '目标与前置条件',
      '说明最终成果、环境、材料和假设。',
      true,
      'recommended',
    ),
    section(
      'materials_and_setup',
      '准备与配置',
      '列出工具、版本、输入和初始设置。',
      true,
      'recommended',
    ),
    section(
      'ordered_steps',
      '操作步骤',
      '按顺序写出可复现步骤，不补造缺失操作。',
      true,
      'required',
    ),
    section(
      'verification_and_troubleshooting',
      '验证与排错',
      '说明如何验证结果及已提到的故障处理。',
      true,
      'required',
    ),
    section('final_checklist', '完成检查表', '生成可执行的收尾检查项。', false, 'recommended'),
  ],
  news: [
    section(
      'event_snapshot',
      '事件概览',
      '用人物、事件、时间、地点概括已确认信息。',
      true,
      'required',
    ),
    section('timeline', '时间线', '区分事件发生时间与报道发布时间。', true, 'required'),
    section(
      'actors_and_attribution',
      '相关方与信源',
      '逐项保留发言人、机构及归因。',
      true,
      'required',
    ),
    section(
      'evidence_and_uncertainty',
      '证据与不确定性',
      '分开已确认事实、主张和未知事项。',
      true,
      'required',
    ),
    section(
      'implications_and_follow_up',
      '影响与后续',
      '说明报道提出的影响和待验证进展。',
      false,
      'recommended',
    ),
  ],
  meeting: [
    section('meeting_context', '会议背景', '记录会议目标、参与者和议程范围。', true, 'recommended'),
    section('decisions', '已定事项', '只收录明确形成的决定和批准。', true, 'required'),
    section('action_items', '行动项', '以事项、负责人、期限和状态组织待办。', true, 'required'),
    section('discussion_summary', '讨论摘要', '按议题概括论点、依据和分歧。', true, 'required'),
    section(
      'open_issues_and_next_meeting',
      '未决事项与下次会议',
      '记录阻塞、待确认项和后续安排。',
      false,
      'recommended',
    ),
  ],
  review: [
    section(
      'review_scope_and_criteria',
      '评测范围与标准',
      '说明评测对象、版本、条件和评价标准。',
      true,
      'recommended',
    ),
    section(
      'product_or_subject_facts',
      '对象事实',
      '分开规格事实、体验判断和厂商主张。',
      true,
      'required',
    ),
    section('strengths', '优势', '记录有具体依据的优点。', true, 'required'),
    section(
      'weaknesses_and_tradeoffs',
      '不足与权衡',
      '记录限制、代价和适用边界。',
      true,
      'required',
    ),
    section(
      'verdict_and_fit',
      '结论与适用人群',
      '给出有条件的结论，不把个人偏好普遍化。',
      true,
      'required',
    ),
  ],
  general: [
    section('overview', '内容概览', '概括主题、目的和范围。', true, 'recommended'),
    section('key_points', '关键内容', '按逻辑组织主要信息。', true, 'required'),
    section(
      'evidence_and_caveats',
      '证据与限制',
      '标注可核对依据、推断和缺失信息。',
      true,
      'required',
    ),
    section('takeaways', '可用结论', '提炼后续可复用的结论或行动。', false, 'recommended'),
  ],
};

const PROFILE_OBJECTIVES: Record<VideoContentType, string> = {
  course: '把系统讲授转成可学习、可复习并可回看证据的课程笔记。',
  interview: '保留人物归属和问答语境，避免把主持人的问题误写成嘉宾观点。',
  tutorial: '生成可复现、可验证且不补造缺失步骤的操作说明。',
  news: '生成带时间线、信源归因和不确定性边界的事件记录。',
  meeting: '把会议转成决策、行动项、讨论依据和未决事项。',
  review: '区分对象事实、体验判断、权衡与适用人群。',
  general: '在类型证据不足时生成中性的结构化摘要，不假装已识别特定体裁。',
};

export const CONTENT_PROMPT_PROFILES: Record<VideoContentType, ContentPromptProfile> =
  Object.fromEntries(
    VIDEO_CONTENT_TYPES.map((type) => {
      const sections = SECTION_DEFINITIONS[type];
      return [
        type,
        {
          id: `video-content-${type}-v1`,
          version: 1,
          content_type: type,
          objective: PROFILE_OBJECTIVES[type],
          sections,
          output_schema: buildOutputSchema(type, sections),
          guardrails: [
            '只使用标题、作者、章节、转录和结构化证据中可见的信息。',
            '关键词命中只是弱信号，不能单独当作内容类型或事实证明。',
            '事实性结论应引用 evidence_segment_ids；没有证据时明确标注未知。',
            '不得伪造说话者、时间点、操作步骤、决定、信源或评测数据。',
          ],
        } satisfies ContentPromptProfile,
      ];
    }),
  ) as Record<VideoContentType, ContentPromptProfile>;

export function getContentPromptProfile(type: VideoContentType): ContentPromptProfile {
  return cloneProfile(CONTENT_PROMPT_PROFILES[type]);
}

/**
 * Resolve the requested content type with an explicit precedence:
 * manual selection > sufficiently confident structured backend value > local
 * multi-signal inference > general fallback.
 */
export function resolveContentRouting(input: ContentRouteInput): ContentRoutingDecision {
  const requested = normalizeRequestedType(input.requestedType);
  if (requested && requested !== 'auto') {
    return decision(requested, 1, 'manual', [
      {
        signal: 'request',
        message: `用户明确选择 ${requested}；手动选择覆盖后端和自动判断。`,
      },
    ]);
  }

  const rejectedBackendReasons: ContentRoutingReason[] = [];
  const backendType = normalizeContentType(input.backendType);
  if (backendType) {
    const reportedConfidence = normalizeConfidence(input.backendConfidence);
    if (
      reportedConfidence !== undefined &&
      reportedConfidence >= BACKEND_ROUTE_CONFIDENCE_THRESHOLD
    ) {
      const backendReasons = normalizeBackendReasons(input.backendReasons);
      return decision(backendType, reportedConfidence, 'backend', [
        {
          signal: 'backend',
          message: `后端返回受支持的结构化 content_type=${backendType}。`,
        },
        ...backendReasons,
      ]);
    }
    rejectedBackendReasons.push(
      reportedConfidence === undefined
        ? {
            signal: 'backend',
            message: `后端 content_type=${backendType} 没有显式置信度，不能覆盖本地可见证据。`,
          }
        : {
            signal: 'backend',
            message: `后端 content_type=${backendType} 的显式置信度 ${formatConfidence(
              reportedConfidence,
            )} 低于采用阈值，继续使用本地可见证据判断。`,
          },
    );
  } else if (hasValue(input.backendType)) {
    rejectedBackendReasons.push({
      signal: 'backend',
      message: '后端 content_type 不在受支持枚举中，未采用。',
    });
  }

  if (input.autoRoute === false) {
    return decision('general', 1, 'fallback', [
      ...rejectedBackendReasons,
      {
        signal: 'fallback',
        message: '自动路由已关闭且没有有效手动类型，使用 general。',
      },
    ]);
  }

  const local = inferLocalRoute(input);
  return {
    ...local,
    reasons: [...rejectedBackendReasons, ...local.reasons],
  };
}

/** Concise alias for callers that treat routing as one post-normalization step. */
export const resolveContentRoute = resolveContentRouting;

export function buildContentRoutingPromptContract(
  requestedType: string = 'auto',
  autoRoute = true,
): ContentRoutingPromptContract {
  const normalized = normalizeRequestedType(requestedType) || 'auto';
  const selected =
    normalized !== 'auto'
      ? [getContentPromptProfile(normalized)]
      : VIDEO_CONTENT_TYPES.map(getContentPromptProfile);
  return {
    contract_version: CONTENT_ROUTER_CONTRACT_VERSION,
    requested_type: normalized,
    auto_route: autoRoute,
    allowed_types: [...VIDEO_CONTENT_TYPES],
    fallback_type: 'general',
    minimum_local_score: LOCAL_ROUTE_SCORE_THRESHOLD,
    minimum_margin: LOCAL_ROUTE_MARGIN_THRESHOLD,
    policies: [
      '手动 requested_type 永远覆盖自动路由和后端预测。',
      '自动判断必须综合至少两类可见信号；单个关键词不能决定类型。',
      '最高候选分或领先差不足时必须回退 general。',
      '返回的 content_type 必须与所选 prompt profile 和 sections schema 一致。',
    ],
    profiles: selected,
  };
}

function inferLocalRoute(input: ContentRouteInput): ContentRoutingDecision {
  const title = normalizeText(input.title);
  const author = normalizeText(input.author);
  const transcript = normalizeText(input.transcript).slice(0, 50_000);
  const chapters = normalizeChapters(input.chapters);
  const chapterText = chapters.join('\n').slice(0, 20_000);

  const candidates = ROUTABLE_TYPES.map((type) =>
    scoreCandidate(type, { title, author, transcript, chapterText, chapters }),
  ).sort((left, right) => right.score - left.score || left.type.localeCompare(right.type));
  const top = candidates[0];
  const second = candidates[1];
  const margin = top.score - second.score;
  const signalCount = new Set(
    top.reasons
      .map((reason) => reason.signal)
      .filter((signal) => !['fallback', 'request', 'backend'].includes(signal)),
  ).size;
  const candidateScores = Object.fromEntries(
    candidates.map((candidate) => [candidate.type, round(candidate.score)]),
  ) as Partial<Record<VideoContentType, number>>;

  const accepted =
    top.score >= LOCAL_ROUTE_SCORE_THRESHOLD &&
    margin >= LOCAL_ROUTE_MARGIN_THRESHOLD &&
    signalCount >= 2;
  if (accepted) {
    const confidence = clamp(
      0.5 +
        top.score * 0.35 +
        Math.min(0.1, margin * 0.25) +
        Math.min(0.05, Math.max(0, signalCount - 2) * 0.025),
      0.6,
      0.96,
    );
    return decision(
      top.type,
      confidence,
      'local',
      [
        ...top.reasons,
        {
          signal: 'structure',
          message: `综合 ${signalCount} 类可见信号；领先下一候选 ${round(margin)}。`,
        },
      ],
      candidateScores,
    );
  }

  const fallbackReasons: ContentRoutingReason[] = [];
  if (top.score === 0) {
    fallbackReasons.push({
      signal: 'fallback',
      message: '标题、作者、转录和章节中没有足够的体裁线索。',
    });
  } else {
    fallbackReasons.push(...top.reasons.slice(0, 4));
    fallbackReasons.push({
      signal: 'fallback',
      message:
        top.score < LOCAL_ROUTE_SCORE_THRESHOLD
          ? `最高候选 ${top.type} 的综合分 ${round(top.score)} 低于阈值，关键词不单独决定类型。`
          : margin < LOCAL_ROUTE_MARGIN_THRESHOLD
            ? `${top.type} 与 ${second.type} 的分差仅 ${round(margin)}，存在歧义。`
            : `最高候选只覆盖 ${signalCount} 类信号，证据来源不足。`,
    });
  }
  const confidence = clamp(
    0.45 +
      Math.max(0, LOCAL_ROUTE_SCORE_THRESHOLD - top.score) * 0.35 +
      Math.min(0.15, Math.max(0, margin) * 0.3),
    0.45,
    0.75,
  );
  return decision('general', confidence, 'fallback', fallbackReasons, candidateScores);
}

function scoreCandidate(
  type: Exclude<VideoContentType, 'general'>,
  evidence: {
    title: string;
    author: string;
    transcript: string;
    chapterText: string;
    chapters: string[];
  },
): WeightedCandidate {
  const rules = CUES[type];
  const reasons: ContentRoutingReason[] = [];
  let score = 0;

  for (const channel of ['title', 'author', 'transcript', 'chapter'] as const) {
    const text = channel === 'chapter' ? evidence.chapterText : evidence[channel];
    const cues = rules[channel] || [];
    const matches = cues.filter((item) => item.pattern.test(text));
    if (matches.length === 0) continue;
    const weights = CHANNEL_WEIGHTS[channel];
    const contribution = Math.min(weights.cap, matches.length * weights.perCue);
    score += contribution;
    reasons.push({
      signal: channel,
      message: `${signalLabel(channel)}提供${matches.map((match) => `“${match.label}”`).join('、')}线索。`,
      weight: round(contribution),
    });
  }

  const structural = structuralSignals(type, evidence.transcript, evidence.chapters);
  score += structural.score;
  reasons.push(...structural.reasons);

  return {
    type,
    score: round(clamp(score, 0, 0.95)),
    reasons,
  };
}

function structuralSignals(
  type: Exclude<VideoContentType, 'general'>,
  transcript: string,
  chapters: string[],
): { score: number; reasons: ContentRoutingReason[] } {
  const reasons: ContentRoutingReason[] = [];
  let score = 0;
  const add = (condition: boolean, weight: number, message: string) => {
    if (!condition) return;
    score += weight;
    reasons.push({ signal: 'structure', message, weight });
  };

  const sequentialChapters = chapters.filter((chapter) =>
    /(?:\b(?:lesson|module|step|part)\s*\d+\b|第\s*\d+\s*(?:课|講|回|章)|步骤\s*\d+|手順\s*\d+)/i.test(
      chapter,
    ),
  ).length;

  if (type === 'course') {
    add(chapters.length >= 3 && sequentialChapters >= 2, 0.16, '多个连续课次/模块形成教学序列。');
    add(
      countMatches(
        transcript,
        /(?:学习目标|练习|复习|learning objective|exercise|recap|学習目標|演習|復習)/gi,
      ) >= 3,
      0.12,
      '转录同时包含目标、讲解和练习式教学结构。',
    );
  }
  if (type === 'interview') {
    add(
      countMatches(
        transcript,
        /(?:^|\n)\s*(?:q|a|host|guest|interviewer|主持人|嘉宾|采访者|司会|ゲスト)\s*[:：]/gim,
      ) >= 4,
      0.18,
      '转录存在多轮、可区分角色的问答结构。',
    );
    add(
      countMatches(transcript, /[?？]\s*(?:\n|$)/gm) >= 3 &&
        countMatches(transcript, /(?:我|私|my|we|我们|私たち)/gi) >= 3,
      0.1,
      '多轮问题与第一人称回答共同出现。',
    );
  }
  if (type === 'tutorial') {
    add(
      countMatches(
        transcript,
        /(?:first|next|then|finally|首先|接下来|然后|最后|まず|次に|それから|最後に)/gi,
      ) >= 3,
      0.16,
      '转录具有至少三段连续操作顺序。',
    );
    add(chapters.length >= 3 && sequentialChapters >= 2, 0.14, '章节形成连续操作步骤。');
  }
  if (type === 'news') {
    add(
      countMatches(
        transcript,
        /(?:according to|said in a statement|reported by|据.+表示|记者报道|によると|発表しました)/gi,
      ) >= 2,
      0.15,
      '转录对多个陈述进行了信源归因。',
    );
    add(
      countMatches(
        transcript,
        /(?:\b\d{1,2}:\d{2}\b|\b20\d{2}[-/年]\d{1,2}|当地时间|現地時間|today|yesterday|今日|昨日)/gi,
      ) >= 2,
      0.1,
      '包含多个明确日期或事件时间线索。',
    );
  }
  if (type === 'meeting') {
    add(
      countMatches(
        transcript,
        /(?:action item|owner|deadline|行动项|负责人|截止|アクションアイテム|担当|期限)/gi,
      ) >= 3,
      0.18,
      '多项行动项同时带有负责人或期限结构。',
    );
    add(
      chapters.some((chapter) => /(?:decision|决定|決定)/i.test(chapter)) &&
        chapters.some((chapter) => /(?:action|next|行动|下一步|アクション|次)/i.test(chapter)),
      0.12,
      '章节同时区分决策与后续行动。',
    );
  }
  if (type === 'review') {
    add(
      countMatches(
        transcript,
        /(?:pros?|cons?|advantage|disadvantage|优点|缺点|优势|不足|メリット|デメリット|長所|短所)/gi,
      ) >= 3,
      0.16,
      '转录从多个角度成对讨论优点与限制。',
    );
    add(
      chapters.length >= 3 &&
        chapters.filter((chapter) =>
          /(?:design|performance|price|verdict|外观|性能|价格|结论|デザイン|性能|価格|結論)/i.test(
            chapter,
          ),
        ).length >= 2,
      0.12,
      '章节按评测维度组织并包含结论。',
    );
  }

  return { score: round(Math.min(score, 0.3)), reasons };
}

function decision(
  type: VideoContentType,
  confidence: number,
  source: ContentRoutingDecision['source'],
  reasons: ContentRoutingReason[],
  candidateScores?: Partial<Record<VideoContentType, number>>,
): ContentRoutingDecision {
  return {
    type,
    confidence: round(clamp(confidence, 0, 1)),
    source,
    reasons,
    prompt_profile: getContentPromptProfile(type),
    candidate_scores: candidateScores,
  };
}

function buildOutputSchema(
  type: VideoContentType,
  sections: ContentPromptSection[],
): ContentPromptOutputSchema {
  const sectionProperties = Object.fromEntries(
    sections.map((item) => [
      item.key,
      {
        type: 'string' as const,
        description: `${item.purpose} Evidence policy: ${item.evidence}.`,
      },
    ]),
  );
  return {
    type: 'object',
    required: ['content_type', 'summary', 'sections', 'evidence_claims', 'content_routing'],
    properties: {
      content_type: {
        type: 'string',
        const: type,
        description: 'The resolved supported content type.',
      },
      summary: {
        type: 'string',
        description: 'A concise overview grounded in the supplied source.',
      },
      sections: {
        type: 'object',
        required: sections.filter((item) => item.required).map((item) => item.key),
        properties: sectionProperties,
      },
      evidence_claims: {
        type: 'array',
        description: 'Factual claims with references to existing segment ids.',
        items: {
          type: 'object',
          required: ['claim', 'evidence_segment_ids'],
          properties: {
            claim: { type: 'string' },
            evidence_segment_ids: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'number' },
          },
        },
      },
      content_routing: {
        type: 'object',
        required: ['type', 'confidence', 'reasons', 'prompt_profile'],
        properties: {
          type: { type: 'string', const: type },
          confidence: { type: 'number' },
          reasons: { type: 'array', items: { type: 'string' } },
          prompt_profile: { type: 'string', const: `video-content-${type}-v1` },
        },
      },
    },
  };
}

function section(
  key: string,
  heading: string,
  purpose: string,
  required: boolean,
  evidence: ContentPromptSection['evidence'],
): ContentPromptSection {
  return { key, heading, purpose, required, evidence };
}

function cue(pattern: RegExp, label: string): Cue {
  return { pattern, label };
}

function normalizeRequestedType(raw: unknown): RequestedContentType | undefined {
  const value = scalarText(raw).trim().toLowerCase();
  if (value === 'auto') return 'auto';
  return normalizeContentType(value);
}

function normalizeContentType(raw: unknown): VideoContentType | undefined {
  const value = scalarText(raw).trim().toLowerCase();
  return VIDEO_CONTENT_TYPES.includes(value as VideoContentType)
    ? (value as VideoContentType)
    : undefined;
}

function normalizeConfidence(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return undefined;
  const value = typeof raw === 'number' ? raw : Number(scalarText(raw).trim());
  if (!Number.isFinite(value)) return undefined;
  return clamp(value > 1 && value <= 100 ? value / 100 : value, 0, 1);
}

function normalizeBackendReasons(raw: unknown): ContentRoutingReason[] {
  if (!Array.isArray(raw)) return [];
  const reasons: ContentRoutingReason[] = [];
  for (const item of raw) {
    const value =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object' && 'message' in item
          ? scalarText((item as { message?: unknown }).message)
          : '';
    const message = value.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (message) reasons.push({ signal: 'backend', message });
    if (reasons.length >= 8) break;
  }
  return reasons;
}

function normalizeChapters(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return normalizeText(item);
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      for (const key of ['title', 'name', 'label', 'text', 'summary']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
          return normalizeText(value);
        }
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeText(raw: unknown): string {
  return scalarText(raw)
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function signalLabel(signal: 'title' | 'author' | 'transcript' | 'chapter'): string {
  return {
    title: '标题',
    author: '作者/频道',
    transcript: '转录',
    chapter: '章节',
  }[signal];
}

function countMatches(text: string, pattern: RegExp): number {
  if (!text) return 0;
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return Array.from(text.matchAll(new RegExp(pattern.source, flags))).length;
}

function hasValue(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    (scalarText(value).trim() !== '' || typeof value === 'object')
  );
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function cloneProfile(profile: ContentPromptProfile): ContentPromptProfile {
  return JSON.parse(JSON.stringify(profile)) as ContentPromptProfile;
}
