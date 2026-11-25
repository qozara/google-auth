export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

export const GOOGLE_DRIVE_BYOS_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.appdata',
] as const;

export const GOOGLE_IDENTITY_AND_DRIVE_SCOPES = [
  ...GOOGLE_IDENTITY_SCOPES,
  ...GOOGLE_DRIVE_BYOS_SCOPES,
] as const;

export const DEFAULT_GOOGLE_SESSION_STORAGE_KEY = 'qozara_google_session_v1';
export const DEFAULT_EXPIRY_BUFFER_MS = 60_000;
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface GoogleUserProfile {
  id?: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface GoogleSession {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  user?: GoogleUserProfile;
  updatedAt: number;
}

export interface SetGoogleSessionInput {
  accessToken: string;
  expiresInSeconds?: number;
  expiresAt?: number;
  scopes?: string | readonly string[] | null;
  user?: GoogleUserProfile;
  mergeExistingScopes?: boolean;
}

export interface GoogleSessionStoreOptions {
  storageKey?: string;
  storage?: StorageLike;
  expiryBufferMs?: number;
  now?: () => number;
}

export type GoogleAuthErrorCode =
  | 'INVALID_TOKEN'
  | 'OAUTH_ERROR'
  | 'POPUP_CLOSED'
  | 'PROFILE_FETCH_FAILED'
  | 'NETWORK_ERROR'
  | 'PROVIDER_UNAVAILABLE';

export class GoogleAuthError extends Error {
  constructor(
    public readonly code: GoogleAuthErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'GoogleAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
