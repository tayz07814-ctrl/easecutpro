// TimelineEngine — the single source of truth the UI subscribes to.
//
// Framework-agnostic (no React, no DOM): a plain observable store holding three
// slices — the undoable `document`, the non-undoable `session` (playhead/zoom/
// settings), and transient `interaction` (selection + in-flight drag). The UI
// binds via useSyncExternalStore(engine.subscribe, engine.getSnapshot) and only
// renders state + reports pointer gestures in FRAMES. All drag/trim/snap/magnet
// decisions live here, so they are headless-testable and identical on desktop,
// web and mobile.

import type {
  Clip,
  DragKind,
  InteractionState,
  SessionState,
  TimelineDocument,
  TimelineSettings
} from './types'
import {
  createSession,
  createTimeline,
  normalizeDoc,
  findClip,
  findTrack,
  moveClipSmartInDoc,
  trimClipInInDoc,
  trimClipOutInDoc,
  magnetTrimInInDoc,
  magnetTrimOutInDoc,
  addTrackToDoc,
  createTrack,
  planDrop,
  slipClipInDoc,
  slideClipInDoc,
  rollEditInDoc,
  mainTrackId
} from './model'
import { secondsToFrames } from './time'
import { uid } from './ids'
import { collectSnapPoints, snapEdges } from './snap'
import { History } from './history'
import * as Commands from './commands'
import type { Command } from './commands'

export interface EngineSnapshot {
  doc: TimelineDocument
  session: SessionState
  interaction: InteractionState
}

type Listener = () => void

export class TimelineEngine {
  private doc: TimelineDocument
  private session: SessionState
  private interaction: InteractionState = { selection: [], drag: null }
  private clipboard: Clip[] = []
  private readonly history: History
  private snapshot: EngineSnapshot
  private readonly listeners = new Set<Listener>()

  constructor(doc?: TimelineDocument, session?: SessionState) {
    this.doc = normalizeDoc(doc ?? createTimeline())
    this.session = session ?? createSession()
    this.history = new History(this.doc)
    this.snapshot = { doc: this.doc, session: this.session, interaction: this.interaction }
  }

  // --- external-store contract (stable identities for useSyncExternalStore) ---

  getSnapshot = (): EngineSnapshot => this.snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private commit(): void {
    this.snapshot = { doc: this.doc, session: this.session, interaction: this.interaction }
    for (const l of this.listeners) l()
  }

  // --- reads ---

  get document(): TimelineDocument {
    return this.doc
  }
  get sessionState(): SessionState {
    return this.session
  }
  get interactionState(): InteractionState {
    return this.interaction
  }
  canUndo(): boolean {
    return this.history.canUndo()
  }
  canRedo(): boolean {
    return this.history.canRedo()
  }
  historyLabels(): { undo: string | null; redo: string | null } {
    return this.history.labels()
  }

  // --- undoable edits ---

  dispatch(command: Command): void {
    const next = command.apply(this.doc)
    if (next === this.doc) return
    this.doc = next
    this.history.push(next, command.label)
    this.commit()
  }

  /** Apply several commands as ONE undo step (e.g. moving a group of clips). */
  batch(label: string, commands: Command[]): void {
    let next = this.doc
    for (const c of commands) next = c.apply(next)
    if (next === this.doc) return
    this.doc = next
    this.history.push(next, label)
    this.commit()
  }

  undo(): void {
    const d = this.history.undo()
    if (!d || d === this.doc) return
    this.doc = d
    this.commit()
  }

  redo(): void {
    const d = this.history.redo()
    if (!d || d === this.doc) return
    this.doc = d
    this.commit()
  }

  // --- non-undoable session state ---

  setPlayhead(frame: number): void {
    const f = Math.max(0, Math.round(frame))
    if (f === this.session.playhead) return
    this.session = { ...this.session, playhead: f }
    this.commit()
  }

  setZoom(pxPerSec: number): void {
    const z = Math.max(1, pxPerSec)
    if (z === this.session.zoom) return
    this.session = { ...this.session, zoom: z }
    this.commit()
  }

  updateSettings(patch: Partial<TimelineSettings>): void {
    const wasMagnet = this.session.settings.magnet
    this.session = { ...this.session, settings: { ...this.session.settings, ...patch } }
    this.commit()
    // Switching magnet ON re-closes any gaps opened in the main lane while it was off.
    if (patch.magnet === true && !wasMagnet) {
      const mid = mainTrackId(this.doc)
      if (mid) this.dispatch(Commands.compactTrack(mid))
    }
  }

