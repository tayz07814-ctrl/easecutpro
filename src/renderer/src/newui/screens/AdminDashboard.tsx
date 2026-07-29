// EaseCut admin dashboard — userbase management, gated to app admins.
//
// Reachable at ?admin=1. Self-contained: it uses the signed-in Supabase session
// and calls the admin_* SECURITY DEFINER RPCs (every one re-checks is_app_admin
// server-side, so a non-admin who loads this page can read/do nothing). Stats,
// plan management, real blocking (auth ban), and per-user / broadcast notices.

import { useCallback, useEffect, useState } from 'react'
import { css } from '../css'
import { getSupabase } from '../../cloud/supabase'

const ACCENT = '#7c6bff'
const CARD = '#111117'
const HAIR = 'rgba(255,255,255,.07)'

interface Overview {
  total_users: number
  new_7d: number
  new_30d: number
  active_7d: number
  pro_users: number
  blocked_users: number
  total_projects: number
  total_spaces: number
  storage_bytes: number
  ai_runs_total: number
}
interface UserRow {
  user_id: string
  email: string | null
  username: string | null
  display_name: string | null
  created_at: string
  last_sign_in_at: string | null
  plan: string
  sub_status: string | null
  current_period_end: string | null
  days_left: number | null
  ai_runs: number
  project_count: number
  space_count: number
  storage_bytes: number
  blocked: boolean
  block_reason: string | null
}

function fmtBytes(n: number): string {
  if (!n) return '0'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}
function fmtDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' })
}
function ago(s: string | null): string {
  if (!s) return 'never'
  const d = (Date.now() - new Date(s).getTime()) / 1000
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`
  return fmtDate(s)
}

export default function AdminDashboard(): JSX.Element {
  const [state, setState] = useState<'loading' | 'denied' | 'anon' | 'ready'>('loading')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [rows, setRows] = useState<UserRow[]>([])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<UserRow | null>(null)
  const [toast, setToast] = useState('')

  const flash = (m: string): void => {
    setToast(m)
    setTimeout(() => setToast(''), 2600)
  }

  const load = useCallback(async (q = ''): Promise<void> => {
    const sb = getSupabase()
    const [{ data: ov }, { data: list, error }] = await Promise.all([
      sb.rpc('admin_overview'),
      sb.rpc('admin_list_users', { p_search: q, p_limit: 500, p_offset: 0 })
    ])
    if (error) throw error
    setOverview(ov as Overview)
    setRows((list as UserRow[]) ?? [])
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const sb = getSupabase()
        const { data: u } = await sb.auth.getUser()
        if (!u.user) return setState('anon')
        const { data: admin } = await sb.rpc('is_app_admin')
        if (!admin) return setState('denied')
        await load()
        setState('ready')
      } catch {
        setState('denied')
      }
    })()
  }, [load])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await load(search)
    } catch (e) {
      flash(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading')
    return <Center>Loading admin…</Center>
  if (state === 'anon')
    return (
      <Center>
        Sign in to the app first (<a href="/" style={{ color: ACCENT }}>open the app →</a>), then return to this URL.
      </Center>
    )
  if (state === 'denied')
    return <Center>Not authorized. This account is not an admin.</Center>

  const kpis: [string, string, string?][] = overview
    ? [
        ['Total users', String(overview.total_users)],
        ['New · 7d', String(overview.new_7d), `${overview.new_30d} in 30d`],
        ['Active · 7d', String(overview.active_7d)],
        ['Pro', String(overview.pro_users)],
        ['Blocked', String(overview.blocked_users)],
        ['Storage', fmtBytes(overview.storage_bytes)],
        ['Projects', String(overview.total_projects)],
        ['AI runs', String(overview.ai_runs_total)]
      ]
    : []

  return (
    <div style={css('position:fixed;inset:0;overflow-y:auto;background:#0a0a0e;color:#ededf2;font-family:Inter,system-ui,sans-serif')} className="ec-newui">
      {/* header */}
      <div style={css(`position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;padding:14px 22px;background:rgba(10,10,14,.9);backdrop-filter:blur(8px);border-bottom:1px solid ${HAIR}`)}>
        <div style={css(`width:26px;height:26px;border-radius:7px;background:${ACCENT};display:grid;place-items:center;font-weight:800;font-size:13px;color:#fff`)}>E</div>
        <div style={css('font-size:15px;font-weight:700;letter-spacing:-.01em')}>EaseCut Admin</div>
        <div style={css('flex:1')} />
        <button onClick={refresh} disabled={busy} style={btn(false)}>{busy ? 'Refreshing…' : 'Refresh'}</button>
        <a href="/" style={{ ...btn(false), textDecoration: 'none' }}>← Back to app</a>
      </div>

      <div style={css('max-width:1200px;margin:0 auto;padding:22px')}>
        {/* KPI grid */}
        <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px')}>
          {kpis.map(([label, val, sub]) => (
            <div key={label} style={css(`background:${CARD};border:1px solid ${HAIR};border-radius:13px;padding:15px 16px`)}>
              <div style={css('font-size:11px;color:#8b8ba0;font-weight:500')}>{label}</div>
              <div style={css('font-size:26px;font-weight:700;letter-spacing:-.02em;margin-top:5px')}>{val}</div>
              {sub && <div style={css('font-size:11px;color:#6e6e85;margin-top:2px')}>{sub}</div>}
            </div>
          ))}
        </div>

        {/* broadcast */}
        <Broadcast onSent={(n) => flash(`Sent to ${n} users`)} onErr={flash} />

        {/* search */}
        <div style={css('display:flex;align-items:center;gap:10px;margin:20px 0 10px')}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && refresh()}
            placeholder="Search email / username…"
            style={css(`flex:1;max-width:340px;background:${CARD};border:1px solid ${HAIR};border-radius:9px;padding:9px 13px;color:#ededf2;font-size:13px;outline:none;font-family:inherit`)}
          />
          <button onClick={refresh} style={btn(true)}>Search</button>
          <div style={css('flex:1')} />
          <div style={css('font-size:12px;color:#6e6e85')}>{rows.length} shown</div>
        </div>

        {/* user table */}
        <div style={css(`background:${CARD};border:1px solid ${HAIR};border-radius:13px;overflow:hidden`)}>
          <div style={css('overflow-x:auto')}>
            <table style={css('width:100%;border-collapse:collapse;font-size:12.5px;min-width:820px')}>
              <thead>
                <tr style={css('text-align:left;color:#8b8ba0;font-size:11px')}>
                  {['User', 'Plan', 'Days left', 'Signup', 'Last active', 'Projects', 'Storage', 'AI', 'Status', ''].map((h) => (
                    <th key={h} style={css(`padding:11px 12px;font-weight:600;border-bottom:1px solid ${HAIR};white-space:nowrap`)}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.user_id} style={css(`border-bottom:1px solid rgba(255,255,255,.04)`)}>
                    <td style={cell()}>
                      <div style={css('font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px')}>{r.email || '—'}</div>
                      <div style={css('color:#6e6e85;font-size:11px')}>@{r.username || '—'}</div>
                    </td>
                    <td style={cell()}><PlanBadge row={r} /></td>
                    <td style={cell()}>{r.days_left != null ? `${r.days_left}d` : '—'}</td>
                    <td style={cell()}>{fmtDate(r.created_at)}</td>
                    <td style={cell()}>{ago(r.last_sign_in_at)}</td>
                    <td style={cell()}>{r.project_count}{r.space_count ? ` · ${r.space_count}sp` : ''}</td>
                    <td style={cell()}>{fmtBytes(r.storage_bytes)}</td>
                    <td style={cell()}>{r.ai_runs}</td>
                    <td style={cell()}>
                      {r.blocked
                        ? <span style={pill('#ff9b9b', 'rgba(255,155,155,.14)')}>Blocked</span>
                        : <span style={pill('#7ed6a6', 'rgba(126,214,166,.12)')}>Active</span>}
                    </td>
                    <td style={cell()}>
                      <button onClick={() => setSel(r)} style={btn(false, true)}>Manage</button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={10} style={css('padding:30px;text-align:center;color:#6e6e85')}>No users match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div style={css('height:40px')} />
      </div>

      {sel && (
        <ManageDrawer
          row={sel}
          onClose={() => setSel(null)}
          onDone={async (msg) => {
            setSel(null)
            flash(msg)
            await refresh()
          }}
          onErr={flash}
        />
      )}
      {toast && (
        <div style={css(`position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:${ACCENT};color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:40;box-shadow:0 8px 24px rgba(124,107,255,.4)`)}>{toast}</div>
      )}
    </div>
  )
}

