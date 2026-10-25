import type { Vault } from 'obsidian';
import type { ProcessingMode, ProcessingResult, SupportedLanguage } from '../types';
import type { ArtifactFingerprint } from '../core/ArtifactFingerprint';

type CacheScheme = 'legacy-v1' | 'fingerprint-v2';

interface CacheIndexEntry {
  url: string;
  mode: ProcessingMode;
  language: SupportedLanguage;
  timestamp: number;
  expiryTimestamp: number;
  size: number;
  path: string;
  scheme?: CacheScheme;
  fingerprintDigest?: string;
  sourceHash?: string;
  runHash?: string;
}

export interface CacheIndex {
  version: string;
  lastUpdated: number;
  maxSize: number;
  expiryDays: number;
  items: Record<string, CacheIndexEntry>;
}

interface LegacyCacheItem {
  url: string;
  mode: ProcessingMode;
  language: SupportedLanguage;
  result: ProcessingResult;
  timestamp: number;
  expiryTimestamp: number;
}

interface FingerprintCacheItem {
  scheme: 'fingerprint-v2';
  fingerprint: {
    version: number;
    key: string;
    digest: string;
    sourceHash: string;
    runHash: string;
  };
  url: string;
  mode: ProcessingMode;
  language: SupportedLanguage;
  result: ProcessingResult;
  timestamp: number;
  expiryTimestamp: number;
}

export class CacheManager {
  private maxSize = 1000;
  private defaultExpiryDays = 30;
  private readonly vault: Vault;
  private readonly pluginDataPath: string;
  private readonly cacheDir: string;
  private readonly indexFile: string;
  private readonly itemsDir: string;
  private index: CacheIndex;
  private isInitialized = false;
  private enabled = true;
  private readonly initialization: Promise<void>;

  constructor(vault: Vault, pluginDataPath?: string) {
    this.vault = vault;
    // 不要写死 vault 配置目录名。优先使用安装目录，回退到 vault.configDir。
    this.pluginDataPath = pluginDataPath || `${vault.configDir}/plugins/video-summary/data`;
    this.cacheDir = `${this.pluginDataPath}/cache`;
    this.indexFile = `${this.cacheDir}/index.json`;
    this.itemsDir = `${this.cacheDir}/items`;
    this.index = this.createDefaultIndex();
    this.initialization = this.initializeCache();
  }

  private createDefaultIndex(): CacheIndex {
    return {
      version: '3.0.0',
      lastUpdated: Date.now(),
      maxSize: this.maxSize,
      expiryDays: this.defaultExpiryDays,
      items: {},
    };
  }

  private async initializeCache(): Promise<void> {
    try {
      await this.ensureCacheDirectory();
      await this.loadIndex();
      // Internal migration/cleanup methods need the index to be usable while
      // this initialization promise is still pending.
      this.isInitialized = true;
      await this.migrateFromLocalStorage();
      await this.cleanupInternal();
    } catch (error) {
      console.error('初始化缓存失败:', error);
      this.isInitialized = false;
    }
  }

  /** Useful for startup callers and deterministic tests. */
  async whenReady(): Promise<boolean> {
    await this.initialization;
    return this.isInitialized;
  }

  private async ensureCacheDirectory(): Promise<void> {
    if (!(await this.vault.adapter.exists(this.cacheDir))) {
      await this.vault.adapter.mkdir(this.cacheDir);
    }
    if (!(await this.vault.adapter.exists(this.itemsDir))) {
      await this.vault.adapter.mkdir(this.itemsDir);
    }
  }

  private legacyKey(url: string, mode: ProcessingMode, language: SupportedLanguage): string {
    return `${url}|${mode}|${language}`;
  }

  private legacyFilePath(key: string): string {
    return `${this.itemsDir}/${this.hashString(key)}.json`;
  }

  private fingerprintFilePath(fingerprint: ArtifactFingerprint): string {
    return `${this.itemsDir}/${fingerprint.digest}.json`;
  }

