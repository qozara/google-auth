import {
  DEFAULT_EXPIRY_BUFFER_MS,
  DEFAULT_GOOGLE_SESSION_STORAGE_KEY,
  DEFAULT_TOKEN_TTL_SECONDS,
  GOOGLE_IDENTITY_SCOPES,
  type GoogleSession,
  type GoogleSessionStoreOptions,
  type GoogleUserProfile,
  type SetGoogleSessionInput,
  type StorageLike,
} from './types.js';
import { hasRequiredScopes, mergeScopes, normalizeScopes } from './scopes.js';

function createDefaultStorage(): StorageLike {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  const fallback = new Map<string, string>();
  return {
    getItem: (k: string) => fallback.get(k) ?? null,
    setItem: (k: string, v: string) => {
      fallback.set(k, v);
    },
    removeItem: (k: string) => {
      fallback.delete(k);
    },
  };
}

export type GoogleSessionListener = (session: GoogleSession | null) => void;

export class GoogleSessionStore {
  private readonly storageKey: string;
  private readonly storage: StorageLike;
  private readonly expiryBufferMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<GoogleSessionListener>();
  private windowStorageHandlerBound = false;

  constructor(options: GoogleSessionStoreOptions = {}) {
    this.storageKey = options.storageKey ?? DEFAULT_GOOGLE_SESSION_STORAGE_KEY;
    this.storage = options.storage ?? createDefaultStorage();
    this.expiryBufferMs = options.expiryBufferMs ?? DEFAULT_EXPIRY_BUFFER_MS;
    this.now = options.now ?? (() => Date.now());
  }

