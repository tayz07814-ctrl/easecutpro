package com.easecutpro.easecut

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Surface
import android.widget.Toast
import androidx.media3.common.C
import androidx.media3.common.util.Size
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.transformer.Composition
import androidx.media3.transformer.CompositionPlayer
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import com.google.common.collect.ImmutableList
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.view.TextureRegistry

/**
 * Native preview PLAYER — hardware-decoded playback of the timeline's base track,
 * rendered straight into a Flutter [TextureRegistry] texture.
 *
 * This uses Media3 **CompositionPlayer** rather than a plain ExoPlayer playlist. The
 * cut list is handed over as ONE [Composition] (the exact same shape the exporter
 * builds), and CompositionPlayer plays it through the Transformer's continuous video
 * graph — the removed ranges are stepped over inside one continuous decode, so the
 * play head never re-primes the decoder (seek-to-keyframe + decode-forward) at a cut.
 *
 * ONE PLAYER FOR THE WHOLE SESSION. Media3 1.9 lets [CompositionPlayer.setComposition]
 * be called repeatedly, so an edit swaps the composition INSIDE the live player. The
 * video graph — and its EGL producer on the Flutter Surface — survives the swap, which
 * is what actually fixes the black flash on cuts/trims: the texture keeps the last
 * rendered frame until the new cut list's first frame lands. (The old design rebuilt
 * the player per edit because 1.7 allowed setComposition only once. Releasing a player
 * destroys its EGL surface; the producer-side disconnect frees the BufferQueue's
 * buffers, so the Flutter texture sampled freed memory → a ~250 ms black hole until
 * the next player's first frame. Reusing the android.view.Surface OBJECT couldn't fix
 * that — it's the EGL producer connection that matters.) It also removes the per-edit
 * main-thread block: CompositionPlayerInternal.release() parks the caller on a
 * ConditionVariable until the playback thread has torn down the GL pipeline and
 * codecs; doing that on every edit (worst right after silence cleaning applies dozens
 * of cuts) is an ANR → process kill when the teardown stalls. Now release happens
 * once, when the editor screen goes away.
 *
 * Crop and the Ken Burns pan are NOT baked here — they stay a Flutter-layer transform
 * on the texture (see editor_screen `_cropped`), so the preview composition is just the
 * cut clips + per-clip volume/speed. Extra audio tracks (music / voiceover) are still
 * previewed with follow-the-leader ExoPlayers synced to the composition clock.
 *
 * Channels:
 *   MethodChannel  "ec/player"        create / load / play / pause / seek / release
 *   EventChannel   "ec/player/events" ~30 Hz {event:"state", timelineMs, durationMs, playing, ended, ready}
 *                                     and {event:"size", width, height} once probed
 *
 * CompositionPlayer position IS the composition timeline, which equals the editor's
 * timeline 1:1 — so we report it verbatim (no per-item offset math).
 */
