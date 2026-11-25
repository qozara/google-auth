# 🔐 `@qozara/google-auth`

Isomorphic, device-local Google OAuth2 session management with token expiry enforcement, incremental scope tracking, legacy credential migration, and optional React 18/19 hooks (`@qozara/google-auth/react`).

Designed for local-first applications in the Qozara ecosystem ([Quomida](https://github.com/qozara/quomida), [Quozen](https://github.com/qozara/Quozen)) so identity authentication (e.g. Qozara Cloud AI) and storage authorization (e.g. Google Drive / Sheets BYOS) remain cleanly decoupled while sharing a single user session without double logins.

---

## ✨ Key Capabilities

- **Zero-Dependency Core (`@qozara/google-auth`)**:
  - `GoogleSessionStore`: Persists `{ accessToken, expiresAt, scopes, user, updatedAt }` in device-local storage (`localStorage` with in-memory SSR/test fallback and cross-tab `storage` event sync).
  - **Strict Expiry Guard**: `getValidAccessToken(requiredScopes?)` enforces an expiry safety buffer (`60s` default) so expired 1-hour OAuth2 implicit tokens are never dispatched to downstream APIs, while `getSession()` preserves user identity metadata for 1-click reconnect UIs.
  - **Canonical Scope & Incremental Auth Tracking**: Normalizes Google OIDC scope URI aliases (`userinfo.email` → `email`, `userinfo.profile` → `profile`) and merges scopes incrementally for the same Google account while resetting scopes cleanly on account switch.
  - **Idempotent Legacy Migration**: `migrateFromLegacyCredentials()` upgrades legacy credential objects into `GoogleSessionStore` without losing active sessions.
- **Optional React Bindings (`@qozara/google-auth/react`)**:
  - `GoogleAuthSessionProvider` & `StandaloneGoogleAuthSessionProvider`
  - `useGoogleAuthSession()` & `useOptionalGoogleAuthSession()` with promise-based `signInForIdentity()`, `signInForDrive()`, `refreshSession()`, and `signOut()`.

---

## 📦 Installation

```bash
npm install @qozara/google-auth
# Optional peer dependencies when using '@qozara/google-auth/react':
npm install react @react-oauth/google
```

---

## 🚀 Usage

### 1. Core Session Store (Framework-Agnostic)

```ts
import {
  GoogleSessionStore,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_DRIVE_BYOS_SCOPES,
} from '@qozara/google-auth';

const sessionStore = new GoogleSessionStore();

// Check valid token for identity-only services (e.g. Qozara Cloud AI)
const aiToken = sessionStore.getValidAccessToken(GOOGLE_IDENTITY_SCOPES);

// Check valid token for Google Drive BYOS sync
const driveToken = sessionStore.getValidAccessToken(GOOGLE_DRIVE_BYOS_SCOPES);
```

### 2. React Provider & Hooks (`@qozara/google-auth/react`)

```tsx
import { GoogleOAuthProvider } from '@react-oauth/google';
import { GoogleAuthSessionProvider, useGoogleAuthSession } from '@qozara/google-auth/react';

export function App() {
  return (
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
      <GoogleAuthSessionProvider>
        <AccountControls />
      </GoogleAuthSessionProvider>
    </GoogleOAuthProvider>
  );
}

function AccountControls() {
  const {
    user,
    isAuthenticated,
    isExpired,
    hasDriveScopes,
    signInForIdentity,
    signInForDrive,
    refreshSession,
    signOut,
  } = useGoogleAuthSession();

  if (!user) {
    return <button onClick={() => signInForIdentity()}>Sign in with Google</button>;
  }

  return (
    <div>
      <p>{user.email} ({isExpired ? 'Session expired' : 'Active'})</p>
      {isExpired && <button onClick={() => refreshSession()}>Reconnect</button>}
      {!hasDriveScopes && <button onClick={() => signInForDrive()}>Grant Google Drive Sync</button>}
      {isAuthenticated && <button onClick={() => signOut()}>Sign Out</button>}
    </div>
  );
}
```

---

## 📄 License

MIT © Qozara
