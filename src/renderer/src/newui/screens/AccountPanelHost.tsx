// Global mount for the account / upgrade panel, so it's reachable from ANY
// screen — the dashboard, the editor, the mobile shells — not just wherever a
// particular screen happens to render it. It registers the opener; anything in
// the app can then raise the panel via openAccountPanel(reason). Two key cases:
// (1) a free-trial user runs out of AI runs mid-edit (stt.ts calls
// openAccountPanel('trial')); (2) the buyer returns from Stripe's hosted checkout
// to ?checkout=success, and we reopen the panel to confirm + poll until the
// webhook flips Pro on.
import { useEffect, useState } from 'react'
import AccountModal from './AccountModal'
import { registerAccountPanel, consumeCheckoutReturn, type AccountReason } from '../../cloud/subscription'

export default function AccountPanelHost(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<AccountReason>(null)

  useEffect(() => {
    registerAccountPanel((r) => {
      setReason(r)
      setOpen(true)
    })
    // Back from Stripe checkout? Reopen the panel to confirm the upgrade.
    if (consumeCheckoutReturn() === 'success') {
      setReason('success')
      setOpen(true)
    }
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
