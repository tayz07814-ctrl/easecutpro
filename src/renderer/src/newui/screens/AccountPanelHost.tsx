// Global mount for the account / upgrade panel, so it's reachable from ANY
// screen — the dashboard, the editor, the mobile shells — not just wherever a
// particular screen happens to render it. It registers the opener; anything in
// the app can then raise the panel via openAccountPanel(reason). The key case:
// when a free-trial user runs out of AI runs mid-edit (enforced in the stt edge
// function), stt.ts calls openAccountPanel('trial') and the upgrade panel comes
// up right there in the editor instead of silently doing nothing.
import { useEffect, useState } from 'react'
import AccountModal from './AccountModal'
import { registerAccountPanel } from '../../cloud/subscription'

export default function AccountPanelHost(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<'trial' | null>(null)

  useEffect(() => {
    registerAccountPanel((r) => {
      setReason(r)
      setOpen(true)
    })
    return () => registerAccountPanel(null)
  }, [])

  return (
    <AccountModal
      open={open}
      reason={reason}
      onClose={() => {
        setOpen(false)
        setReason(null)
      }}
    />
  )
}
