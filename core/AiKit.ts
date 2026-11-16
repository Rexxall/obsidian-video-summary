import { Platform, requestUrl, type App } from 'obsidian';
import {
  AiClient,
  ModelCache,
  nodeCliRunner,
  nodeStream,
  requestUrlTransport,
  type Lang,
  type ModelCacheData,
} from '../vendor/rex-ai-kit/index';
import { isChinese } from '../utils/i18n';
import { hasSecretStorage } from './ModelSettings';

/** The plugin speaks Chinese or English; the shared AI settings follow the same choice. */
export function aiLang(): Lang & ('zh' | 'en') {
  return isChinese() ? 'zh' : 'en';
}

/**
 * Nothing here touches the network: requests start when a job runs or the person presses
 * Check in settings. On desktop the reply streams through Node, so every provider shows the
 * note as it is written; Claude Code and Codex on this computer read text only.
 */
export function createAiClient(app: App, cache: ModelCacheData | undefined): AiClient {
  return new AiClient({
    keys: hasSecretStorage(app) ? app.secretStorage : undefined,
    transport: requestUrlTransport(requestUrl),
    stream: Platform.isDesktopApp ? nodeStream() : undefined,
    cache: new ModelCache(cache),
    cli: Platform.isDesktopApp ? nodeCliRunner() : undefined,
    lang: aiLang(),
  });
}
