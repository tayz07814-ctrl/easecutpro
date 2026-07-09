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
  try {
    await getSupabase().auth.signOut()
  } catch {
    /* ignore — local session is cleared regardless */
  }
}
