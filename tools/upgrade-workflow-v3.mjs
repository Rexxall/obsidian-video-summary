#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_WORKFLOW_PATH = fileURLToPath(
  new URL('../Obsidian Video Summary.json', import.meta.url),
);

const ACTIVE_AI_AGENT_NAMES = [
  'AI Agent',
  'AI Agent1',
  'AI Agent2',
  'AI Agent3',
  'AI Agent5',
  'AI Agent6',
];

const RICH_PROMPT_MARKER = 'VIDEO_KNOWLEDGE_V3_EVIDENCE_OUTPUT';
const CONTENT_ROUTE_PROMPT_MARKER = 'VIDEO_CONTENT_ROUTE_V1';

const RICH_PROMPT_BLOCK = [
  `// ${RICH_PROMPT_MARKER}`,
  "const knowledgeMetadata = {{ $('Webhook').item.json.body.metadata || {} }};",
  'const contentRouterContract = knowledgeMetadata.content_router_contract || null;',
  "const rawEvidenceSegments = {{ $('Set: Final Transcript for AI').item.json.video_segments || [] }};",
  'const evidenceSegmentCatalog = Array.isArray(rawEvidenceSegments)',
  '  ? rawEvidenceSegments.map((segment) => ({',
  '      id: segment.id,',
  '      start: segment.start,',
  '      end: segment.end,',
  '      text: segment.text,',
  '      source: segment.source || "speech",',
  '      timing_quality: segment.timing_quality || "none",',
  '    }))',
  '  : [];',
  "const processingDepth = knowledgeMetadata.processing_depth || 'evidence';",
  "const requestedContentType = knowledgeMetadata.content_type || 'auto';",
  'const shouldAssessAttention = knowledgeMetadata.attention_assessment !== false;',
  'const shouldGenerateLearning = knowledgeMetadata.generate_learning === true;',
  'userPrompt += `',
  '',
  '【结构化证据附加输出（VIDEO_KNOWLEDGE_V3）】',
  '在既有必填字段 video_title、summary、note 之外，输出以下可选 JSON 字段。不要删除既有字段：',
  '- content_type：只能是 course / interview / tutorial / news / meeting / review / general；请求值为 ${requestedContentType}，auto 时根据文稿判断。',
  '- evidence_claims：数组。每项为 {"id":"claim-1","claim":"可核查陈述","evidence":[{"segment_id":"下方真实 segment id","source":"speech","quote":"对应原话"}],"start":秒或null,"end":秒或null,"confidence":0到1,"review_state":"supported或needs-review或inference"}。',
  '- attention：仅当 ${shouldAssessAttention} 为 true 时输出；结构为 {"action":"watch或skim或skip","score":0到1,"confidence":0到1,"rationale":"理由","information_density":0到1,"originality":0到1,"actionability":0到1,"promotional_ratio":0到1,"evidence_segment_ids":["真实segment id"],"limitations":["限制"]}。四个核心指标不可省略；没有知识库上下文时不要输出 vault_relevance。',
  '- learning：仅当 ${shouldGenerateLearning} 为 true 时输出；可含 flashcards、questions、feynman_prompts，并让卡片/题目的 evidence_segment_ids 只引用真实 segment id。',
  '',
  `【内容类型路由结构（${CONTENT_ROUTE_PROMPT_MARKER}）】`,
  '机器可读路由合同：${JSON.stringify(contentRouterContract)}',
  '以下结构要求优先于前面的通用排版法则。requestedContentType 不是 auto 时必须按用户指定类型组织；auto 时只能依据标题、作者、章节和文稿判断，证据不足使用 general。',
  '- course：学习目标 → 概念地图 → 课程结构 → 重点讲解 → 练习与复习。',
  '- interview：人物与语境 → 对谈主题 → 按说话者归属的观点 → 关键问答 → 未决问题。不得把主持人的问题写成嘉宾主张。',
  '- tutorial：目标与前置条件 → 材料与配置 → 可复现的顺序步骤 → 验证与排错 → 完成检查表。不得补造文稿没有的步骤。',
  '- news：事件概览 → 时间线 → 相关方与信源 → 已确认事实/主张/未知事项 → 影响与后续。',
  '- meeting：会议背景 → 已定事项 → 行动项（事项/负责人/期限/状态）→ 讨论摘要 → 未决事项。',
  '- review：评测范围与标准 → 对象事实 → 优势 → 不足与权衡 → 有条件的结论与适用人群。',
  '- general：内容概览 → 关键内容 → 证据与限制 → 可用结论。',
  'content_type 必须与 note 实际采用的结构一致；缺失信息应写“未提供”，不能为了填满结构而虚构。',
  '',
  '处理深度：${processingDepth}',
  '可引用的语音时间段目录（这是字幕证据，不是画面证据）：',
  '${JSON.stringify(evidenceSegmentCatalog)}',
  '',
  '证据红线：',
  '1. evidence 只能引用上方存在的 segment id；没有可引用 segment 时 evidence_claims 返回空数组。',
  '2. 无时间信息时不得虚构 0:00、start=0 或 end=0；相应时间字段省略或使用 null。',
  '3. 当前工作流没有接通视频画面理解。不要输出 visual_evidence，不要声称看见幻灯片、图表、代码界面、人物动作或镜头。',
  '4. 仅由字幕推断且不能被原话直接支持的内容，review_state 必须为 inference 或 needs-review。',
  '`;',
].join('\n');

