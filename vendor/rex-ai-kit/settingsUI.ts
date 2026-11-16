// Generated from rex-ai-kit 0.1.0. Do not edit here.
import { type App, DropdownComponent, SecretComponent, Setting, TextComponent } from 'obsidian';
import { PROVIDERS, getProvider, providerName, resolveProvider } from './catalog';
import type { AiClient } from './client';
import { STRINGS, ago, type Lang, type Strings } from './i18n';
import { defaultModel, pickerRows } from './models';
import type { AiSlot, KeyStatus, Provider, Scene } from './types';
import { grantWarning } from './util';

export interface AiSettingsOptions {
	app: App;
	client: AiClient;
	/** The plugin's saved slot. The UI edits a copy and hands it back through onChange. */
	slot: AiSlot & { grantExpiry?: string };
	onChange: (slot: AiSlot & { grantExpiry?: string }) => void | Promise<void>;
	/** Which recommendation goes first and becomes the default when switching provider. */
	scene?: Scene;
	lang?: Lang;
	/** Hide providers this plugin cannot use, e.g. ones without image input. */
	filter?: (p: Provider) => boolean;
	/** Show a heading row above the group. Default true. */
	heading?: boolean;
	/** Mark the content as private, so the Gemini free-tier note shows. */
	privateContent?: boolean;
	/** Offer Claude Code and Codex on this computer. Off by default; desktop only. */
	allowLocalAgents?: boolean;
}

const MANUAL = '__manual__';

/**
 * Draws the shared "AI service" group: provider, Keychain key with a Check button, model picker,
 * and an Advanced fold. Nothing is fetched until the user presses Check or Refresh, or opens
 * the model menu with a stale cache.
 */
