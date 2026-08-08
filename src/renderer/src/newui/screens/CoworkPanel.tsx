import { useCallback, useEffect, useState } from 'react'
import { css } from '../css'
import { useStore, makeXferReporter } from '../../store'
import { listProjects, getProject } from '../../projectsApi'
import { hydrateProjectMedia } from '../../webapi'
import {
  me,
  setUsername,
  listSpaces,
  createSpace,
  ensureDefaultSpace,
  deleteSpace,
  renameSpace,
  listMembers,
  inviteMember,
  removeMember,
  requestJoinByKey,
  listJoinRequests,
  decideJoinRequest,
  regenerateJoinKey,
  listSpaceProjects,
  spaceUsage,
  shareProject,
  listSpaceFolders,
  createSpaceFolder,
  renameSpaceFolder,
  deleteSpaceFolder,
  moveSpaceProjectToFolder,
  fmtBytes,
  GiB,
  type Space,
  type Member,
  type JoinRequest,
  type SpaceFolder,
  type CoworkProject
} from '../../cloud/cowork'
import FolderRail, { projectDragType } from './FolderRail'
import { ecPrompt } from '../../ui/ecPrompt'

// Screen — Cloud Cowork. Shown in the Dashboard when the "Cloud cowork" nav is
// selected. Spaces (100 GB free each) hold shared projects; every member can
// open a project, edit it, and their edits save back to R2 as their own version.
// Files live in Cloudflare R2 (via the r2-sign edge function); this panel only
// talks to the Supabase metadata tables + the cowork data layer.

const HAIR = 'rgba(255,255,255,.07)'
const CARD = 'background:#101015;border:1px solid rgba(255,255,255,.07);border-radius:14px'

function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
function avatarText(name: string): string {
  return (name.replace(/[^a-zA-Z]/g, '').slice(0, 2) || 'M').toUpperCase()
}

