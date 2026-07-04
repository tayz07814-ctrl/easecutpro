// A process-wide handle to the live TimelineEngine so that components OUTSIDE the
// timeline tree (the preview, export) can read and edit the same authoritative
// document. TimelinePanel owns the engine and registers it here on mount; the
// preview subscribes through the hooks below. Kept intentionally tiny — no logic,
// just a shared reference + React bindings.

import { useSyncExternalStore } from 'react'
import type { TimelineEngine, EngineSnapshot } from '@shared/timeline/engine'

let shared: TimelineEngine | null = null
const listeners = new Set<() => void>()

/** TimelinePanel calls this on mount (and null on unmount). */
export function setSharedEngine(engine: TimelineEngine | null): void {
  shared = engine
  for (const l of listeners) l()
}

export function getSharedEngine(): TimelineEngine | null {
  return shared
}

const NOOP_UNSUB = (): void => undefined

/** Reactive current engine (re-renders when the engine is (un)registered). */
export function useSharedEngine(): TimelineEngine | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => shared,
    () => shared
  )
}

/** Reactive snapshot of the shared engine's document/session, or null if none. */
export function useSharedEngineSnapshot(): EngineSnapshot | null {
  const engine = useSharedEngine()
  return useSyncExternalStore(
    engine ? engine.subscribe : () => NOOP_UNSUB,
    engine ? engine.getSnapshot : () => null,
    () => null
  )
}
