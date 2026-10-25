import type {
  EvidenceClaim,
  EvidenceReference,
  VideoKnowledgeArtifact,
  VideoSegment,
} from '../types';
import {
  isExactHostOrSubdomain,
  safeExternalHttpUrl,
  safeRemoteImageUrl,
} from '../utils/SafeExternalUrl';

export const CLAIM_LAB_CONTRACT_VERSION = 'claim-lab-v1';
export const CLAIM_LAB_MANAGED_START = '<!-- video-summary-claim-lab:start -->';
export const CLAIM_LAB_MANAGED_END = '<!-- video-summary-claim-lab:end -->';

const MAX_ARTIFACTS = 24;
const MAX_CLAIMS_PER_ARTIFACT = 80;
const MAX_FINDINGS = 240;
const MIN_PAIR_SIMILARITY = 0.18;
const AGREEMENT_SIMILARITY = 0.52;
const CONFLICT_TOPIC_SIMILARITY = 0.38;
const UPDATE_SIMILARITY = 0.38;

export type ClaimLabRelation = 'agreement' | 'conflict' | 'update' | 'unique' | 'unknown';

export interface ResolvedClaimEvidence {
  reference: EvidenceReference;
  segment: VideoSegment;
  quote: string;
  timestamp_url?: string;
}

export interface ResolvedArtifactClaim {
  artifact_id: string;
  artifact_title: string;
  claim: EvidenceClaim;
  evidence: ResolvedClaimEvidence[];
  evidence_state: 'supported' | 'needs-review' | 'missing';
}

export interface ClaimLabFinding {
  id: string;
  relation: ClaimLabRelation;
  left: ResolvedArtifactClaim;
  right?: ResolvedArtifactClaim;
  similarity: number;
  explanation: string;
  review_state: 'supported' | 'needs-review';
}

export interface ClaimLabReport {
  contract_version: typeof CLAIM_LAB_CONTRACT_VERSION;
  lab_id: string;
  title: string;
  artifact_ids: string[];
  generated_at: string;
  findings: ClaimLabFinding[];
  limitations: string[];
  managed_markdown: string;
}

export interface ClaimLabOptions {
  title?: string;
  now?: Date;
}

/**
 * Build a conservative, inspectable claim/evidence matrix.
 *
 * "Conflict" is only emitted when both claims resolve to real persisted
 * segments, substantially overlap in topic, and contain explicit opposing
 * direction or polarity cues. A weak lexical match is never promoted to a
 * conflict. Missing evidence is represented as `unknown / needs-review`.
 */
export function buildClaimLabReport(
  inputArtifacts: readonly VideoKnowledgeArtifact[],
  options: ClaimLabOptions = {},
): ClaimLabReport {
  const artifacts = uniqueArtifacts(inputArtifacts).slice(0, MAX_ARTIFACTS);
  if (artifacts.length < 2) {
    throw new Error('Claim Lab requires at least two persisted video artifacts');
  }

  const generatedAt = (options.now || new Date()).toISOString();
  const artifactIds = artifacts.map((artifact) => artifact.artifact_id).sort();
  const labId = `claim-lab-${stableTextHash(artifactIds.join('|'))}`;
  const title = cleanText(options.title) || `多视频论点实验室 · ${artifacts.length} 个视频`;
  const resolved = new Map(
    artifacts.map((artifact) => [
      artifact.artifact_id,
      artifact.claims
        .slice(0, MAX_CLAIMS_PER_ARTIFACT)
        .map((claim) => resolveArtifactClaim(artifact, claim)),
    ]),
  );

  const findings: ClaimLabFinding[] = [];
  for (let leftIndex = 0; leftIndex < artifacts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < artifacts.length; rightIndex += 1) {
      if (findings.length >= MAX_FINDINGS) break;
      const leftArtifact = artifacts[leftIndex];
      const rightArtifact = artifacts[rightIndex];
      findings.push(
        ...compareArtifactClaims(
          leftArtifact,
          resolved.get(leftArtifact.artifact_id) || [],
          rightArtifact,
          resolved.get(rightArtifact.artifact_id) || [],
          MAX_FINDINGS - findings.length,
        ),
      );
    }
  }

  const limitations: string[] = [];
  if (inputArtifacts.length > MAX_ARTIFACTS) {
    limitations.push(`为保证本地处理有界，本次只比较前 ${MAX_ARTIFACTS} 个工件。`);
  }
  if (artifacts.some((artifact) => artifact.claims.length > MAX_CLAIMS_PER_ARTIFACT)) {
    limitations.push(`每个工件最多比较前 ${MAX_CLAIMS_PER_ARTIFACT} 条主张。`);
  }
  if (findings.length >= MAX_FINDINGS) {
    limitations.push(`本次矩阵最多输出 ${MAX_FINDINGS} 条发现，剩余主张未自动比较。`);
  }
  limitations.push(
    '关系由可解释的本地文本规则建议；agreement/update/unique 仍应人工复核，conflict 只有在双方都有真实证据段且存在明确反向表述时才会标注。',
  );

  const reportBase: Omit<ClaimLabReport, 'managed_markdown'> = {
    contract_version: CLAIM_LAB_CONTRACT_VERSION,
    lab_id: labId,
    title,
    artifact_ids: artifactIds,
    generated_at: generatedAt,
    findings,
    limitations,
  };
  return {
    ...reportBase,
    managed_markdown: renderClaimLabManagedMarkdown(reportBase, artifacts),
  };
}

