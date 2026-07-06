// Media resolver — the ONE place that turns a clip's source path into a
// playable URL, on every platform, with an explicit "missing" state.
//
// Components used to call mediaSrc() ad-hoc and each invented its own idea of
// what an empty string meant; a dead browser-local id (project saved before its
// upload finished, then reloaded) rendered as a silent black <video>. Resolve
// here instead: `missing` is a first-class answer the UI can show.

import { mediaSrc, IS_WEB } from '../platform'
import { isWebMediaId, localUrl } from '../webmedia'

export interface ResolvedMedia {
  /** playable URL ('' when missing). */
  url: string
  /** true when the source is a browser-local id whose File is gone (stale
   *  project reference) — nothing can play it; offer re-import instead. */
  missing: boolean
}

export function resolveMedia(path: string | undefined | null): ResolvedMedia {
  if (!path) return { url: '', missing: false }
  if (IS_WEB && isWebMediaId(path)) {
    const url = localUrl(path)
    return { url, missing: url === '' }
  }
  return { url: mediaSrc(path), missing: false }
}

/** Human message for a project whose media can't be played anymore. */
export const MISSING_MEDIA_MESSAGE =
  'This project’s media isn’t available anymore (saved before upload finished). ' +
  'Re-import the clip to continue — your edits are intact.'