function PlanBadge({ row }: { row: UserRow }): JSX.Element {
  const pro = row.plan !== 'free' && (row.sub_status === 'active' || row.sub_status === 'trialing')
  if (pro) return <span style={pill('#c4baff', 'rgba(124,107,255,.18)')}>{row.plan}{row.sub_status === 'trialing' ? ' · trial' : ''}</span>
  return <span style={pill('#9a9aae', 'rgba(255,255,255,.06)')}>free</span>
}

function Broadcast({ onSent, onErr }: { onSent: (n: number) => void; onErr: (m: string) => void }): JSX.Element {
  const [msg, setMsg] = useState('')
  const [open, setOpen] = useState(false)
  const send = async (): Promise<void> => {
    if (!msg.trim()) return
    if (!confirm(`Send this notification to ALL users?\n\n"${msg}"`)) return
    try {
      const { data, error } = await getSupabase().rpc('admin_broadcast', { p_message: msg.trim() })
      if (error) throw error
      setMsg('')
      setOpen(false)
      onSent(Number(data) || 0)
    } catch (e) {
      onErr(String((e as Error).message))
    }
  }
  return (
    <div style={css(`margin-top:18px;background:${CARD};border:1px solid ${HAIR};border-radius:13px;padding:14px 16px`)}>
      <div style={css('display:flex;align-items:center;gap:10px')}>
        <div style={css('font-size:13px;font-weight:600')}>📣 Broadcast notification</div>
        <div style={css('flex:1')} />
        <button onClick={() => setOpen((o) => !o)} style={btn(false)}>{open ? 'Cancel' : 'Compose'}</button>
      </div>
      {open && (
        <div style={css('margin-top:12px;display:flex;gap:10px;align-items:flex-end')}>
          <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2} placeholder="Message to every user's in-app inbox…"
            style={css(`flex:1;background:#0d0d12;border:1px solid ${HAIR};border-radius:9px;padding:10px 12px;color:#ededf2;font-size:13px;font-family:inherit;resize:vertical;outline:none`)} />
          <button onClick={send} style={btn(true)}>Send to all</button>
        </div>
      )}
    </div>
  )
}

