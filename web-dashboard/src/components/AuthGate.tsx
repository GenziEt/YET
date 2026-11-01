import { useCallback, useEffect, useState } from 'react';
import { ApiError, isManagerRole, login, logout, subscribeSession } from '../lib/api';

/**
 * App-level sign-in gate + session indicator (Phase 5 audit fix). Previously
 * each manager-only page carried its own inline login bar, so the dashboard
 * rendered read-only data with no session context and DriversPage could call
 * /admin/* without a JWT. One gate at the shell keeps auth state honest for
 * every view; pages that still show their own bar simply find the user
 * already signed in.
 */

export function useSession(): string | null {
  const read = () => (isManagerRole(localStorage.getItem('yet_role')) ? localStorage.getItem('yet_role') : null);
  const [role, setRole] = useState<string | null>(read);
  useEffect(() => {
    const sync = () => setRole(read());
    const off = subscribeSession(sync); // same-tab login/logout (api.ts pub/sub)
    window.addEventListener('storage', sync); // other tabs
    return () => { off(); window.removeEventListener('storage', sync); };
  }, []);
  return role;
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const role = useSession();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const { role: r } = await login(identifier.trim(), password);
        if (!isManagerRole(r)) {
          logout(); // drivers/staff without fleet rights must not linger half-signed-in
          setError('This account has no fleet-manager access.');
        }
      } catch (err) {
        setError(err instanceof ApiError && err.status === 401 ? 'Wrong phone/email or password.' : 'Login failed — check the API is reachable.');
      } finally {
        setBusy(false);
      }
    },
    [identifier, password],
  );

  if (role) {
    return (
      <>
        <div className="session-bar" role="status">
          <span className={`session-chip ${role.toLowerCase()}`}>Signed in · {role.replace('_', ' ')}</span>
          <button className="btn ghost small" onClick={() => logout()}>Sign out</button>
        </div>
        {children}
      </>
    );
  }

  return (
    <form className="auth-card" onSubmit={submit} aria-label="Fleet manager sign-in">
      <h2>YET Fleet Intelligence</h2>
      <p>Fleet managers and admins sign in here. Drivers never log in — their phone pairs once via OTP.</p>
      <label>
        Phone or email
        <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      <button className="btn" disabled={busy || !identifier || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <p className="auth-error" role="alert">{error}</p>}
    </form>
  );
}
