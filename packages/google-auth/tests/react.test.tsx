/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TokenResponse, NonOAuthError, OverridableTokenClientConfig } from '@react-oauth/google';
import {
  GoogleSessionStore,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_DRIVE_BYOS_SCOPES,
} from '@qozara/google-auth';
import {
  GoogleAuthSessionProvider,
  StandaloneGoogleAuthSessionProvider,
  useGoogleAuthSession,
  useOptionalGoogleAuthSession,
} from '@qozara/google-auth/react';

interface MockUseGoogleLoginOptions {
  scope: string;
  onSuccess: (res: TokenResponse) => void;
  onError?: (err: Pick<TokenResponse, 'error'>) => void;
  onNonOAuthError?: (err: NonOAuthError) => void;
}

const triggerCalls: Array<{ scope: string; override?: OverridableTokenClientConfig }> = [];
let mockOAuthMode: 'success' | 'popup_closed' = 'success';

vi.mock('@react-oauth/google', () => ({
  useGoogleLogin: (opts: MockUseGoogleLoginOptions) => {
    return (override?: OverridableTokenClientConfig) => {
      triggerCalls.push({ scope: opts.scope, override });
      if (mockOAuthMode === 'popup_closed') {
        opts.onNonOAuthError?.({ type: 'popup_closed' });
        return;
      }
      opts.onSuccess({
        access_token: opts.scope.includes('drive.file') ? 'drive-token-123' : 'identity-token-123',
        expires_in: 3600,
        scope: opts.scope,
        prompt: override?.prompt ?? '',
        token_type: 'Bearer',
      });
    };
  },
}));

describe('@qozara/google-auth/react — GoogleAuthSessionProvider', () => {
  beforeEach(() => {
    triggerCalls.length = 0;
    mockOAuthMode = 'success';
  });

  it('returns null from useOptionalGoogleAuthSession when outside provider', () => {
    const Probe = () => {
      const ctx = useOptionalGoogleAuthSession();
      return <div data-testid="probe">{ctx === null ? 'none' : 'present'}</div>;
    };
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('none');
  });

  it('supports identity-only sign-in (Qozara AI) followed by incremental Drive upgrade and independent signOut', async () => {
    const map = new Map<string, string>();
    const store = new GoogleSessionStore({
      storage: {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => {
          map.set(k, v);
        },
        removeItem: (k) => {
          map.delete(k);
        },
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        sub: 'sub-99',
        email: 'diego@qozara.org',
        name: 'Diego',
        picture: 'https://example.com/diego.png',
      }),
    });

    const TestConsumer = () => {
      const {
        isAuthenticated,
        user,
        hasIdentityScopes,
        hasDriveScopes,
        getValidAccessToken,
        signInForIdentity,
        signInForDrive,
        signOut,
      } = useGoogleAuthSession();

      return (
        <div>
          <span data-testid="auth">{String(isAuthenticated)}</span>
          <span data-testid="email">{user?.email ?? 'none'}</span>
          <span data-testid="id-scopes">{String(hasIdentityScopes)}</span>
          <span data-testid="drive-scopes">{String(hasDriveScopes)}</span>
          <span data-testid="ai-token">{getValidAccessToken(GOOGLE_IDENTITY_SCOPES) ?? 'null'}</span>
          <span data-testid="drive-token">
            {getValidAccessToken(GOOGLE_DRIVE_BYOS_SCOPES) ?? 'null'}
          </span>
          <button onClick={() => void signInForIdentity()}>Sign In AI</button>
          <button onClick={() => void signInForDrive()}>Connect Drive</button>
          <button onClick={() => signOut()}>Sign Out</button>
        </div>
      );
    };

    render(
      <GoogleAuthSessionProvider
        store={store}
        fetchImpl={mockFetch as unknown as typeof fetch}
      >
        <TestConsumer />
      </GoogleAuthSessionProvider>
    );

    expect(screen.getByTestId('auth').textContent).toBe('false');

    // Step 1: Sign in only for Qozara AI (identity scopes only, NO Drive scopes)
    fireEvent.click(screen.getByText('Sign In AI'));

    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('true');
    });
    expect(screen.getByTestId('email').textContent).toBe('diego@qozara.org');
    expect(screen.getByTestId('id-scopes').textContent).toBe('true');
    expect(screen.getByTestId('drive-scopes').textContent).toBe('false');
    expect(screen.getByTestId('ai-token').textContent).toBe('identity-token-123');
    expect(screen.getByTestId('drive-token').textContent).toBe('null');

    // Step 2: Upgrade to Google Drive scopes incrementally (passes login hint!)
    fireEvent.click(screen.getByText('Connect Drive'));

    await waitFor(() => {
      expect(screen.getByTestId('drive-scopes').textContent).toBe('true');
    });
    expect(screen.getByTestId('ai-token').textContent).toBe('drive-token-123');
    expect(screen.getByTestId('drive-token').textContent).toBe('drive-token-123');

    const driveCall = triggerCalls.find((c) => c.scope.includes('drive.file'));
    expect(driveCall?.override).toEqual(expect.objectContaining({ hint: 'diego@qozara.org' }));

    // Step 3: Explicit Sign Out clears session
    fireEvent.click(screen.getByText('Sign Out'));
    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('false');
    });
    expect(screen.getByTestId('ai-token').textContent).toBe('null');
  });

  it('rejects cleanly with POPUP_CLOSED when popup is dismissed and supports StandaloneGoogleAuthSessionProvider', async () => {
    mockOAuthMode = 'popup_closed';
    let capturedErrorCode = '';

    const PopupProbe = () => {
      const { signInForIdentity } = useGoogleAuthSession();
      return (
        <button
          onClick={() => {
            signInForIdentity().catch((err: { code?: string }) => {
              capturedErrorCode = err.code ?? 'unknown';
            });
          }}
        >
          Open Popup
        </button>
      );
    };

    render(
      <GoogleAuthSessionProvider>
        <PopupProbe />
      </GoogleAuthSessionProvider>
    );

    fireEvent.click(screen.getByText('Open Popup'));
    await waitFor(() => {
      expect(capturedErrorCode).toBe('POPUP_CLOSED');
    });

    let standaloneCode = '';
    const StandaloneProbe = () => {
      const { signInForIdentity } = useGoogleAuthSession();
      return (
        <button
          onClick={() => {
            signInForIdentity().catch((err: { code?: string }) => {
              standaloneCode = err.code ?? 'unknown';
            });
          }}
        >
          Standalone Login
        </button>
      );
    };

    render(
      <StandaloneGoogleAuthSessionProvider>
        <StandaloneProbe />
      </StandaloneGoogleAuthSessionProvider>
    );

    fireEvent.click(screen.getByText('Standalone Login'));
    await waitFor(() => {
      expect(standaloneCode).toBe('PROVIDER_UNAVAILABLE');
    });
  });
});