class EcPlayer(
    private val context: Context,
    messenger: BinaryMessenger,
    private val textures: TextureRegistry
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {

    private val methodChannel = MethodChannel(messenger, "ec/player")
    private val eventChannel = EventChannel(messenger, "ec/player/events")

    private var player: CompositionPlayer? = null
    private var textureEntry: TextureRegistry.SurfaceTextureEntry? = null
    private var surface: Surface? = null
    private var events: EventChannel.EventSink? = null

    // A playback/video-graph error can leave the GL pipeline dead; the next load then
    // rebuilds the player from scratch instead of swapping into a corpse.
    @Volatile private var playerBroken = false

    private var totalDurationMs = 0L
    private var outSize: Size? = null
    private var surfaceSize: Size? = null // size the persistent Surface's buffer is sized for

    // Extra audio tracks (music / voiceover), previewed via follow-the-leader players.
    private val audioPlayers = ArrayList<ExoPlayer>()
    private var audioStarts = LongArray(0) // each track's timeline start (ms)

    private val main = Handler(Looper.getMainLooper())
    private var polling = false
    private var pollTick = 0

    private val poller = object : Runnable {
        override fun run() {
            val p = player
            val sink = events
            if (p != null && sink != null) {
                try {
                    val pos = maxOf(0L, p.currentPosition)
                    val dur = if (p.duration > 0) p.duration else totalDurationMs
                    sink.success(
                        mapOf(
                            "event" to "state",
                            "timelineMs" to pos,
                            "durationMs" to dur,
                            "playing" to p.isPlaying,
                            "ended" to (p.playbackState == Player.STATE_ENDED),
                            "ready" to (p.playbackState == Player.STATE_READY)
                        )
                    )
                    // Keep music tracks aligned to the composition clock (corrects drift).
                    if (audioPlayers.isNotEmpty()) {
                        pollTick++
                        if (p.isPlaying && pollTick % 30 == 0) syncAudio(true)
                    }
                } catch (_: Exception) {
                }
            }
            if (polling) main.postDelayed(this, 33)
        }
    }

    init {
        methodChannel.setMethodCallHandler(this)
        eventChannel.setStreamHandler(this)
    }

    override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) {
        events = sink
    }

    override fun onCancel(arguments: Any?) {
        events = null
    }

    /** Show a native toast (main thread) — used to surface preview errors on-screen. */
    private fun toast(msg: String) {
        main.post {
            try {
                Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
            } catch (_: Exception) {
            }
        }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "create" -> create(result)
                "load" -> load(call, result)
                "play" -> {
                    player?.playWhenReady = true
                    syncAudio(true)
                    result.success(null)
                }
                "pause" -> {
                    player?.playWhenReady = false
                    syncAudio(false)
                    result.success(null)
                }
                "seek" -> seek(call, result)
                "release" -> {
                    releaseInternal()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            result.error("ec_player", e.message, null)
        }
    }

    /** Allocate the Flutter texture once; the player + Surface are built on first [load]. */
    private fun create(result: MethodChannel.Result) {
        if (textureEntry == null) {
            textureEntry = textures.createSurfaceTexture()
        }
        startPolling()
        result.success(mapOf("textureId" to (textureEntry?.id() ?: -1L)))
    }

    private fun load(call: MethodCall, result: MethodChannel.Result) {
        @Suppress("UNCHECKED_CAST")
        val segs = (call.argument<List<Map<String, Any>>>("segments")) ?: emptyList()
        val entry = textureEntry ?: run {
            result.error("ec_player", "not created", null)
            return
        }
        if (segs.isEmpty()) {
            result.success(null)
            return
        }

        // Probe the first clip's display size (rotation-corrected) — CompositionPlayer
        // does not report video size to the app, and setVideoSurface needs an output size.
        val firstUri = segs.firstOrNull()?.get("uri") as? String
        val size = firstUri?.let { probeSize(it) } ?: (outSize ?: Size(1920, 1080))
        outSize = size

        // Build the composition BEFORE touching the current player, so a not-yet-
        // playable timeline (e.g. every clip's duration still unknown right after import)
        // leaves the current preview intact instead of crashing the import.
        val built = buildPreviewComposition(segs)
        if (built == null) {
            result.success(null)
            return
        }
        val (composition, totalMs) = built

        val prevPos = player?.currentPosition?.coerceAtLeast(0L) ?: 0L
        val wasPlaying = player?.playWhenReady ?: false
        val startPos = prevPos.coerceIn(0L, maxOf(0L, totalMs - 1L))

        // The Surface is created ONCE and kept. Recreate it only when the output size
        // truly changed (a different-resolution clip became first) — that reallocates
        // the texture buffer, so the old player must go with it.
        val st = entry.surfaceTexture()
        val sizeChanged = surface == null || size != surfaceSize
        if (sizeChanged || playerBroken) {
            releasePlayer()
            if (sizeChanged) {
                surface?.release()
                st.setDefaultBufferSize(size.width, size.height)
                surface = Surface(st)
                surfaceSize = size
            }
        }
        val surf = surface!!
        events?.success(mapOf("event" to "size", "width" to size.width, "height" to size.height))

        totalDurationMs = totalMs
        try {
            val existing = player
            if (existing == null) {
                buildPlayer(surf, size, composition, startPos, wasPlaying)
            } else {
                // The heart of the fix: swap the cut list INSIDE the live player. The
                // video graph and its surface connection survive, so the last frame
                // stays up until the new composition's first frame replaces it.
                existing.setComposition(composition, startPos)
                // After stop() or a playback error the player parks in IDLE and needs
                // an explicit prepare to pick the new composition up.
                if (existing.playbackState == Player.STATE_IDLE) existing.prepare()
            }
        } catch (e: Throwable) {
            // The in-place swap failed — fall back to a one-off full rebuild.
            releasePlayer()
            try {
                buildPlayer(surf, size, composition, startPos, wasPlaying)
            } catch (e2: Throwable) {
                // Show the exact throwing frame (release build is not minified, so class +
                // method + line survive) — a null message alone is useless.
                val top = e2.stackTrace.take(3).joinToString("  <  ") {
                    "${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}"
                }
                toast("Preview x: ${e2.javaClass.simpleName}: ${e2.message} @ $top")
                player = null
            }
        }

        // Extra audio tracks (music / voiceover) — previewed via follow-the-leader players.
        releaseAudio()
        @Suppress("UNCHECKED_CAST")
        val audio = (call.argument<List<Map<String, Any>>>("audioTracks")) ?: emptyList()
        if (audio.isNotEmpty()) {
            val aStarts = ArrayList<Long>()
            for (a in audio) {
                val uri = a["uri"] as? String ?: continue
                val aStart = (a["startMs"] as? Number)?.toLong() ?: 0L
                val aEnd = (a["endMs"] as? Number)?.toLong() ?: 0L
                val tlStart = (a["timelineStartMs"] as? Number)?.toLong() ?: 0L
                val vol = (a["volume"] as? Number)?.toFloat() ?: 1f
                try {
                    val clip = MediaItem.ClippingConfiguration.Builder().setStartPositionMs(aStart)
                    if (aEnd > aStart) clip.setEndPositionMs(aEnd)
                    val mi = MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build()
                    val ap = ExoPlayer.Builder(context).build()
                    ap.repeatMode = Player.REPEAT_MODE_OFF
                    ap.volume = vol.coerceIn(0f, 4f)
                    ap.setMediaItem(mi)
                    ap.prepare()
                    audioPlayers.add(ap)
                    aStarts.add(tlStart)
                } catch (_: Exception) {
                }
            }
            audioStarts = aStarts.toLongArray()
        }
        result.success(null)
    }

    /** Build the persistent CompositionPlayer (first load, or recovery after an error /
     *  output-size change). */
    private fun buildPlayer(
        surf: Surface,
        size: Size,
        composition: Composition,
        startPos: Long,
        playWhenReady: Boolean
    ) {
        val cp = CompositionPlayer.Builder(context).build()
        cp.repeatMode = Player.REPEAT_MODE_OFF
        // Surface the real reason a preview blanks (a playback/video-graph error is
        // otherwise silent → black screen), and mark the pipeline for rebuild.
        cp.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                playerBroken = true
                toast("Preview error: ${error.errorCodeName} — ${error.message}")
            }
        })
        cp.setVideoSurface(surf, size)
        cp.setComposition(composition, startPos)
        cp.prepare()
        cp.playWhenReady = playWhenReady
        player = cp
        playerBroken = false
    }

    /**
     * Build the preview [Composition]: one sequence of the cut clips. Each keeps its
     * per-clip volume (channel-mix) and speed; crop / Ken Burns are intentionally left
     * to the Flutter-layer transform.
     *
     * Per-clip speed rides on [EditedMediaItem.Builder.setSpeed] (a constant
     * [SpeedProvider]) — CompositionPlayer 1.9 rejects compositions carrying free-form
     * SpeedChangeEffect video effects, and setSpeed wires the matched audio time-stretch
     * itself.
     *
     * [EditedMediaItem.durationUs] must be the WHOLE source media length — Media3 derives
     * each clip's presentation length from the ClippingConfiguration and asserts
     * `endPositionUs <= durationUs`. Setting it to the clipped span made every cut clip
     * (startMs > 0) fail that check (import, startMs == 0, slipped through). So probe the
     * real source duration (cached per file) and use it here.
     *
     * Returns the composition and the summed TIMELINE length (ms), or null if nothing is
     * playable yet (so the caller keeps the current preview instead of feeding
     * CompositionPlayer an empty sequence, which it rejects).
     */
    private fun buildPreviewComposition(segs: List<Map<String, Any>>): Pair<Composition, Long>? {
        val items = ArrayList<EditedMediaItem>()
        var totalMs = 0L
        val srcDurCache = HashMap<String, Long>() // uri -> full source duration (ms)
        for (seg in segs) {
            val uri = seg["uri"] as? String ?: continue
            val startMs = (seg["startMs"] as? Number)?.toLong() ?: 0L
            var endMs = (seg["endMs"] as? Number)?.toLong() ?: 0L
            val srcDurMs = srcDurCache.getOrPut(uri) { probeDurationMs(uri) }
            // endMs <= startMs is the "to end" sentinel (unknown right after import).
            if (endMs <= startMs) endMs = if (srcDurMs > startMs) srcDurMs else startMs
            if (srcDurMs > 0 && endMs > srcDurMs) endMs = srcDurMs // keep the clip inside the source
            val speed = (seg["speed"] as? Number)?.toFloat()?.coerceIn(0.1f, 8f) ?: 1f
            val volume = (seg["volume"] as? Number)?.toFloat()?.coerceIn(0f, 4f) ?: 1f
            val spanMs = if (endMs > startMs) endMs - startMs else 0L
            if (spanMs <= 0L) continue
            val timelineMs = maxOf(1L, (spanMs / speed).toLong())
            // Full-source duration for the item (fall back to the clip end when the probe
            // fails — that still satisfies endPositionUs <= durationUs). Must be > 0.
            val durationUs = (if (srcDurMs > 0) srcDurMs else endMs).coerceAtLeast(1L) * 1000L

            val clip = MediaItem.ClippingConfiguration.Builder()
                .setStartPositionMs(startMs)
                .setEndPositionMs(endMs)
            val mi = MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build()
            val b = EditedMediaItem.Builder(mi).setDurationUs(durationUs)

            if (speed != 1f) {
                b.setSpeed(object : SpeedProvider {
                    override fun getSpeed(timeUs: Long): Float = speed
                    override fun getNextSpeedChangeTimeUs(timeUs: Long): Long = C.TIME_UNSET
                })
            }
            val videoEffects = ArrayList<Effect>()
            val maskFrames = parseMaskFrames(seg["maskFrames"])
            if (maskFrames.isNotEmpty()) videoEffects.add(BackgroundMaskEffect(maskFrames))
            if (volume != 1f) {
                // Muted clips get a ZERO-GAIN mix rather than setRemoveAudio: with the
                // whole timeline muted, removeAudio would strip the composition's audio
                // track entirely, which CompositionPlayer does not take kindly to —
                // keeping a silent track is safe and audibly identical.
                val gain = if (volume <= 0.001f) 0f else volume
                val mix = ChannelMixingAudioProcessor()
                mix.putChannelMixingMatrix(ChannelMixingMatrix.create(1, 1).scaleBy(gain))
                mix.putChannelMixingMatrix(ChannelMixingMatrix.create(2, 2).scaleBy(gain))
                b.setEffects(Effects(ImmutableList.of<AudioProcessor>(mix), videoEffects))
            } else if (videoEffects.isNotEmpty()) {
                b.setEffects(Effects(ImmutableList.of<AudioProcessor>(), videoEffects))
            }
            items.add(b.build())
            totalMs += timelineMs
        }
        if (items.isEmpty()) return null
        @Suppress("DEPRECATION")
        val seq = EditedMediaItemSequence.Builder(items).build()
        return Composition.Builder(listOf(seq)).build() to totalMs
    }

    private fun parseMaskFrames(raw: Any?): List<BackgroundMaskEffect.MaskFrame> {
        if (raw !is List<*>) return emptyList()
        return raw.mapNotNull { item ->
            if (item !is Map<*, *>) return@mapNotNull null
            val path = item["p"] as? String ?: return@mapNotNull null
            val time = (item["t"] as? Number)?.toLong() ?: 0L
            if (path.isEmpty()) null else BackgroundMaskEffect.MaskFrame(time, path)
        }
    }

    /** Source duration (ms) via metadata, 0 if unknown. */
    private fun probeDurationMs(uri: String): Long {
        val mmr = MediaMetadataRetriever()
        try {
            val path = if (uri.startsWith("file://")) Uri.parse(uri).path ?: uri else uri
            mmr.setDataSource(path)
            return mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        } catch (_: Exception) {
            return 0L
        } finally {
            try {
                mmr.release()
            } catch (_: Exception) {
            }
        }
    }

    /** Rotation-corrected display size of a video file; a sane default on failure. */
    private fun probeSize(uri: String): Size {
        val mmr = MediaMetadataRetriever()
        try {
            val path = if (uri.startsWith("file://")) Uri.parse(uri).path ?: uri else uri
            mmr.setDataSource(path)
            var w = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            var h = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val rot = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            if (rot == 90 || rot == 270) {
                val t = w; w = h; h = t
            }
            if (w <= 0 || h <= 0) return Size(1920, 1080)
            return Size(w, h)
        } catch (_: Exception) {
            return Size(1920, 1080)
        } finally {
            try {
                mmr.release()
            } catch (_: Exception) {
            }
        }
    }

    private fun seek(call: MethodCall, result: MethodChannel.Result) {
        val ms = (call.argument<Number>("timelineMs"))?.toLong() ?: 0L
        val p = player
        if (p != null) {
            try {
                p.seekTo(ms.coerceIn(0L, if (totalDurationMs > 0) totalDurationMs else ms))
            } catch (_: Exception) {
            }
            syncAudio(p.playWhenReady)
        }
        result.success(null)
    }

    /** Point every music track at the composition clock and match play state. */
    private fun syncAudio(play: Boolean) {
        val tl = player?.currentPosition?.coerceAtLeast(0L) ?: return
        for (i in audioPlayers.indices) {
            val ap = audioPlayers[i]
            val startAt = if (i in audioStarts.indices) audioStarts[i] else 0L
            val local = tl - startAt
            try {
                if (local < 0) {
                    ap.playWhenReady = false
                } else {
                    if (kotlin.math.abs(ap.currentPosition - local) > 120) ap.seekTo(local)
                    ap.playWhenReady = play
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun startPolling() {
        if (!polling) {
            polling = true
            main.postDelayed(poller, 33)
        }
    }

    private fun stopPolling() {
        polling = false
        main.removeCallbacks(poller)
    }

    private fun releaseAudio() {
        for (ap in audioPlayers) {
            try {
                ap.release()
            } catch (_: Exception) {
            }
        }
        audioPlayers.clear()
        audioStarts = LongArray(0)
    }

    private fun releasePlayer() {
        player?.let {
            try {
                it.release()
            } catch (_: Exception) {
            }
        }
        player = null
        playerBroken = false
    }

    private fun releaseInternal() {
        stopPolling()
        releaseAudio()
        releasePlayer()
        surface?.release()
        surface = null
        surfaceSize = null
        textureEntry?.release()
        textureEntry = null
    }

    fun dispose() {
        methodChannel.setMethodCallHandler(null)
        eventChannel.setStreamHandler(null)
        releaseInternal()
    }
}