  getSession(): GoogleSession | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<GoogleSession>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.accessToken !== 'string' ||
        !parsed.accessToken.trim() ||
        typeof parsed.expiresAt !== 'number' ||
        !Number.isFinite(parsed.expiresAt)
      ) {
        return null;
      }

      const scopes = normalizeScopes(Array.isArray(parsed.scopes) ? parsed.scopes : []);
      const session: GoogleSession = {
        accessToken: parsed.accessToken.trim(),
        expiresAt: parsed.expiresAt,
        scopes,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      };

      if (parsed.user && typeof parsed.user === 'object' && typeof parsed.user.email === 'string') {
        const cleanUser: GoogleUserProfile = {
          email: parsed.user.email.trim().toLowerCase(),
        };
        if (typeof parsed.user.id === 'string' && parsed.user.id.trim()) {
          cleanUser.id = parsed.user.id.trim();
        }
        if (typeof parsed.user.name === 'string' && parsed.user.name.trim()) {
          cleanUser.name = parsed.user.name.trim();
        }
        if (typeof parsed.user.picture === 'string' && parsed.user.picture.trim()) {
          cleanUser.picture = parsed.user.picture.trim();
        }
        session.user = cleanUser;
      }

      return session;
    } catch {
      return null;
    }
  }

  isExpired(session: GoogleSession | null = this.getSession()): boolean {
    if (!session || !session.accessToken) return true;
    return this.now() + this.expiryBufferMs >= session.expiresAt;
  }

  hasScopes(requiredScopes: readonly string[]): boolean {
    const session = this.getSession();
    if (!session) return false;
    return hasRequiredScopes(session.scopes, requiredScopes);
  }

  isValidForScopes(requiredScopes: readonly string[]): boolean {
    const session = this.getSession();
    if (!session || this.isExpired(session)) return false;
    return hasRequiredScopes(session.scopes, requiredScopes);
  }

  getValidAccessToken(requiredScopes?: readonly string[]): string | null {
    const session = this.getSession();
    if (!session || this.isExpired(session)) {
      return null;
    }
    if (requiredScopes && requiredScopes.length > 0) {
      if (!hasRequiredScopes(session.scopes, requiredScopes)) {
        return null;
      }
    }
    return session.accessToken;
  }

  setSession(input: SetGoogleSessionInput): GoogleSession {
    const token = (input.accessToken || '').trim();
    if (!token) {
      throw new Error('GoogleSessionStore.setSession requires a non-empty accessToken');
    }

    const current = this.getSession();
    const nowTs = this.now();
    const ttlMs = (input.expiresInSeconds ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000;
    const expiresAt = typeof input.expiresAt === 'number' ? input.expiresAt : nowTs + ttlMs;

    const incomingEmail = input.user?.email?.trim().toLowerCase();
    const existingEmail = current?.user?.email?.trim().toLowerCase();
    const isSameAccount =
      !incomingEmail || !existingEmail || incomingEmail === existingEmail;

    let resolvedUser: GoogleUserProfile | undefined;
    if (input.user) {
      const normalizedIncoming: GoogleUserProfile = {
        email: input.user.email.trim().toLowerCase(),
        ...(input.user.id ? { id: input.user.id } : {}),
        ...(input.user.name ? { name: input.user.name } : {}),
        ...(input.user.picture ? { picture: input.user.picture } : {}),
      };
      resolvedUser = isSameAccount && current?.user
        ? { ...current.user, ...normalizedIncoming }
        : normalizedIncoming;
    } else if (isSameAccount && current?.user) {
      resolvedUser = current.user;
    }

    const shouldMergeScopes = input.mergeExistingScopes !== false && isSameAccount;
    const resolvedScopes = shouldMergeScopes
      ? mergeScopes(current?.scopes, input.scopes)
      : normalizeScopes(input.scopes);

    const nextSession: GoogleSession = {
      accessToken: token,
      expiresAt,
      scopes: resolvedScopes,
      ...(resolvedUser ? { user: resolvedUser } : {}),
      updatedAt: nowTs,
    };

    try {
      this.storage.setItem(this.storageKey, JSON.stringify(nextSession));
    } catch {
      // Ignore storage quota errors in restricted private browsing modes
    }

    this.emit(nextSession);
    return nextSession;
  }

  clearSession(): void {
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      // Ignore storage removal errors
    }
    this.emit(null);
  }

  subscribe(listener: GoogleSessionListener): () => void {
    this.listeners.add(listener);
    this.ensureWindowStorageListener();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Idempotently migrates legacy credentials (e.g. Quomida RxDB active_cloud_provider.credentials
   * or Quozen localStorage token/profile) into GoogleSessionStore when no active valid session exists.
   */
  migrateFromLegacyCredentials(
    legacy: unknown,
    fallbackScopes: readonly string[] = GOOGLE_IDENTITY_SCOPES
  ): GoogleSession | null {
    const existing = this.getSession();
    if (existing && !this.isExpired(existing)) {
      return existing;
    }
    if (!legacy) {
      return null;
    }

    if (typeof legacy === 'string' && legacy.trim()) {
      return this.setSession({
        accessToken: legacy.trim(),
        scopes: fallbackScopes,
      });
    }

    if (typeof legacy !== 'object') {
      return null;
    }

    const record = legacy as Record<string, unknown>;
    const rawToken =
      (typeof record.accessToken === 'string' && record.accessToken) ||
      (typeof record.access_token === 'string' && record.access_token) ||
      (typeof record.token === 'string' && record.token) ||
      '';

    if (!rawToken.trim()) {
      return null;
    }

    const rawExpiresAt =
      typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt
        : undefined;

    let user: GoogleUserProfile | undefined;
    if (record.user && typeof record.user === 'object') {
      const u = record.user as Record<string, unknown>;
      if (typeof u.email === 'string' && u.email.trim()) {
        user = {
          email: u.email.trim().toLowerCase(),
          ...(typeof u.id === 'string' && u.id.trim() ? { id: u.id.trim() } : {}),
          ...(typeof u.name === 'string' && u.name.trim() ? { name: u.name.trim() } : {}),
          ...(typeof u.picture === 'string' && u.picture.trim()
            ? { picture: u.picture.trim() }
            : {}),
        };
      }
    } else if (typeof record.userEmail === 'string' && record.userEmail.trim()) {
      user = {
        email: record.userEmail.trim().toLowerCase(),
        ...(typeof record.userName === 'string' && record.userName.trim()
          ? { name: record.userName.trim() }
          : {}),
        ...(typeof record.userPicture === 'string' && record.userPicture.trim()
          ? { picture: record.userPicture.trim() }
          : {}),
      };
    }

    const rawScopes =
      typeof record.scope === 'string' || Array.isArray(record.scopes)
        ? ((record.scope as string) ?? (record.scopes as string[]))
        : fallbackScopes;

    return this.setSession({
      accessToken: rawToken.trim(),
      expiresAt: rawExpiresAt,
      scopes: rawScopes,
      user,
      mergeExistingScopes: false,
    });
  }

  private emit(session: GoogleSession | null): void {
    for (const listener of this.listeners) {
      try {
        listener(session);
      } catch {
        // Prevent individual subscriber error from breaking notification chain
      }
    }
  }

  private ensureWindowStorageListener(): void {
    if (this.windowStorageHandlerBound) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    this.windowStorageHandlerBound = true;
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key === this.storageKey) {
        this.emit(this.getSession());
      }
    });
  }
}

let defaultStoreInstance: GoogleSessionStore | null = null;

export function getDefaultGoogleSessionStore(): GoogleSessionStore {
  if (!defaultStoreInstance) {
    defaultStoreInstance = new GoogleSessionStore();
  }
  return defaultStoreInstance;
}
