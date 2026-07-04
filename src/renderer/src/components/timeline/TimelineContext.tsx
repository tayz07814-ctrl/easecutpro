// React binding for the framework-agnostic TimelineEngine. The engine is the
// store; components subscribe with useSyncExternalStore and read the snapshot.
// No business logic lives here — this is purely the plumbing.

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { TimelineEngine, type EngineSnapshot } from '@shared/timeline/engine'

const EngineContext = createContext<TimelineEngine | null>(null)

export function TimelineProvider({
  engine,
  children
}: {
  engine: TimelineEngine
  children: ReactNode
}): JSX.Element {
  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>
}

export function useEngine(): TimelineEngine {
  const engine = useContext(EngineContext)
  if (!engine) throw new Error('useEngine must be used within a <TimelineProvider>')
  return engine
}

/** Subscribe to the whole engine snapshot (document + session). */
export function useTimeline(): EngineSnapshot {
  const engine = useEngine()
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot)
}
