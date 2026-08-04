// Suppress the click that a preview drag leaves behind.
//
// The overlay/text layers sit ABOVE the <video> but are pointer-events:none
// except on the boxes themselves, and the play/pause toggle lives on the
// <video>'s own onClick. Moving, cropping or resizing an overlay therefore ends
// with a click that reaches the video and resumes playback mid-edit —
// stopPropagation on pointerdown cannot prevent it, because the click is a
// separate event synthesised after pointerup.
//
// So the layers mark the interaction, and the preview's click handler skips one
// toggle while the mark is fresh. Time-boxed rather than a sticky flag: if a
// drag ever ends without its pointerup (pointer lost, element unmounted), the
// guard expires on its own instead of wedging click-to-play off.

let until = 0

/** Called by the overlay/text layers when a pointer interaction begins. */
export function suppressPreviewClick(ms = 400): void {
  until = Date.now() + ms
}

/** True while a preview drag's trailing click should be swallowed. */
export function previewClickSuppressed(): boolean {
  return Date.now() < until
}