export default function CoworkPanel(): JSX.Element {
  const openCoworkProject = useStore((s) => s.openCoworkProject)

  const [uid, setUid] = useState('')
  const [myUsername, setMyUsername] = useState('')
  const [spaces, setSpaces] = useState<Space[]>([])
  const [spaceId, setSpaceId] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')

  const [usage, setUsage] = useState<{ used: number; quota: number }>({ used: 0, quota: 100 * GiB })
  const [members, setMembers] = useState<Member[]>([])
  const [requests, setRequests] = useState<JoinRequest[]>([])
  const [projects, setProjects] = useState<CoworkProject[]>([])
  const [folders, setFolders] = useState<SpaceFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)

  const [inviteId, setInviteId] = useState('')
  const [joinKeyInput, setJoinKeyInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [busy, setBusy] = useState('')
  const [membersOpen, setMembersOpen] = useState(false)
  const [sharePick, setSharePick] = useState(false)
  const [localProjects, setLocalProjects] = useState<{ id: string; name: string }[]>([])

  const space = spaces.find((s) => s.id === spaceId) || null
  const isOwner = !!space && space.owner_id === uid

  // ---- initial load: identity + spaces (create a default one if none) --------
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const [who, sp] = await Promise.all([me(), ensureDefaultSpace()])
        if (!live) return
        setUid(who.id)
        setMyUsername(who.username)
        setSpaces(sp)
        setSpaceId((prev) => prev || sp[0]?.id || '')
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : 'Failed to load spaces')
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  // Prefill the join key from a shared invite link (?join=KEY).
  useEffect(() => {
    try {
      const k = new URLSearchParams(window.location.search).get('join')
      if (k) setJoinKeyInput(k.trim())
    } catch {
      /* no-op */
    }
  }, [])

  // ---- per-space load: usage + members + projects ----------------------------
  const reloadSpace = useCallback(async (id: string) => {
    if (!id) return
    try {
      // listJoinRequests returns [] for non-owners (RPC guards on ownership),
      // so it's safe to call unconditionally.
      const [u, m, p, r, f] = await Promise.all([
        spaceUsage(id),
        listMembers(id),
        listSpaceProjects(id),
        listJoinRequests(id).catch(() => [] as JoinRequest[]),
        listSpaceFolders(id).catch(() => [] as SpaceFolder[])
      ])
      setUsage(u)
      setMembers(m)
      setProjects(p)
      useStore.getState().setCoworkCount(p.length)
      setRequests(r)
      setFolders(f)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load space')
    }
  }, [])

  // reset the open folder when switching spaces
  useEffect(() => {
    setSelectedFolder(null)
  }, [spaceId])

  useEffect(() => {
    void reloadSpace(spaceId)
  }, [spaceId, reloadSpace])

  const reloadSpaces = useCallback(async () => {
    const sp = await listSpaces()
    setSpaces(sp)
    return sp
  }, [])

  // ---- actions ---------------------------------------------------------------
  const onNewSpace = async (): Promise<void> => {
    const name = await ecPrompt('Name your new space', '', 'Create')
    if (name == null) return
    setBusy('Creating space…')
    try {
      const s = await createSpace(name)
      await reloadSpaces()
      setSpaceId(s.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create space')
    } finally {
      setBusy('')
    }
  }

  const onDeleteSpace = async (): Promise<void> => {
    if (!space || !isOwner) return
    if (!window.confirm(`Delete “${space.name}” and everything in it? This cannot be undone.`)) return
    setBusy('Deleting space…')
    try {
      await deleteSpace(space.id)
      const sp = await reloadSpaces()
      setSpaceId(sp[0]?.id || '')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete space')
    } finally {
      setBusy('')
    }
  }

  const onRenameSpace = async (): Promise<void> => {
    if (!space || !isOwner) return
    const next = await ecPrompt('Rename this space', space.name, 'Rename')
    if (next == null) return
    const name = next.trim()
    if (!name || name === space.name) return
    setBusy('Renaming space…')
    setErr('')
    setNotice('')
    try {
      await renameSpace(space.id, name)
      await reloadSpaces()
      setNotice('Space renamed.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not rename the space')
    } finally {
      setBusy('')
    }
  }

  const onInvite = async (): Promise<void> => {
    if (!spaceId || !inviteId.trim()) return
    setBusy('Sending invite…')
    setErr('')
    setNotice('')
    try {
      const who = inviteId.trim()
      await inviteMember(spaceId, who)
      setInviteId('')
      setNotice(`Invite sent to ${who} — they'll see it in their in-app notifications.`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send invite')
    } finally {
      setBusy('')
    }
  }

  const onRequestJoin = async (): Promise<void> => {
    if (!joinKeyInput.trim()) return
    setBusy('Sending request…')
    setErr('')
    setNotice('')
    try {
      const res = await requestJoinByKey(joinKeyInput)
      setJoinKeyInput('')
      if (res === 'already_member') setNotice('You’re already a member of that space.')
      else if (res === 'pending') setNotice('You already have a request waiting for approval.')
      else setNotice('Request sent — the space owner needs to approve you before you can join.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send the request')
    } finally {
      setBusy('')
    }
  }

  const onDecideRequest = async (req: JoinRequest, approve: boolean): Promise<void> => {
    if (!spaceId) return
    setBusy(approve ? 'Approving…' : 'Declining…')
    setErr('')
    setNotice('')
    try {
      await decideJoinRequest(req.id, approve)
      await reloadSpace(spaceId)
      setNotice(approve ? `${req.username ? '@' + req.username : req.name} was added to the space.` : 'Request declined.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update the request')
    } finally {
      setBusy('')
    }
  }

  const onRegenKey = async (): Promise<void> => {
    if (!space || !isOwner) return
    if (!window.confirm('Generate a new space key? The old key will stop working immediately.')) return
    setBusy('Generating new key…')
    setErr('')
    setNotice('')
    try {
      await regenerateJoinKey(space.id)
      await reloadSpaces()
      setNotice('New space key generated.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not regenerate the key')
    } finally {
      setBusy('')
    }
  }

  const onEditUsername = async (): Promise<void> => {
    const next = await ecPrompt('Choose your username (3–24 chars: letters, numbers, _ or .)', myUsername, 'Save')
    if (next == null) return
    setBusy('Saving username…')
    setErr('')
    try {
      await setUsername(next)
      setMyUsername(next.trim().replace(/^@/, ''))
      await reloadSpace(spaceId)
      setNotice('Username updated.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update username')
    } finally {
      setBusy('')
    }
  }

  const onCopyKey = async (): Promise<void> => {
    if (!space?.join_key) return
    try {
      await navigator.clipboard.writeText(space.join_key)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the key is visible to copy manually */
    }
  }

  // Shareable invite link — opening it prefills the space key so the recipient
  // just clicks "Request to join" (owner still approves). Works anywhere the
  // owner can paste a link (chat, email, etc.), no server email needed.
  const inviteLink = space?.join_key
    ? `${window.location.origin}${window.location.pathname}?join=${space.join_key}`
    : ''
  const onCopyInviteLink = async (): Promise<void> => {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopiedLink(true)
      window.setTimeout(() => setCopiedLink(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }

  const onRemoveMember = async (userId: string): Promise<void> => {
    if (!spaceId) return
    setBusy('Removing member…')
    try {
      await removeMember(spaceId, userId)
      await reloadSpace(spaceId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not remove member')
    } finally {
      setBusy('')
    }
  }

  const openSharePicker = async (): Promise<void> => {
    setSharePick(true)
    try {
      const metas = await listProjects()
      setLocalProjects(metas.map((m) => ({ id: m.id, name: m.name })))
    } catch {
      setLocalProjects([])
    }
  }

  const onShare = async (projectId: string, name: string): Promise<void> => {
    if (!spaceId) return
    setSharePick(false)
    setErr('')
    setNotice('')
    setBusy('Preparing media…')
    try {
      const rec = await getProject(projectId)
      if (!rec?.project) throw new Error('Could not load that project')
      await hydrateProjectMedia(rec.project)
      setBusy('')
      // Per-file byte progress shows in the right-side transfer dock (store-backed),
      // so a long upload keeps reporting even if the user clicks around.
      await shareProject(spaceId, rec.project, name, makeXferReporter(), selectedFolder)
      await reloadSpace(spaceId)
      setNotice(`“${name}” uploaded to the space.`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not share project')
    } finally {
      setBusy('')
    }
  }

  const onOpen = async (cp: CoworkProject): Promise<void> => {
    setBusy('Opening…')
    try {
      await openCoworkProject(cp, null, (s) => setBusy(s))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not open project')
      setBusy('')
    }
  }

  // ---- folders ---------------------------------------------------------------
  const onCreateFolder = async (): Promise<void> => {
    if (!spaceId) return
    const name = await ecPrompt('New folder name', '', 'Create')
    if (name == null || !name.trim()) return
    try {
      const f = await createSpaceFolder(spaceId, name)
      await reloadSpace(spaceId)
      setSelectedFolder(f.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create folder')
    }
  }
  const onRenameFolder = async (id: string, curName: string): Promise<void> => {
    const name = await ecPrompt('Rename folder', curName, 'Rename')
    if (name == null || !name.trim()) return
    try {
      await renameSpaceFolder(id, name)
      await reloadSpace(spaceId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not rename folder')
    }
  }
  const onDeleteFolder = async (id: string): Promise<void> => {
    if (!window.confirm('Delete this folder? Projects inside move back to All projects.')) return
    try {
      await deleteSpaceFolder(id)
      if (selectedFolder === id) setSelectedFolder(null)
      await reloadSpace(spaceId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete folder')
    }
  }
  const onMoveProject = async (folderId: string | null, projectId: string): Promise<void> => {
    setProjects((ps) => ps.map((p) => (p.id === projectId ? { ...p, folder_id: folderId } : p))) // optimistic
    try {
      await moveSpaceProjectToFolder(projectId, folderId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not move project')
      await reloadSpace(spaceId)
    }
  }

  // ---- render ----------------------------------------------------------------
  if (loading) {
    return <div style={css('padding:60px 0;text-align:center;color:#6E6E85;font-size:13px')}>Loading your spaces…</div>
  }

  const pct = usage.quota ? Math.min(100, (usage.used / usage.quota) * 100) : 0
  const near = pct >= 90
  const folderCounts = { all: projects.length, byId: {} as Record<string, number> }
  for (const p of projects) if (p.folder_id) folderCounts.byId[p.folder_id] = (folderCounts.byId[p.folder_id] || 0) + 1
  const visibleProjects = selectedFolder ? projects.filter((p) => (p.folder_id ?? null) === selectedFolder) : projects

  return (
    <div style={css('display:flex;flex-direction:column;gap:16px')} onClick={() => { setSharePick(false); setMembersOpen(false) }}>
      {/* header: title + space selector (+rename) + storage chip + members dropdown + actions */}
      <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap')}>
        <h1 style={css('margin:0;font-size:19px;font-weight:600;letter-spacing:-.02em')}>Cloud cowork</h1>
        {spaces.length > 0 && (
          <select
            value={spaceId}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => { setSpaceId(e.target.value); setMembersOpen(false) }}
            style={css('background:#111116;color:#EDEDF2;border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px 11px;font-size:13px;font-family:inherit;outline:none;cursor:pointer')}
          >
            {spaces.map((s) => (
              <option key={s.id} value={s.id} style={css('background:#111116')}>{s.name}</option>
            ))}
          </select>
        )}
        {isOwner && space && (
          <span onClick={(e) => { e.stopPropagation(); void onRenameSpace() }} title="Rename this space" style={css('cursor:pointer;color:#8B8BA0;display:flex;align-items:center;padding:7px;border:1px solid rgba(255,255,255,.1);border-radius:8px')}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 13.5V16h2.5l7.4-7.4-2.5-2.5L4 13.5z" /><path d="M12.5 5.1l2.4 2.4" /></svg>
          </span>
        )}
        <div style={css('flex:1')} />

        {/* compact storage chip — small bar + % in the corner */}
        {space && (
          <div title={`${fmtBytes(usage.used)} of ${fmtBytes(usage.quota)} used`} style={css('display:flex;align-items:center;gap:7px;padding:6px 10px;border:1px solid rgba(255,255,255,.1);border-radius:9px;background:#111116')}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={near ? '#E6B26A' : '#8B8BA0'} strokeWidth="1.5"><path d="M2 5.5C2 4 4.7 3 8 3s6 1 6 2.5" /><path d="M2 5.5v5C2 12 4.7 13 8 13s6-1 6-2.5v-5" /><path d="M2 8c0 1.5 2.7 2.5 6 2.5s6-1 6-2.5" /></svg>
            <div style={css('width:42px;height:5px;background:rgba(255,255,255,.09);border-radius:3px;overflow:hidden')}>
              <div style={css(`width:${pct}%;height:100%;border-radius:3px;background:${near ? '#E6B26A' : '#7C6BFF'}`)} />
            </div>
            <span style={css(`font-family:'Geist Mono',monospace;font-size:11px;color:${near ? '#E6B26A' : '#8B8BA0'}`)}>{Math.round(pct)}%</span>
          </div>
        )}

        {/* members dropdown — list + space key + requests + invite live here */}
        {space && (
          <div style={css('position:relative')} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setMembersOpen((o) => !o)} style={css('display:flex;align-items:center;gap:7px;background:#111116;border:1px solid rgba(255,255,255,.1);color:#EDEDF2;font-family:inherit;font-size:12.5px;padding:8px 12px;border-radius:9px;cursor:pointer', membersOpen ? 'border-color:rgba(124,107,255,.5)' : '')}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#B9B9CC" strokeWidth="1.4"><circle cx="6" cy="5" r="2.4" /><path d="M2 13c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6" /><path d="M11 4.2a2.2 2.2 0 0 1 0 4.1M14 13c0-1.9-1.2-3.2-2.8-3.5" /></svg>
              <span>Members</span>
              <span style={css("font-family:'Geist Mono',monospace;font-size:11px;color:#8B8BA0")}>{members.length}</span>
              {isOwner && requests.length > 0 && (
                <span style={css('min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#FF6B6B;color:#fff;font-size:9.5px;font-weight:700;display:flex;align-items:center;justify-content:center')}>{requests.length}</span>
              )}
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#8B8BA0" strokeWidth="1.6" style={css(membersOpen ? 'transform:rotate(180deg)' : '')}><path d="M3 4.5L6 7.5 9 4.5" /></svg>
            </button>
            {membersOpen && (
              <div style={css('position:absolute;right:0;top:calc(100% + 8px);width:344px;max-height:72vh;overflow-y:auto;background:#141419;border:1px solid rgba(255,255,255,.1);border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,.6);z-index:30;padding:14px')}>
                {/* pending join requests — owner approves or declines each */}
                {isOwner && requests.length > 0 && (
                  <div style={css('margin-bottom:14px;padding:12px 13px;background:rgba(124,107,255,.07);border:1px solid rgba(124,107,255,.22);border-radius:11px')}>
                    <div style={css('font-size:12.5px;font-weight:600;color:#C4BAFF;margin-bottom:10px')}>{requests.length} request{requests.length > 1 ? 's' : ''} to join</div>
                    <div style={css('display:flex;flex-direction:column;gap:9px')}>
                      {requests.map((r) => (
                        <div key={r.id} style={css('display:flex;align-items:center;gap:10px')}>
                          <div style={css('width:26px;height:26px;flex:none;border-radius:50%;background:#2A2A34;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#C9C9DA')}>{avatarText(r.username || r.name)}</div>
                          <div style={css('flex:1;min-width:0')}>
                            <div style={css('font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{r.username ? `@${r.username}` : r.name}</div>
                            <div style={css('font-size:10.5px;color:#7A7A8C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{relTime(r.created_at)}</div>
                          </div>
                          <button onClick={() => void onDecideRequest(r, true)} style={css('background:#7C6BFF;border:none;color:#fff;font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:7px;cursor:pointer')}>Approve</button>
                          <button onClick={() => void onDecideRequest(r, false)} style={css('background:transparent;border:1px solid rgba(255,255,255,.14);color:#B7B7C6;font-family:inherit;font-size:11.5px;padding:5px 9px;border-radius:7px;cursor:pointer')}>Decline</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* member list */}
                <div style={css('display:flex;flex-direction:column;gap:9px')}>
                  {members.map((m) => (
                    <div key={m.user_id} style={css('display:flex;align-items:center;gap:10px')}>
                      <div style={css('width:28px;height:28px;flex:none;border-radius:50%;background:#2A2A34;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;color:#C9C9DA')}>{avatarText(m.username || m.name)}</div>
                      <div style={css('flex:1;min-width:0')}>
                        <div style={css('font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{m.username ? `@${m.username}` : m.name}{m.user_id === uid ? ' (you)' : ''}</div>
                        <div style={css('font-size:10.5px;color:#7A7A8C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{m.email || m.name}</div>
                      </div>
                      <span style={css('font-size:10px;padding:3px 7px;border-radius:20px;background:rgba(124,107,255,.14);color:#C4BAFF;text-transform:capitalize')}>{m.role}</span>
                      {isOwner && m.role !== 'owner' && (
                        <span onClick={() => void onRemoveMember(m.user_id)} style={css('cursor:pointer;color:#6E6E85;font-size:13px;padding:2px 3px')} title="Remove from space">✕</span>
                      )}
                    </div>
                  ))}
                </div>

                {/* shareable space key */}
                <div style={css('margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07)')}>
                  <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:9px')}>
                    <span style={css('font-size:11.5px;color:#8B8BA0')}>Space key</span>
                    <span style={css("font-family:'Geist Mono',monospace;font-size:12px;letter-spacing:.08em;color:#C4BAFF;background:rgba(124,107,255,.12);border:1px solid rgba(124,107,255,.28);border-radius:7px;padding:4px 9px")}>{space.join_key}</span>
                  </div>
                  <div style={css('display:flex;gap:7px;flex-wrap:wrap')}>
                    <span onClick={() => void onCopyKey()} style={css('cursor:pointer;color:#9A9AAE;font-size:11.5px;border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:5px 10px')}>{copied ? 'Copied' : 'Copy key'}</span>
                    <span onClick={() => void onCopyInviteLink()} title="Copy an invite link that prefills this key" style={css('cursor:pointer;color:#9A9AAE;font-size:11.5px;border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:5px 10px')}>{copiedLink ? 'Link copied' : 'Copy link'}</span>
                    {isOwner && (
                      <span onClick={() => void onRegenKey()} title="Generate a new key (invalidates the old one)" style={css('cursor:pointer;color:#9A9AAE;font-size:11.5px;border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:5px 10px')}>New key</span>
                    )}
                  </div>
                </div>

                {/* invite (owner) */}
                {isOwner && (
                  <div style={css('margin-top:14px')}>
                    <div style={css('display:flex;gap:8px')}>
                      <input
                        value={inviteId}
                        onChange={(e) => setInviteId(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void onInvite() }}
                        placeholder="Invite by @username or email"
                        style={css('flex:1;min-width:0;font-size:12.5px;color:#EDEDF2;background:#0C0C10;border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:8px 10px;font-family:inherit;outline:none')}
                      />
                      <button onClick={() => void onInvite()} style={css('background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:#EDEDF2;font-family:inherit;font-size:12px;font-weight:500;padding:8px 13px;border-radius:9px;cursor:pointer;white-space:nowrap')}>Invite</button>
                    </div>
                    <div style={css('font-size:10.5px;color:#6E6E85;margin-top:7px;line-height:1.45')}>
                      Invites land in the app for people who already have an EaseCut account (no email is sent). For anyone else, use Copy link.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {isOwner && space && (
          <button onClick={(e) => { e.stopPropagation(); void onDeleteSpace() }} style={css('background:transparent;border:1px solid rgba(255,255,255,.12);color:#FF9B9B;font-family:inherit;font-size:12.5px;padding:8px 12px;border-radius:9px;cursor:pointer')}>Delete</button>
        )}
        <button onClick={(e) => { e.stopPropagation(); void onNewSpace() }} style={css('background:#7C6BFF;border:none;color:#fff;font-family:inherit;font-size:13px;font-weight:600;padding:9px 15px;border-radius:9px;cursor:pointer;box-shadow:0 4px 16px rgba(124,107,255,.3)')}>New space</button>
      </div>

      {(err || busy || notice) && (
        <div style={css(
          `${CARD};padding:11px 14px;font-size:12.5px;display:flex;align-items:center;gap:9px`,
          err ? 'border-color:rgba(255,155,155,.35);color:#FF9B9B' : notice ? 'border-color:rgba(126,214,166,.32);color:#7ED6A6' : 'color:#A99BFF'
        )}>
          {busy && !err && !notice ? <span style={css('width:6px;height:6px;border-radius:50%;background:#A99BFF;animation:ecPulse 1.4s infinite')} /> : null}
          <span style={css('flex:1')}>{err || busy || notice}</span>
          {err || notice ? <span onClick={() => { setErr(''); setNotice('') }} style={css('cursor:pointer;color:#9A9AAE')}>✕</span> : null}
        </div>
      )}

      {/* identity + join-by-key */}
      <div style={css(`${CARD};padding:13px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap`)}>
        <div style={css('display:flex;align-items:center;gap:8px')}>
          <span style={css('font-size:12.5px;color:#8B8BA0')}>You are</span>
          <span style={css('font-size:13px;font-weight:600;color:#C4BAFF')}>@{myUsername || '…'}</span>
          <span onClick={() => void onEditUsername()} style={css('cursor:pointer;color:#7A7A8C;font-size:12px;border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:3px 8px')}>Edit</span>
        </div>
        <div style={css('flex:1;min-width:20px')} />
        <div style={css('display:flex;align-items:center;gap:8px')}>
          <input
            value={joinKeyInput}
            onChange={(e) => setJoinKeyInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onRequestJoin() }}
            placeholder="Enter a space key"
            style={css("width:150px;font-size:13px;color:#EDEDF2;background:#0C0C10;border:1px solid rgba(255,255,255,.1);border-radius:9px;padding:9px 11px;font-family:'Geist Mono',monospace;letter-spacing:.06em;outline:none")}
          />
          <button onClick={() => void onRequestJoin()} title="Sends a request the space owner must approve" style={css('background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:#EDEDF2;font-family:inherit;font-size:12.5px;font-weight:500;padding:9px 15px;border-radius:9px;cursor:pointer;white-space:nowrap')}>Request to join</button>
        </div>
      </div>

      {!space ? (
        <div style={css('padding:50px 0;text-align:center;color:#6E6E85;font-size:13px')}>No space selected.</div>
      ) : (
        /* center area — projects only */
        <div style={css(`${CARD};padding:16px 18px;min-height:380px`)}>
            <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:14px;position:relative')}>
              <span style={css('font-size:14px;font-weight:600')}>Projects</span>
              <span style={css("font-family:'Geist Mono',monospace;font-size:11px;color:#6E6E85")}>{projects.length}</span>
              <div style={css('flex:1')} />
              <button onClick={(e) => { e.stopPropagation(); void openSharePicker() }} style={css('background:rgba(124,107,255,.14);border:1px solid rgba(124,107,255,.3);color:#C4BAFF;font-family:inherit;font-size:12.5px;font-weight:500;padding:8px 13px;border-radius:9px;cursor:pointer;white-space:nowrap')}>Add a project</button>
              {sharePick && (
                <div onClick={(e) => e.stopPropagation()} style={css('position:absolute;right:0;top:calc(100% + 6px);width:280px;max-height:300px;overflow-y:auto;background:#191920;border:1px solid rgba(255,255,255,.1);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:6px;z-index:8')}>
                  <div style={css('padding:7px 10px 8px;font-size:11px;color:#7A7A8C')}>Send a local project to this space</div>
                  {localProjects.length === 0 ? (
                    <div style={css('padding:8px 10px;font-size:12.5px;color:#6E6E85')}>No local projects to share.</div>
                  ) : (
                    localProjects.map((p) => (
                      <div key={p.id} onClick={() => void onShare(p.id, p.name)} style={css('padding:8px 10px;font-size:13px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{p.name}</div>
                    ))
                  )}
                </div>
              )}
            </div>
            {/* folders (shared across members) + project list */}
            <div style={css('display:flex;gap:18px;align-items:flex-start')}>
              <FolderRail
                folders={folders}
                selected={selectedFolder}
                counts={folderCounts}
                onSelect={setSelectedFolder}
                onCreate={() => void onCreateFolder()}
                onRename={(id, name) => void onRenameFolder(id, name)}
                onDelete={(id) => void onDeleteFolder(id)}
                onDropProject={(fid, pid) => void onMoveProject(fid, pid)}
              />
              <div style={css('flex:1;min-width:0')}>
                {visibleProjects.length === 0 ? (
                  <div style={css('padding:26px 0;text-align:center;color:#6E6E85;font-size:12.5px')}>
                    {selectedFolder
                      ? 'This folder is empty — drag a project here to file it.'
                      : 'No shared projects yet — “Add a project” to send one here.'}
                  </div>
                ) : (
                  <div style={css('display:flex;flex-direction:column;gap:9px')}>
                    {visibleProjects.map((p) => (
                      <div
                        key={p.id}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData(projectDragType, p.id); e.dataTransfer.effectAllowed = 'move' }}
                        style={css('display:flex;align-items:center;gap:12px;background:#0E0E12;border:1px solid rgba(255,255,255,.06);border-radius:11px;padding:12px 14px;cursor:grab')}
                      >
                        <div style={css('width:34px;height:34px;flex:none;border-radius:9px;background:rgba(124,107,255,.14);display:flex;align-items:center;justify-content:center')}>
                          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#A99BFF" strokeWidth="1.6"><rect x="2.5" y="4" width="15" height="12" rx="2" /><path d="M8.5 8.5v3l3-1.5z" fill="#A99BFF" /></svg>
                        </div>
                        <div style={css('flex:1;min-width:0')}>
                          <div style={css('font-size:13.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{p.name}</div>
                          <div style={css('font-size:11px;color:#7A7A8C')}>{fmtBytes(p.media_bytes)} · {relTime(p.updated_at)}</div>
                        </div>
                        <button onClick={() => void onOpen(p)} style={css('background:#7C6BFF;border:none;color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;padding:8px 15px;border-radius:8px;cursor:pointer;white-space:nowrap')}>Open</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
        </div>
      )}
    </div>
  )
}
