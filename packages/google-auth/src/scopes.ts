const GOOGLE_SCOPE_ALIASES: Record<string, string> = {
  'https://www.googleapis.com/auth/userinfo.email': 'email',
  'https://www.googleapis.com/auth/userinfo.profile': 'profile',
};

function canonicalizeScope(raw: string): string {
  const trimmed = raw.trim();
  return GOOGLE_SCOPE_ALIASES[trimmed] ?? trimmed;
}

/**
 * Normalizes a space- or comma-delimited scope string or array into a deduplicated canonical array.
 */
export function normalizeScopes(scopes?: string | readonly string[] | null): string[] {
  if (!scopes) return [];

  const tokens =
    typeof scopes === 'string'
      ? scopes.split(/[\s,]+/)
      : scopes.flatMap((entry) => (typeof entry === 'string' ? entry.split(/[\s,]+/) : []));

  const unique = new Set<string>();
  for (const token of tokens) {
    const canonical = canonicalizeScope(token);
    if (canonical) {
      unique.add(canonical);
    }
  }
  return Array.from(unique);
}

/**
 * Merges multiple scope strings or arrays into a deduplicated canonical scope list.
 */
export function mergeScopes(
  ...scopeInputs: Array<string | readonly string[] | null | undefined>
): string[] {
  const merged = new Set<string>();
  for (const input of scopeInputs) {
    for (const scope of normalizeScopes(input)) {
      merged.add(scope);
    }
  }
  return Array.from(merged);
}

/**
 * Formats scopes as a space-delimited OAuth2 scope string.
 */
export function formatScopeString(scopes: readonly string[]): string {
  return normalizeScopes(scopes).join(' ');
}

/**
 * Returns true if all requiredScopes are satisfied by grantedScopes (accounting for Google userinfo URI aliases).
 */
export function hasRequiredScopes(
  grantedScopes: string | readonly string[] | null | undefined,
  requiredScopes: readonly string[]
): boolean {
  if (requiredScopes.length === 0) return true;
  const grantedSet = new Set(normalizeScopes(grantedScopes));
  for (const req of normalizeScopes(requiredScopes)) {
    if (!grantedSet.has(req)) {
      return false;
    }
  }
  return true;
}
