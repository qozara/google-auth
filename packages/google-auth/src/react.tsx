import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useGoogleLogin, type TokenResponse } from '@react-oauth/google';
import {
  GOOGLE_DRIVE_BYOS_SCOPES,
  GOOGLE_IDENTITY_AND_DRIVE_SCOPES,
  GOOGLE_IDENTITY_SCOPES,
  GoogleAuthError,
  type GoogleSession,
  type GoogleUserProfile,
} from './types.js';
import { formatScopeString, hasRequiredScopes } from './scopes.js';
import { fetchGoogleUserProfile } from './profile.js';
import {
  GoogleSessionStore,
  getDefaultGoogleSessionStore,
} from './GoogleSessionStore.js';

export interface SignOutOptions {
  revokeRemote?: boolean;
}

export interface GoogleAuthSessionContextValue {
  session: GoogleSession | null;
  user: GoogleUserProfile | null;
  isAuthenticated: boolean;
  isExpired: boolean;
  isLoading: boolean;
  hasIdentityScopes: boolean;
  hasDriveScopes: boolean;
  store: GoogleSessionStore;
  getValidAccessToken: (requiredScopes?: readonly string[]) => string | null;
  signInForIdentity: () => Promise<GoogleSession>;
  signInForDrive: () => Promise<GoogleSession>;
  refreshSession: (requiredScopes?: readonly string[]) => Promise<GoogleSession>;
  signOut: (options?: SignOutOptions) => void;
}

const GoogleAuthSessionContext = createContext<GoogleAuthSessionContextValue | null>(null);

export interface GoogleAuthSessionProviderProps {
  store?: GoogleSessionStore;
  fetchImpl?: typeof fetch;
  children: ReactNode;
}

interface PendingLoginRequest {
  resolve: (session: GoogleSession) => void;
  reject: (err: Error) => void;
}

const IDENTITY_SCOPE_STRING = formatScopeString(GOOGLE_IDENTITY_SCOPES);
const DRIVE_SCOPE_STRING = formatScopeString(GOOGLE_IDENTITY_AND_DRIVE_SCOPES);

export function GoogleAuthSessionProvider({
  store: providedStore,
  fetchImpl,
  children,
}: GoogleAuthSessionProviderProps) {
  const store = useMemo(() => providedStore ?? getDefaultGoogleSessionStore(), [providedStore]);
  const [session, setSession] = useState<GoogleSession | null>(() => store.getSession());
  const [isLoading, setIsLoading] = useState(false);
  const pendingRef = useRef<PendingLoginRequest | null>(null);

  useEffect(() => {
    setSession(store.getSession());
    return store.subscribe((next) => {
      setSession(next);
    });
  }, [store]);

  const handleTokenSuccess = useCallback(
    async (tokenResponse: TokenResponse, fallbackScopes: readonly string[]) => {
      setIsLoading(true);
      try {
        const accessToken = tokenResponse.access_token;
        let profile: GoogleUserProfile | undefined;
        try {
          profile = await fetchGoogleUserProfile(accessToken, { fetchImpl });
        } catch (profileErr) {
          // If refreshing an existing session and profile endpoint fails transiently, preserve existing user if available
          const existingUser = store.getSession()?.user;
          if (!existingUser) {
            throw profileErr;
          }
          profile = existingUser;
        }

        const saved = store.setSession({
          accessToken,
          expiresInSeconds: tokenResponse.expires_in,
          scopes: tokenResponse.scope || fallbackScopes,
          user: profile,
        });

        const pending = pendingRef.current;
        pendingRef.current = null;
        pending?.resolve(saved);
      } catch (err) {
        const pending = pendingRef.current;
        pendingRef.current = null;
        const wrapped =
          err instanceof Error
            ? err
            : new GoogleAuthError('OAUTH_ERROR', 'Failed to complete Google sign-in', err);
        pending?.reject(wrapped);
      } finally {
        setIsLoading(false);
      }
    },
    [fetchImpl, store]
  );

  const handleOAuthFailure = useCallback((code: 'OAUTH_ERROR' | 'POPUP_CLOSED', detail: unknown) => {
    setIsLoading(false);
    const pending = pendingRef.current;
    pendingRef.current = null;
    pending?.reject(
      new GoogleAuthError(
        code,
        code === 'POPUP_CLOSED' ? 'Google sign-in popup was closed' : 'Google OAuth failed',
        detail
      )
    );
  }, []);

  const triggerIdentityLogin = useGoogleLogin({
    scope: IDENTITY_SCOPE_STRING,
    include_granted_scopes: true,
    onSuccess: (res) => {
      void handleTokenSuccess(res, GOOGLE_IDENTITY_SCOPES);
    },
    onError: (err) => handleOAuthFailure('OAUTH_ERROR', err),
    onNonOAuthError: (err) => handleOAuthFailure('POPUP_CLOSED', err),
  });

  const triggerDriveLogin = useGoogleLogin({
    scope: DRIVE_SCOPE_STRING,
    include_granted_scopes: true,
    onSuccess: (res) => {
      void handleTokenSuccess(res, GOOGLE_IDENTITY_AND_DRIVE_SCOPES);
    },
    onError: (err) => handleOAuthFailure('OAUTH_ERROR', err),
    onNonOAuthError: (err) => handleOAuthFailure('POPUP_CLOSED', err),
  });

  const signInForIdentity = useCallback((): Promise<GoogleSession> => {
    setIsLoading(true);
    const existingHint = store.getSession()?.user?.email;
    return new Promise<GoogleSession>((resolve, reject) => {
      pendingRef.current = { resolve, reject };
      triggerIdentityLogin(existingHint ? { hint: existingHint } : undefined);
    });
  }, [store, triggerIdentityLogin]);

  const signInForDrive = useCallback((): Promise<GoogleSession> => {
    setIsLoading(true);
    const existingHint = store.getSession()?.user?.email;
    return new Promise<GoogleSession>((resolve, reject) => {
      pendingRef.current = { resolve, reject };
      triggerDriveLogin(existingHint ? { hint: existingHint } : undefined);
    });
  }, [store, triggerDriveLogin]);

  const refreshSession = useCallback(
    (requiredScopes?: readonly string[]): Promise<GoogleSession> => {
      const current = store.getSession();
      const needsDrive =
        (requiredScopes && hasRequiredScopes(requiredScopes, GOOGLE_DRIVE_BYOS_SCOPES)) ||
        hasRequiredScopes(current?.scopes, GOOGLE_DRIVE_BYOS_SCOPES);
      return needsDrive ? signInForDrive() : signInForIdentity();
    },
    [signInForDrive, signInForIdentity, store]
  );

  const signOut = useCallback(
    (options?: SignOutOptions) => {
      const currentToken = store.getSession()?.accessToken;
      store.clearSession();
      if (options?.revokeRemote && currentToken && typeof window !== 'undefined') {
        const g = (window as unknown as { google?: { accounts?: { oauth2?: { revoke?: (t: string, cb?: () => void) => void } } } }).google;
        g?.accounts?.oauth2?.revoke?.(currentToken, () => {});
      }
    },
    [store]
  );

  const getValidAccessToken = useCallback(
    (requiredScopes?: readonly string[]) => store.getValidAccessToken(requiredScopes),
    [store]
  );

  const isExpired = Boolean(session && store.isExpired(session));
  const isAuthenticated = Boolean(session && !isExpired);
  const hasIdentityScopes = Boolean(
    session && hasRequiredScopes(session.scopes, GOOGLE_IDENTITY_SCOPES)
  );
  const hasDriveScopes = Boolean(
    session && hasRequiredScopes(session.scopes, GOOGLE_DRIVE_BYOS_SCOPES)
  );

  const value = useMemo<GoogleAuthSessionContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isAuthenticated,
      isExpired,
      isLoading,
      hasIdentityScopes,
      hasDriveScopes,
      store,
      getValidAccessToken,
      signInForIdentity,
      signInForDrive,
      refreshSession,
      signOut,
    }),
    [
      session,
      isAuthenticated,
      isExpired,
      isLoading,
      hasIdentityScopes,
      hasDriveScopes,
      store,
      getValidAccessToken,
      signInForIdentity,
      signInForDrive,
      refreshSession,
      signOut,
    ]
  );

  return (
    <GoogleAuthSessionContext.Provider value={value}>
      {children}
    </GoogleAuthSessionContext.Provider>
  );
}