export function renderAiSettings(containerEl: HTMLElement, o: AiSettingsOptions): { destroy(): void } {
	const s: Strings = STRINGS[o.lang ?? 'en'];
	const scene = o.scene ?? 'balanced';
	const root = containerEl.createDiv({ cls: 'rak-ai' });
	let slot = { ...o.slot };
	let aborter = new AbortController();
	let status: { kind: KeyStatus | 'idle' | 'busy'; detail?: string } = { kind: 'idle' };
	let balanceText: string | null = null;
	let modelError: string | null = null;

	const save = async () => {
		await o.onChange({ ...slot });
	};

	const draw = () => {
		root.empty();
		const p = resolveProvider(slot);
		if (o.heading !== false) new Setting(root).setName(s.heading).setHeading();

		// Provider
		const showHint = !!p.hint && !p.localAgent && (p.id !== 'gemini' || !!o.privateContent);
		new Setting(root).setName(s.provider).setDesc(showHint ? p.hint! : '').addDropdown((d) => {
			const local = !!o.allowLocalAgents && o.client.canRunLocal;
			fillProviders(d, s, o.lang ?? 'en', (p) => (!p.localAgent || local) && (!o.filter || o.filter(p)));
			d.setValue(getProvider(slot.provider) ? slot.provider : 'custom');
			d.onChange(async (id) => {
				aborter.abort();
				aborter = new AbortController();
				const np = resolveProvider({ provider: id });
				slot = { provider: id, model: defaultModel(np, scene, o.client.cache.get(np)), grantExpiry: undefined };
				status = { kind: 'idle' };
				balanceText = null;
				modelError = null;
				await save();
				draw();
			});
		});

		// Local agent: show where the program is instead of a key.
		if (p.localAgent) {
			const row = new Setting(root).setName(s.program).setDesc(p.hint ?? '');
			if (status.kind === 'busy') row.controlEl.createSpan({ cls: 'rak-dot is-busy' });
			row.addButton((b) =>
				b.setButtonText(status.kind === 'busy' ? s.checking : s.check).setDisabled(status.kind === 'busy').onClick(async () => {
					status = { kind: 'busy' };
					draw();
					const r = await o.client.check(slot);
					status = { kind: r.status, detail: r.status === 'ok' ? r.detail : s.notFound };
					draw();
				}),
			);
			if (status.kind === 'ok' || status.kind === 'missing')
				row.descEl.createDiv({ cls: `rak-keyline` }).createSpan({ cls: `rak-status is-${status.kind}`, text: status.detail ?? '' });
		} else if (p.needsKey) {
			const keyRow = new Setting(root).setName(s.key).setDesc(s.keyDesc);
			keyRow.addComponent((el) =>
				new SecretComponent(o.app, el).setValue(p.secretName).onChange(async (name) => {
					slot.secretName = name && name !== resolveProvider({ provider: slot.provider }).secretName ? name : undefined;
					status = { kind: 'idle' };
					balanceText = null;
					await save();
					draw();
				}),
			);
			if (status.kind === 'busy') keyRow.controlEl.createSpan({ cls: 'rak-dot is-busy', attr: { 'aria-label': s.checking } });
			keyRow.addButton((b) =>
				b.setButtonText(status.kind === 'busy' ? s.checking : s.check).setDisabled(status.kind === 'busy').onClick(async () => {
					status = { kind: 'busy' };
					draw();
					const r = await o.client.check(slot, aborter.signal);
					status = { kind: r.status, detail: r.detail };
					if (r.status === 'ok' && p.balance) {
						balanceText = await o.client
							.balance(slot, aborter.signal)
							.then((b) => (b ? `${s.balance} ${b.text}` : null))
							.catch(() => null);
					}
					draw();
				}),
			);
			const line = keyRow.descEl.createDiv({ cls: 'rak-keyline' });
			if (status.kind === 'idle' && !o.client.hasKey(slot)) line.createSpan({ cls: 'rak-status is-missing', text: s.missing });
			if (status.kind !== 'idle' && status.kind !== 'busy') line.createSpan({ cls: `rak-status is-${status.kind}`, text: status.detail && status.kind !== 'ok' ? `${statusLabel(s, status.kind)} · ${status.detail}` : statusLabel(s, status.kind) });
			if (balanceText) line.createSpan({ cls: 'rak-balance', text: balanceText });
			if (!o.client.hasKey(slot) || status.kind === 'missing' || status.kind === 'invalid') {
				if (p.consoleUrl) linkTo(line, p.consoleUrl, s.getKey);
			} else if (!balanceText && (p.usageUrl ?? p.consoleUrl)) linkTo(line, (p.usageUrl ?? p.consoleUrl)!, s.usage);
			const warn = grantWarning(slot.grantExpiry);
			if (warn) {
				keyRow.settingEl.addClass('rak-warn');
				line.createSpan({ cls: 'rak-expiry', text: s.expiresSoon(warn) });
			}
		} else if (!p.localAgent) {
			new Setting(root).setName(s.key).setDesc(s.keyNone);
		}

		// Model
		const modelRow = new Setting(root).setName(s.model).setDesc(p.modelsPath ? s.modelDesc : '');
		if (modelError) modelRow.descEl.createDiv({ cls: 'rak-keyline' }).createSpan({ cls: 'rak-status is-invalid', text: s.modelError(modelError) });
		const cached = o.client.cache.get(p);
		const rows = pickerRows(p, cached, scene);
		let manualInput: TextComponent | null = null;
		const known = rows.some((r) => r.id === slot.model);
		const showManual = !!slot.model && !known;
		modelRow.addDropdown((d) => {
			const sel = d.selectEl;
			const picks = rows.filter((r) => r.pick);
			const rest = rows.filter((r) => !r.pick);
			if (picks.length) {
				const g = sel.createEl('optgroup', { attr: { label: s.recommended } });
				for (const r of picks) g.createEl('option', { value: r.id, text: `${r.id} · ${s[r.pick!.scene]}` });
			}
			if (rest.length) {
				const age = o.client.cache.age(p);
				const g = sel.createEl('optgroup', { attr: { label: age != null ? s.allCount(rest.length, ago(s, age)) : s.all } });
				for (const r of rest) g.createEl('option', { value: r.id, text: r.id });
			}
			sel.createEl('option', { value: MANUAL, text: s.manual });
			d.setValue(showManual ? MANUAL : slot.model || picks[0]?.id || rest[0]?.id || MANUAL);
			d.onChange(async (v) => {
				if (v === MANUAL) {
					manualInput?.inputEl.focus();
					draw();
					manualInput?.inputEl.focus();
					return;
				}
				slot.model = v;
				await save();
			});
		});
		if (showManual || rows.length === 0) {
			modelRow.addText((t) => {
				manualInput = t;
				t.setPlaceholder(s.manualPh).setValue(slot.model ?? '');
				t.inputEl.addClass('rak-manual');
				t.onChange(async (v) => {
					slot.model = v.trim();
					await save();
				});
			});
		}
		if (p.modelsPath) {
			modelRow.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip(s.refresh)
					.onClick(async () => {
						modelError = null;
						try {
							await o.client.models(slot, true, aborter.signal);
						} catch (e) {
							modelError = e instanceof Error ? e.message : String(e);
						}
						draw();
					}),
			);
		}

		// Advanced
		const det = root.createEl('details', { cls: 'rak-advanced' });
		det.createEl('summary', { text: s.advanced });
		new Setting(det)
			.setName(p.localAgent ? s.programPath : s.baseUrl)
			.setDesc(p.localAgent ? s.programPathDesc : s.baseUrlDesc)
			.addText((t) =>
				t
					.setPlaceholder(p.localAgent ? `/usr/local/bin/${p.localAgent}` : resolveProvider({ provider: slot.provider }).baseUrl || 'https://…/v1')
					.setValue(slot.baseUrl ?? '')
					.onChange(async (v) => {
						slot.baseUrl = v.trim() || undefined;
						await save();
					}),
			);
		if (p.needsKey) {
			new Setting(det)
				.setName(s.expiry)
				.setDesc(s.expiryDesc)
				.addText((t) => {
					t.inputEl.type = 'date';
					t.setValue(slot.grantExpiry ?? '').onChange(async (v) => {
						slot.grantExpiry = v || undefined;
						await save();
					});
				});
		}
	};

	draw();
	return {
		destroy() {
			aborter.abort();
			root.remove();
		},
	};
}

function fillProviders(d: DropdownComponent, s: Strings, lang: Lang, filter?: (p: Provider) => boolean) {
	const groups = new Map<Provider['group'], Provider[]>();
	for (const p of PROVIDERS) {
		if (filter && !filter(p)) continue;
		groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
	}
	for (const [g, list] of groups) {
		const og = d.selectEl.createEl('optgroup', { attr: { label: s.groups[g] } });
		for (const p of list) og.createEl('option', { value: p.id, text: providerName(p, lang) });
	}
}

function statusLabel(s: Strings, k: KeyStatus | 'idle' | 'busy'): string {
	return k === 'ok' ? s.ok : k === 'missing' ? s.missing : k === 'invalid' ? s.invalid : k === 'error' ? s.error : k === 'busy' ? s.checking : '';
}

function linkTo(parent: HTMLElement, href: string, text: string) {
	parent.createEl('a', { cls: 'rak-link', text, href, attr: { target: '_blank', rel: 'noopener' } });
}
