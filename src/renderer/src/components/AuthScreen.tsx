import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { authLogin, authSignup, authMe } from '../webapi'
import { cloudLogin, cloudSignup, testAccountLogin } from '../cloud/auth'
import { IS_CLOUD } from '../platform'
import { safeErrMessage } from '../safeError'

export default function AuthScreen(): JSX.Element {
  const setUser = useStore((s) => s.setUser)
  const setView = useStore((s) => s.setView)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [gated, setGated] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Cloud (Supabase) has no invite code — gating is a dashboard switch there.
    if (IS_CLOUD) return
    authMe().then(({ signupGated }) => setGated(signupGated))
  }, [])

  // TEST BRANCH: back into the shared no-login test account (re-arms the
  // silent auto-login for future visits).
  async function testerLogin(): Promise<void> {
    setBusy(true)
    setErr('')
    try {
      const user = await testAccountLogin()
      setUser(user)
      setView('home')
    } catch (e) {
      setErr(safeErrMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const user = IS_CLOUD
        ? mode === 'signup'
          ? await cloudSignup(email, password)
          : await cloudLogin(email, password)
        : mode === 'signup'
          ? await authSignup(email, password, code)
          : await authLogin(email, password)
      setUser(user)
      setView('home')
    } catch (e) {
      setErr(safeErrMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">EaseCut<span>Pro</span></div>
        <p className="muted">{mode === 'signup' ? 'Create your account' : 'Welcome back'}</p>

        <input type="email" autoComplete="email" placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {mode === 'signup' && gated && (
          <input type="text" placeholder="Signup code" value={code} onChange={(e) => setCode(e.target.value)} />
        )}

        {err && <div className="auth-err">{err}</div>}

        <button className="auth-go" type="submit" disabled={busy || !email || !password}>
          {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}
        </button>

        <div className="auth-switch">
          {mode === 'signup' ? 'Already have an account?' : 'New here?'}{' '}
          <button type="button" className="link" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setErr('') }}>
            {mode === 'signup' ? 'Log in' : 'Create one'}
          </button>
        </div>

        {IS_CLOUD && (
          <div className="auth-switch">
            Just testing?{' '}
            <button type="button" className="link" onClick={() => void testerLogin()} disabled={busy}>
              Continue as shared tester (no account)
            </button>
          </div>
        )}
      </form>
    </div>
  )
}
