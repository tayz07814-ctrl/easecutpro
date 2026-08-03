// Cloud build auth — Supabase Auth replaces the PC server's users.json +
// HMAC cookie. Same AuthUser shape the rest of the app already consumes.
import { getSupabase, supabaseConfigured } from './supabase'

export interface AuthUser {
  id: string
  email: string
}

export async function cloudAuthMe(): Promise<{ user: AuthUser | null; signupGated: boolean }> {
  if (!supabaseConfigured()) return { user: null, signupGated: false }
  try {
    const { data } = await getSupabase().auth.getSession()
    const u = data.session?.user
    // Signup gating is a Supabase dashboard switch (Auth → disable signups),
    // not an invite code — the code field never shows in the cloud build.
    return { user: u ? { id: u.id, email: u.email ?? '' } : null, signupGated: false }
  } catch {
    return { user: null, signupGated: false }
  }
}

export async function cloudSignup(email: string, password: string): Promise<AuthUser> {
  const { data, error } = await getSupabase().auth.signUp({ email, password })
  if (error) throw new Error(error.message)
  if (!data.user) throw new Error('Signup failed')
  // Email confirmation on (Supabase default): no session until the link is
  // clicked — surface that instead of a silent not-logged-in state.
  if (!data.session) throw new Error('Check your email to confirm your account, then log in.')
  return { id: data.user.id, email: data.user.email ?? '' }
}

export async function cloudLogin(email: string, password: string): Promise<AuthUser> {
  const { data, error } = await getSupabase().auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  return { id: data.user.id, email: data.user.email ?? '' }
}

export async function cloudLogout(): Promise<void> {
  // TEST BRANCH: an explicit logout must LAND on the sign-in screen — without
  // this flag the bootstrap would bounce the user straight back into the
  // shared test account on the next load, making a real sign-in unreachable.
  setTestAutoLogin(false)
  try {
    await getSupabase().auth.signOut()
  } catch {
    /* ignore — local session is cleared regardless */
  }
}

// ---- TEST BRANCH (silence-mastery) shared test account ----------------------
// The branch's public testing URL needs no login: the bootstrap silently signs
// into this shared account (credentials deliberately public — the account
// exists only for this branch). A real account is still usable: `?login=1`
// or an explicit Log out disables the auto-login and shows the auth screen;
// the button there ("continue as shared tester") re-enables it.

export const TEST_ACCOUNT_EMAIL = 'silence.mastery.tester@easecutpro.com'
export const TEST_ACCOUNT_PASSWORD = 'smx-testing-4271-branch'

export function setTestAutoLogin(v: boolean): void {
  try {
    localStorage.setItem('ec.testAutoLogin', v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** Should the bootstrap auto-login to the shared test account? `?login=1`
 *  opts out (and persists, so the choice survives the OAuth-style reloads);
 *  `?login=0` opts back in. Default: on. */
export function testAutoLoginEnabled(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('login')
    if (q === '1') setTestAutoLogin(false)
    else if (q === '0') setTestAutoLogin(true)
    return localStorage.getItem('ec.testAutoLogin') !== '0'
  } catch {
    return true
  }
}

/** Sign into the shared test account and re-arm the auto-login. */
export async function testAccountLogin(): Promise<AuthUser> {
  const user = await cloudLogin(TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_PASSWORD)
  setTestAutoLogin(true)
  return user
}
