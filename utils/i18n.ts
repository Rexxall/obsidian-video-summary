/**
 * Interface language follows Obsidian: Chinese when Obsidian is set to Chinese (zh, zh-TW),
 * English otherwise. Every string carries both versions where it is written, so no entry can be
 * missing in one language.
 */
let chinese = true;

/** Call once on load with Obsidian's getLanguage(); tests keep the Chinese default. */
export function setInterfaceLanguage(code: string | undefined): void {
  chinese = /^zh\b/i.test(code ?? '');
}

export function isChinese(): boolean {
  return chinese;
}

export function tr(zh: string, en: string): string {
  return chinese ? zh : en;
}