  /** Load a document (e.g. from a saved project); clears history & interaction. */
  replaceDocument(doc: TimelineDocument): void {
    this.doc = normalizeDoc(doc)
    this.history.reset(this.doc)
    this.interaction = { selection: [], drag: null }
    this.commit()
  }

  // --- selection ---

  select(ids: string[], additive = false): void {
    const set = additive ? new Set([...this.interaction.selection, ...ids]) : new Set(ids)
    this.interaction = { ...this.interaction, selection: [...set] }
    this.commit()
  }

  toggleSelect(id: string): void {
    const has = this.interaction.selection.includes(id)
    const selection = has
      ? this.interaction.selection.filter((x) => x !== id)
      : [...this.interaction.selection, id]
    this.interaction = { ...this.interaction, selection }
    this.commit()
  }

  clearSelection(): void {
    if (this.interaction.selection.length === 0) return
    this.interaction = { ...this.interaction, selection: [] }
    this.commit()
  }

  isSelected(id: string): boolean {
    return this.interaction.selection.includes(id)
  }

  selectAll(): void {
    const ids: string[] = []
    for (const t of this.doc.tracks) for (const c of t.clips) ids.push(c.id)
    this.select(ids)
  }

  // --- clipboard + selection edits (each is one undo step) ---

  copySelection(): void {
    const clips: Clip[] = []
    for (const id of this.interaction.selection) {
      const l = findClip(this.doc, id)
      if (l) clips.push(structuredClone(l.clip))
    }
    this.clipboard = clips
  }

  hasClipboard(): boolean {
    return this.clipboard.length > 0
  }

  cutSelection(): void {
    this.copySelection()
    const ids = [...this.interaction.selection]
    if (!ids.length) return
    this.batch('Cut', ids.map((id) => Commands.rippleDelete(id)))
    this.clearSelection()
  }

  /** Paste the clipboard so its earliest clip lands at `frame`, preserving relative layout. */
  pasteAt(frame: number): void {
    if (!this.clipboard.length) return
    const minStart = Math.min(...this.clipboard.map((c) => c.start))
    const cmds: Command[] = []
    const newIds: string[] = []
    for (const c of this.clipboard) {
      const copy = structuredClone(c)
      copy.id = uid('clip')
      copy.start = Math.max(0, frame + (c.start - minStart))
      copy.end = copy.start + copy.duration
      if (!findTrack(this.doc, copy.trackId)) {
        const mid = mainTrackId(this.doc)
        if (!mid) continue
        copy.trackId = mid
      }
      cmds.push(Commands.addClip(copy))
      newIds.push(copy.id)
    }
    if (cmds.length) {
      this.batch('Paste', cmds)
      this.select(newIds)
    }
  }

  duplicateSelection(): void {
    const cmds: Command[] = []
    const newIds: string[] = []
    for (const id of this.interaction.selection) {
      const l = findClip(this.doc, id)
      if (!l) continue
      const copy = structuredClone(l.clip)
      copy.id = uid('clip')
      copy.start = l.clip.end
      copy.end = copy.start + copy.duration
      cmds.push(Commands.addClip(copy))
      newIds.push(copy.id)
    }
    if (cmds.length) {
      this.batch('Duplicate', cmds)
      this.select(newIds)
    }
  }

  deleteSelection(ripple: boolean): void {
    const ids = [...this.interaction.selection]
    if (!ids.length) return
    this.batch(
      ripple ? 'Ripple delete' : 'Delete',
      ids.map((id) => (ripple ? Commands.rippleDelete(id) : Commands.removeClip(id)))
    )
    this.clearSelection()
  }

  /** Split at the playhead: only the selected clip(s) when there's a selection,
   *  otherwise every clip crossing it (razor the whole timeline). */
  splitAtPlayhead(): void {
    const frame = this.session.playhead
    const sel = this.interaction.selection
    if (sel.length > 0) {
      this.batch(
        'Split',
        sel.map((id) => Commands.splitClip(id, frame))
      )
    } else {
      this.dispatch(Commands.razorAt(frame))
    }
  }

  // --- drag / trim (frames in; preview out; one command on drop) ---

