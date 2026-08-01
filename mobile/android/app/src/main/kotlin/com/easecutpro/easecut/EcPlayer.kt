package com.easecutpro.easecut

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Surface
import android.widget.Toast
import androidx.media3.common.util.Size
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.effect.SpeedChangeEffect
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
 * graph. That is the point: the removed ranges are stepped over inside one continuous
 * decode — like AVPlayer on an AVMutableComposition on iOS — so the play head no
 * longer re-primes the decoder (seek-to-keyframe + decode-forward) at every cut. No
 * proxy, no pre-warm.
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
 *
 * NOTE: [CompositionPlayer.setComposition] may be called only once per instance, so
 * every [load] releases the current player and builds a fresh one.
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

    private var totalDurationMs = 0L
    private var outSize: Size? = null

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

    /** Allocate the Flutter texture once; the player AND its Surface are built per [load]. */
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

        // Build the composition BEFORE tearing down the current player, so a not-yet-
        // playable timeline (e.g. every clip's duration still unknown right after import)
        // leaves the current preview intact instead of crashing the import.
        val built = buildPreviewComposition(segs)
        if (built == null) {
            result.success(null)
            return
        }
        val (composition, totalMs) = built

        // Preserve position + play state across the mandatory player recreation.
        val prevPos = player?.currentPosition?.coerceAtLeast(0L) ?: 0L
        val wasPlaying = player?.playWhenReady ?: false
        releasePlayer()

        // Fresh Surface from the persistent SurfaceTexture on EVERY (re)load: releasing a
        // CompositionPlayer disconnects its output Surface, so reusing the same Surface
        // object for the next player renders black (the import worked, the post-cut reload
        // went black). The Flutter texture id is unchanged, so this is invisible to Dart.
        surface?.release()
        val st = entry.surfaceTexture()
        st.setDefaultBufferSize(size.width, size.height)
        val surf = Surface(st)
        surface = surf
        events?.success(mapOf("event" to "size", "width" to size.width, "height" to size.height))

        totalDurationMs = totalMs
        try {
            val cp = CompositionPlayer.Builder(context).build()
            cp.repeatMode = Player.REPEAT_MODE_OFF
            // Surface the real reason a preview blanks (a playback/video-graph error is
            // otherwise silent → black screen). This is the diagnostic that turns "black"
            // into an actionable fault.
            cp.addListener(object : Player.Listener {
                override fun onPlayerError(error: PlaybackException) {
                    toast("Preview error: ${error.errorCodeName} — ${error.message}")
                }
            })
            cp.setVideoSurface(surf, size)
            cp.setComposition(composition)
            cp.prepare()
            if (prevPos in 1 until totalMs) cp.seekTo(prevPos)
            cp.playWhenReady = wasPlaying
            player = cp
        } catch (e: Throwable) {
            // Show the exact throwing frame (release build is not minified, so class +
            // method + line survive) — a null message alone is useless.
            val top = e.stackTrace.take(3).joinToString("  <  ") {
                "${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}"
            }
            toast("Preview x: ${e.javaClass.simpleName}: ${e.message} @ $top")
            player = null
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

    /**
     * Build the preview [Composition]: one sequence of the cut clips. Each keeps its
     * per-clip volume (channel-mix) and speed (SpeedChange + Sonic); crop / Ken Burns
     * are intentionally left to the Flutter-layer transform.
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

            val vfx = ArrayList<Effect>()
            val afx = ArrayList<AudioProcessor>()
            if (speed != 1f) {
                vfx.add(SpeedChangeEffect(speed))
                val sonic = SonicAudioProcessor()
                sonic.setSpeed(speed)
                afx.add(sonic)
            }
            if (volume <= 0.001f) {
                b.setRemoveAudio(true)
            } else if (volume != 1f) {
                val mix = ChannelMixingAudioProcessor()
                mix.putChannelMixingMatrix(ChannelMixingMatrix.create(1, 1).scaleBy(volume))
                mix.putChannelMixingMatrix(ChannelMixingMatrix.create(2, 2).scaleBy(volume))
                afx.add(mix)
            }
            if (vfx.isNotEmpty() || afx.isNotEmpty()) {
                b.setEffects(Effects(ImmutableList.copyOf(afx), ImmutableList.copyOf(vfx)))
            }
            items.add(b.build())
            totalMs += timelineMs
        }
        if (items.isEmpty()) return null
        val seq = EditedMediaItemSequence(items)
        return Composition.Builder(listOf(seq)).build() to totalMs
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
    }

    private fun releaseInternal() {
        stopPolling()
        releaseAudio()
        releasePlayer()
        surface?.release()
        surface = null
        textureEntry?.release()
        textureEntry = null
    }

    fun dispose() {
        methodChannel.setMethodCallHandler(null)
        eventChannel.setStreamHandler(null)
        releaseInternal()
    }
}
