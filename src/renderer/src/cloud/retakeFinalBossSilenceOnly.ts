// Silence Only — the Retake Final Boss audio/VAD tail exposed as a standalone
// 0.07 action. It intentionally imports no transcription or judge modules.

import type { SilenceRegion } from '@shared/types'
import type { RetakeFinalBossSettings } from '@shared/retakefinalboss'
import { decodeAudioFloat32 } from './audio'
import { detectRetakeFinalBossSilences } from './retakeFinalBossVad'

export async function runRetakeFinalBossSilenceOnlyCloud(
  mediaId: string,
  onProgress: ((percent: number, message?: string) => void) | undefined,
  settings: RetakeFinalBossSettings
): Promise<SilenceRegion[]> {
  onProgress?.(3, 'Preparing timeline audio…')
  const audio = await decodeAudioFloat32(mediaId, (percent) => {
    onProgress?.(3 + Math.round(percent * 0.42), 'Preparing timeline audio…')
  })
  onProgress?.(48, 'Detecting silence with FSMN-VAD…')
  const regions = await detectRetakeFinalBossSilences(
    audio.float32,
    audio.sampleRate,
    audio.durationS,
    settings
  )
  onProgress?.(100, 'Silence Only finished')
  return regions
}