  /** Begin a move/trim. `grabFrame` is the pointer frame at grab time. */
  beginDrag(kind: DragKind, clipId: string, grabFrame: number): void {
    const loc = findClip(this.doc, clipId)
    if (!loc) return
    const { clip } = loc
    const selection = this.interaction.selection.includes(clipId)
      ? this.interaction.selection
      : [clipId]
    // A multi-selection move drags every selected clip together.
    const group =
      kind === 'move' && selection.length > 1
        ? selection
            .map((id) => {
              const l = findClip(this.doc, id)
              return l ? { clipId: id, originStart: l.clip.start } : null
            })
            .filter((g): g is { clipId: string; originStart: number } => g !== null)
        : null
    this.interaction = {
      selection,
      drag: {
        kind,
        clipId,
        grabFrame,
        grabOffset: clip.start - grabFrame,
        originTrackId: clip.trackId,
        originStart: clip.start,
        originDuration: clip.duration,
        dropFrame: clip.start,
        targetTrackId: clip.trackId,
        group,
        preview: this.doc,
        snapLine: null
      }
    }
    this.commit()
  }

  /** Update the in-flight drag from the current pointer frame (+ track for moves). */
  updateDrag(pointerFrame: number, opts?: { trackId?: string; zone?: 'above' | 'below' }): void {
    const drag = this.interaction.drag
    if (!drag) return
    const tb = this.doc.timebase
    const { magnet, snapping, snapThresholdPx } = this.session.settings
    const thr = Math.max(1, secondsToFrames(snapThresholdPx / this.session.zoom, tb))
    const loc = findClip(this.doc, drag.clipId)
    if (!loc) return
    const clip = loc.clip

    if (drag.kind === 'move') {
      let start = Math.max(0, pointerFrame + drag.grabOffset)
      let snapLine: number | null = null
      const exclude =
        drag.group && drag.group.length > 1
          ? new Set(drag.group.map((g) => g.clipId))
          : new Set([drag.clipId])
      if (snapping) {
        const points = collectSnapPoints(this.doc, exclude, this.session.playhead)
        const snap = snapEdges([start, start + clip.duration], points, thr)
        if (snap) {
          start = Math.max(0, start + snap.delta)
          snapLine = snap.line
        }
      }
      if (drag.group && drag.group.length > 1) {
        // group move: shift every selected clip by the primary's delta
        const delta = start - drag.originStart
        let preview = this.doc
        for (const g of drag.group) {
          const gl = findClip(preview, g.clipId)
          if (gl) preview = moveClipSmartInDoc(preview, g.clipId, gl.track.id, Math.max(0, g.originStart + delta), magnet)
        }
        this.interaction = {
          ...this.interaction,
          drag: { ...drag, dropFrame: start, targetTrackId: drag.originTrackId, newTrackId: null, newTrackZone: null, preview, snapLine }
        }
      } else {
        // region-aware target: video/image -> video lanes, text -> text lanes,
        // audio -> audio lanes (below main). Incompatible drops stay on origin.
        const plan = planDrop(this.doc, clip.kind, {
          trackId: opts?.trackId,
          zone: opts?.zone,
          originTrackId: drag.originTrackId
        })
        if (plan.type === 'new') {
          const newTrackId = drag.newTrackId ?? uid('track')
          let preview = addTrackToDoc(
            this.doc,
            createTrack({ kind: plan.kind, order: plan.order, id: newTrackId, autoCreated: true })
          )
          preview = moveClipSmartInDoc(preview, drag.clipId, newTrackId, start, magnet)
          this.interaction = {
            ...this.interaction,
            drag: { ...drag, dropFrame: start, targetTrackId: newTrackId, newTrackId, newTrackZone: opts?.zone ?? null, preview, snapLine }
          }
        } else {
          const preview = moveClipSmartInDoc(this.doc, drag.clipId, plan.trackId, start, magnet)
          this.interaction = {
            ...this.interaction,
            drag: { ...drag, dropFrame: start, targetTrackId: plan.trackId, newTrackId: null, newTrackZone: null, preview, snapLine }
          }
        }
      }
    } else if (drag.kind === 'slip') {
      const preview = slipClipInDoc(this.doc, drag.clipId, pointerFrame - drag.grabFrame, tb)
      this.interaction = { ...this.interaction, drag: { ...drag, dropFrame: pointerFrame - drag.grabFrame, snapLine: null, preview } }
    } else if (drag.kind === 'slide') {
      const newStart = drag.originStart + (pointerFrame - drag.grabFrame)
      const preview = slideClipInDoc(this.doc, drag.clipId, newStart, tb)
      this.interaction = { ...this.interaction, drag: { ...drag, dropFrame: newStart, snapLine: null, preview } }
    } else if (drag.kind === 'roll') {
      let boundary = pointerFrame
      let snapLine: number | null = null
      if (snapping) {
        const points = collectSnapPoints(this.doc, new Set([drag.clipId]), this.session.playhead)
        const snap = snapEdges([boundary], points, thr)
        if (snap) {
          boundary += snap.delta
          snapLine = snap.line
        }
      }
      const preview = rollEditInDoc(this.doc, drag.clipId, boundary, tb)
      this.interaction = { ...this.interaction, drag: { ...drag, dropFrame: boundary, snapLine, preview } }
    } else {
      const gapless = loc.track.isMain === true && magnet
      let edge = pointerFrame
      let snapLine: number | null = null
      if (snapping) {
        const points = collectSnapPoints(this.doc, new Set([drag.clipId]), this.session.playhead)
        const snap = snapEdges([edge], points, thr)
        if (snap) {
          edge += snap.delta
          snapLine = snap.line
        }
      }
      const preview =
        drag.kind === 'trimIn'
          ? gapless
            ? magnetTrimInInDoc(this.doc, drag.clipId, edge, tb)
            : trimClipInInDoc(this.doc, drag.clipId, edge, tb)
          : gapless
            ? magnetTrimOutInDoc(this.doc, drag.clipId, edge, tb)
            : trimClipOutInDoc(this.doc, drag.clipId, edge, tb)
      this.interaction = { ...this.interaction, drag: { ...drag, dropFrame: edge, snapLine, preview } }
    }
    this.commit()
  }