  private hashString(value: string): string {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash &= hash;
    }
    return Math.abs(hash).toString(36);
  }

  private async migrateFromLocalStorage(): Promise<void> {
    try {
      if (typeof localStorage === 'undefined') return;
      const oldCacheData = localStorage.getItem('video-summary-cache');
      if (!oldCacheData) return;

      console.log('发现旧缓存数据，开始迁移...');
      const entries = JSON.parse(oldCacheData) as Array<
        [string, { mode?: ProcessingMode; language?: SupportedLanguage; result: ProcessingResult }]
      >;
      let migratedCount = 0;
      for (const [key, item] of entries) {
        try {
          await this.writeLegacyEntry(
            key.split('|')[0],
            item.mode || 'summary',
            item.language || 'zh',
            item.result,
          );
          migratedCount += 1;
        } catch (error) {
          console.error(`迁移缓存项失败: ${key}`, error);
        }
      }
      console.log(`迁移完成，共迁移 ${migratedCount} 项`);
      localStorage.removeItem('video-summary-cache');
    } catch (error) {
      console.error('迁移旧缓存失败:', error);
    }
  }

  private async loadIndex(): Promise<void> {
    try {
      if (!(await this.vault.adapter.exists(this.indexFile))) {
        await this.saveIndex();
        return;
      }

      const parsed = JSON.parse(
        await this.vault.adapter.read(this.indexFile),
      ) as Partial<CacheIndex>;
      if (!parsed.version || !parsed.items || typeof parsed.items !== 'object') {
        throw new Error('索引文件格式无效');
      }
      const defaults = this.createDefaultIndex();
      this.index = {
        ...defaults,
        ...parsed,
        // Loading a v2 index is supported, but newly saved entries use the v3
        // scheme marker and cryptographic fingerprint identity.
        version: '3.0.0',
        items: parsed.items,
      };
      this.maxSize = this.index.maxSize;
      this.defaultExpiryDays = this.index.expiryDays;
    } catch (error) {
      console.error('加载索引失败:', error);
      this.index = this.createDefaultIndex();
    }
  }

  private async saveIndex(): Promise<void> {
    this.index.lastUpdated = Date.now();
    await this.vault.adapter.write(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  /**
   * Historical url|mode|language lookup kept for cache management and older
   * callers. New processing must use getByFingerprint: legacy keys cannot prove
   * model/backend/schema/prompt provenance and are never its fallback.
   */
  async get(
    url: string,
    mode: ProcessingMode,
    language: SupportedLanguage,
    options?: { bypassDisabled?: boolean },
  ): Promise<ProcessingResult | null> {
    await this.initialization;
    if ((!this.enabled && !options?.bypassDisabled) || !this.isInitialized) return null;

    const key = this.legacyKey(url, mode, language);
    const indexItem = this.index.items[key];
    if (!indexItem || indexItem.scheme === 'fingerprint-v2') return null;
    if (Date.now() > indexItem.expiryTimestamp) {
      await this.removeIndexKey(key);
      return null;
    }

    try {
      const cacheItem = JSON.parse(
        await this.vault.adapter.read(indexItem.path),
      ) as LegacyCacheItem;
      // Historical filenames use a 32-bit hash, so validate the complete key.
      if (cacheItem.url !== url || cacheItem.mode !== mode || cacheItem.language !== language) {
        console.warn('缓存键与文件内容不匹配（疑似哈希碰撞），按未命中处理:', key);
        return null;
      }
      return cacheItem.result;
    } catch (error) {
      console.error('读取缓存文件失败:', error);
      delete this.index.items[key];
      await this.saveIndex();
      return null;
    }
  }

  /**
   * Exact rich-result lookup. It intentionally does not inspect or reuse
   * legacy url|mode|language entries, even when the URL happens to match.
   */
  async getByFingerprint(
    fingerprint: ArtifactFingerprint,
    options?: { bypassDisabled?: boolean },
  ): Promise<ProcessingResult | null> {
    await this.initialization;
    if ((!this.enabled && !options?.bypassDisabled) || !this.isInitialized) return null;

    const key = fingerprint.key;
    const indexItem = this.index.items[key];
    if (!this.matchesIndexFingerprint(indexItem, fingerprint)) return null;
    if (Date.now() > indexItem.expiryTimestamp) {
      await this.removeIndexKey(key);
      return null;
    }

    try {
      const cacheItem = JSON.parse(
        await this.vault.adapter.read(indexItem.path),
      ) as FingerprintCacheItem;
      if (!this.matchesStoredFingerprint(cacheItem, fingerprint)) {
        console.warn('缓存指纹与文件 provenance 不匹配，按未命中处理:', key);
        return null;
      }
      return cacheItem.result;
    } catch (error) {
      console.error('读取指纹缓存失败:', error);
      delete this.index.items[key];
      await this.saveIndex();
      return null;
    }
  }

  async set(
    url: string,
    mode: ProcessingMode,
    language: SupportedLanguage,
    result: ProcessingResult,
  ): Promise<void> {
    await this.initialization;
    if (!this.enabled || !this.isInitialized) return;
    await this.writeLegacyEntry(url, mode, language, result);
  }

  private async writeLegacyEntry(
    url: string,
    mode: ProcessingMode,
    language: SupportedLanguage,
    result: ProcessingResult,
  ): Promise<void> {
    const key = this.legacyKey(url, mode, language);
    const filePath = this.legacyFilePath(key);
    const timestamp = Date.now();
    const cacheItem: LegacyCacheItem = {
      url,
      mode,
      language,
      result,
      timestamp,
      expiryTimestamp: timestamp + this.defaultExpiryDays * 24 * 60 * 60 * 1000,
    };
    const cacheData = JSON.stringify(cacheItem, null, 2);
    await this.vault.adapter.write(filePath, cacheData);
    this.index.items[key] = {
      url,
      mode,
      language,
      timestamp,
      expiryTimestamp: cacheItem.expiryTimestamp,
      size: cacheData.length,
      path: filePath,
      scheme: 'legacy-v1',
    };
    await this.finishWrite();
  }

  async setByFingerprint(
    fingerprint: ArtifactFingerprint,
    result: ProcessingResult,
    sourceLabel = '',
  ): Promise<void> {
    await this.initialization;
    if (!this.enabled || !this.isInitialized) return;

    const key = fingerprint.key;
    const filePath = this.fingerprintFilePath(fingerprint);
    const timestamp = Date.now();
    const resultWithProvenance = this.withFingerprintProvenance(result, fingerprint);
    const cacheItem: FingerprintCacheItem = {
      scheme: 'fingerprint-v2',
      fingerprint: {
        version: fingerprint.version,
        key,
        digest: fingerprint.digest,
        sourceHash: fingerprint.source.source_hash,
        runHash: fingerprint.run_hash,
      },
      url: sourceLabel,
      mode: fingerprint.run.mode,
      language: fingerprint.run.language,
      result: resultWithProvenance,
      timestamp,
      expiryTimestamp: timestamp + this.defaultExpiryDays * 24 * 60 * 60 * 1000,
    };
    const cacheData = JSON.stringify(cacheItem, null, 2);
    await this.vault.adapter.write(filePath, cacheData);
    this.index.items[key] = {
      url: sourceLabel,
      mode: fingerprint.run.mode,
      language: fingerprint.run.language,
      timestamp,
      expiryTimestamp: cacheItem.expiryTimestamp,
      size: cacheData.length,
      path: filePath,
      scheme: 'fingerprint-v2',
      fingerprintDigest: fingerprint.digest,
      sourceHash: fingerprint.source.source_hash,
      runHash: fingerprint.run_hash,
    };
    await this.finishWrite();
  }

  has(url: string, mode: ProcessingMode, language: SupportedLanguage): boolean {
    if (!this.enabled || !this.isInitialized) return false;
    const item = this.index.items[this.legacyKey(url, mode, language)];
    return Boolean(item && item.scheme !== 'fingerprint-v2' && Date.now() <= item.expiryTimestamp);
  }

  hasFingerprint(fingerprint: ArtifactFingerprint): boolean {
    if (!this.enabled || !this.isInitialized) return false;
    const item = this.index.items[fingerprint.key];
    return this.matchesIndexFingerprint(item, fingerprint) && Date.now() <= item.expiryTimestamp;
  }

  async remove(url: string, mode: ProcessingMode, language: SupportedLanguage): Promise<void> {
    await this.initialization;
    if (!this.isInitialized) return;
    await this.removeIndexKey(this.legacyKey(url, mode, language));
  }

  async removeByFingerprint(fingerprint: ArtifactFingerprint): Promise<void> {
    await this.initialization;
    if (!this.isInitialized) return;
    await this.removeIndexKey(fingerprint.key);
  }

  private async removeIndexKey(key: string): Promise<void> {
    const indexItem = this.index.items[key];
    if (!indexItem) return;
    try {
      if (await this.vault.adapter.exists(indexItem.path)) {
        await this.vault.adapter.remove(indexItem.path);
      }
    } catch (error) {
      console.error('删除缓存文件失败:', error);
    }
    delete this.index.items[key];
    await this.saveIndex();
  }

  private async finishWrite(): Promise<void> {
    if (Object.keys(this.index.items).length > this.maxSize) {
      await this.evictOldest();
    }
    await this.saveIndex();
  }

  private async evictOldest(): Promise<void> {
    let oldest: [string, CacheIndexEntry] | undefined;
    for (const entry of Object.entries(this.index.items)) {
      if (!oldest || entry[1].timestamp < oldest[1].timestamp) oldest = entry;
    }
    if (oldest) await this.removeIndexKey(oldest[0]);
  }

  async cleanup(): Promise<void> {
    await this.initialization;
    await this.cleanupInternal();
  }

  private async cleanupInternal(): Promise<void> {
    if (!this.isInitialized) return;
    const now = Date.now();
    const expiredKeys = Object.entries(this.index.items)
      .filter(([, item]) => now > item.expiryTimestamp)
      .map(([key]) => key);
    for (const key of expiredKeys) await this.removeIndexKey(key);
    if (expiredKeys.length > 0) {
      console.log(`清理了 ${expiredKeys.length} 个过期缓存项`);
    }
  }

  getStats(): { size: number; maxSize: number; expiredCount: number; totalSize: number } {
    if (!this.isInitialized) {
      return { size: 0, maxSize: this.maxSize, expiredCount: 0, totalSize: 0 };
    }
    const now = Date.now();
    const entries = Object.values(this.index.items);
    return {
      size: entries.length,
      maxSize: this.maxSize,
      expiredCount: entries.filter((item) => now > item.expiryTimestamp).length,
      totalSize: entries.reduce((total, item) => total + item.size, 0),
    };
  }

  async clear(): Promise<void> {
    await this.initialization;
    if (!this.isInitialized) return;
    for (const key of Object.keys(this.index.items)) await this.removeIndexKey(key);
  }

  setConfig(maxSize: number, expiryDays: number): void {
    this.maxSize = maxSize;
    this.defaultExpiryDays = expiryDays;
    if (!this.isInitialized) return;
    this.index.maxSize = maxSize;
    this.index.expiryDays = expiryDays;
    void this.saveIndex();
  }

  async getAllItems(): Promise<
    Array<{
      key: string;
      url: string;
      mode: ProcessingMode;
      language: SupportedLanguage;
      timestamp: number;
      expiryTimestamp: number;
      size: number;
      isExpired: boolean;
      scheme: CacheScheme;
    }>
  > {
    await this.initialization;
    if (!this.isInitialized) return [];
    const now = Date.now();
    return Object.entries(this.index.items)
      .map(([key, item]) => ({
        key,
        url: item.url,
        mode: item.mode,
        language: item.language,
        timestamp: item.timestamp,
        expiryTimestamp: item.expiryTimestamp,
        size: item.size,
        isExpired: now > item.expiryTimestamp,
        scheme: item.scheme || 'legacy-v1',
      }))
      .sort((first, second) => second.timestamp - first.timestamp);
  }

  async getItemContent(
    url: string,
    mode: ProcessingMode,
    language: SupportedLanguage,
  ): Promise<ProcessingResult | null> {
    return this.get(url, mode, language, { bypassDisabled: true });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private matchesIndexFingerprint(
    item: CacheIndexEntry | undefined,
    fingerprint: ArtifactFingerprint,
  ): item is CacheIndexEntry {
    return Boolean(
      item &&
      item.scheme === 'fingerprint-v2' &&
      item.fingerprintDigest === fingerprint.digest &&
      item.sourceHash === fingerprint.source.source_hash &&
      item.runHash === fingerprint.run_hash,
    );
  }

  private matchesStoredFingerprint(
    item: FingerprintCacheItem,
    fingerprint: ArtifactFingerprint,
  ): boolean {
    const provenance = item?.result?.artifact;
    return (
      item?.scheme === 'fingerprint-v2' &&
      item.fingerprint?.version === fingerprint.version &&
      item.fingerprint?.key === fingerprint.key &&
      item.fingerprint?.digest === fingerprint.digest &&
      item.fingerprint?.sourceHash === fingerprint.source.source_hash &&
      item.fingerprint?.runHash === fingerprint.run_hash &&
      provenance?.fingerprint === fingerprint.key &&
      provenance?.fingerprint_digest === fingerprint.digest &&
      provenance?.run_hash === fingerprint.run_hash
    );
  }

  private withFingerprintProvenance(
    result: ProcessingResult,
    fingerprint: ArtifactFingerprint,
  ): ProcessingResult {
    return {
      ...result,
      artifact: {
        ...(result.artifact || {}),
        schema_version: fingerprint.run.schema_version,
        source_hash: fingerprint.source.source_hash,
        transcript_hash: fingerprint.source.transcript_hash || result.artifact?.transcript_hash,
        backend: fingerprint.run.backend,
        model: fingerprint.run.model,
        prompt_version: fingerprint.run.prompt_version,
        processing_depth: fingerprint.run.processing_depth,
        fingerprint_version: fingerprint.version,
        fingerprint: fingerprint.key,
        fingerprint_digest: fingerprint.digest,
        run_hash: fingerprint.run_hash,
      },
    };
  }
}
