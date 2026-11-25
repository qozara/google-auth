import { describe, it, expect, vi } from 'vitest';
import {
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_DRIVE_BYOS_SCOPES,
  GOOGLE_IDENTITY_AND_DRIVE_SCOPES,
  GoogleSessionStore,
  GoogleAuthError,
  normalizeScopes,
  mergeScopes,
  hasRequiredScopes,
  fetchGoogleUserProfile,
  type StorageLike,
} from '@qozara/google-auth';

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

describe('@qozara/google-auth — scopes & canonicalization', () => {
  it('normalizes space/comma separated scopes and canonicalizes Google userinfo URI aliases', () => {
    const raw =
      'openid https://www.googleapis.com/auth/userinfo.email, https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file';
    const normalized = normalizeScopes(raw);

    expect(normalized).toContain('openid');
    expect(normalized).toContain('email');
    expect(normalized).toContain('profile');
    expect(normalized).toContain('https://www.googleapis.com/auth/drive.file');

    expect(hasRequiredScopes(raw, GOOGLE_IDENTITY_SCOPES)).toBe(true);
    expect(hasRequiredScopes(raw, GOOGLE_DRIVE_BYOS_SCOPES)).toBe(false);
  });

  it('merges incremental scope sets without duplicates', () => {
    const merged = mergeScopes(GOOGLE_IDENTITY_SCOPES, GOOGLE_DRIVE_BYOS_SCOPES, ['email']);
    expect(hasRequiredScopes(merged, GOOGLE_IDENTITY_AND_DRIVE_SCOPES)).toBe(true);
    expect(merged.filter((s) => s === 'email')).toHaveLength(1);
  });
});

