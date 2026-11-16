/**
 * The light tier's chat call over rex-ai-kit: every provider the kit knows (OpenAI, Anthropic,
 * Gemini, DeepSeek, the local Claude Code and Codex…), streamed where the transport allows,
 * errors explained in the interface language. No obsidian import, so tests drive it with a
 * fake client.
 */
import type { Chat, ChatMessage } from './LiteTier';
import { isReasoningModel } from './LiteTier';
import {
  AiError,
  explainError,
  type AiSlot,
  type CompleteOptions,
  type CompleteResult,
} from '../vendor/rex-ai-kit/index';

/** The part of AiClient this needs. */
export interface ChatClient {
  complete(
    slot: AiSlot,
    opts: Omit<CompleteOptions, 'model'> & { model?: string },
  ): Promise<CompleteResult>;
}

/**
 * A note in JSON with its transcript references runs to several thousand tokens; the kit's
 * default of 4096 cut long ones off. Services with their own OpenAI-compatible servers often
 * cap max_tokens at 8192 and answer 400 above it.
 */
function maxTokensFor(provider: string): number {
  return ['openai', 'anthropic', 'gemini', 'openrouter'].includes(provider) ? 32_000 : 8_192;
}

export function kitChat(client: ChatClient, slot: AiSlot, lang: 'zh' | 'en'): Chat {
  return async (messages, jsonMode, onText, signal) => {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const turns = messages
      .filter(
        (message): message is ChatMessage & { role: 'user' | 'assistant' } =>
          message.role !== 'system',
      )
      .map((message) => ({ role: message.role, content: message.content }));
    const ask = (json: boolean) => {
      let full = '';
      return client.complete(slot, {
        system: system || undefined,
        messages: turns,
        json,
        maxTokens: maxTokensFor(slot.provider),
        // Same as the backend's chat node; reasoning models only take the default.
        temperature: isReasoningModel(slot.model) ? undefined : 0.4,
        signal,
        onText: (piece) => {
          full += piece;
          onText(full, 0);
        },
      });
    };
    try {
      let reply: CompleteResult;
      try {
        reply = await ask(jsonMode);
      } catch (error) {
        // A service that does not take JSON mode answers 400; ask once more without it.
        if (!(jsonMode && error instanceof AiError && error.status === 400)) throw error;
        reply = await ask(false);
      }
      if (!reply.text.trim()) {
        throw new AiError('The model sent an empty reply', 'bad-response', undefined, undefined);
      }
      return reply.text;
    } catch (error) {
      if (error instanceof AiError && error.kind === 'aborted') throw error;
      throw new Error(explainError(error, lang));
    }
  };
}
