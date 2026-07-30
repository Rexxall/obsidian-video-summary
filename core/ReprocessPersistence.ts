import type { ProcessingResult, VideoInput, VideoKnowledgeArtifact } from '../types';
import { ArtifactStore, normalizeTranscriptForHash, sha256Hex } from './ArtifactStore';

export interface ArtifactPersistenceIdentity {
  artifactId: string;
  sourceHash: string;
  source: VideoKnowledgeArtifact['source'];
  transcriptHash?: string;
}

/**
 * A no-fetch reprocess must treat the integrity-checked local snapshot as the
 * source of truth. A backend may legitimately return only a new summary, or it
 * may normalize the transcript; neither is allowed to change source identity.
 */
export function hydratePersistedReprocessResult(
  result: ProcessingResult,
  input: VideoInput,
  previous?: VideoKnowledgeArtifact,
): void {
  if (!input.skipSourceFetch) {
    result.video_transcript ||= input.transcript;
    return;
  }

  if (input.transcript?.trim()) {
    result.video_transcript = input.transcript;
  } else {
    result.video_transcript ||= previous?.transcript;
  }
  if (!result.video_segments?.length) {
    result.video_segments = input.persistedSegments || previous?.segments;
  }
  if (!result.evidence_claims?.length) {
    result.evidence_claims = input.persistedEvidenceClaims || previous?.claims;
  }
  if (!result.visual_evidence?.length) {
    result.visual_evidence = input.persistedVisualEvidence || previous?.visual_evidence;
  }
  result.timing_quality ||= previous?.timing_quality;
}

/**
 * Resolve the content-addressed identity only after persisted inputs have been
 * restored. When the caller supplied a known artifact, retain its reviewed
 * identity and update only the note locator.
 */
export async function resolveArtifactPersistenceIdentity(input: {
  jobInput: VideoInput;
  result: ProcessingResult;
  notePath?: string;
  previous?: VideoKnowledgeArtifact;
}): Promise<ArtifactPersistenceIdentity> {
  const { jobInput, result, notePath, previous } = input;
  const transcriptHash = result.video_transcript
    ? await sha256Hex(normalizeTranscriptForHash(result.video_transcript))
    : result.artifact?.transcript_hash;

  if (jobInput.skipSourceFetch && previous) {
    const source: VideoKnowledgeArtifact['source'] = {
      ...previous.source,
      note_path: notePath || previous.source.note_path,
      transcript_hash: previous.source.transcript_hash || transcriptHash,
      source_hash: previous.source.source_hash,
    };
    return {
      artifactId: previous.artifact_id,
      sourceHash: previous.source.source_hash,
      source,
      transcriptHash,
    };
  }

  const source: VideoKnowledgeArtifact['source'] = {
    url:
      (jobInput.skipSourceFetch
        ? jobInput.sourceUrl || jobInput.url
        : result.artifact?.source_url) ||
      jobInput.sourceUrl ||
      jobInput.url,
    local_file: jobInput.localFile,
    note_path: notePath,
    transcript_hash: transcriptHash,
    source_hash: '',
  };
  const sourceHash = await ArtifactStore.sourceHash(source);
  return {
    artifactId: ArtifactStore.artifactId(sourceHash),
    sourceHash,
    source: { ...source, source_hash: sourceHash },
    transcriptHash,
  };
}
