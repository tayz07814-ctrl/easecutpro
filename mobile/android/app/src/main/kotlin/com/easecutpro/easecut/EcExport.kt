package com.easecutpro.easecut

import android.content.Context
import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Matrix
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
import java.nio.ByteBuffer
import java.nio.ByteOrder
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.effect.Crop
import androidx.media3.effect.MatrixTransformation
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

/** Length of the audio fade applied on each side of a cut seam (8 ms — inaudible on speech, kills the click). */
private const val SEAM_FADE_US = 8_000L

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
    // Map a pass's 0–100 progress onto a slice of the overall bar (two-pass export).
    private var progBase = 0
    private var progScale = 1f

    private val poller = object : Runnable {
        override fun run() {
            val t = transformer
            if (t != null) {
                try {
                    val state = t.getProgress(progressHolder)
                    if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
                        events?.success(mapOf("percent" to (progBase + progressHolder.progress * progScale)))
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
            "proxy" -> renderProxy(call, result)
            "extractAudio" -> extractAudio(call, result)
            "thumbnails" -> thumbnails(call, result)
            "waveform" -> waveform(call, result)
            "duration" -> duration(call, result)
            else -> result.notImplemented()
        }
    }

    private var audioTx: Transformer? = null

    // The preview proxy renders on its OWN transformer + pending, fully independent of
    // the export above, so a proxy render and a real export never block each other.
    private var proxyTx: Transformer? = null
    private var proxyPending: MethodChannel.Result? = null

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

    /** Probe a media file's duration (ms) — cheap, for multi-clip sequencing. */
    private fun duration(call: MethodCall, result: MethodChannel.Result) {
        val uri = call.argument<String>("uri")
        if (uri == null) {
            result.error("ec_export", "no uri", null)
            return
        }
        Thread {
            var durMs = 0L
            val r = MediaMetadataRetriever()
            try {
                r.setDataSource(context, Uri.parse(uri))
                durMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            } catch (_: Exception) {
            } finally {
                try {
                    r.release()
                } catch (_: Exception) {
                }
            }
            main.post { result.success(mapOf("durationMs" to durMs)) }
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

            // Overlays (images UNDER captions/text), decoded once; composited in a
            // SECOND pass over the finished single video (see below).
            val capOvs = parseOvs(captions)
            val imgOvs = parseOvs(images)

            // --- pass 1: base video sequence (trim + concat + crop/speed/size, audio
            // kept) + extra audio-only sequences (music / voiceover). Built by the
            // shared helper so the preview proxy renders the exact same base. Overlays
            // are NOT applied here — they are composited in pass 2 below. ---
            val pass1Comp = buildBaseComposition(segments, width, height, fps, audioTracks)
            val finalOut = File(context.cacheDir, "ec_export_${System.currentTimeMillis()}.mp4")
            val hasOverlays = capOvs.isNotEmpty() || imgOvs.isNotEmpty()

            pending = result
            if (!hasOverlays) {
                // No overlays → pass 1 IS the export.
                progBase = 0
                progScale = 1f
                runPass(pass1Comp, finalOut, bitrate,
                    { finishOk(finalOut, outName, it) }, { failExport(it.message) })
            } else {
                // Pass 1 → temp; then pass 2 composites the overlays onto the finished
                // single video at OUTPUT time (item-level overlays only render on the
                // first clip, so we overlay the whole concatenated video in one go).
                val tmp = File(context.cacheDir, "ec_pass1_${System.currentTimeMillis()}.mp4")
                progBase = 0
                progScale = 0.6f
                runPass(pass1Comp, tmp, bitrate, { _ ->
                    try {
                        val ovTracks = ArrayList<TextureOverlay>()
                        trackAll(imgOvs)?.let { ovTracks.add(it) } // images UNDER text
                        trackAll(capOvs)?.let { ovTracks.add(it) }
                        val vEff = ArrayList<Effect>()
                        if (ovTracks.isNotEmpty()) vEff.add(OverlayEffect(ImmutableList.copyOf(ovTracks)))
                        val item = EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(tmp)))
                            .setEffects(Effects(ImmutableList.of<AudioProcessor>(), vEff))
                            .build()
                        @Suppress("DEPRECATION")
                        val comp2 = Composition.Builder(EditedMediaItemSequence.Builder(listOf(item)).build()).build()
                        progBase = 60
                        progScale = 0.4f
                        runPass(comp2, finalOut, bitrate,
                            { tmp.delete(); finishOk(finalOut, outName, it) },
                            { tmp.delete(); failExport(it.message) })
                    } catch (e: Exception) {
                        tmp.delete()
                        failExport(e.message)
                    }
                }, { failExport(it.message) })
            }
            startPolling()
        } catch (e: Exception) {
            pending = null
            transformer = null
            result.error("ec_export", "could not start: ${e.message}", null)
        }
    }

    /**
     * Build the FLAT base composition shared by the real export (pass 1) and the
     * preview proxy: each segment trimmed + normalised (crop / speed / output size /
     * per-clip volume) and concatenated into one video sequence, plus any extra
     * audio-only sequences (music / voiceover) mixed in. NO overlays — those are a
     * separate pass. Throws if a segment is missing its uri.
     */
    private fun buildBaseComposition(
        segments: List<Map<String, Any>>,
        outW: Int,
        outH: Int,
        fps: Int,
        audioTracks: List<Map<String, Any>>?,
    ): Composition {
        val baseItems = ArrayList<EditedMediaItem>()
        val lastIndex = segments.size - 1
        for ((index, seg) in segments.withIndex()) {
            val uri = seg["uri"] as? String ?: throw IllegalArgumentException("a segment has no uri")
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
            // Ken Burns moving pan/zoom — a per-frame scale+translate that glides the
            // framing across the clip (Dart zeroes crop when this is on). Added before
            // speed so its frame timestamps run 0..span.
            if ((seg["kb"] as? Boolean) == true) {
                val fs = (seg["kbFromScale"] as? Number)?.toFloat() ?: 1f
                val ts = (seg["kbToScale"] as? Number)?.toFloat() ?: 1f
                val fx = (seg["kbFromCx"] as? Number)?.toDouble() ?: 0.5
                val fy = (seg["kbFromCy"] as? Number)?.toDouble() ?: 0.5
                val txc = (seg["kbToCx"] as? Number)?.toDouble() ?: 0.5
                val tyc = (seg["kbToCy"] as? Number)?.toDouble() ?: 0.5
                val spanUs = (if (endMs > startMs) (endMs - startMs) else 0L) * 1000.0
                vfx.add(kenBurns(fs, ts, fx, fy, txc, tyc, spanUs))
            }
            if (speed != 1f && speed > 0f) {
                vfx.add(SpeedChangeEffect(speed))
                val sonic = SonicAudioProcessor()
                sonic.setSpeed(speed)
                afx.add(sonic)
            }
            // Force output size (every clip normalised so the concat is uniform).
            vfx.add(Presentation.createForWidthAndHeight(outW, outH, Presentation.LAYOUT_SCALE_TO_FIT))

            if (volume <= 0.001f) {
                builder.setRemoveAudio(true)
            } else if (volume != 1f) {
                val mix = ChannelMixingAudioProcessor()
                mix.putChannelMixingMatrix(ChannelMixingMatrix.create(1, 1).scaleBy(volume))
                mix.putChannelMixingMatrix(ChannelMixingMatrix.create(2, 2).scaleBy(volume))
                afx.add(mix)
            }
            // Seam de-click: this base sequence is a butt-jointed concatenation of the
            // kept ranges, and a hard audio splice pops (a DC step at the join). Fade
            // this clip's audio up from / down to silence at the interior joins (never
            // the real video start/end, and not on muted clips) so both sides of every
            // seam meet at zero. Applied last, on the final post-speed/volume audio.
            if (volume > 0.001f && (index > 0 || index < lastIndex)) {
                afx.add(SeamFadeAudioProcessor(SEAM_FADE_US, index > 0, index < lastIndex))
            }
            builder.setEffects(Effects(ImmutableList.copyOf(afx), ImmutableList.copyOf(vfx)))
            if (fps > 0) builder.setFrameRate(fps)
            baseItems.add(builder.build())
        }
        val sequences = ArrayList<EditedMediaItemSequence>()
        @Suppress("DEPRECATION")
        sequences.add(EditedMediaItemSequence.Builder(baseItems).build())

        // --- extra audio sequences (music / voiceover) — audio only, mixed in.
        // A track placed later on the timeline gets a silent WAV lead-in so it
        // starts at the right moment; per-track gain via a channel-mixing matrix.
        audioTracks?.forEach { a ->
            val uri = a["uri"] as? String ?: return@forEach
            val startMs = (a["startMs"] as? Number)?.toLong() ?: 0L
            val endMs = (a["endMs"] as? Number)?.toLong() ?: 0L
            val tlStart = (a["timelineStartMs"] as? Number)?.toLong() ?: 0L
            val vol = (a["volume"] as? Number)?.toFloat() ?: 1f
            if (vol <= 0.001f) return@forEach // fully muted — nothing to mix
            val clip = MediaItem.ClippingConfiguration.Builder().setStartPositionMs(startMs)
            if (endMs > startMs) clip.setEndPositionMs(endMs)
            val mi = MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build()
            val ab = EditedMediaItem.Builder(mi).setRemoveVideo(true)
            if (vol != 1f) {
                val mix = ChannelMixingAudioProcessor()
                mix.putChannelMixingMatrix(ChannelMixingMatrix.create(1, 1).scaleBy(vol))
                mix.putChannelMixingMatrix(ChannelMixingMatrix.create(2, 2).scaleBy(vol))
                ab.setEffects(Effects(ImmutableList.of<AudioProcessor>(mix), ImmutableList.of<Effect>()))
            }
            val seqItems = ArrayList<EditedMediaItem>()
            if (tlStart > 0) {
                silentWav(tlStart)?.let { s ->
                    seqItems.add(EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(s))).build())
                }
            }
            seqItems.add(ab.build())
            @Suppress("DEPRECATION")
            sequences.add(EditedMediaItemSequence.Builder(seqItems).build())
        }

        return Composition.Builder(sequences).build()
    }

    /**
     * A Ken Burns time-varying transform. Per output frame it lerps a zoom (scale ≥1)
     * and a visible-window CENTRE (0..1) between the from/to keyframes, then returns
     * the NDC matrix that shows that window (translate the centre to the origin, then
     * scale up). The window is clamped inside the frame so it never reveals an edge.
     * [spanUs] is the clip's pre-speed duration; the effect runs before any speed
     * change, so frame timestamps arrive as 0..span.
     */
    private fun kenBurns(
        fromScale: Float,
        toScale: Float,
        fromCx: Double,
        fromCy: Double,
        toCx: Double,
        toCy: Double,
        spanUs: Double,
    ): MatrixTransformation {
        // Normalise against the FIRST frame this instance sees (a fresh instance per
        // clip) so it works whether Media3 hands us clip-relative or sequence-cumulative
        // timestamps — either way `rel` runs 0..span across this clip.
        var baseUs = Long.MIN_VALUE
        return MatrixTransformation { presentationTimeUs ->
            if (baseUs == Long.MIN_VALUE) baseUs = presentationTimeUs
            val rel = (presentationTimeUs - baseUs).toDouble()
            val f = if (spanUs > 0.0) (rel / spanUs).coerceIn(0.0, 1.0) else 0.0
            val s = (fromScale + (toScale - fromScale) * f.toFloat()).coerceAtLeast(1.0f)
            val half = (1.0 / s) / 2.0
            val cx = (fromCx + (toCx - fromCx) * f).coerceIn(half, 1.0 - half)
            val cy = (fromCy + (toCy - fromCy) * f).coerceIn(half, 1.0 - half)
            val ndcx = (cx * 2.0 - 1.0).toFloat()
            val ndcy = -(cy * 2.0 - 1.0).toFloat() // image y-down → NDC y-up
            val m = Matrix()
            m.postTranslate(-ndcx, -ndcy)
            m.postScale(s, s)
            m
        }
    }

    /**
     * A tiny seam de-clicker used only inside the offline Transformer passes (export +
     * preview proxy — never the live player). It linearly fades the first [fadeUs] of
     * the clip up from silence (when [fadeIn]) and holds back the last [fadeUs] so it
     * can ramp down to silence at end-of-stream (when [fadeOut]). Because Media3
     * concatenates sequence items without overlap, this is a fade-to-zero on each side
     * of a join — both sides meet at 0, so the hard splice no longer pops. PCM16 only;
     * any other encoding is passed straight through. Runs offline, so the per-call
     * scratch allocation is fine.
     */
    private class SeamFadeAudioProcessor(
        private val fadeUs: Long,
        private val fadeIn: Boolean,
        private val fadeOut: Boolean,
    ) : BaseAudioProcessor() {
        private var channels = 0
        private var fadeFrames = 1
        private var framePos = 0L
        private var hold = ShortArray(0) // frames retained so the tail can ramp down on EOS
        private var heldFrames = 0

        override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
            if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT || (!fadeIn && !fadeOut)) {
                return AudioProcessor.AudioFormat.NOT_SET // unsupported / nothing to do → passthrough
            }
            channels = inputAudioFormat.channelCount
            fadeFrames = Math.max(1, (inputAudioFormat.sampleRate.toLong() * fadeUs / 1_000_000L).toInt())
            hold = ShortArray(fadeFrames * channels)
            return inputAudioFormat
        }

        override fun queueInput(inputBuffer: ByteBuffer) {
            val bpf = 2 * channels // bytes per frame (16-bit × channels)
            val inFrames = inputBuffer.remaining() / bpf
            if (inFrames == 0) return
            val total = heldFrames + inFrames
            // combined = retained tail (heldFrames) followed by the new input frames
            val combined = ShortArray(total * channels)
            System.arraycopy(hold, 0, combined, 0, heldFrames * channels)
            var w = heldFrames * channels
            repeat(inFrames * channels) { combined[w++] = inputBuffer.getShort() }
            // Emit all but the last fadeFrames (kept back so we can ramp the true tail).
            val emit = if (fadeOut) Math.max(0, total - fadeFrames) else total
            if (emit > 0) {
                val out = replaceOutputBuffer(emit * bpf)
                for (f in 0 until emit) {
                    val g = framePos + f
                    val gain = if (fadeIn && g < fadeFrames) g.toDouble() / fadeFrames else 1.0
                    for (c in 0 until channels) {
                        val s = combined[f * channels + c]
                        out.putShort(if (gain >= 1.0) s else (s * gain).toInt().toShort())
                    }
                }
                out.flip()
                framePos += emit
            }
            val keep = total - emit
            System.arraycopy(combined, emit * channels, hold, 0, keep * channels)
            heldFrames = keep
        }

        override fun onQueueEndOfStream() {
            if (heldFrames == 0) return
            val bpf = 2 * channels
            val out = replaceOutputBuffer(heldFrames * bpf)
            for (h in 0 until heldFrames) {
                val g = framePos + h
                val gIn = if (fadeIn && g < fadeFrames) g.toDouble() / fadeFrames else 1.0
                val gOut = if (fadeOut) Math.min(1.0, (heldFrames - 1 - h).toDouble() / fadeFrames) else 1.0
                val gain = Math.min(gIn, gOut)
                for (c in 0 until channels) {
                    val s = hold[h * channels + c]
                    out.putShort(if (gain >= 1.0) s else (s * gain).toInt().toShort())
                }
            }
            out.flip()
            framePos += heldFrames
            heldFrames = 0
        }

        override fun onFlush() {
            framePos = 0
            heldFrames = 0
        }
    }

    /**
     * Render a FLAT low-res preview proxy — the export's pass-1 base (video + main
     * audio, crop/speed/size baked, NO overlays and NO extra audio tracks) — to a temp
     * MP4. Playing this single file back is seamless across cut boundaries. Runs on its
     * OWN transformer + pending so it never blocks (or is blocked by) a real export.
     * Resolves { path, durationMs }; durationMs is the summed timeline length so the
     * Dart timeline maps 1:1 onto the proxy.
     */
    @Suppress("UNCHECKED_CAST")
    private fun renderProxy(call: MethodCall, result: MethodChannel.Result) {
        try {
            val segments = (call.argument<List<Map<String, Any>>>("segments")) ?: emptyList()
            if (segments.isEmpty()) {
                result.error("ec_export", "No segments for proxy", null)
                return
            }
            val height = (call.argument<Number>("height"))?.toInt() ?: 540
            val aspect = (call.argument<Number>("aspect"))?.toDouble() ?: (16.0 / 9.0)
            // Even output dims (encoders require it); width derived from the aspect (w/h).
            val outH = (if (height >= 2) height else 540).let { if (it % 2 == 0) it else it - 1 }
            var outW = Math.round(outH * (if (aspect > 0.0) aspect else 16.0 / 9.0)).toInt()
            if (outW % 2 != 0) outW += 1
            if (outW < 2) outW = 2

            // Summed timeline length (Σ (endMs-startMs)/speed) — matches the Dart totalMs.
            var durMs = 0L
            for (seg in segments) {
                val s0 = (seg["startMs"] as? Number)?.toLong() ?: 0L
                val e0 = (seg["endMs"] as? Number)?.toLong() ?: 0L
                val sp = (seg["speed"] as? Number)?.toDouble() ?: 1.0
                val span = if (e0 > s0) (e0 - s0) else 0L
                durMs += Math.round(span / (if (sp > 0.0) sp else 1.0))
            }

            // Supersede any in-flight proxy (never touches the export's transformer).
            cancelProxy()

            val comp = buildBaseComposition(segments, outW, outH, 0, null)
            val out = File(context.cacheDir, "ec_proxy_${System.currentTimeMillis()}.mp4")
            val fDur = durMs
            proxyPending = result
            val t = Transformer.Builder(context)
                .setEncoderFactory(
                    DefaultEncoderFactory.Builder(context)
                        .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(2_500_000).build())
                        .setEnableFallback(true)
                        .build()
                )
                .addListener(object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        if (proxyPending === result) {
                            proxyTx = null
                            proxyPending = null
                            result.success(mapOf("path" to out.absolutePath, "durationMs" to fDur))
                        }
                    }

                    override fun onError(composition: Composition, exportResult: ExportResult, exception: ExportException) {
                        if (proxyPending === result) {
                            proxyTx = null
                            proxyPending = null
                            result.error("ec_export", "proxy failed: ${exception.message}", null)
                        }
                    }
                })
                .build()
            proxyTx = t
            t.start(comp, out.absolutePath)
        } catch (e: Exception) {
            proxyTx = null
            proxyPending = null
            result.error("ec_export", "proxy could not start: ${e.message}", null)
        }
    }

    /** Cancel any in-flight proxy render (on the main thread) and resolve its pending. */
    private fun cancelProxy() {
        val tx = proxyTx
        proxyTx = null
        val old = proxyPending
        proxyPending = null
        if (tx != null) {
            try {
                tx.cancel()
            } catch (_: Exception) {
            }
        }
        old?.error("ec_export", "proxy superseded", null)
    }

    /** Start a Transformer pass; [onDone]/[onErr] fire on the main thread. */
    private fun runPass(
        composition: Composition,
        outFile: File,
        bitrate: Int,
        onDone: (ExportResult) -> Unit,
        onErr: (ExportException) -> Unit,
    ) {
        val tb = Transformer.Builder(context)
        if (bitrate > 0) {
            tb.setEncoderFactory(
                DefaultEncoderFactory.Builder(context)
                    .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(bitrate).build())
                    .setEnableFallback(true)
                    .build()
            )
        }
        val t = tb.addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, exportResult: ExportResult) = onDone(exportResult)
            override fun onError(composition: Composition, exportResult: ExportResult, exception: ExportException) =
                onErr(exception)
        }).build()
        transformer = t
        t.start(composition, outFile.absolutePath)
    }

    private fun finishOk(out: File, outName: String, r: ExportResult) {
        stopPolling()
        var savedTo: String? = null
        try {
            savedTo = saveToGallery(out, outName)
        } catch (_: Exception) {
        }
        val ret = HashMap<String, Any?>()
        ret["path"] = out.absolutePath
        ret["durationMs"] = r.durationMs
        if (savedTo != null) ret["savedTo"] = savedTo
        pending?.success(ret)
        pending = null
        transformer = null
    }

    private fun failExport(msg: String?) {
        stopPolling()
        pending?.error("ec_export", msg, null)
        pending = null
        transformer = null
    }

    // Cache of silent lead-in WAVs by duration so repeated exports reuse them.
    private val silenceCache = HashMap<Long, File>()

    /** A [durationMs] file of PCM silence (44.1k/stereo/16-bit) to offset an audio track. */
    private fun silentWav(durationMs: Long): File? {
        if (durationMs <= 0) return null
        silenceCache[durationMs]?.let { if (it.exists()) return it }
        return try {
            val sampleRate = 44100
            val channels = 2
            val bytesPerSample = 2
            val frames = (durationMs * sampleRate / 1000L).toInt()
            val dataSize = frames * channels * bytesPerSample
            val f = File(context.cacheDir, "ec_silence_${durationMs}.wav")
            FileOutputStream(f).use { fos ->
                fos.write(wavHeader(dataSize, sampleRate, channels, bytesPerSample))
                val zeros = ByteArray(8192)
                var remaining = dataSize
                while (remaining > 0) {
                    val n = minOf(zeros.size, remaining)
                    fos.write(zeros, 0, n)
                    remaining -= n
                }
            }
            silenceCache[durationMs] = f
            f
        } catch (_: Exception) {
            null
        }
    }

    private fun wavHeader(dataSize: Int, sampleRate: Int, channels: Int, bytesPerSample: Int): ByteArray {
        val byteRate = sampleRate * channels * bytesPerSample
        val blockAlign = channels * bytesPerSample
        val h = ByteArray(44)
        fun putStr(off: Int, s: String) { for (i in s.indices) h[off + i] = s[i].code.toByte() }
        fun putIntLE(off: Int, v: Int) {
            h[off] = (v and 0xff).toByte()
            h[off + 1] = ((v shr 8) and 0xff).toByte()
            h[off + 2] = ((v shr 16) and 0xff).toByte()
            h[off + 3] = ((v shr 24) and 0xff).toByte()
        }
        fun putShortLE(off: Int, v: Int) {
            h[off] = (v and 0xff).toByte()
            h[off + 1] = ((v shr 8) and 0xff).toByte()
        }
        putStr(0, "RIFF"); putIntLE(4, dataSize + 36); putStr(8, "WAVE")
        putStr(12, "fmt "); putIntLE(16, 16); putShortLE(20, 1)
        putShortLE(22, channels); putIntLE(24, sampleRate); putIntLE(28, byteRate)
        putShortLE(32, blockAlign); putShortLE(34, bytesPerSample * 8)
        putStr(36, "data"); putIntLE(40, dataSize)
        return h
    }

    /** A baked overlay PNG with its window on the OUTPUT timeline (ms). */
    private class Ov(val png: ByteArray, val startMs: Long, val endMs: Long)

    /** Decode [{ base64, startMs, endMs }] overlays into timeline-space [Ov]s. */
    private fun parseOvs(arr: List<Map<String, Any>>?): List<Ov> {
        val out = ArrayList<Ov>()
        if (arr == null) return out
        for (o in arr) {
            val b64 = o["base64"] as? String ?: continue
            val png = try {
                Base64.decode(b64, Base64.DEFAULT)
            } catch (_: Exception) {
                continue
            }
            out.add(Ov(png, (o["startMs"] as? Number)?.toLong() ?: 0L, (o["endMs"] as? Number)?.toLong() ?: 0L))
        }
        return out
    }

    /** All overlays as one timed track at OUTPUT time (µs) — for the single-item pass 2. */
    private fun trackAll(all: List<Ov>): TimedOverlay? {
        val items = ArrayList<TimedOverlay.Item>()
        for (o in all) {
            val s = o.startMs * 1000L
            val e = o.endMs * 1000L
            if (e > s) items.add(TimedOverlay.Item(o.png, s, e))
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
        try {
            proxyTx?.cancel()
        } catch (_: Exception) {
        }
        proxyTx = null
        proxyPending = null
    }
}
