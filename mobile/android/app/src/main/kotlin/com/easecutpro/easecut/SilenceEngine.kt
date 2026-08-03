package com.easecutpro.easecut

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.File
import java.nio.ByteOrder
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * The two-pass silence engine — transcript timestamps first, RMS energy second,
 * one keep-mask. No model, no ONNX (the FSMN VAD is gone: it segfaulted on some
 * devices and cost several MB of APK). Everything here is arithmetic over the
 * decoded audio, so every decision is deterministic and explainable.
 *
 * The mask, in order:
 *  1. KEPT WORDS (passed in from the app: the transcript minus the AI's word cuts)
 *     are protected. Their edges may be walked inward by up to `trimEdgeS`, but
 *     only while the audio there is actually below the silence threshold —
 *     AssemblyAI pads word END times through trailing silence, so an
 *     energy-verified shrink eats that dead air without ever clipping speech.
 *     Word STARTS get half the allowance: onsets ("m" of "my") are low-energy and
 *     clip easily.
 *  2. ENERGY-ACTIVE REGIONS (RMS over an adaptive threshold) that fall OUTSIDE
 *     word spans are protected too — real sound the transcript missed. Two island
 *     rules: blips under 120 ms that overlap no word are clicks/taps → silence;
 *     with `removeBreaths` on, non-word islands under 400 ms (breaths, lip smacks)
 *     → silence as well.
 *  3. Everything not protected is a gap. Gaps at least `minSilenceS` long become
 *     cuts, shrunk by `padLeftS` at their start (air kept after speech ends) and
 *     `padRightS` at their end (lead kept before speech resumes). Each cut edge
 *     then valley-snaps ±30 ms (within its pad zone) to the locally quietest
 *     frame, so seams land on the deadest instant.
 *
 * The threshold is ADAPTIVE: noise floor = 10th percentile of 20 ms frame RMS,
 * threshold = floor + sensitivity dB, capped below the 90th percentile (speech)
 * so a noisy clip can't have its quiet speech eaten. Absolute dBFS settings can't
 * do this — a car vlog and a studio take differ by 30 dB.
 *
 * THIS CODE RUNS IN ITS OWN OS PROCESS (see [VadProvider], android:process=
 * ":vadengine"): the MediaCodec decoder is still native code, and a native fault
 * there kills only the helper process — the app's binder call throws, EcVad
 * reports the stage recorded in [stageFile] and falls back to word-gap silence.
 *
 * Memory: the decode resamples to 16 kHz mono 16-bit inline (~19 MB per 10 min);
 * the RMS scan adds one float per 10 ms hop. Nothing else is materialised.
 */
object SilenceEngine {

    /** filesDir is per-APP (shared by both processes), so the app side can read which
     *  stage was in flight when the helper process died. */
    private fun stageFile(context: Context) = File(context.filesDir, "ec_vad_stage")

    private fun stage(context: Context, s: String) {
        try {
            stageFile(context).writeText(s)
        } catch (_: Exception) {
        }
    }

    /**
     * Full pipeline. [wordsS] is the KEPT transcript as flattened [start, end, …]
     * pairs in seconds, sorted. Returns cut regions [startS, endS] to REMOVE.
     * Throws on any catchable failure (the caller reports it); a native fault kills
     * this process and the caller learns the stage from [stageFile].
     */
    fun detect(
        context: Context,
        uri: String,
        wordsS: DoubleArray,
        minSilenceS: Double,
        padLeftS: Double,
        padRightS: Double,
        trimEdgeS: Double,
        removeBreaths: Boolean,
        sensitivityDb: Double
    ): List<DoubleArray> {
        stage(context, "audio decode")
        val (pcm, count) = decodeMono16k(context, uri)
        if (count <= 0) throw IllegalStateException("decoder produced no audio samples")
        val durationS = count.toDouble() / TARGET_RATE

        stage(context, "energy scan")
        val rmsDb = frameRmsDb(pcm, count)
        val thr = adaptiveThresholdDb(rmsDb, sensitivityDb)
        val active = activeIntervals(rmsDb, thr, durationS)

        stage(context, "cut geometry")
        val words = mergeIntervals(pairsToIntervals(wordsS, durationS))
        val protected_ = buildProtected(words, active, trimEdgeS, rmsDb, thr, removeBreaths)
        val cuts = gapsToCuts(protected_, durationS, minSilenceS, padLeftS, padRightS, rmsDb)
        stage(context, "done")
        return cuts
    }

    // --- energy ---------------------------------------------------------------

    /** RMS (dBFS) of 20 ms frames on a 10 ms hop — index i covers [i·10ms, i·10ms+20ms). */
    private fun frameRmsDb(pcm: ShortArray, count: Int): FloatArray {
        val frames = max(0, 1 + (count - FRAME_WIN) / FRAME_HOP)
        val out = FloatArray(frames)
        for (i in 0 until frames) {
            val a = i * FRAME_HOP
            var sum = 0.0
            for (j in a until a + FRAME_WIN) {
                val v = pcm[j] / 32768.0
                sum += v * v
            }
            val rms = sqrt(sum / FRAME_WIN)
            out[i] = if (rms > 1e-9) (20.0 * log10(rms)).toFloat() else -180f
        }
        return out
    }

    /** floor(p10) + sensitivity, kept at least 8 dB under speech (p90) and never
     *  below floor+3 — so uniform-loudness clips degrade to "no energy regions"
     *  rather than eating everything or nothing. */
    private fun adaptiveThresholdDb(rmsDb: FloatArray, sensitivityDb: Double): Float {
        if (rmsDb.isEmpty()) return -45f
        val sorted = rmsDb.copyOf()
        sorted.sort()
        val floorDb = sorted[(sorted.size * 10 / 100).coerceIn(0, sorted.size - 1)]
        val speechDb = sorted[(sorted.size * 90 / 100).coerceIn(0, sorted.size - 1)]
        var thr = floorDb + sensitivityDb.toFloat().coerceIn(3f, 30f)
        thr = min(thr, speechDb - 8f)
        thr = max(thr, floorDb + 3f)
        return min(thr, -20f) // never call anything above -20 dBFS "silence"
    }

    /** Hysteresis: enter active above thr+2, leave below thr−2 → intervals (seconds). */
    private fun activeIntervals(rmsDb: FloatArray, thr: Float, durationS: Double): List<DoubleArray> {
        val out = ArrayList<DoubleArray>()
        var start = -1
        for (i in rmsDb.indices) {
            if (start < 0) {
                if (rmsDb[i] > thr + 2f) start = i
            } else if (rmsDb[i] < thr - 2f) {
                out.add(doubleArrayOf(start * HOP_S, min(durationS, i * HOP_S + WIN_S)))
                start = -1
            }
        }
        if (start >= 0) out.add(doubleArrayOf(start * HOP_S, durationS))
        return out
    }

    /** Is the 10 ms grid frame containing [t] below the silence threshold? */
    private fun quietAt(rmsDb: FloatArray, thr: Float, t: Double): Boolean {
        if (rmsDb.isEmpty()) return true
        val i = (t / HOP_S).toInt().coerceIn(0, rmsDb.size - 1)
        return rmsDb[i] < thr
    }

    // --- keep mask --------------------------------------------------------------

    private fun pairsToIntervals(flat: DoubleArray, durationS: Double): List<DoubleArray> {
        val out = ArrayList<DoubleArray>(flat.size / 2)
        var i = 0
        while (i + 1 < flat.size) {
            val a = flat[i].coerceIn(0.0, durationS)
            val b = flat[i + 1].coerceIn(0.0, durationS)
            if (b > a) out.add(doubleArrayOf(a, b))
            i += 2
        }
        out.sortBy { it[0] }
        return out
    }

    private fun mergeIntervals(sorted: List<DoubleArray>): List<DoubleArray> {
        val out = ArrayList<DoubleArray>()
        for (iv in sorted) {
            val last = out.lastOrNull()
            if (last != null && iv[0] <= last[1]) last[1] = max(last[1], iv[1])
            else out.add(doubleArrayOf(iv[0], iv[1]))
        }
        return out
    }

    private fun overlapsAny(iv: DoubleArray, set: List<DoubleArray>): Boolean {
        for (s in set) {
            if (s[0] < iv[1] && iv[0] < s[1]) return true
            if (s[0] >= iv[1]) break // sorted
        }
        return false
    }

    /**
     * Protected = trimmed word spans ∪ surviving energy islands.
     * Word-edge trim is ENERGY-VERIFIED: an edge only moves through frames already
     * below the threshold — full [trimEdgeS] on word ends (ASR pads them), half on
     * word starts (onsets are low-energy and precious).
     */
    private fun buildProtected(
        words: List<DoubleArray>,
        active: List<DoubleArray>,
        trimEdgeS: Double,
        rmsDb: FloatArray,
        thr: Float,
        removeBreaths: Boolean
    ): List<DoubleArray> {
        val trimmed = ArrayList<DoubleArray>(words.size)
        val trim = trimEdgeS.coerceIn(0.0, 0.2)
        for (w in words) {
            var w0 = w[0]
            var w1 = w[1]
            if (trim > 0) {
                var eaten = 0.0
                while (eaten + STEP_S <= trim && w1 - STEP_S > w0 + MIN_WORD_S &&
                    quietAt(rmsDb, thr, w1 - STEP_S)
                ) {
                    w1 -= STEP_S; eaten += STEP_S
                }
                eaten = 0.0
                while (eaten + STEP_S <= trim / 2 && w0 + STEP_S < w1 - MIN_WORD_S &&
                    quietAt(rmsDb, thr, w0)
                ) {
                    w0 += STEP_S; eaten += STEP_S
                }
            }
            trimmed.add(doubleArrayOf(w0, w1))
        }

        val keep = ArrayList<DoubleArray>(trimmed)
        for (a in active) {
            if (overlapsAny(a, trimmed)) {
                keep.add(a) // sound attached to a word (its own onset/tail) — protected
                continue
            }
            val len = a[1] - a[0]
            if (len < CLICK_MAX_S) continue // click/tap/chair creak → silence
            if (removeBreaths && len < BREATH_MAX_S) continue // breath/lip smack → silence
            keep.add(a) // real non-word sound the transcript missed — protected
        }
        keep.sortBy { it[0] }
        return mergeIntervals(keep)
    }

    /** Complement of the protected set → pads → min-length filter → valley snap. */
    private fun gapsToCuts(
        protected_: List<DoubleArray>,
        durationS: Double,
        minSilenceS: Double,
        padLeftS: Double,
        padRightS: Double,
        rmsDb: FloatArray
    ): List<DoubleArray> {
        val minSil = minSilenceS.coerceIn(0.0, 10.0)
        val padL = padLeftS.coerceIn(0.0, 1.0)
        val padR = padRightS.coerceIn(0.0, 1.0)

        // Gaps between protected intervals (plus the clip edges).
        val gaps = ArrayList<DoubleArray>()
        var cursor = 0.0
        for (p in protected_) {
            if (p[0] > cursor + 0.001) gaps.add(doubleArrayOf(cursor, p[0]))
            cursor = max(cursor, p[1])
        }
        if (durationS > cursor + 0.001) gaps.add(doubleArrayOf(cursor, durationS))

        val cuts = ArrayList<DoubleArray>()
        for (g in gaps) {
            if (g[1] - g[0] < minSil) continue
            val leading = g[0] <= 0.001 // nothing before → trim flush to the start
            val trailing = g[1] >= durationS - 0.001 // nothing after → flush to the end
            var c0 = if (leading) 0.0 else g[0] + padL
            var c1 = if (trailing) durationS else g[1] - padR
            if (c1 - c0 < MIN_CUT_S) continue
            // Valley snap: slide each interior edge (within its pad zone, ±30 ms) to
            // the locally quietest frame so the seam lands on the deadest instant.
            if (!leading) c0 = snapToValley(rmsDb, c0, g[0], c1 - MIN_CUT_S)
            if (!trailing) c1 = snapToValley(rmsDb, c1, c0 + MIN_CUT_S, g[1])
            cuts.add(doubleArrayOf(c0, c1))
        }
        return cuts
    }

    /** Quietest 10 ms frame within ±30 ms of [t], clamped to [lo, hi]. */
    private fun snapToValley(rmsDb: FloatArray, t: Double, lo: Double, hi: Double): Double {
        if (rmsDb.isEmpty() || hi <= lo) return t.coerceIn(min(lo, hi), max(lo, hi))
        val from = max(lo, t - SNAP_S)
        val to = min(hi, t + SNAP_S)
        var best = t
        var bestDb = Float.MAX_VALUE
        var x = from
        while (x <= to + 1e-9) {
            val i = (x / HOP_S).toInt().coerceIn(0, rmsDb.size - 1)
            if (rmsDb[i] < bestDb) {
                bestDb = rmsDb[i]
                best = x
            }
            x += STEP_S
        }
        return best.coerceIn(lo, hi)
    }

    // --- audio decode: any source → 16 kHz mono 16-bit PCM ------------------

    /**
     * Decodes the first audio track, downmixing to mono and resampling to 16 kHz
     * INLINE — the source-rate audio is never accumulated, so a 10-minute 48 kHz
     * stereo clip costs ~19 MB of shorts instead of ~230 MB of floats. Returns the
     * backing array plus the number of valid samples (the array may be longer).
     * Failures THROW with a named reason so the app can show it — a silent empty
     * return here used to read as "engine found nothing".
     */
    private fun decodeMono16k(context: Context, uri: String): Pair<ShortArray, Int> {
        var extractor: MediaExtractor? = null
        var codec: MediaCodec? = null
        var sampleRate = 0
        var channels = 1
        var out = ShortArray(0)
        var written = 0
        try {
            extractor = MediaExtractor()
            extractor.setDataSource(context, Uri.parse(uri), null)
            var trackIndex = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val f = extractor.getTrackFormat(i)
                if ((f.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) {
                    trackIndex = i; format = f; break
                }
            }
            if (trackIndex < 0 || format == null) throw IllegalStateException("no audio track in clip")
            extractor.selectTrack(trackIndex)
            if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0L
            // Past this the PCM alone would dominate the heap; word-gap silence is the
            // better trade for feature-length audio.
            if (durationUs > MAX_DURATION_US) throw IllegalStateException("clip over 45 min — silence scan skipped")

            // Pre-size from the container duration so the decode never reallocates.
            val estimate = if (durationUs > 0) (durationUs / 1_000_000.0 * TARGET_RATE).toInt() + TARGET_RATE
            else 10 * 60 * TARGET_RATE
            out = ShortArray(max(TARGET_RATE, estimate))

            // Streaming linear-interpolation resample state (global sample indices, so
            // interpolation is exact across decoder-buffer boundaries).
            var ratio = if (sampleRate > 0) sampleRate.toDouble() / TARGET_RATE else 1.0
            var outIdx = 0L
            var base = 0L
            var prev = 0f

            fun ensure(need: Int) {
                if (need <= out.size) return
                out = out.copyOf(max(need, out.size * 2))
            }

            fun push(mono: FloatArray, len: Int) {
                if (len <= 0) return
                val last = base + len - 1
                while (true) {
                    val p = outIdx * ratio
                    val left = floor(p).toLong()
                    val right = left + 1
                    if (right > last || left < base - 1) break
                    val mix = (p - left).toFloat()
                    val lv = if (left < base) prev else mono[(left - base).toInt()]
                    val rv = mono[(right - base).toInt()]
                    ensure(written + 1)
                    val v = lv * (1 - mix) + rv * mix
                    out[written++] = max(-32768, min(32767, (v * 32767f).toInt())).toShort()
                    outIdx++
                }
                prev = mono[len - 1]
                base += len
            }

            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
            codec.configure(format, null, null, 0)
            codec.start()
            val info = MediaCodec.BufferInfo()
            var sawInputEOS = false
            var sawOutputEOS = false
            var scratch = FloatArray(0)
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
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val of = codec.outputFormat
                    if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) sampleRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    if (of.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    if (sampleRate > 0) ratio = sampleRate.toDouble() / TARGET_RATE
                } else if (outIndex >= 0) {
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEOS = true
                    if (info.size > 0) {
                        val outBuf = codec.getOutputBuffer(outIndex)!!
                        outBuf.position(info.offset)
                        outBuf.limit(info.offset + info.size)
                        val sb = outBuf.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                        val n = sb.remaining()
                        val ch = max(1, channels)
                        val frames = n / ch
                        if (frames > 0) {
                            if (scratch.size < frames) scratch = FloatArray(frames)
                            var idx = 0
                            for (fr in 0 until frames) {
                                var acc = 0f
                                for (c in 0 until ch) acc += sb.get(idx++).toInt() / 32768f
                                scratch[fr] = acc / ch
                            }
                            push(scratch, frames)
                        }
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                }
            }
        } catch (e: IllegalStateException) {
            throw e // the named reasons above — pass through verbatim
        } catch (e: Exception) {
            throw IllegalStateException("audio decode failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            try { codec?.stop() } catch (_: Exception) {}
            try { codec?.release() } catch (_: Exception) {}
            try { extractor?.release() } catch (_: Exception) {}
        }
        if (written == 0 || sampleRate <= 0) throw IllegalStateException("decoder produced no audio samples")
        return out to written
    }

    private const val TARGET_RATE = 16000
    private const val FRAME_WIN = 320 // 20 ms @ 16 kHz
    private const val FRAME_HOP = 160 // 10 ms hop
    private const val WIN_S = 0.02
    private const val HOP_S = 0.01
    private const val STEP_S = 0.01 // edge-walk / valley-scan step
    private const val SNAP_S = 0.03 // valley-snap search radius
    private const val MIN_CUT_S = 0.04 // never emit a cut shorter than this
    private const val MIN_WORD_S = 0.05 // edge trim always leaves this much word core
    private const val CLICK_MAX_S = 0.12 // non-word energy shorter than this = click
    private const val BREATH_MAX_S = 0.40 // …than this = breath (when removeBreaths)
    private const val MAX_DURATION_US = 45L * 60L * 1_000_000L
}
