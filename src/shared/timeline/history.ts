// Undo/redo over document snapshots. Because every edit produces an immutable
// document with structural sharing (unchanged tracks/clips keep their identity),
// snapshotting is cheap and undo is exact — no fragile hand-written inverses.

import type { TimelineDocument } from './types'

interface Entry {
  doc: TimelineDocument
  label: string
}

export class History {
  private past: Entry[] = []
  private future: Entry[] = []
  private present: TimelineDocument
  private readonly limit: number

  constructor(initial: TimelineDocument, limit = 200) {
    this.present = initial
    this.limit = limit
  }

  /** Record a new present, produced by a command with `label`. Clears the redo stack. */
  push(doc: TimelineDocument, label: string): void {
    this.past.push({ doc: this.present, label })
    if (this.past.length > this.limit) this.past.shift()
    this.present = doc
    this.future = []
  }

  canUndo(): boolean {
    return this.past.length > 0
  }

  canRedo(): boolean {
    return this.future.length > 0
  }

  undo(): TimelineDocument | null {
    const prev = this.past.pop()
    if (!prev) return null
    this.future.push({ doc: this.present, label: prev.label })
    this.present = prev.doc
    return this.present
  }

  redo(): TimelineDocument | null {
    const next = this.future.pop()
    if (!next) return null
    this.past.push({ doc: this.present, label: next.label })
    this.present = next.doc
    return this.present
  }

  reset(doc: TimelineDocument): void {
    this.past = []
    this.future = []
    this.present = doc
  }

  /** Labels of the next undo/redo actions, for menu/tooltip display. */
  labels(): { undo: string | null; redo: string | null } {
    return {
      undo: this.past.length ? this.past[this.past.length - 1].label : null,
      redo: this.future.length ? this.future[this.future.length - 1].label : null
    }
  }
}
