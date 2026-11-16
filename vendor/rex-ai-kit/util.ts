// Generated from rex-ai-kit 0.1.0. Do not edit here.
const GRANT_WARN_DAYS = 30;

/** Returns the date to show when a free-credit expiry is within the warning window. Exported for tests. */
export function grantWarning(expiry: string | undefined, now = new Date()): string | null {
	if (!expiry) return null;
	const d = new Date(`${expiry}T23:59:59`);
	if (isNaN(d.getTime())) return null;
	const days = (d.getTime() - now.getTime()) / 86400000;
	return days >= 0 && days <= GRANT_WARN_DAYS ? expiry : null;
}
