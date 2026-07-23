package com.easecutpro.easecut

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.ExoPlayer
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.view.TextureRegistry

/**
 * Native preview PLAYER — hardware-decoded playback of the timeline's base track via
 * Media3 ExoPlayer, rendered straight into a Flutter [TextureRegistry] texture.
 *
 * This is the whole reason for the Flutter rebuild: instead of a TextureView stacked
 * behind a transparent WebView (which never composited reliably on-device), ExoPlayer
 * draws into a SurfaceTexture that the Flutter engine composites like any other widget.
 * Dart shows it with `Texture(textureId: id)` — no WebView, no manual view stacking.
 *
 * Channels:
 *   MethodChannel  "ec/player"        create / load / play / pause / seek / release
 *   EventChannel   "ec/player/events" ~10 Hz {event:"state", timelineMs, playing, ended, ready}
 *                                     and {event:"size", width, height} on video-size change
 *
 * A segment carries its own timeline offset so we report a GLOBAL timeline position
 * (segment start + in-clip position); Dart keeps the clock/overlays locked to it.
 */
class EcPlayer(
    private val context: Context,
    messenger: BinaryMessenger,
    private val textures: TextureRegistry
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {

    private val methodChannel = MethodChannel(messenger, "ec/player")
    private val eventChannel = EventChannel(messenger, "ec/player/events")

    private var player: ExoPlayer? = null
    private var textureEntry: TextureRegistry.SurfaceTextureEntry? = null
    private var surface: Surface? = null
    private var events: EventChannel.EventSink? = null

    private var starts = LongArray(0)
    private var ends = LongArray(0)

    private val main = Handler(Looper.getMainLooper())
    private var polling = false
    private val poller = object : Runnable {
        override fun run() {
            val p = player
            val sink = events
            if (p != null && sink != null) {
                try {
                    val idx = p.currentMediaItemIndex
                    val pos = maxOf(0L, p.contentPosition)
                    val base = if (idx in starts.indices) starts[idx] else 0L
                    val dur = p.duration
                    sink.success(
                        mapOf(
                            "event" to "state",
                            "timelineMs" to (base + pos),
                            "durationMs" to (if (dur > 0) dur else 0L),
                            "playing" to p.isPlaying,
                            "ended" to (p.playbackState == Player.STATE_ENDED),
                            "ready" to (p.playbackState == Player.STATE_READY)
                        )
                    )
                } catch (_: Exception) {
                }
            }
            if (polling) main.postDelayed(this, 100)
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

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "create" -> create(result)
                "load" -> load(call, result)
                "play" -> {
                    player?.playWhenReady = true
                    result.success(null)
                }
                "pause" -> {
                    player?.playWhenReady = false
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

    private fun create(result: MethodChannel.Result) {
        if (player == null) {
            val entry = textures.createSurfaceTexture()
            textureEntry = entry
            val st = entry.surfaceTexture()
            val surf = Surface(st)
            surface = surf
            val p = ExoPlayer.Builder(context).build()
            p.repeatMode = Player.REPEAT_MODE_OFF
            p.setVideoSurface(surf)
            p.addListener(object : Player.Listener {
                override fun onVideoSizeChanged(videoSize: VideoSize) {
                    val w = videoSize.width
                    val h = videoSize.height
                    if (w > 0 && h > 0) {
                        st.setDefaultBufferSize(w, h)
                        events?.success(mapOf("event" to "size", "width" to w, "height" to h))
                    }
                }
            })
            player = p
        }
        startPolling()
        result.success(mapOf("textureId" to (textureEntry?.id() ?: -1L)))
    }

    private fun load(call: MethodCall, result: MethodChannel.Result) {
        @Suppress("UNCHECKED_CAST")
        val segs = (call.argument<List<Map<String, Any>>>("segments")) ?: emptyList()
        val p = player ?: run {
            result.error("ec_player", "not created", null)
            return
        }
        val items = ArrayList<MediaItem>()
        val s = LongArray(segs.size)
        val e = LongArray(segs.size)
        for (i in segs.indices) {
            val seg = segs[i]
            val uri = seg["uri"] as? String ?: continue
            val startMs = (seg["startMs"] as? Number)?.toLong() ?: 0L
            val endMs = (seg["endMs"] as? Number)?.toLong() ?: 0L
            s[i] = (seg["timelineStartMs"] as? Number)?.toLong() ?: 0L
            e[i] = (seg["timelineEndMs"] as? Number)?.toLong() ?: (s[i] + maxOf(0L, endMs - startMs))
            val clip = MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs)
            if (endMs > startMs) clip.setEndPositionMs(endMs)
            items.add(MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build())
        }
        starts = s
        ends = e
        p.setMediaItems(items)
        p.prepare()
        result.success(null)
    }

    private fun seek(call: MethodCall, result: MethodChannel.Result) {
        val ms = (call.argument<Number>("timelineMs"))?.toLong() ?: 0L
        val p = player
        if (p != null) {
            var idx = 0
            for (i in starts.indices) {
                if (ms >= starts[i] && ms < ends[i]) {
                    idx = i
                    break
                }
                if (i == starts.size - 1) idx = i
            }
            val inClip = maxOf(0L, ms - (if (idx in starts.indices) starts[idx] else 0L))
            try {
                p.seekTo(idx, inClip)
            } catch (_: Exception) {
            }
        }
        result.success(null)
    }

    private fun startPolling() {
        if (!polling) {
            polling = true
            main.postDelayed(poller, 100)
        }
    }

    private fun stopPolling() {
        polling = false
        main.removeCallbacks(poller)
    }

    private fun releaseInternal() {
        stopPolling()
        player?.let {
            try {
                it.release()
            } catch (_: Exception) {
            }
        }
        player = null
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
