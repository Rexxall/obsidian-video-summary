import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAIM_LAB_MANAGED_END,
  CLAIM_LAB_MANAGED_START,
  buildClaimLabReport,
  compareResolvedClaims,
  resolveArtifactClaim,
  upsertClaimLabMarkdown,
} from '../core/ClaimLab';
import type { EvidenceClaim, VideoKnowledgeArtifact } from '../types';

void test('claim lab marks an explicit, fully evidenced opposition as conflict', () => {
  const left = artifact('left', 'https://youtu.be/left', {
    claim: '课程指出规律运动会增加记忆表现',
    quote: '规律运动会增加记忆表现',
  });
  const right = artifact('right', 'https://youtu.be/right', {
    claim: '新研究指出规律运动会降低记忆表现',
    quote: '规律运动会降低记忆表现',
  });

  const report = buildClaimLabReport([left, right], {
    now: new Date('2026-07-29T10:00:00Z'),
  });
  const conflict = report.findings.find((finding) => finding.relation === 'conflict');

  assert.ok(conflict);
  assert.equal(conflict.review_state, 'supported');
  assert.equal(conflict.left.evidence_state, 'supported');
  assert.equal(conflict.right?.evidence_state, 'supported');
  assert.match(report.managed_markdown, /\[0:12\]\(<https:\/\/youtu\.be\/left\?t=12s>\)/);
  assert.match(report.managed_markdown, /规律运动会增加记忆表现/);
  assert.match(report.managed_markdown, /\[左侧视频\]\(<https:\/\/youtu\.be\/left>\)/);
});

void test('missing segment evidence remains unknown and never becomes a fabricated conflict', () => {
  const left = artifact('left', 'https://youtu.be/left', {
    claim: '治疗会提高生存率',
    quote: '治疗会提高生存率',
  });
  const right = artifact('right', 'https://youtu.be/right', {
    claim: '治疗会降低生存率',
    quote: '治疗会降低生存率',
  });
  right.claims[0].evidence = [{ segment_id: 'does-not-exist', source: 'speech' }];

  const comparison = compareResolvedClaims(
    resolveArtifactClaim(left, left.claims[0]),
    resolveArtifactClaim(right, right.claims[0]),
    left,
    right,
  );
  const report = buildClaimLabReport([left, right]);

  assert.equal(comparison.relation, 'unknown');
  assert.equal(comparison.review_state, 'needs-review');
  assert.equal(
    report.findings.some((finding) => finding.relation === 'conflict'),
    false,
  );
  assert.match(report.managed_markdown, /missing \/ needs-review/);
});

void test('identical negative claims never become a conflict through substring matches', () => {
  for (const claimText of ['系统不安全', 'The system is unsafe', '这个结论不成立']) {
    const left = artifact('negative-left', 'https://youtu.be/negative-left', {
      claim: claimText,
      quote: claimText,
    });
    const right = artifact('negative-right', 'https://youtu.be/negative-right', {
      claim: claimText,
      quote: claimText,
    });
    const comparison = compareResolvedClaims(
      resolveArtifactClaim(left, left.claims[0]),
      resolveArtifactClaim(right, right.claims[0]),
      left,
      right,
    );
    assert.notEqual(comparison.relation, 'conflict');
  }
});

void test('an inference claim with a real segment remains needs-review in Claim Lab', () => {
  const left = artifact('inference-left', 'https://youtu.be/inference-left', {
    claim: '治疗可能提高生存率',
    quote: '治疗可能提高生存率',
  });
  const right = artifact('inference-right', 'https://youtu.be/inference-right', {
    claim: '治疗可能提高生存率',
    quote: '治疗可能提高生存率',
  });
  left.claims[0].review_state = 'inference';

  const resolved = resolveArtifactClaim(left, left.claims[0]);
  const comparison = compareResolvedClaims(
    resolved,
    resolveArtifactClaim(right, right.claims[0]),
    left,
    right,
  );

  assert.equal(resolved.evidence_state, 'needs-review');
  assert.equal(comparison.relation, 'unknown');
  assert.equal(comparison.review_state, 'needs-review');
});