function functionBody(fn) {
  const source = fn.toString();
  return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}')).trim();
}

function stableSegmentId(start, end, text) {
  const startMs = Math.round(start * 1000);
  const input = `${startMs}|${Math.round(end * 1000)}|${text}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `seg-${startMs}-${(hash >>> 0).toString(36)}`;
}

/**
 * This function body is copied verbatim into the n8n Code node. Keep it
 * dependency-free so the same implementation can run in both n8n and tests.
 */
export function runNativeSubtitleNode($input, $) {
  const items = $input.all();

  function decodeEntities(value) {
    return String(value || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  function cleanCueText(lines) {
    const cleaned = [];
    for (const line of lines) {
      const text = decodeEntities(line)
        .replace(/<[^>]+>/g, '')
        .replace(/\{\\[^}]+\}/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || cleaned[cleaned.length - 1] === text) continue;
      cleaned.push(text);
    }
    return cleaned.join(' ').trim();
  }

  function parseTimestamp(value) {
    const parts = String(value || '')
      .replace(',', '.')
      .split(':')
      .map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return null;
  }

  function makeSegmentId(start, end, text) {
    const startMs = Math.round(start * 1000);
    const input = `${startMs}|${Math.round(end * 1000)}|${text}`;
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `seg-${startMs}-${(hash >>> 0).toString(36)}`;
  }

  function formatTimestamp(seconds) {
    const wholeSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainingSeconds = wholeSeconds % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  function parseTimedSubtitles(raw) {
    const normalized = String(raw || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '');
    const marker = normalized.match(/^__NATIVE_SUBTITLE_FILE__=(.+)$/m);
    if (!marker || marker.index === undefined) return [];

    const markerEnd = normalized.indexOf('\n', marker.index);
    const subtitleText = markerEnd >= 0 ? normalized.slice(markerEnd + 1) : '';
    const blocks = subtitleText.split(/\n{2,}/);
    const segments = [];
    const timePattern =
      /((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})/;

    for (const block of blocks) {
      const lines = block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0 || /^NOTE(?:\s|$)/i.test(lines[0])) continue;

      const timingIndex = lines.findIndex((line) => timePattern.test(line));
      if (timingIndex < 0) continue;
      const timingMatch = lines[timingIndex].match(timePattern);
      if (!timingMatch) continue;

      const start = parseTimestamp(timingMatch[1]);
      const end = parseTimestamp(timingMatch[2]);
      const text = cleanCueText(lines.slice(timingIndex + 1));
      if (start === null || end === null || end < start || !text) continue;

      segments.push({
        id: makeSegmentId(start, end, text),
        start,
        end,
        text,
        source: 'speech',
        timing_quality: 'exact',
      });
    }
    return segments;
  }

  for (const item of items) {
    let base = {};
    try {
      base = $('Code: Detect Platform & Prepare Download').item.json || {};
    } catch (_error) {
      base = {};
    }

    const stdout = item.json.stdout || '';
    const fileMatch = String(stdout).match(/^__NATIVE_SUBTITLE_FILE__=(.+)$/m);
    const languageMatch = String(stdout).match(/^__NATIVE_SUBTITLE_LANGS__=(.+)$/m);
    const segments = parseTimedSubtitles(stdout);
    const transcript = segments
      .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`)
      .join('\n');
    const hasTimedTranscript = segments.length > 0;

    item.json = {
      ...base,
      ...item.json,
      native_subtitle_file: fileMatch ? fileMatch[1].trim() : '',
      native_subtitle_langs: languageMatch ? languageMatch[1].trim() : '',
      transcript_source: hasTimedTranscript ? 'native_subtitle' : 'asr_fallback',
      timing_quality: hasTimedTranscript ? 'exact' : 'none',
      video_segments: hasTimedTranscript ? segments : [],
      video_transcript: hasTimedTranscript ? transcript : '',
    };
  }

  return items;
}

