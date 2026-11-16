// Generated from rex-ai-kit 0.1.0. Do not edit here.
/** Typed reads from parsed JSON, so replies from any provider are handled without `any`. */

/** Follow a path of keys and indexes; undefined as soon as a step is missing. */
export function at(v: unknown, ...path: (string | number)[]): unknown {
	let cur = v;
	for (const k of path) {
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string | number, unknown>)[k];
	}
	return cur;
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A number, or a numeric string such as "12.30". */
export const numLike = (v: unknown): number | undefined => {
	if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
	if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
	return undefined;
};

export const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** Seconds since 1970 from an ISO date string. */
export const isoSeconds = (v: unknown): number | undefined => {
	const t = typeof v === 'string' ? Date.parse(v) : NaN;
	return Number.isFinite(t) ? t / 1000 : undefined;
};