function ManageDrawer({
  row, onClose, onDone, onErr
}: { row: UserRow; onClose: () => void; onDone: (msg: string) => void; onErr: (m: string) => void }): JSX.Element {
  const [plan, setPlan] = useState(row.plan === 'free' ? 'pro' : row.plan)
  const [days, setDays] = useState('30')
  const [note, setNote] = useState('')
  const [reason, setReason] = useState(row.block_reason ?? '')
  const rpc = async (fn: string, args: Record<string, unknown>, ok: string): Promise<void> => {
    try {
      const { error } = await getSupabase().rpc(fn, args)
      if (error) throw error
      onDone(ok)
    } catch (e) {
      onErr(String((e as Error).message))
    }
  }
  return (
    <div onClick={onClose} style={css('position:fixed;inset:0;background:rgba(4,4,6,.6);backdrop-filter:blur(3px);z-index:30;display:flex;justify-content:flex-end')}>
      <div onClick={(e) => e.stopPropagation()} style={css(`width:380px;max-width:92vw;height:100%;overflow-y:auto;background:#0e0e13;border-left:1px solid ${HAIR};padding:20px`)}>
        <div style={css('display:flex;align-items:center;gap:10px')}>
          <div style={css('font-size:15px;font-weight:700')}>Manage user</div>
          <div style={css('flex:1')} />
          <button onClick={onClose} style={btn(false)}>Close</button>
        </div>
        <div style={css(`margin-top:14px;background:${CARD};border:1px solid ${HAIR};border-radius:11px;padding:13px`)}>
          <div style={css('font-size:13.5px;font-weight:600;word-break:break-all')}>{row.email}</div>
          <div style={css('color:#8b8ba0;font-size:12px;margin-top:2px')}>@{row.username || '—'} · joined {fmtDate(row.created_at)}</div>
          <div style={css('display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;font-size:12px;color:#c9c9da')}>
            <Stat k="Plan" v={row.plan} />
            <Stat k="Days left" v={row.days_left != null ? `${row.days_left}` : '—'} />
            <Stat k="Projects" v={String(row.project_count)} />
            <Stat k="Spaces" v={String(row.space_count)} />
            <Stat k="Storage" v={fmtBytes(row.storage_bytes)} />
            <Stat k="AI runs" v={String(row.ai_runs)} />
            <Stat k="Last active" v={ago(row.last_sign_in_at)} />
          </div>
        </div>

        {/* plan */}
        <Section title="Plan">
          <div style={css('display:flex;gap:8px')}>
            <select value={plan} onChange={(e) => setPlan(e.target.value)} style={field()}>
              {['pro', 'business', 'free'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <input value={days} onChange={(e) => setDays(e.target.value)} placeholder="days" style={{ ...field(), width: 74 }} />
          </div>
          <div style={css('display:flex;gap:8px;margin-top:9px')}>
            <button style={btn(true)} onClick={() => rpc('admin_set_plan', { p_user: row.user_id, p_plan: plan, p_status: plan === 'free' ? 'canceled' : 'active', p_days_from_now: plan === 'free' ? null : Number(days) || null }, 'Plan updated')}>
              {plan === 'free' ? 'Downgrade to free' : `Grant ${plan}`}
            </button>
          </div>
          <div style={css('font-size:11px;color:#6e6e85;margin-top:7px;line-height:1.5')}>Manual grant/fix. Automated billing still flows through Paddle; leave the days blank for no expiry.</div>
        </Section>

        {/* notify */}
        <Section title="Send notification">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Message to this user…" style={{ ...field(), resize: 'vertical' }} />
          <button style={{ ...btn(true), marginTop: 8 }} disabled={!note.trim()}
            onClick={() => rpc('admin_notify', { p_user: row.user_id, p_message: note.trim() }, 'Notification sent')}>Send</button>
        </Section>

        {/* block */}
        <Section title={row.blocked ? 'Unblock' : 'Block user'}>
          {!row.blocked && (
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" style={field()} />
          )}
          <button
            style={{ ...btn(false), marginTop: 9, borderColor: row.blocked ? 'rgba(126,214,166,.4)' : 'rgba(255,155,155,.4)', color: row.blocked ? '#7ed6a6' : '#ff9b9b' }}
            onClick={() => {
              if (!confirm(row.blocked ? 'Unblock this user? They will be able to sign in again.' : 'Block this user? They will be signed out and cannot sign in.')) return
              rpc('admin_block', { p_user: row.user_id, p_block: !row.blocked, p_reason: reason || null }, row.blocked ? 'User unblocked' : 'User blocked')
            }}>
            {row.blocked ? 'Unblock user' : 'Block user'}
          </button>
          {row.blocked && row.block_reason && <div style={css('font-size:11.5px;color:#8b8ba0;margin-top:8px')}>Reason: {row.block_reason}</div>}
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={css(`margin-top:16px;border-top:1px solid ${HAIR};padding-top:14px`)}>
      <div style={css('font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6e6e85;margin-bottom:9px')}>{title}</div>
      {children}
    </div>
  )
}
function Stat({ k, v }: { k: string; v: string }): JSX.Element {
  return <div><div style={css('color:#6e6e85;font-size:10.5px')}>{k}</div><div style={css('font-weight:600;margin-top:1px')}>{v}</div></div>
}
function Center({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={css('position:fixed;inset:0;display:grid;place-items:center;background:#0a0a0e;color:#c9c9da;font-family:Inter,system-ui,sans-serif;font-size:14px;padding:24px;text-align:center')}>{children}</div>
}

function btn(primary: boolean, small = false): React.CSSProperties {
  return css(
    `border-radius:8px;cursor:pointer;font-family:inherit;font-weight:600;border:1px solid ${primary ? ACCENT : HAIR};background:${primary ? ACCENT : 'transparent'};color:${primary ? '#fff' : '#c9c9da'};` +
      (small ? 'font-size:11.5px;padding:5px 10px' : 'font-size:12.5px;padding:8px 14px')
  )
}
function field(): React.CSSProperties {
  return css(`background:#0d0d12;border:1px solid ${HAIR};border-radius:8px;padding:9px 11px;color:#ededf2;font-size:13px;font-family:inherit;outline:none;width:100%;box-sizing:border-box`)
}
function cell(): React.CSSProperties {
  return css('padding:10px 12px;white-space:nowrap;vertical-align:middle')
}
function pill(color: string, bg: string): React.CSSProperties {
  return css(`display:inline-block;font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:6px;color:${color};background:${bg}`)
}