/**
 * This body is parameterized with the retry switch node name and then embedded
 * into both active n8n parser nodes.
 */
export function runAiParserNode($input, $, switchNodeName) {
  const switchContextNode = switchNodeName;
  const items = $input.all();
  const MAX_AI_RETRIES = 3;

  function nodeJson(name) {
    try {
      return $(name).item.json || {};
    } catch (_error) {
      return {};
    }
  }

  const finalTranscriptContext = nodeJson('Set: Final Transcript for AI');
  const retryContext = nodeJson(switchContextNode);

  for (const item of items) {
    const originalVideoTranscript =
      item.json.video_transcript ||
      finalTranscriptContext.video_transcript ||
      retryContext.video_transcript ||
      '';
    const videoSegments = Array.isArray(item.json.video_segments)
      ? item.json.video_segments
      : Array.isArray(finalTranscriptContext.video_segments)
        ? finalTranscriptContext.video_segments
        : Array.isArray(retryContext.video_segments)
          ? retryContext.video_segments
          : [];
    const timingQuality =
      item.json.timing_quality ||
      finalTranscriptContext.timing_quality ||
      retryContext.timing_quality ||
      'none';
    const transcriptSource =
      item.json.transcript_source ||
      finalTranscriptContext.transcript_source ||
      retryContext.transcript_source ||
      'unknown';

    const priorRetryCount = item.json.ai_retry_count ?? retryContext.ai_retry_count ?? 0;
    item.json.ai_retry_count = Number.isFinite(Number(priorRetryCount))
      ? Number(priorRetryCount)
      : 0;
    item.json.trigger_ai_retry = false;
    item.json.max_ai_retries_for_prompt = MAX_AI_RETRIES;
    item.json.parsing_error_details = null;

    let parsedDataForNextNode = {
      summary: 'Error: AI output processing did not complete as expected.',
      note: 'Error: AI output processing did not complete as expected.',
    };

    if (item.json.error) {
      if (item.json.ai_retry_count < MAX_AI_RETRIES) {
        item.json.ai_retry_count += 1;
        item.json.trigger_ai_retry = true;
        item.json.parsing_error_details = `上游错误，第${item.json.ai_retry_count}次重试: ${item.json.error}`;
        delete item.json.error;
      } else {
        item.json.parsing_error_details = `上游错误，已达最大重试次数: ${item.json.error}`;
      }
    } else {
      const rawOutput = item.json.output;
      let parsedJson = null;

      if (rawOutput && typeof rawOutput === 'object' && !Array.isArray(rawOutput)) {
        parsedJson = rawOutput;
      } else if (typeof rawOutput === 'string') {
        let textToParse = rawOutput
          .replace(/<think>[\s\S]*?<\/think>/gs, '')
          .replace(/^>\s*思考中\s*\.*([\r\n]+|$)/m, '')
          .trim();
        const fencedJsonMatch = textToParse.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
        if (fencedJsonMatch && fencedJsonMatch[1]) {
          textToParse = fencedJsonMatch[1].trim();
        }
        try {
          parsedJson = JSON.parse(textToParse);
        } catch (error) {
          item.json.parsing_error_details = `JSON解析失败: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        item.json.parsing_error_details = 'AI输出不是对象、字符串或缺失';
      }

      if (
        parsedJson &&
        typeof parsedJson.summary === 'string' &&
        typeof parsedJson.note === 'string'
      ) {
        // Preserve the complete rich object. Downstream normalization validates
        // optional fields; this parser must not discard them.
        parsedDataForNextNode = parsedJson;
        item.json.ai_retry_count = 0;
      } else if (!item.json.parsing_error_details) {
        item.json.parsing_error_details = '解析的JSON缺少必要的summary和note字段';
      }

      if (item.json.parsing_error_details) {
        if (item.json.ai_retry_count < MAX_AI_RETRIES) {
          item.json.ai_retry_count += 1;
          item.json.trigger_ai_retry = true;
          item.json.parsing_error_details = `${item.json.parsing_error_details}，第${item.json.ai_retry_count}次重试`;
        } else {
          item.json.parsing_error_details = `${item.json.parsing_error_details}，已达最大重试次数`;
        }
      }
    }

    item.json.output = parsedDataForNextNode;
    item.json.video_transcript = originalVideoTranscript;
    item.json.video_segments = videoSegments;
    item.json.timing_quality = timingQuality;
    item.json.transcript_source = transcriptSource;
  }

  return items;
}

export function executeNodeCode(code, inputItems, nodeContexts = {}) {
  const $input = { all: () => inputItems };
  const $ = (name) => ({
    item: {
      json: nodeContexts[name] || {},
    },
  });
  return new Function('$input', '$', code)($input, $);
}

function buildAiParserCode(switchNodeName) {
  return functionBody(runAiParserNode).replace(
    'const switchContextNode = switchNodeName;',
    `const switchContextNode = ${JSON.stringify(switchNodeName)};`,
  );
}

function getNode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) {
    throw new Error(`Workflow node not found: ${name}`);
  }
  return node;
}

function upsertAssignment(node, assignment) {
  const assignments = node.parameters.assignments?.assignments;
  if (!Array.isArray(assignments)) {
    throw new Error(`Node has no assignment list: ${node.name}`);
  }
  const index = assignments.findIndex((candidate) => candidate.name === assignment.name);
  if (index >= 0) {
    assignments[index] = {
      ...assignments[index],
      ...assignment,
    };
  } else {
    assignments.push(assignment);
  }
}

function insertRichPrompt(text) {
  const returnIndex = text.lastIndexOf('return userPrompt;');
  if (returnIndex < 0) {
    throw new Error('AI Agent prompt does not end with return userPrompt;');
  }
  const markerIndex = text.indexOf(`// ${RICH_PROMPT_MARKER}`);
  const prefix = markerIndex >= 0 ? text.slice(0, markerIndex) : text.slice(0, returnIndex);
  return `${prefix}${RICH_PROMPT_BLOCK}\n\n${text.slice(returnIndex)}`;
}

export function upgradeWorkflow(workflow) {
  const upgraded = structuredClone(workflow);

  getNode(upgraded, 'Code: Parse Native Subtitles').parameters.jsCode =
    functionBody(runNativeSubtitleNode);

  const finalTranscript = getNode(upgraded, 'Set: Final Transcript for AI');
  finalTranscript.parameters.includeOtherFields = true;
  upsertAssignment(finalTranscript, {
    id: 'v3-video-transcript',
    name: 'video_transcript',
    value: '={{ $json.video_transcript || $json.full_transcript || "" }}',
    type: 'string',
  });
  upsertAssignment(finalTranscript, {
    id: 'v3-video-segments',
    name: 'video_segments',
    value:
      '={{ Array.isArray($json.video_segments) ? $json.video_segments : (Array.isArray($json.segments) ? $json.segments : []) }}',
    type: 'array',
  });
  upsertAssignment(finalTranscript, {
    id: 'v3-timing-quality',
    name: 'timing_quality',
    value:
      '={{ $json.timing_quality || ((Array.isArray($json.video_segments) && $json.video_segments.length) || (Array.isArray($json.segments) && $json.segments.length) ? "aligned" : "none") }}',
    type: 'string',
  });
  upsertAssignment(finalTranscript, {
    id: 'v3-transcript-source',
    name: 'transcript_source',
    value:
      '={{ $json.transcript_source || ($json.full_transcript ? "asr" : ($json.video_transcript ? "provided_transcript" : "none")) }}',
    type: 'string',
  });

  getNode(upgraded, 'Code: Parse AI JSON Output & Manage Retries').parameters.jsCode =
    buildAiParserCode('Switch: AI Parse Retry?');
  getNode(upgraded, 'Code: Parse AI JSON Output & Manage Retries1').parameters.jsCode =
    buildAiParserCode('Switch: AI Parse Retry ??');

  const summary = getNode(upgraded, 'Set: Summary');
  summary.parameters.includeOtherFields = false;
  upsertAssignment(summary, {
    id: 'v3-summary-video-transcript',
    name: 'video_transcript',
    value: "={{ $('Set: Final Transcript for AI').item.json.video_transcript || '' }}",
    type: 'string',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-video-segments',
    name: 'video_segments',
    value:
      "={{ Array.isArray($('Set: Final Transcript for AI').item.json.video_segments) ? $('Set: Final Transcript for AI').item.json.video_segments : [] }}",
    type: 'array',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-timing-quality',
    name: 'timing_quality',
    value: "={{ $('Set: Final Transcript for AI').item.json.timing_quality || 'none' }}",
    type: 'string',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-transcript-source',
    name: 'transcript_source',
    value: "={{ $('Set: Final Transcript for AI').item.json.transcript_source || 'unknown' }}",
    type: 'string',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-content-type',
    name: 'content_type',
    value: '={{ $json.output.content_type || "" }}',
    type: 'string',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-evidence-claims',
    name: 'evidence_claims',
    value: '={{ Array.isArray($json.output.evidence_claims) ? $json.output.evidence_claims : [] }}',
    type: 'array',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-attention',
    name: 'attention',
    value:
      '={{ $json.output.attention && typeof $json.output.attention === "object" ? $json.output.attention : {} }}',
    type: 'object',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-learning',
    name: 'learning',
    value:
      '={{ $json.output.learning && typeof $json.output.learning === "object" ? $json.output.learning : {} }}',
    type: 'object',
  });

  for (const name of ACTIVE_AI_AGENT_NAMES) {
    const agent = getNode(upgraded, name);
    if (agent.disabled) {
      throw new Error(`Expected active AI Agent is disabled: ${name}`);
    }
    agent.parameters.text = insertRichPrompt(agent.parameters.text);
  }

  return upgraded;
}

function hasConnection(workflow, from, to, kind = 'main') {
  const branches = workflow.connections[from]?.[kind] || [];
  return branches.some((branch) => branch.some((edge) => edge.node === to));
}

export function validateWorkflow(workflow) {
  const errors = [];

  try {
    const nativeParser = getNode(workflow, 'Code: Parse Native Subtitles');
    if (!nativeParser.parameters.jsCode.includes("timing_quality: 'exact'")) {
      errors.push('Native subtitle parser does not emit exact timing quality.');
    }
    if (!nativeParser.parameters.jsCode.includes('video_segments')) {
      errors.push('Native subtitle parser does not emit video_segments.');
    }

    const finalTranscript = getNode(workflow, 'Set: Final Transcript for AI');
    const finalNames = new Set(
      finalTranscript.parameters.assignments.assignments.map((item) => item.name),
    );
    for (const field of [
      'video_transcript',
      'video_segments',
      'timing_quality',
      'transcript_source',
    ]) {
      if (!finalNames.has(field)) {
        errors.push(`Final Transcript is missing ${field}.`);
      }
    }

    for (const parserName of [
      'Code: Parse AI JSON Output & Manage Retries',
      'Code: Parse AI JSON Output & Manage Retries1',
    ]) {
      const parser = getNode(workflow, parserName);
      if (!parser.parameters.jsCode.includes('parsedDataForNextNode = parsedJson')) {
        errors.push(`${parserName} does not preserve the complete rich output.`);
      }
      for (const field of ['video_segments', 'timing_quality', 'transcript_source']) {
        if (!parser.parameters.jsCode.includes(`item.json.${field}`)) {
          errors.push(`${parserName} does not restore ${field}.`);
        }
      }
    }

    const summary = getNode(workflow, 'Set: Summary');
    const summaryNames = new Set(
      summary.parameters.assignments.assignments.map((item) => item.name),
    );
    for (const field of [
      'video_transcript',
      'video_segments',
      'timing_quality',
      'transcript_source',
      'content_type',
      'evidence_claims',
      'attention',
      'learning',
    ]) {
      if (!summaryNames.has(field)) {
        errors.push(`Summary is missing ${field}.`);
      }
    }

    for (const name of ACTIVE_AI_AGENT_NAMES) {
      const agent = getNode(workflow, name);
      if (!agent.parameters.text.includes(RICH_PROMPT_MARKER)) {
        errors.push(`${name} is missing the rich evidence prompt.`);
      }
      if (!agent.parameters.text.includes(CONTENT_ROUTE_PROMPT_MARKER)) {
        errors.push(`${name} is missing the content-route prompt.`);
      }
      if (!agent.parameters.text.includes('当前工作流没有接通视频画面理解')) {
        errors.push(`${name} does not disclose the visual-understanding limit.`);
      }
    }

    const analyzeVideo = getNode(workflow, 'Analyze video');
    if (!analyzeVideo.disabled) {
      errors.push('Analyze video must remain disabled until a real visual path exists.');
    }
    if (workflow.connections['Analyze video']) {
      errors.push('Analyze video unexpectedly has outgoing connections.');
    }
    for (const [from, connectionKinds] of Object.entries(workflow.connections)) {
      for (const branches of Object.values(connectionKinds)) {
        if (branches.some((branch) => branch.some((edge) => edge.node === 'Analyze video'))) {
          errors.push(`Analyze video unexpectedly has an incoming edge from ${from}.`);
        }
      }
    }

    const requiredEdges = [
      ['Code: Parse Native Subtitles', 'Switch: Native Transcript Found'],
      ['Merge: Transcript Sources', 'Set: Final Transcript for AI'],
      ['Set: Final Transcript for AI', 'Switch: Operation Mode'],
      ['Set: Summary', 'Merge'],
    ];
    for (const [from, to] of requiredEdges) {
      if (!hasConnection(workflow, from, to)) {
        errors.push(`Required workflow edge is missing: ${from} -> ${to}.`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return errors;
}

function parseArgs(argv) {
  const args = {
    check: false,
    workflowPath: DEFAULT_WORKFLOW_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--check') {
      args.check = true;
    } else if (value === '--workflow') {
      args.workflowPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const originalText = readFileSync(args.workflowPath, 'utf8');
  const workflow = JSON.parse(originalText);
  const upgraded = upgradeWorkflow(workflow);
  const errors = validateWorkflow(upgraded);
  if (errors.length > 0) {
    throw new Error(`Workflow v3 validation failed:\n- ${errors.join('\n- ')}`);
  }

  const upgradedText = `${JSON.stringify(upgraded, null, 2)}\n`;
  if (args.check) {
    if (originalText !== upgradedText) {
      throw new Error(
        'Workflow is not upgraded or is not deterministically formatted. Run tools/upgrade-workflow-v3.mjs.',
      );
    }
    console.log('Workflow v3 check passed.');
    return;
  }

  if (originalText !== upgradedText) {
    writeFileSync(args.workflowPath, upgradedText, 'utf8');
    console.log(`Upgraded workflow: ${args.workflowPath}`);
  } else {
    console.log(`Workflow already current: ${args.workflowPath}`);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { CONTENT_ROUTE_PROMPT_MARKER, DEFAULT_WORKFLOW_PATH, RICH_PROMPT_MARKER, stableSegmentId };
