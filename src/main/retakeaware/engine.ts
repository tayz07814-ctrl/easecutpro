// Retake-Aware Cut Beta — Node wrapper (cut_mode: "retake_aware_beta").
//
// The orchestration itself lives in the PURE dependency-injected core at
// src/shared/retakeaware/engine.ts (shared with the browser cloud build). This
// wrapper is the ONLY entry point of the beta engine on Electron/server: it
// extracts the audio (small mono WAV — every provider accepts it) and binds
// the platform deps to it — verbatim transcription (provider chain), the
// whisper-vad silence scan, the LLM judge and the fs debug-JSON write in
// ~/.easecutpro/retakeaware/. It is not imported by (and does not import)
// FastCut / ProCut / Smart Smooth Cut internals — only neutral app services
// (ffmpeg audio extraction, whisper-1 fallback transcription, key resolution).

import { mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { RetakeAwareResult } from '../../shared/retakeaware/types'
import { runRetakeAwareCut, type RetakeEngineDeps, type ProgressFn } from '../../shared/retakeaware/engine'
import { transcribeVerbatim } from './providers'
import { reviewRetakeGroups } from './llm'
import { prepareAudioWav } from '../ffmpeg'

export async function retakeAwareCut(
  mediaPath: string,
  onProgress?: ProgressFn
): Promise<RetakeAwareResult> {
  const warnings: string[] = []
  const op: ProgressFn = (pct, msg) => onProgress?.(pct, msg)
  console.log('[retake-aware-beta] job start:', mediaPath)

  // 1. audio (small mono WAV — every provider accepts it)
  op(3, 'Retake β: extracting audio…')
  let audioPath = mediaPath
  try {
    if (!/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(mediaPath)) audioPath = await prepareAudioWav(mediaPath)
  } catch (e) {
    warnings.push(`Audio extraction failed (${(e as Error).message}) — sending the original file to the provider.`)
  }

  // Every dep is bound to the SAME audio the transcription reads.
  const deps: RetakeEngineDeps = {
    transcribeVerbatim: (p) => transcribeVerbatim(audioPath, p),
    reviewRetakeGroups,
    saveDebug: async (json) => {
      const dir = join(homedir(), '.easecutpro', 'retakeaware')
      await mkdir(dir, { recursive: true })
      const debugPath = join(dir, `debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      await writeFile(debugPath, json, 'utf8')
      return debugPath
    }
  }
  return runRetakeAwareCut(deps, onProgress, warnings)
}
