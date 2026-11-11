import type { VideoKnowledgeArtifact } from '../types';

/** What the plugin used to write into a note's properties, now kept beside the note. */
export interface NoteArtifactLink {
  artifactId: string;
  contentType?: string;
  attentionAction?: string;
  processingDepth?: string;
}

/**
 * Which stored record belongs to which note. The record itself keeps its note's path
 * (source.note_path), so this map is rebuilt from the records at startup and kept up to
 * date on every save, rename and delete; notes no longer carry video_artifact_id and the
 * other internal fields. Older notes that still have video_artifact_id keep working:
 * callers read that first.
 */
export class NoteArtifactLinks {
  private byPath = new Map<string, NoteArtifactLink>();
  private listeners = new Set<() => void>();

  static fromArtifact(artifact: VideoKnowledgeArtifact): NoteArtifactLink {
    return {
      artifactId: artifact.artifact_id,
      contentType: artifact.content_type || undefined,
      attentionAction: artifact.attention?.action || undefined,
      processingDepth: artifact.provenance?.processing_depth || undefined,
    };
  }

  rebuild(artifacts: VideoKnowledgeArtifact[]) {
    this.byPath.clear();
    // The newest record wins when two point at the same note.
    const sorted = [...artifacts].sort((a, b) =>
      String(a.updated_at || '').localeCompare(String(b.updated_at || '')),
    );
    for (const artifact of sorted) {
      const path = artifact.source?.note_path;
      if (path) this.byPath.set(path, NoteArtifactLinks.fromArtifact(artifact));
    }
    this.emit();
  }

  record(artifact: VideoKnowledgeArtifact) {
    const path = artifact.source?.note_path;
    if (!path) {
      // The note was deleted: the record stays, the link goes.
      let changed = false;
      for (const [key, link] of this.byPath) {
        if (link.artifactId === artifact.artifact_id) changed = this.byPath.delete(key) || changed;
      }
      if (changed) this.emit();
      return;
    }
    // A record that moved to another note no longer belongs to the old one.
    for (const [key, link] of this.byPath) {
      if (link.artifactId === artifact.artifact_id && key !== path) this.byPath.delete(key);
    }
    this.byPath.set(path, NoteArtifactLinks.fromArtifact(artifact));
    this.emit();
  }

  rename(oldPath: string, newPath: string) {
    const link = this.byPath.get(oldPath);
    if (!link) return;
    this.byPath.delete(oldPath);
    this.byPath.set(newPath, link);
    this.emit();
  }

  remove(path: string) {
    if (this.byPath.delete(path)) this.emit();
  }

  get(path: string): NoteArtifactLink | undefined {
    return this.byPath.get(path);
  }

  /** The note a record belongs to, if this map knows it. */
  pathFor(artifactId: string): string | undefined {
    for (const [path, link] of this.byPath) if (link.artifactId === artifactId) return path;
    return undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}