  /** Commit the in-flight drag as a single undoable command. */
  endDrag(): void {
    const drag = this.interaction.drag
    if (!drag) return
    this.interaction = { ...this.interaction, drag: null }
    if (drag.preview === this.doc) {
      this.commit()
      return
    }
    if (drag.kind === 'move') {
      if (drag.group && drag.group.length > 1) {
        const delta = drag.dropFrame - drag.originStart
        const magnet = this.session.settings.magnet
        const cmds = drag.group
          .map((g) => {
            const gl = findClip(this.doc, g.clipId)
            return gl ? Commands.moveClipSmart(g.clipId, gl.track.id, Math.max(0, g.originStart + delta), magnet) : null
          })
          .filter((c): c is ReturnType<typeof Commands.moveClipSmart> => c !== null)
        this.batch('Move clips', cmds)
      } else if (drag.newTrackZone && drag.newTrackId) {
        const clipKind = findClip(this.doc, drag.clipId)?.clip.kind ?? 'video'
        const plan = planDrop(this.doc, clipKind, { zone: drag.newTrackZone, originTrackId: drag.originTrackId })
        if (plan.type === 'new') {
          this.batch('Move to new track', [
            Commands.addTrack(plan.kind, { id: drag.newTrackId, order: plan.order, autoCreated: true }),
            Commands.moveClipSmart(drag.clipId, drag.newTrackId, drag.dropFrame, this.session.settings.magnet)
          ])
        } else {
          this.dispatch(Commands.moveClipSmart(drag.clipId, plan.trackId, drag.dropFrame, this.session.settings.magnet))
        }
      } else {
        this.dispatch(
          Commands.moveClipSmart(drag.clipId, drag.targetTrackId, drag.dropFrame, this.session.settings.magnet)
        )
      }
    } else if (drag.kind === 'slip') {
      this.dispatch(Commands.slipClip(drag.clipId, drag.dropFrame))
    } else if (drag.kind === 'slide') {
      this.dispatch(Commands.slideClip(drag.clipId, drag.dropFrame))
    } else if (drag.kind === 'roll') {
      this.dispatch(Commands.rollEdit(drag.clipId, drag.dropFrame))
    } else {
      const gapless = findClip(this.doc, drag.clipId)?.track.isMain === true && this.session.settings.magnet
      if (drag.kind === 'trimIn') {
        this.dispatch(
          gapless ? Commands.magnetTrimIn(drag.clipId, drag.dropFrame) : Commands.trimClipIn(drag.clipId, drag.dropFrame)
        )
      } else {
        this.dispatch(
          gapless ? Commands.magnetTrimOut(drag.clipId, drag.dropFrame) : Commands.trimClipOut(drag.clipId, drag.dropFrame)
        )
      }
    }
  }

  /** Abort the in-flight drag with no change. */
  cancelDrag(): void {
    if (!this.interaction.drag) return
    this.interaction = { ...this.interaction, drag: null }
    this.commit()
  }
}