/**
 * Replace only the generated Claim Lab block. Everything outside the marker
 * pair, including a user's free-form notes, is preserved byte-for-byte.
 */
export function upsertClaimLabMarkdown(existing: string, report: ClaimLabReport): string {
  const block = report.managed_markdown.trim();
  if (!existing) {
    return [
      `# ${escapeMarkdownText(report.title)}`,
      '',
      block,
      '',
      '## 我的判断与批注',
      '',
      '> 在这里写你的结论；重新生成时此区域不会被覆盖。',
      '',
    ].join('\n');
  }
  const startIndex = existing.indexOf(CLAIM_LAB_MANAGED_START);
  const endIndex = existing.indexOf(CLAIM_LAB_MANAGED_END);

  if (startIndex >= 0 && endIndex >= startIndex) {
    const suffixIndex = endIndex + CLAIM_LAB_MANAGED_END.length;
    return `${existing.slice(0, startIndex)}${block}${existing.slice(suffixIndex)}`;
  }

  if (startIndex >= 0 || endIndex >= 0) {
    throw new Error(
      'Claim Lab managed block markers are incomplete; refusing to overwrite user text',
    );
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}

export function compareResolvedClaims(
  left: ResolvedArtifactClaim,
  right: ResolvedArtifactClaim,
  leftArtifact: VideoKnowledgeArtifact,
  rightArtifact: VideoKnowledgeArtifact,
): Omit<ClaimLabFinding, 'id' | 'left' | 'right'> {
  const similarity = claimSimilarity(left.claim.claim, right.claim.claim);
  if (left.evidence_state !== 'supported' || right.evidence_state !== 'supported') {
    return {
      relation: 'unknown',
      similarity,
      explanation: '至少一侧主张没有经过支持态复核的真实时间段证据，不能判断一致、冲突或更新。',
      review_state: 'needs-review',
    };
  }

  const opposition = explicitOpposition(left.claim.claim, right.claim.claim);
  const topicSimilarity = claimSimilarity(
    stripDirectionCues(left.claim.claim),
    stripDirectionCues(right.claim.claim),
  );
  if (opposition && topicSimilarity >= CONFLICT_TOPIC_SIMILARITY) {
    return {
      relation: 'conflict',
      similarity: Math.max(similarity, topicSimilarity),
      explanation: `双方证据完整，主题重合度 ${percent(topicSimilarity)}，并出现明确反向表述（${opposition}）。`,
      review_state: 'supported',
    };
  }

  const newer = newerArtifact(leftArtifact, rightArtifact);
  if (
    similarity >= UPDATE_SIMILARITY &&
    newer &&
    containsUpdateCue(newer === 'left' ? left.claim.claim : right.claim.claim)
  ) {
    return {
      relation: 'update',
      similarity,
      explanation: `双方证据完整、主题重合度 ${percent(similarity)}；较新的工件使用了明确更新表述。`,
      review_state: 'supported',
    };
  }

  if (similarity >= AGREEMENT_SIMILARITY) {
    return {
      relation: 'agreement',
      similarity,
      explanation: `双方证据完整，主张文本重合度 ${percent(similarity)}，未发现明确反向表述。`,
      review_state: 'supported',
    };
  }

  return {
    relation: 'unknown',
    similarity,
    explanation: `双方虽有证据，但文本重合度仅 ${percent(similarity)}，不足以可靠判断关系。`,
    review_state: 'needs-review',
  };
}

export function resolveArtifactClaim(
  artifact: VideoKnowledgeArtifact,
  claim: EvidenceClaim,
): ResolvedArtifactClaim {
  const segments = new Map(artifact.segments.map((segment) => [segment.id, segment]));
  const evidence = claim.evidence.flatMap((reference): ResolvedClaimEvidence[] => {
    const segment = segments.get(reference.segment_id);
    if (!segment || !cleanText(segment.text)) return [];
    const requestedQuote = cleanText(reference.quote);
    const quote =
      requestedQuote &&
      normalizeComparable(segment.text).includes(normalizeComparable(requestedQuote))
        ? requestedQuote
        : cleanText(segment.text);
    return [
      {
        reference,
        segment,
        quote,
        timestamp_url: segment.timestamp_url || timestampUrl(artifact.source.url, segment.start),
      },
    ];
  });
  return {
    artifact_id: artifact.artifact_id,
    artifact_title: cleanText(artifact.title) || artifact.artifact_id,
    claim,
    evidence,
    evidence_state:
      evidence.length === 0
        ? 'missing'
        : claim.review_state && claim.review_state !== 'supported'
          ? 'needs-review'
          : 'supported',
  };
}

export function claimSimilarity(left: string, right: string): number {
  const leftTokens = semanticTokens(left);
  const rightTokens = semanticTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const containment = intersection / Math.min(leftTokens.size, rightTokens.size);
  return roundScore(jaccard * 0.55 + containment * 0.45);
}

function compareArtifactClaims(
  leftArtifact: VideoKnowledgeArtifact,
  leftClaims: readonly ResolvedArtifactClaim[],
  rightArtifact: VideoKnowledgeArtifact,
  rightClaims: readonly ResolvedArtifactClaim[],
  limit: number,
): ClaimLabFinding[] {
  if (limit <= 0) return [];
  if (leftClaims.length === 0 && rightClaims.length === 0) {
    return [];
  }

  const output: ClaimLabFinding[] = [];
  const pairedRight = new Set<string>();
  for (const left of leftClaims) {
    if (output.length >= limit) break;
    const ranked = rightClaims
      .map((right) => ({ right, similarity: claimSimilarity(left.claim.claim, right.claim.claim) }))
      .sort(
        (a, b) => b.similarity - a.similarity || a.right.claim.id.localeCompare(b.right.claim.id),
      );
    const best = ranked[0];

    if (!best || best.similarity < MIN_PAIR_SIMILARITY) {
      output.push(uniqueFinding(left));
      continue;
    }

    pairedRight.add(best.right.claim.id);
    const comparison = compareResolvedClaims(left, best.right, leftArtifact, rightArtifact);
    output.push({
      id: findingId(left, best.right),
      left,
      right: best.right,
      ...comparison,
    });
  }

  for (const right of rightClaims) {
    if (output.length >= limit) break;
    if (!pairedRight.has(right.claim.id)) output.push(uniqueFinding(right));
  }
  return output;
}

function uniqueFinding(claim: ResolvedArtifactClaim): ClaimLabFinding {
  const hasEvidence = claim.evidence_state === 'supported';
  return {
    id: findingId(claim),
    relation: hasEvidence ? 'unique' : 'unknown',
    left: claim,
    similarity: 0,
    explanation: hasEvidence
      ? '在本次其他视频中没有找到达到最低主题重合度的对应主张。'
      : '主张没有可解析到真实时间段的证据，暂不能作为独有结论。',
    review_state: hasEvidence ? 'supported' : 'needs-review',
  };
}

function renderClaimLabManagedMarkdown(
  report: Omit<ClaimLabReport, 'managed_markdown'>,
  artifacts: readonly VideoKnowledgeArtifact[],
): string {
  const counts = relationCounts(report.findings);
  const lines = [
    CLAIM_LAB_MANAGED_START,
    `> [!info] 自动生成的证据矩阵`,
    `> 合同：\`${CLAIM_LAB_CONTRACT_VERSION}\` · 生成时间：${report.generated_at} · 工件：${artifacts.length}`,
    '',
    '## 比较范围',
    '',
    ...artifacts.map(
      (artifact) =>
        `- ${artifactSourceLink(artifact)} · \`${artifact.artifact_id}\` · ${artifact.claims.length} 条主张`,
    ),
    '',
    '## 关系计数',
    '',
    '| 关系 | 数量 | 含义 |',
    '| --- | ---: | --- |',
    `| agreement | ${counts.agreement} | 双方有真实证据且表述高度重合 |`,
    `| conflict | ${counts.conflict} | 双方有真实证据、主题重合且存在明确反向表述 |`,
    `| update | ${counts.update} | 较新的有证据表述明确更新了同一主题 |`,
    `| unique | ${counts.unique} | 有证据，但其他视频没有足够接近的主张 |`,
    `| unknown | ${counts.unknown} | 证据缺失或相似度不足，需要人工判断 |`,
    '',
    '## 主张 × 工件证据矩阵',
    '',
    `| 发现 | 关系 | ${artifacts
      .map(
        (artifact) =>
          `${escapeTableCell(cleanText(artifact.title) || artifact.artifact_id)}<br><code>${escapeTableCell(artifact.artifact_id)}</code>`,
      )
      .join(' | ')} |`,
    `| --- | --- | ${artifacts.map(() => '---').join(' | ')} |`,
    ...(report.findings.length > 0
      ? report.findings.map((finding, index) => {
          const claimsByArtifact = new Map<string, ResolvedArtifactClaim>();
          claimsByArtifact.set(finding.left.artifact_id, finding.left);
          if (finding.right) claimsByArtifact.set(finding.right.artifact_id, finding.right);
          const cells = artifacts.map((artifact) => {
            const claim = claimsByArtifact.get(artifact.artifact_id);
            return claim ? renderMatrixCell(claim) : '**missing**';
          });
          return `| ${index + 1} | ${finding.relation} | ${cells.join(' | ')} |`;
        })
      : [`| - | unknown | ${artifacts.map(() => '**missing / needs-review**').join(' | ')} |`]),
    '',
    '## 逐项证据',
    '',
  ];

  if (report.findings.length === 0) {
    lines.push('> [!warning] 没有可比较的持久化主张。', '');
  } else {
    report.findings.forEach((finding, index) => {
      lines.push(
        `### ${index + 1}. ${relationLabel(finding.relation)} · ${finding.review_state}`,
        '',
        `- 判断：${escapeMarkdownText(finding.explanation)}`,
        `- 左侧主张（${artifactClaimSource(finding.left)}）：${escapeMarkdownText(finding.left.claim.claim)}`,
        ...renderResolvedEvidence(finding.left),
      );
      if (finding.right) {
        lines.push(
          `- 右侧主张（${artifactClaimSource(finding.right)}）：${escapeMarkdownText(finding.right.claim.claim)}`,
          ...renderResolvedEvidence(finding.right),
        );
      } else {
        lines.push('- 右侧主张：缺少对应主张（missing counterpart）');
      }
      lines.push('');
    });
  }

  lines.push(
    '## 限制与复核',
    '',
    ...report.limitations.map((limitation) => `- ${escapeMarkdownText(limitation)}`),
    '',
    CLAIM_LAB_MANAGED_END,
  );
  return lines.join('\n');
}

function renderMatrixCell(resolved: ResolvedArtifactClaim): string {
  const claim = escapeTableCell(truncateText(resolved.claim.claim, 96));
  const evidence = resolved.evidence[0];
  if (!evidence) {
    return `**主张：** ${claim}<br>**证据：missing / needs-review**`;
  }
  const time = formatTimestamp(evidence.segment.start);
  const evidenceUrl = safeExternalHttpUrl(evidence.timestamp_url);
  const timeLabel = evidenceUrl ? `[${time}](<${escapeLinkDestination(evidenceUrl)}>)` : time;
  const quote = escapeTableCell(truncateText(evidence.quote, 110));
  return `**主张：** ${claim}<br>**证据：** ${timeLabel} “${quote}”`;
}

function renderResolvedEvidence(resolved: ResolvedArtifactClaim): string[] {
  if (resolved.evidence.length === 0) {
    return ['  - 证据：**missing / needs-review**（没有真实 segment 引用）'];
  }
  return resolved.evidence.slice(0, 4).map((evidence) => {
    const time = formatTimestamp(evidence.segment.start);
    const evidenceUrl = safeExternalHttpUrl(evidence.timestamp_url);
    const timeLabel = evidenceUrl ? `[${time}](<${escapeLinkDestination(evidenceUrl)}>)` : time;
    const remoteKeyframe = safeRemoteImageUrl(evidence.segment.keyframe?.url);
    const keyframeLink = remoteKeyframe
      ? ` · [关键帧](<${escapeLinkDestination(remoteKeyframe)}>)`
      : '';
    return `  - 证据 ${timeLabel} · ${evidence.reference.source}${keyframeLink}：“${escapeMarkdownText(evidence.quote)}”`;
  });
}

function artifactClaimSource(claim: ResolvedArtifactClaim): string {
  return `${escapeMarkdownText(claim.artifact_title)} · \`${claim.artifact_id}\``;
}

function artifactSourceLink(artifact: VideoKnowledgeArtifact): string {
  const title = escapeMarkdownText(cleanText(artifact.title) || artifact.artifact_id);
  const sourceUrl = safeExternalHttpUrl(artifact.source.url);
  if (sourceUrl) {
    return `[${title}](<${escapeLinkDestination(sourceUrl)}>)`;
  }
  if (artifact.source.note_path) {
    return `[[${artifact.source.note_path.replace(/\|/g, '\\|')}|${title}]]`;
  }
  return title;
}

function relationCounts(findings: readonly ClaimLabFinding[]): Record<ClaimLabRelation, number> {
  const counts: Record<ClaimLabRelation, number> = {
    agreement: 0,
    conflict: 0,
    update: 0,
    unique: 0,
    unknown: 0,
  };
  findings.forEach((finding) => {
    counts[finding.relation] += 1;
  });
  return counts;
}

function relationLabel(relation: ClaimLabRelation): string {
  const labels: Record<ClaimLabRelation, string> = {
    agreement: '一致 agreement',
    conflict: '冲突 conflict',
    update: '更新 update',
    unique: '独有 unique',
    unknown: '未知 unknown',
  };
  return labels[relation];
}

function explicitOpposition(left: string, right: string): string | undefined {
  const pairs: Array<[RegExp, RegExp, string]> = [
    [
      /(?:增加|上升|提高|增长|rise|increase|higher|improve)/iu,
      /(?:减少|下降|降低|衰退|fall|decrease|lower|decline)/iu,
      '上升 vs 下降',
    ],
    [
      /(?:支持|赞成|(?<!无)有效|(?<!不)可行|(?<!不)安全|\bsupport\b|\beffective\b|\bfeasible\b|\bsafe\b)/iu,
      /(?:反对|否定|无效|不可行|不安全|\boppose\b|\bineffective\b|\binfeasible\b|\bunsafe\b|\brefute\b)/iu,
      '支持/有效 vs 反对/无效',
    ],
    [
      /(?:(?<!不)应该|必须|需要|\bshould\b(?!\s+not\b)|\bmust\b(?!\s+not\b)|\brequired\b)/iu,
      /(?:不应该|无需|禁止|\bshould\s+not\b|\bmust\s+not\b|\bunnecessary\b|\bprohibited\b)/iu,
      '应该/必须 vs 不应该/禁止',
    ],
    [
      /(?:真实|正确|(?<!不)成立|\btrue\b|\bcorrect\b|\bconfirmed\b)/iu,
      /(?:虚假|错误|不成立|\bfalse\b|\bincorrect\b|\bdisproved\b)/iu,
      '成立 vs 不成立',
    ],
  ];
  for (const [positive, negative, label] of pairs) {
    if (
      (positive.test(left) && negative.test(right)) ||
      (negative.test(left) && positive.test(right))
    ) {
      return label;
    }
  }
  const leftNegated = hasNegation(left);
  const rightNegated = hasNegation(right);
  if (leftNegated !== rightNegated) return '肯定 vs 明确否定';
  return undefined;
}

function stripDirectionCues(value: string): string {
  return value.replace(
    /增加|上升|提高|增长|减少|下降|降低|衰退|支持|赞成|有效|可行|安全|反对|否定|无效|不可行|不安全|应该|必须|需要|不应该|无需|禁止|真实|正确|成立|虚假|错误|不成立|rise|increase|higher|improve|fall|decrease|lower|decline|support|effective|feasible|safe|oppose|ineffective|infeasible|unsafe|refute|should|must|required|unnecessary|prohibited|true|correct|confirmed|false|incorrect|disproved/giu,
    ' ',
  );
}

function hasNegation(value: string): boolean {
  return /(?:不|没|无|未|否|not\b|never\b|no longer\b|cannot\b|can't\b|won't\b)/iu.test(value);
}

function containsUpdateCue(value: string): boolean {
  return /(?:最新|目前|现在|更新|修正|改为|截至|新版|new evidence|latest|currently|updated|revised|as of|now)/iu.test(
    value,
  );
}

function newerArtifact(
  left: VideoKnowledgeArtifact,
  right: VideoKnowledgeArtifact,
): 'left' | 'right' | undefined {
  const leftTime = artifactTime(left);
  const rightTime = artifactTime(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return undefined;
  const difference = leftTime - rightTime;
  if (Math.abs(difference) < 60_000) return undefined;
  return difference > 0 ? 'left' : 'right';
}

function artifactTime(artifact: VideoKnowledgeArtifact): number {
  return Date.parse(artifact.provenance.generated_at || artifact.updated_at);
}

function semanticTokens(value: string): Set<string> {
  const normalized = normalizeComparable(value);
  const tokens = new Set<string>();
  const latin = normalized.match(/[a-z0-9][a-z0-9_-]+/g) || [];
  latin.forEach((token) => {
    if (!STOP_WORDS.has(token)) tokens.add(token);
  });
  const cjkRuns =
    normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || [];
  cjkRuns.forEach((run) => {
    const characters = Array.from(run);
    if (characters.length === 1) tokens.add(characters[0]);
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.add(characters.slice(index, index + 2).join(''));
    }
  });
  return tokens;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'are',
  'was',
  'were',
  'have',
  'has',
  'video',
]);

