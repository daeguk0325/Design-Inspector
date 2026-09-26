// ?target= query handling: the supervisor opens the browser with the
// resolved dev-server URL so App A connects with zero typing.
// Generic: any local target project, validated against the local-URL policy.

import { validateTargetUrl } from '../url/policy.ts';

/** Extract a validated target URL from a location.search string. Null if absent/invalid. */
export function parseTargetFromSearch(search: string): string | null {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get('target');
    if (!raw || raw.trim() === '') return null;
    const check = validateTargetUrl(raw);
    return check.ok ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function parseInspectorTokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get('inspectorToken');
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/** Remove ?target= after consuming so reloads rely on the session target. */
export function stripTargetParam(href: string): string {
  try {
    const u = new URL(href);
    u.searchParams.delete('target');
    u.searchParams.delete('inspectorFrame');
    u.searchParams.delete('inspectorToken');
    return u.toString();
  } catch {
    return href;
  }
}
