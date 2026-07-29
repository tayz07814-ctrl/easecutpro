import { useCallback, useEffect, useState } from 'react'
import { css } from '../css'
import { listNotifications, markAllNotifsRead, deleteNotif, acceptInvite, type Notif } from '../../cloud/cowork'

// In-app notifications bell + dropdown. Lives in the Dashboard header. Polls the
// user's inbox, shows an unread badge, and lets them accept space invites (which
// joins the space) or dismiss a notification. Opening the panel clears the badge.

function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function NotificationsBell({ onJoined }: { onJoined?: (spaceId: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notif[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      setItems(await listNotifications())
    } catch {
      /* offline / not signed in — leave the bell empty */
    }
  }, [])

  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), 30000)
    return () => window.clearInterval(t)
  }, [load])

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  const unread = items.filter((n) => !n.read).length

  const toggle = async (): Promise<void> => {
    const willOpen = !open
    setOpen(willOpen)
    if (willOpen) {
      setErr('')
      await load()
      if (items.some((n) => !n.read)) {
        try {
          await markAllNotifsRead()
        } catch {
          /* best-effort */
        }
        setItems((xs) => xs.map((n) => ({ ...n, read: true })))
      }
    }
  }

  const onAccept = async (n: Notif): Promise<void> => {
    setBusyId(n.id)
    setErr('')
    try {
      const spaceId = await acceptInvite(n)
      await load()
      setOpen(false)
      onJoined?.(spaceId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not join')
    } finally {
      setBusyId(null)
    }
  }

  const onDismiss = async (n: Notif): Promise<void> => {
    setItems((xs) => xs.filter((x) => x.id !== n.id))
    try {
      await deleteNotif(n.id)
    } catch {
      /* best-effort */
    }
  }

  return (
    <div style={css('position:relative;flex:none')} onClick={(e) => e.stopPropagation()}>
      <div onClick={() => void toggle()} style={css('position:relative;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.07);border-radius:9px;cursor:pointer', open ? 'background:rgba(255,255,255,.06)' : '')}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#B9B9CC" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && (
          <span style={css('position:absolute;top:5px;right:5px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:#FF6B6B;color:#fff;font-size:9.5px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #0C0C10')}>{unread > 9 ? '9+' : unread}</span>
        )}
      </div>
      {open && (
        <div style={css('position:absolute;right:0;top:calc(100% + 8px);width:328px;max-height:420px;overflow-y:auto;background:#101015;border:1px solid rgba(255,255,255,.1);border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,.6);z-index:40')}>
          <div style={css('display:flex;align-items:center;gap:8px;padding:14px 16px 12px;border-bottom:1px solid rgba(255,255,255,.06)')}>
            <span style={css('font-size:14px;font-weight:600')}>Notifications</span>
            <div style={css('flex:1')} />
            {items.length > 0 && <span onClick={() => { void deleteAll(items, setItems) }} style={css('font-size:11.5px;color:#7A7A8C;cursor:pointer')}>Clear all</span>}
          </div>
          {err ? <div style={css('padding:10px 16px;font-size:12px;color:#FF9B9B')}>{err}</div> : null}
          {items.length === 0 ? (
            <div style={css('padding:34px 16px;text-align:center;color:#6E6E85;font-size:12.5px')}>You&rsquo;re all caught up.</div>
          ) : (
            <div style={css('padding:6px')}>
              {items.map((n) => (
                <div key={n.id} style={css('padding:11px 12px;border-radius:10px;display:flex;flex-direction:column;gap:8px', n.read ? '' : 'background:rgba(124,107,255,.07)')}>
                  <div style={css('display:flex;align-items:flex-start;gap:9px')}>
                    <div style={css('width:28px;height:28px;flex:none;border-radius:8px;background:rgba(124,107,255,.14);display:flex;align-items:center;justify-content:center')}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#A99BFF" strokeWidth="1.4"><circle cx="6" cy="5" r="2.4" /><path d="M2 13c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6" /><path d="M11 4.2a2.2 2.2 0 0 1 0 4.1M14 13c0-1.9-1.2-3.2-2.8-3.5" /></svg>
                    </div>
                    <div style={css('flex:1;min-width:0')}>
                      <div style={css('font-size:12.5px;color:#DDDDE8;line-height:1.4')}>{n.message || 'You have a new notification'}</div>
                      <div style={css('font-size:10.5px;color:#7A7A8C;margin-top:3px')}>{relTime(n.created_at)}</div>
                    </div>
                    <span onClick={() => void onDismiss(n)} style={css('cursor:pointer;color:#5C5C70;font-size:12px;flex:none')} title="Dismiss">✕</span>
                  </div>
                  {n.kind === 'space_invite' && n.join_key ? (
                    <div style={css('display:flex;gap:8px;padding-left:37px')}>
                      <button onClick={() => void onAccept(n)} disabled={busyId === n.id} style={css('background:#7C6BFF;border:none;color:#fff;font-family:inherit;font-size:12px;font-weight:600;padding:6px 14px;border-radius:8px;cursor:pointer', busyId === n.id ? 'opacity:.6' : '')}>{busyId === n.id ? 'Joining…' : 'Join space'}</button>
                    </div>
                  ) : (n.kind === 'join_approved' || n.kind === 'join_request') && n.space_id ? (
                    <div style={css('display:flex;gap:8px;padding-left:37px')}>
                      <button onClick={() => { onJoined?.(n.space_id as string); setOpen(false) }} style={css('background:rgba(124,107,255,.16);border:1px solid rgba(124,107,255,.32);color:#C4BAFF;font-family:inherit;font-size:12px;font-weight:600;padding:6px 14px;border-radius:8px;cursor:pointer')}>{n.kind === 'join_approved' ? 'Open space' : 'Review request'}</button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

async function deleteAll(items: Notif[], setItems: (xs: Notif[]) => void): Promise<void> {
  setItems([])
  await Promise.all(items.map((n) => deleteNotif(n.id).catch(() => undefined)))
}