function timestampUrl(sourceUrl: string | undefined, seconds: number | null): string | undefined {
  if (!sourceUrl || seconds === null || !Number.isFinite(seconds) || seconds < 0) return undefined;
  try {
    const safeSource = safeExternalHttpUrl(sourceUrl);
    if (!safeSource) return undefined;
    const url = new URL(safeSource);
    if (url.hostname === 'youtu.be' || isExactHostOrSubdomain(url.hostname, 'youtube.com')) {
      url.searchParams.set('t', `${Math.floor(seconds)}s`);
      return url.toString();
    }
    if (isExactHostOrSubdomain(url.hostname, 'bilibili.com') || url.hostname === 'b23.tv') {
      url.searchParams.set('t', String(Math.floor(seconds)));
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function formatTimestamp(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '时间未对齐';
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function uniqueArtifacts(artifacts: readonly VideoKnowledgeArtifact[]): VideoKnowledgeArtifact[] {
  const byId = new Map<string, VideoKnowledgeArtifact>();
  artifacts.forEach((artifact) => {
    if (artifact?.artifact_id && !byId.has(artifact.artifact_id)) {
      byId.set(artifact.artifact_id, artifact);
    }
  });
  return Array.from(byId.values());
}

function findingId(left: ResolvedArtifactClaim, right?: ResolvedArtifactClaim): string {
  return `finding-${stableTextHash(
    `${left.artifact_id}:${left.claim.id}|${right?.artifact_id || ''}:${right?.claim.id || ''}`,
  )}`;
}

export function stableTextHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeComparable(value: string): string {
  return cleanText(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeMarkdownText(value: string): string {
  return cleanText(value)
    .replace(/\\/g, '\\\\')
    .replace(/([*_[\]`|])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/\r?\n/g, ' ');
}

function escapeTableCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, '\\|');
}

function truncateText(value: string, maximum: number): string {
  const characters = Array.from(cleanText(value));
  return characters.length <= maximum
    ? characters.join('')
    : `${characters.slice(0, Math.max(1, maximum - 1)).join('')}…`;
}

function escapeLinkDestination(value: string): string {
  return value.replace(/[<>]/g, encodeURIComponent);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}
