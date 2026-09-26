// Accepted local URL policy (§14.2). Explicit allow-list, no vague "localhost" regex.

export interface UrlCheck {
  ok: boolean;
  error?: string;
  origin?: string;
}

const HOST_PATTERNS: RegExp[] = [
  /^localhost$/,
  /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/,
  /^\[::1\]$/,
  /^0\.0\.0\.0$/,
  // LAN IPs: 10/8, 172.16/12, 192.168/16
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  // custom local dev domains
  /^[a-z0-9-]+\.local$/,
  /^[a-z0-9-]+\.localhost$/,
  /^localhost\.[a-z0-9.-]+$/,
];

export function validateTargetUrl(input: string): UrlCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Enter a URL.' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL format.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// are allowed.' };
  }
  const host = u.hostname.toLowerCase();
  const allowed = HOST_PATTERNS.some((re) => re.test(host));
  if (!allowed) {
    return {
      ok: false,
      error:
        'Only local development hosts are allowed: localhost, 127.0.0.0/8, [::1], 0.0.0.0, LAN IPs, *.local / *.localhost. Path, query and hash are permitted.',
    };
  }
  // Explicit ports permitted; path/query/hash permitted (§14.2).
  return { ok: true, origin: u.origin };
}

/** Materially different target? Used for §14.4 invalidation (origin + path root). */
export function isMateriallyDifferentTarget(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin !== ub.origin || ua.pathname !== ub.pathname;
  } catch {
    return true;
  }
}
