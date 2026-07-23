package com.easecutpro.easecut

import android.content.Context
import android.content.ContentValues
import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.nio.ByteOrder
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.effect.Crop
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.SpeedChangeEffect
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
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
            "extractAudio" -> extractAudio(call, result)
            "thumbnails" -> thumbnails(call, result)
            "waveform" -> waveform(call, result)
            else -> result.notImplemented()
        }
    }

    private var audioTx: Transformer? = null

    /** Extract the source's audio to a compact AAC .m4a (for Cut Lord transcription). */
    private fun extractAudio(call: MethodCall, result: MethodChannel.Result) {
        val uri = call.argument<String>("uri")
        if (uri == null) {
            result.error("ec_export", "no uri", null)
            return
        }
        try {
            val item = EditedMediaItem.Builder(MediaItem.fromUri(uri)).setRemoveVideo(true).build()
            val out = File(context.cacheDir, "ec_audio_${System.currentTimeMillis()}.m4a")
            val t = Transformer.Builder(context)
                .setAudioMimeType(MimeTypes.AUDIO_AAC)
                .addListener(object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        audioTx = null
                        result.success(mapOf("path" to out.absolutePath))
                    }

                    override fun onError(composition: Composition, exportResult: ExportResult, exception: ExportException) {
                        audioTx = null
                        result.error("ec_export", "audio extract failed: ${exception.message}", null)
                    }
                })
                .build()
            audioTx = t
            t.start(item, out.absolutePath)
        } catch (e: Exception) {
            result.error("ec_export", "audio extract could not start: ${e.message}", null)
        }
    }

    /** Evenly-spaced frames as small JPEGs (base64) for the timeline filmstrip. */
    private fun thumbnails(call: MethodCall, result: MethodChannel.Result) {
        val uri = call.argument<String>("uri")
        val count = (call.argument<Number>("count"))?.toInt() ?: 10
        if (uri == null) {
            result.error("ec_export", "no uri", null)
            return
        }
        Thread {
            val frames = ArrayList<Map<String, Any>>()
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(context, Uri.parse(uri))
                val durMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                val n = count.coerceIn(1, 40)
                for (i in 0 until n) {
                    val tMs = if (n == 1) durMs / 2 else durMs * i / (n - 1)
                    val bmp = r.getFrameAtTime(tMs * 1000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) ?: continue
                    val th = 160
                    val tw = (bmp.width * th / maxOf(1, bmp.height)).coerceAtLeast(1)
                    val scaled = Bitmap.createScaledBitmap(bmp, tw, th, true)
                    val baos = ByteArrayOutputStream()
                    scaled.compress(Bitmap.CompressFormat.JPEG, 55, baos)
                    frames.add(mapOf("ms" to tMs, "jpeg" to Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)))
                    if (scaled != bmp) scaled.recycle()
                    bmp.recycle()
                }
            } catch (_: Exception) {
            } finally {
                try {
                    r.release()
                } catch (_: Exception) {
                }
            }
            main.post { result.success(mapOf("frames" to frames)) }
        }.start()
    }

    /** Decode the audio track to PCM and return [buckets] normalized (0..1) abs-max peaks. */
    private fun waveform(call: MethodCall, result: MethodChannel.Result) {
        val uri = call.argument<String>("uri")
        val buckets = (call.argument<Number>("buckets"))?.toInt()?.coerceIn(32, 2000) ?: 400
        if (uri == null) {
            result.error("ec_export", "no uri", null)
            return
        }
        Thread {
            val peaks = ArrayList<Float>() // downsampled abs-max, ~one per 1024 samples
            var extractor: MediaExtractor? = null
            var codec: MediaCodec? = null
            try {
                extractor = MediaExtractor()
                extractor.setDataSource(context, Uri.parse(uri), null)
                var trackIndex = -1
                var format: MediaFormat? = null
                for (i in 0 until extractor.trackCount) {
                    val f = extractor.getTrackFormat(i)
                    val mime = f.getString(MediaFormat.KEY_MIME) ?: ""
                    if (mime.startsWith("audio/")) {
                        trackIndex = i
                        format = f
                        break
                    }
                }
                if (trackIndex >= 0 && format != null) {
                    extractor.selectTrack(trackIndex)
                    codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
                    codec.configure(format, null, null, 0)
                    codec.start()
                    val info = MediaCodec.BufferInfo()
                    var sawInputEOS = false
                    var sawOutputEOS = false
                    var acc = 0f
                    var accCount = 0
                    val downs = 1024
                    while (!sawOutputEOS) {
                        if (!sawInputEOS) {
                            val inIndex = codec.dequeueInputBuffer(10000)
                            if (inIndex >= 0) {
                                val inBuf = codec.getInputBuffer(inIndex)!!
                                val sampleSize = extractor.readSampleData(inBuf, 0)
                                if (sampleSize < 0) {
                                    codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                    sawInputEOS = true
                                } else {
                                    codec.queueInputBuffer(inIndex, 0, sampleSize, extractor.sampleTime, 0)
                                    extractor.advance()
                                }
                            }
                        }
                        val outIndex = codec.dequeueOutputBuffer(info, 10000)
                        if (outIndex >= 0) {
                            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEOS = true
                            if (info.size > 0) {
                                val outBuf = codec.getOutputBuffer(outIndex)!!
                                outBuf.position(info.offset)
                                outBuf.limit(info.offset + info.size)
                                val sb = outBuf.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                                val n = sb.remaining()
                                var k = 0
                                while (k < n) {
                                    val v = kotlin.math.abs(sb.get(k).toInt()) / 32768f
                                    if (v > acc) acc = v
                                    accCount++
                                    if (accCount >= downs) {
                                        peaks.add(acc)
                                        acc = 0f
                                        accCount = 0
                                    }
                                    k++
                                }
                            }
                            codec.releaseOutputBuffer(outIndex, false)
                        }
                    }
                    if (accCount > 0) peaks.add(acc)
                }
            } catch (_: Exception) {
            } finally {
                try {
                    codec?.stop()
                } catch (_: Exception) {
                }
                try {
                    codec?.release()
                } catch (_: Exception) {
                }
                try {
                    extractor?.release()
                } catch (_: Exception) {
                }
            }
            // Resample the downsampled peaks to exactly [buckets] (max per segment), normalized.
            val out = DoubleArray(buckets)
            if (peaks.isNotEmpty()) {
                var maxV = 0f
                for (i in 0 until buckets) {
                    val a = (i.toLong() * peaks.size / buckets).toInt()
                    var b = ((i + 1).toLong() * peaks.size / buckets).toInt()
                    if (b <= a) b = a + 1
                    if (b > peaks.size) b = peaks.size
                    var m = 0f
                    var j = a
                    while (j < b) {
                        if (peaks[j] > m) m = peaks[j]
                        j++
                    }
                    out[i] = m.toDouble()
                    if (m > maxV) maxV = m
                }
                if (maxV > 0f) {
                    for (i in out.indices) out[i] = (out[i] / maxV).coerceIn(0.0, 1.0)
                }
            }
            main.post { result.success(mapOf("peaks" to out.toList())) }
        }.start()
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
            val fps = (call.argument<Number>("fps"))?.toInt() ?: 0
            val bitrate = (call.argument<Number>("bitrate"))?.toInt() ?: 0
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
                val speed = (seg["speed"] as? Number)?.toFloat() ?: 1f
                val volume = (seg["volume"] as? Number)?.toFloat() ?: 1f
                val cl = (seg["cropL"] as? Number)?.toFloat() ?: 0f
                val ct = (seg["cropT"] as? Number)?.toFloat() ?: 0f
                val cr = (seg["cropR"] as? Number)?.toFloat() ?: 0f
                val cb = (seg["cropB"] as? Number)?.toFloat() ?: 0f
                val clip = MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs)
                if (endMs > startMs) clip.setEndPositionMs(endMs)
                val mi = MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build()

                val builder = EditedMediaItem.Builder(mi)
                val vfx = ArrayList<Effect>()
                val afx = ArrayList<AudioProcessor>()
                // Crop (fractions off each edge → NDC [-1,1]); applied before speed.
                if (cl > 0f || ct > 0f || cr > 0f || cb > 0f) {
                    vfx.add(Crop(-1f + 2f * cl, 1f - 2f * cr, -1f + 2f * cb, 1f - 2f * ct))
                }
                if (speed != 1f && speed > 0f) {
                    vfx.add(SpeedChangeEffect(speed))
                    val sonic = SonicAudioProcessor()
                    sonic.setSpeed(speed)
                    afx.add(sonic)
                }
                if (volume <= 0.001f) {
                    builder.setRemoveAudio(true)
                } else if (volume != 1f) {
                    val mix = ChannelMixingAudioProcessor()
                    mix.putChannelMixingMatrix(ChannelMixingMatrix.create(1, 1).scaleBy(volume))
                    mix.putChannelMixingMatrix(ChannelMixingMatrix.create(2, 2).scaleBy(volume))
                    afx.add(mix)
                }
                if (vfx.isNotEmpty() || afx.isNotEmpty()) {
                    builder.setEffects(Effects(ImmutableList.copyOf(afx), ImmutableList.copyOf(vfx)))
                }
                if (fps > 0) builder.setFrameRate(fps)
                baseItems.add(builder.build())
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
            val tb = Transformer.Builder(context)
            if (bitrate > 0) {
                tb.setEncoderFactory(
                    DefaultEncoderFactory.Builder(context)
                        .setRequestedVideoEncoderSettings(
                            VideoEncoderSettings.Builder().setBitrate(bitrate).build()
                        )
                        .setEnableFallback(true)
                        .build()
                )
            }
            val t = tb
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
