// Desktop-cloud HYBRID api. The Electron preload's window.api stays the source
// of truth for everything NATIVE (dialogs, probe, waveform, thumbnails,
// combine, export, the ffmpeg preview) — `aiApi()` returns a merged surface
// whose AI methods are the same edge-function engines the cloud web build
// uses, so the shipped installer contains zero API keys and every AI run is
// authenticated + metered per account exactly like easecutpro.com.
//
// WHY an indirection instead of overwriting window.api: contextBridge exposes
// window.api as a READ-ONLY global — `window.api = …` throws in strict-mode
// ESM and killed the renderer at startup (black screen). Call sites that can
// route to the cloud go through aiApi(); on web builds it returns window.api
// unchanged, so their behavior is byte-identical.
//
// The engines take a mediaId and pull audio through cloud/audio.ts, whose
// native branch extracts the 16 kHz STT WAV with the bundled ffmpeg — so on
// desktop the upload payload comes from ffmpeg, not a browser decode.
//
// suggestCuts (Smart Cut) and fastCut stay native: the cloud build has no edge
// equivalent for them (desktopOnly stubs there too).

import type { ProgressEvent } from '@shared/types'
import { IS_DESKTOP_CLOUD } from '../platform'
import { generateOverlaysCloud, suggestOverlaysCloud } from './overlayMatch'
import { invokeEdge } from './supabase'
import { retakeAwareCutCloud, ultracutCutCloud, transcribeCloud } from './retakeEngine'
import { premiumCutCloud } from './premiumEngine'
import { cutCutProCloud } from './procutEngine'
import { initSettingsSync } from './settings'

const progressListeners = new Set<(e: ProgressEvent) => void>()

function emit(kind: ProgressEvent['kind'], percent: number, message?: string, jobId = 'cloud'): void {
  for (const cb of progressListeners) cb({ jobId, kind, percent, message })
}

/** The cloud engines emit progress here (they never cross IPC). store.init()
 *  registers the same handler it gives window.api.onProgress. */
export function onDesktopCloudProgress(cb: (e: ProgressEvent) => void): () => void {
  progressListeners.add(cb)
  return () => progressListeners.delete(cb)
}

export type HybridApi = Window['api'] & {
  ultracutCut: Window['api']['retakeAwareCut']
  premiumCut: Window['api']['retakeAwareCut']
}

let merged: HybridApi | null = null

function buildHybrid(): HybridApi {
  const native = window.api
  return {
    ...native,

    // Verbatim STT via the edge functions (AssemblyAI -> Deepgram). The native
    // backend/model args are meaningless here and ignored.
    transcribe: async (path) => transcribeCloud(path, (pct, msg) => emit('transcribe', pct, msg)),

    // ProCut: AssemblyAI transcribes + Claude finalizes (procut-judge).
    cutCutPro: (path, transcript, _modelName, script) =>
      cutCutProCloud(path, transcript ?? null, script, (pct, msg) => emit('transcribe', pct, msg)),

    // Find Cuts — the retake judge over the full transcript.
    retakeAwareCut: (path) => retakeAwareCutCloud(path, (pct, msg) => emit('transcribe', pct, msg)),

    // Ultracut (Beta) / Premium Cut — extra keys the store feature-detects
    // (it falls back to retakeAwareCut when they're absent).
    ultracutCut: (path) => ultracutCutCloud(path, (pct, msg) => emit('transcribe', pct, msg)),
    premiumCut: (path) => premiumCutCloud(path, (pct, msg) => emit('transcribe', pct, msg)),

    // Overlay placement / suggestion / vision — all edge functions, with the
    // same graceful fallbacks as the cloud build.
    generateOverlays: async (transcript, assets, rules, opts) =>
      generateOverlaysCloud(transcript, assets, rules, opts),
    suggestOverlays: async (transcript, assets, opts) => suggestOverlaysCloud(transcript, assets, opts),
    describeOverlayImage: async (imageBase64, mediaType) => {
      try {
        return await invokeEdge<{ description: string }>('overlay-vision', { image: imageBase64, mediaType })
      } catch {
        return { description: '' } // graceful: matching falls back to the overlay name
      }
    },
    matchMoment: async (frames, line, overlays) => {
      try {
        return await invokeEdge<{ overlayId: string; note?: string }>('moment-vision', { frames, line, overlays })
      } catch {
        return { overlayId: '' } // graceful: moment matching just adds nothing
      }
    }
  }
}

/** The api surface AI call sites should use. Desktop hybrid → cloud engines
 *  merged over native; every other build → window.api untouched. */
export function aiApi(): Window['api'] & Partial<Pick<HybridApi, 'ultracutCut' | 'premiumCut'>> {
  if (!IS_DESKTOP_CLOUD) return window.api
  if (!merged) merged = buildHybrid()
  return merged
}

/** One-time desktop-hybrid boot work (main.tsx). */
export function initDesktopCloud(): void {
  // Cross-device user settings (same table the web build syncs through).
  initSettingsSync()
}
