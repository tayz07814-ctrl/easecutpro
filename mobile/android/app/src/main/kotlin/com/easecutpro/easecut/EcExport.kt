package com.easecutpro.easecut

import android.content.Context
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import com.google.common.collect.ImmutableList
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream

/**
 * Native FULL export via Media3 Transformer — the phone's hardware codecs encode the
 * whole edit:
 *   - base video: each clip trimmed + concatenated (sequence 0), audio kept;
 *   - captions / text / images: baked to full-frame bitmaps in Dart, composited as a
 *     timed OverlayEffect at the output resolution (see [TimedOverlay]);
 *   - extra audio tracks (music / voiceover): each an audio-only sequence, mixed in.
 *
 * Output is forced to width×height (Presentation) so the baked bitmaps map 1:1. On
 * success the MP4 is published into Movies/EaseCutPro.
 *
 * Channels:
 *   MethodChannel "ec/export"        ping / export (resolves on completion)
 *   EventChannel  "ec/export/events" {percent} progress
 */
class EcExport(
    private val context: Context,
    messenger: BinaryMessenger
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {

    private val methodChannel = MethodChannel(messenger, "ec/export")
    private val eventChannel = EventChannel(messenger, "ec/export/events")

    private var events: EventChannel.EventSink? = null
    private var pending: MethodChannel.Result? = null
    private var transformer: Transformer? = null
    private val progressHolder = ProgressHolder()
    private val main = Handler(Looper.getMainLooper())
    private var polling = false

    private val poller = object : Runnable {
        override fun run() {
            val t = transformer
            if (t != null) {
                try {
                    val state = t.getProgress(progressHolder)
                    if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
                        events?.success(mapOf("percent" to progressHolder.progress))
                    }
                } catch (_: Exception) {
                }
            }
            if (polling) main.postDelayed(this, 250)
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
        when (call.method) {
            "ping" -> result.success(mapOf("ok" to true))
            "export" -> startExport(call, result)
            else -> result.notImplemented()
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun startExport(call: MethodCall, result: MethodChannel.Result) {
        if (pending != null) {
            result.error("ec_export", "an export is already running", null)
            return
        }
        try {
            val segments = (call.argument<List<Map<String, Any>>>("segments")) ?: emptyList()
            if (segments.isEmpty()) {
                result.error("ec_export", "No segments to export", null)
                return
            }
            val width = (call.argument<Number>("width"))?.toInt() ?: 1080
            val height = (call.argument<Number>("height"))?.toInt() ?: 1920
            val outName = call.argument<String>("filename")
                ?: "EaseCutPro_${System.currentTimeMillis()}.mp4"
            val captions = call.argument<List<Map<String, Any>>>("captions")
            val images = call.argument<List<Map<String, Any>>>("images")
            val audioTracks = call.argument<List<Map<String, Any>>>("audioTracks")

            // --- base video sequence (trim + concat, audio kept) ---
            val baseItems = ArrayList<EditedMediaItem>()
            for (seg in segments) {
                val uri = seg["uri"] as? String ?: run {
                    result.error("ec_export", "a segment has no uri", null)
                    return
                }
                val startMs = (seg["startMs"] as? Number)?.toLong() ?: 0L
                val endMs = (seg["endMs"] as? Number)?.toLong() ?: 0L
                val clip = MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs)
                if (endMs > startMs) clip.setEndPositionMs(endMs)
                val mi = MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build()
                baseItems.add(EditedMediaItem.Builder(mi).build())
            }
            val sequences = ArrayList<EditedMediaItemSequence>()
            sequences.add(EditedMediaItemSequence(baseItems))

            // --- extra audio sequences (music / voiceover) — audio only, mixed in ---
            audioTracks?.forEach { a ->
                val uri = a["uri"] as? String ?: return@forEach
                val startMs = (a["startMs"] as? Number)?.toLong() ?: 0L
                val endMs = (a["endMs"] as? Number)?.toLong() ?: 0L
                val clip = MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs)
                if (endMs > startMs) clip.setEndPositionMs(endMs)
                val mi = MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build()
                val item = EditedMediaItem.Builder(mi).setRemoveVideo(true).build()
                sequences.add(EditedMediaItemSequence(listOf(item)))
            }

            // --- video effects: force output size + composite caption / image overlays ---
            val videoEffects = ArrayList<Effect>()
            videoEffects.add(
                Presentation.createForWidthAndHeight(width, height, Presentation.LAYOUT_SCALE_TO_FIT)
            )
            val overlays = ArrayList<TextureOverlay>()
            buildTrack(images)?.let { overlays.add(it) } // images UNDER text
            buildTrack(captions)?.let { overlays.add(it) }
            if (overlays.isNotEmpty()) {
                videoEffects.add(OverlayEffect(ImmutableList.copyOf(overlays)))
            }

            val out = File(context.cacheDir, "ec_export_${System.currentTimeMillis()}.mp4")
            val effects = Effects(ImmutableList.of<AudioProcessor>(), videoEffects)
            val composition = Composition.Builder(sequences).setEffects(effects).build()

            pending = result
            val t = Transformer.Builder(context)
                .addListener(object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        stopPolling()
                        var savedTo: String? = null
                        try {
                            savedTo = saveToGallery(out, outName)
                        } catch (_: Exception) {
                        }
                        val ret = HashMap<String, Any?>()
                        ret["path"] = out.absolutePath
                        ret["durationMs"] = exportResult.durationMs
                        if (savedTo != null) ret["savedTo"] = savedTo
                        pending?.success(ret)
                        pending = null
                        transformer = null
                    }

                    override fun onError(
                        composition: Composition,
                        exportResult: ExportResult,
                        exception: ExportException
                    ) {
                        stopPolling()
                        pending?.error("ec_export", exception.message, null)
                        pending = null
                        transformer = null
                    }
                })
                .build()
            transformer = t
            t.start(composition, out.absolutePath)
            startPolling()
        } catch (e: Exception) {
            pending = null
            transformer = null
            result.error("ec_export", "could not start: ${e.message}", null)
        }
    }

    /** Build a timed overlay track from [{ base64, startMs, endMs }], or null if empty. */
    private fun buildTrack(arr: List<Map<String, Any>>?): TimedOverlay? {
        if (arr == null || arr.isEmpty()) return null
        val items = ArrayList<TimedOverlay.Item>()
        try {
            for (o in arr) {
                val b64 = o["base64"] as? String ?: continue
                val png = Base64.decode(b64, Base64.DEFAULT)
                val s = ((o["startMs"] as? Number)?.toLong() ?: 0L) * 1000L
                val e = ((o["endMs"] as? Number)?.toLong() ?: 0L) * 1000L
                items.add(TimedOverlay.Item(png, s, e))
            }
        } catch (_: Exception) {
            return null
        }
        return if (items.isEmpty()) null else TimedOverlay(items)
    }

    private fun startPolling() {
        if (!polling) {
            polling = true
            main.postDelayed(poller, 250)
        }
    }

    private fun stopPolling() {
        polling = false
        main.removeCallbacks(poller)
    }

    /** Publish the finished MP4 into Movies/EaseCutPro so it appears in the gallery. */
    private fun saveToGallery(src: File, displayName: String): String? {
        return try {
            val resolver = context.contentResolver
            val values = ContentValues()
            values.put(MediaStore.Video.Media.DISPLAY_NAME, displayName)
            values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            if (Build.VERSION.SDK_INT >= 29) {
                values.put(
                    MediaStore.Video.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_MOVIES + "/EaseCutPro"
                )
                values.put(MediaStore.Video.Media.IS_PENDING, 1)
                val collection =
                    MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                val item = resolver.insert(collection, values) ?: return null
                resolver.openOutputStream(item).use { os -> copyStream(src, os) }
                values.clear()
                values.put(MediaStore.Video.Media.IS_PENDING, 0)
                resolver.update(item, values, null, null)
                "Movies/EaseCutPro/$displayName"
            } else {
                val moviesDir = File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES),
                    "EaseCutPro"
                )
                if (!moviesDir.exists()) moviesDir.mkdirs()
                val dest = File(moviesDir, displayName)
                FileOutputStream(dest).use { os -> copyStream(src, os) }
                values.put(MediaStore.Video.Media.DATA, dest.absolutePath)
                resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
                "Movies/EaseCutPro/$displayName"
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun copyStream(src: File, os: OutputStream?) {
        if (os == null) throw Exception("no output stream")
        FileInputStream(src).use { input ->
            val buf = ByteArray(1024 * 256)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                os.write(buf, 0, n)
            }
            os.flush()
        }
    }

    fun dispose() {
        methodChannel.setMethodCallHandler(null)
        eventChannel.setStreamHandler(null)
        stopPolling()
        transformer = null
        pending = null
    }
}