/**
 * Fallback provider for environments where VITE_GOOGLE_CLIENT_ID is unconfigured (offline-only / tests).
 */
export function StandaloneGoogleAuthSessionProvider({
  store: providedStore,
  children,
}: Omit<GoogleAuthSessionProviderProps, 'fetchImpl'>) {
  const store = useMemo(() => providedStore ?? getDefaultGoogleSessionStore(), [providedStore]);
  const [session, setSession] = useState<GoogleSession | null>(() => store.getSession());

  useEffect(() => {
    setSession(store.getSession());
    return store.subscribe((next) => setSession(next));
  }, [store]);

  const unavailable = useCallback(
    (): Promise<GoogleSession> =>
      Promise.reject(
        new GoogleAuthError(
          'PROVIDER_UNAVAILABLE',
          'Google OAuth Client ID is not configured in this environment'
        )
      ),
    []
  );

  const signOut = useCallback(() => {
    store.clearSession();
  }, [store]);

  const getValidAccessToken = useCallback(
    (requiredScopes?: readonly string[]) => store.getValidAccessToken(requiredScopes),
    [store]
  );

  const isExpired = Boolean(session && store.isExpired(session));
  const isAuthenticated = Boolean(session && !isExpired);

  const value = useMemo<GoogleAuthSessionContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isAuthenticated,
      isExpired,
      isLoading: false,
      hasIdentityScopes: Boolean(
        session && hasRequiredScopes(session.scopes, GOOGLE_IDENTITY_SCOPES)
      ),
      hasDriveScopes: Boolean(
        session && hasRequiredScopes(session.scopes, GOOGLE_DRIVE_BYOS_SCOPES)
      ),
      store,
      getValidAccessToken,
      signInForIdentity: unavailable,
      signInForDrive: unavailable,
      refreshSession: unavailable,
      signOut,
    }),
    [session, isAuthenticated, isExpired, store, getValidAccessToken, unavailable, signOut]
  );

  return (
    <GoogleAuthSessionContext.Provider value={value}>
      {children}
    </GoogleAuthSessionContext.Provider>
  );
}

export function useOptionalGoogleAuthSession(): GoogleAuthSessionContextValue | null {
  return useContext(GoogleAuthSessionContext);
}

export function useGoogleAuthSession(): GoogleAuthSessionContextValue {
  const context = useContext(GoogleAuthSessionContext);
  if (!context) {
    throw new Error('useGoogleAuthSession must be used within a GoogleAuthSessionProvider');
  }
  return context;
}
