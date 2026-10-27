/**
 * Normalize a user-, note-, or backend-supplied external URL for clickable UI.
 * Credentials and non-HTTP schemes are rejected so values such as javascript:
 * cannot become active links or window.open targets.
 */
export function safeExternalHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (
    !candidate ||
    [...candidate].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isExactHostOrSubdomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const base = domain.toLowerCase().replace(/\.$/, '');
  return host === base || host.endsWith(`.${base}`);
}

const TRUSTED_REMOTE_IMAGE_DOMAINS = [
  'ytimg.com',
  'ggpht.com',
  'hdslb.com',
  'biliimg.com',
  'douyinpic.com',
  'byteimg.com',
  'tiktokcdn.com',
  'tiktokcdn-eu.com',
  'tiktokcdn-us.com',
  'byteoversea.com',
  'ibytedtos.com',
  'xhscdn.com',
] as const;

/**
 * Remote images are more restrictive than clickable links: rendering an image
 * immediately makes a request. Only HTTPS assets on known platform media hosts
 * are accepted; loopback/private/custom backend URLs must be localized first.
 */
export function safeRemoteImageUrl(value: unknown): string | undefined {
  const normalized = safeExternalHttpUrl(value);
  if (!normalized) return undefined;
  const url = new URL(normalized);
  if (url.protocol !== 'https:' || url.port) return undefined;
  if (
    !TRUSTED_REMOTE_IMAGE_DOMAINS.some((domain) => isExactHostOrSubdomain(url.hostname, domain))
  ) {
    return undefined;
  }
  return url.toString();
}

/** Allow bounded raster data URLs, but never SVG or other active document types. */
export function safeInlineRasterDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (!candidate || candidate.length > 2_000_000) return undefined;
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\r\n]+$/i.test(candidate)
    ? candidate
    : undefined;
}

/** Only paths produced by MediaAssetLocalizer may become Vault image embeds. */
export function safeManagedVaultImagePath(
  value: unknown,
  expectedRoot: unknown,
): string | undefined {
  if (typeof value !== 'string' || typeof expectedRoot !== 'string') return undefined;
  const candidate = value.trim();
  const root = expectedRoot.trim().replace(/\/+$/, '');
  if (
    !candidate ||
    !root ||
    candidate.length > 1024 ||
    candidate.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    candidate.includes('\\') ||
    ['|', '[', ']', '#', '^'].some((character) => candidate.includes(character)) ||
    [...candidate].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  if (!candidate.startsWith(`${root}/`)) return undefined;
  const parts = candidate.split('/');
  const rootParts = root.split('/');
  if (
    rootParts.some((part) => !part || part === '.' || part === '..') ||
    rootParts[rootParts.length - 1] !== '_video-summary-assets'
  ) {
    return undefined;
  }
  if (parts.some((part) => !part || part === '.' || part === '..')) return undefined;
  const marker = parts.lastIndexOf('_video-summary-assets');
  if (marker !== rootParts.length - 1 || marker !== parts.length - 3) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(parts[marker + 1] || '')) return undefined;
  if (!/^[A-Za-z0-9._-]+\.(?:png|jpe?g)$/i.test(parts[parts.length - 1] || '')) return undefined;
  return candidate;
}

/** Reader may auto-load only a relative path that must subsequently resolve to a Vault TFile. */
export function safeVaultRelativeMediaPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > 1024 ||
    candidate.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) ||
    candidate.includes('\\') ||
    candidate.split('/').some((part) => !part || part === '.' || part === '..') ||
    [...candidate].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return candidate;
}