describe('@qozara/google-auth — GoogleSessionStore lifecycle & expiry', () => {
  it('stores session, validates expiry with safety buffer, and checks required scopes', () => {
    let clock = 1_000_000;
    const storage = createMemoryStorage();
    const store = new GoogleSessionStore({
      storage,
      expiryBufferMs: 60_000,
      now: () => clock,
    });

    expect(store.getSession()).toBeNull();
    expect(store.getValidAccessToken()).toBeNull();

    const saved = store.setSession({
      accessToken: 'ya29.identity-only-token',
      expiresInSeconds: 3600,
      scopes: 'openid https://www.googleapis.com/auth/userinfo.email profile',
      user: {
        id: 'sub-123',
        email: 'alice@qozara.org',
        name: 'Alice',
        picture: 'https://example.com/alice.png',
      },
    });

    expect(saved.expiresAt).toBe(1_000_000 + 3_600_000);
    expect(store.isExpired()).toBe(false);
    expect(store.getValidAccessToken(GOOGLE_IDENTITY_SCOPES)).toBe('ya29.identity-only-token');
    // Missing drive scopes -> null when drive scopes are required
    expect(store.getValidAccessToken(GOOGLE_DRIVE_BYOS_SCOPES)).toBeNull();

    // Advance clock to within the 60s expiry safety buffer -> treated as expired
    clock = 1_000_000 + 3_541_000;
    expect(store.isExpired()).toBe(true);
    expect(store.getValidAccessToken(GOOGLE_IDENTITY_SCOPES)).toBeNull();
    // Raw session & user metadata remain readable for "Reconnect alice@qozara.org" UI
    expect(store.getSession()?.user?.email).toBe('alice@qozara.org');
  });

  it('preserves user profile and merges scopes on incremental upgrade for the same account, but resets on account switch', () => {
    const clock = 5_000_000;
    const store = new GoogleSessionStore({
      storage: createMemoryStorage(),
      now: () => clock,
    });

    store.setSession({
      accessToken: 'token-1',
      expiresInSeconds: 3600,
      scopes: GOOGLE_IDENTITY_SCOPES,
      user: {
        id: 'u1',
        email: 'alice@qozara.org',
        name: 'Alice',
        picture: 'https://example.com/a.jpg',
      },
    });

    // Incremental scope upgrade omitting user picture/name
    const upgraded = store.setSession({
      accessToken: 'token-2-with-drive',
      expiresInSeconds: 3600,
      scopes: GOOGLE_DRIVE_BYOS_SCOPES,
    });

    expect(upgraded.user).toEqual({
      id: 'u1',
      email: 'alice@qozara.org',
      name: 'Alice',
      picture: 'https://example.com/a.jpg',
    });
    expect(store.getValidAccessToken(GOOGLE_IDENTITY_SCOPES)).toBe('token-2-with-drive');
    expect(store.getValidAccessToken(GOOGLE_DRIVE_BYOS_SCOPES)).toBe('token-2-with-drive');

    // Switching to a different Google account replaces scopes and user cleanly
    const switched = store.setSession({
      accessToken: 'token-bob',
      expiresInSeconds: 3600,
      scopes: GOOGLE_IDENTITY_SCOPES,
      user: {
        id: 'u2',
        email: 'bob@qozara.org',
        name: 'Bob',
      },
    });

    expect(switched.user?.email).toBe('bob@qozara.org');
    expect(switched.user?.picture).toBeUndefined();
    expect(store.getValidAccessToken(GOOGLE_DRIVE_BYOS_SCOPES)).toBeNull();
  });

  it('notifies subscribers on setSession and clearSession and handles corrupted storage gracefully', () => {
    const storage = createMemoryStorage();
    storage.setItem('qozara_google_session_v1', '{not-valid-json');

    const store = new GoogleSessionStore({ storage });
    expect(store.getSession()).toBeNull();

    const events: Array<string | null> = [];
    const unsub = store.subscribe((s) => events.push(s?.accessToken ?? null));

    store.setSession({
      accessToken: 'tok-abc',
      expiresInSeconds: 3600,
      scopes: GOOGLE_IDENTITY_SCOPES,
    });
    store.clearSession();
    unsub();

    store.setSession({
      accessToken: 'tok-ignored',
      expiresInSeconds: 3600,
      scopes: GOOGLE_IDENTITY_SCOPES,
    });

    expect(events).toEqual(['tok-abc', null]);
  });

  it('migrates legacy Quomida active_cloud_provider credentials idempotently', () => {
    const now = 10_000_000;
    const store = new GoogleSessionStore({
      storage: createMemoryStorage(),
      now: () => now,
    });

    const migrated = store.migrateFromLegacyCredentials(
      {
        accessToken: 'legacy-drive-token',
        expiresAt: now + 1_800_000,
        userEmail: 'alice@qozara.org',
        userName: 'Alice Legacy',
        userPicture: 'https://example.com/pic.png',
      },
      GOOGLE_IDENTITY_AND_DRIVE_SCOPES
    );

    expect(migrated).not.toBeNull();
    expect(store.getValidAccessToken(GOOGLE_DRIVE_BYOS_SCOPES)).toBe('legacy-drive-token');
    expect(store.getSession()?.user).toEqual({
      email: 'alice@qozara.org',
      name: 'Alice Legacy',
      picture: 'https://example.com/pic.png',
    });

    // Idempotent: does not overwrite an active valid session with older legacy credentials
    store.setSession({
      accessToken: 'newer-token',
      expiresInSeconds: 3600,
      scopes: GOOGLE_IDENTITY_AND_DRIVE_SCOPES,
      user: { email: 'alice@qozara.org', name: 'Alice' },
    });

    store.migrateFromLegacyCredentials({
      accessToken: 'stale-legacy-token',
      expiresAt: now + 900_000,
      userEmail: 'alice@qozara.org',
    });

    expect(store.getValidAccessToken()).toBe('newer-token');
  });
});

describe('@qozara/google-auth — fetchGoogleUserProfile', () => {
  it('fetches and normalizes Google OIDC userinfo profile', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        sub: 'google-123',
        email: 'Alice@Qozara.org ',
        name: 'Alice Smith',
        picture: 'https://lh3.googleusercontent.com/a/avatar',
      }),
    });

    const profile = await fetchGoogleUserProfile('valid-token', {
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(mockFetch).toHaveBeenCalledWith('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer valid-token' },
      signal: undefined,
    });
    expect(profile).toEqual({
      id: 'google-123',
      email: 'alice@qozara.org',
      name: 'Alice Smith',
      picture: 'https://lh3.googleusercontent.com/a/avatar',
    });
  });

  it('throws GoogleAuthError(INVALID_TOKEN) on 401 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid_token' }),
    });

    await expect(
      fetchGoogleUserProfile('expired-token', {
        fetchImpl: mockFetch as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({
      name: 'GoogleAuthError',
      code: 'INVALID_TOKEN',
    } satisfies Partial<GoogleAuthError>);
  });
});
