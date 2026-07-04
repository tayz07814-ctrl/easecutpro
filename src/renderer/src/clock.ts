// Shared playback clock: the base video's current time, updated each frame by
// VideoPreview's rAF loop. Lets image overlays animate zoom at native fps even
// though <img> has no currentTime.
export const playClock = { t: 0 }