void test('claim lab managed-block rerun preserves the user-authored region byte-for-byte', () => {
  const first = buildClaimLabReport([
    artifact('left', 'https://youtu.be/left', { claim: '初版结论', quote: '初版结论' }),
    artifact('right', 'https://youtu.be/right', { claim: '另一结论', quote: '另一结论' }),
  ]);
  const initial = upsertClaimLabMarkdown('', first);
  const userSuffix = '\n## 用户分析\n\n- [ ] 我自己的复核\n\n这段绝不能覆盖。\n';
  const before = `${initial}${userSuffix}`;
  const second = buildClaimLabReport([
    artifact('left', 'https://youtu.be/left', {
      claim: '重跑后的结论',
      quote: '重跑后的结论',
    }),
    artifact('right', 'https://youtu.be/right', { claim: '另一结论', quote: '另一结论' }),
  ]);

  const after = upsertClaimLabMarkdown(before, second);

  assert.match(after, /重跑后的结论/);
  assert.doesNotMatch(after, /初版结论/);
  assert.ok(after.endsWith(userSuffix));
  assert.equal(count(after, CLAIM_LAB_MANAGED_START), 1);
  assert.equal(count(after, CLAIM_LAB_MANAGED_END), 1);
});

void test('artifact-column matrix renders every selected artifact and explicit missing cells', () => {
  const first = artifact('matrix-a', 'https://youtu.be/matrix-a', {
    claim: '苹果含有膳食纤维',
    quote: '苹果含有膳食纤维',
  });
  const second = artifact('matrix-b', 'https://youtu.be/matrix-b', {
    claim: '苹果的膳食纤维有助于饱腹',
    quote: '苹果的膳食纤维有助于饱腹',
  });
  const third = artifact('matrix-c', 'https://youtu.be/matrix-c', {
    claim: '火星表面存在峡谷',
    quote: '火星表面存在峡谷',
  });

  const report = buildClaimLabReport([first, second, third]);

  assert.match(report.managed_markdown, /## 主张 × 工件证据矩阵/);
  for (const artifactId of ['matrix-a', 'matrix-b', 'matrix-c']) {
    assert.match(report.managed_markdown, new RegExp(`<code>${artifactId}<\\/code>`));
  }
  assert.match(report.managed_markdown, /\*\*主张：\*\*/);
  assert.match(report.managed_markdown, /\*\*证据：\*\*/);
  assert.match(report.managed_markdown, /\*\*missing\*\*/);
});

void test('claim lab refuses fewer than two persisted artifact selections', () => {
  assert.throws(
    () =>
      buildClaimLabReport([
        artifact('only-one', 'https://youtu.be/only', {
          claim: '只有一个',
          quote: '只有一个',
        }),
      ]),
    /at least two persisted video artifacts/,
  );
});

function artifact(
  id: string,
  url: string,
  content: { claim: string; quote: string },
): VideoKnowledgeArtifact {
  const segmentId = `${id}-segment`;
  const claim: EvidenceClaim = {
    id: `${id}-claim`,
    claim: content.claim,
    evidence: [{ segment_id: segmentId, source: 'speech', quote: content.quote }],
  };
  return {
    schema_version: 3,
    artifact_id: id,
    source: {
      url,
      note_path: `Videos/${id}.md`,
      source_hash: id.padEnd(8, 'a').slice(0, 8),
    },
    title: id === 'left' ? '左侧视频' : '右侧视频',
    platform: 'youtube',
    timing_quality: 'exact',
    transcript: content.quote,
    segments: [
      {
        id: segmentId,
        start: 12,
        end: 18,
        text: content.quote,
        source: 'speech',
        timing_quality: 'exact',
      },
    ],
    claims: [claim],
    visual_evidence: [],
    related_notes: [],
    highlights: [],
    course_ids: [],
    provenance: {
      schema_version: 3,
      generated_at: id === 'right' ? '2026-07-29T00:00:00Z' : '2026-07-28T00:00:00Z',
    },
    created_at: '2026-07-28T00:00:00Z',
    updated_at: id === 'right' ? '2026-07-29T00:00:00Z' : '2026-07-28T00:00:00Z',
  };
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
