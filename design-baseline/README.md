# Design baseline snapshot

Frozen copy of `src/renderer/src/styles.css` as of commit **d37f8d0** (branch base of
`ui/easecut-redesign`, == `backup/easecut-stable-v3`), taken before the Easecut premium
redesign began.

Purpose: reference/rollback baseline for the legacy UI. This file is **not imported**
anywhere and is not bundled. The live legacy stylesheet remains `src/renderer/src/styles.css`,
which the redesign does **not** modify — all new-UI styles live in `src/renderer/src/design/*.css`
scoped under `:root[data-ec-ui="new"]` and are gated by `VITE_NEW_EASECUT_UI=true`.
