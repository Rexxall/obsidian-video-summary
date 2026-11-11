export const NOTE_PROMPT_MARKER: string;
export const NOTE_SYSTEM_MESSAGE: string;
export interface NotePromptSegment {
  id: string;
  start?: number | null;
  text: string;
}
export interface NotePromptInput {
  transcript?: string;
  segments?: NotePromptSegment[];
  title?: string;
  author?: string;
  language?: string;
  metadata?: Record<string, unknown>;
  retryCount?: number;
  parseError?: string;
}
export function buildNotePrompt(input: NotePromptInput): string;
export function notePromptExpression(): string;
