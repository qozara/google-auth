import { GoogleAuthError, type GoogleUserProfile } from './types.js';

export interface FetchGoogleUserProfileOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Fetches the authenticated user's OpenID Connect profile from Google's v3 userinfo endpoint.
 */
export async function fetchGoogleUserProfile(
  accessToken: string,
  options: FetchGoogleUserProfileOptions = {}
): Promise<GoogleUserProfile> {
  const token = (accessToken || '').trim();
  if (!token) {
    throw new GoogleAuthError('INVALID_TOKEN', 'Access token is required to fetch Google profile');
  }

  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new GoogleAuthError('NETWORK_ERROR', 'Global fetch is unavailable in this environment');
  }

  let response: Response;
  try {
    response = await fetchFn('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: options.signal,
    });
  } catch (err) {
    throw new GoogleAuthError(
      'NETWORK_ERROR',
      err instanceof Error ? err.message : 'Network error fetching Google user profile',
      err
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new GoogleAuthError(
      'INVALID_TOKEN',
      `Google OAuth token rejected (${response.status})`
    );
  }

  if (!response.ok) {
    throw new GoogleAuthError(
      'PROFILE_FETCH_FAILED',
      `Failed to fetch Google user profile (${response.status})`
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const rawEmail = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (!rawEmail) {
    throw new GoogleAuthError(
      'PROFILE_FETCH_FAILED',
      'Google userinfo response did not include an email address'
    );
  }

  const profile: GoogleUserProfile = {
    email: rawEmail,
  };
  if (typeof data.sub === 'string' && data.sub.trim()) {
    profile.id = data.sub.trim();
  }
  if (typeof data.name === 'string' && data.name.trim()) {
    profile.name = data.name.trim();
  }
  if (typeof data.picture === 'string' && data.picture.trim()) {
    profile.picture = data.picture.trim();
  }

  return profile;
}
