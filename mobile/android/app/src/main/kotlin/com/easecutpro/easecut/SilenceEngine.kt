package com.easecutpro.easecut

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Silence Mastery — the native port of main's ONE silence engine
 * (src/shared/silenceMastery.ts + src/renderer/src/cloud/sileroVad.ts +
 * the store's Silero-only pipeline). Same model, same fixed VAD tuning, same
 * post-pipeline, same settings semantics — so a preset behaves identically on
 * the web app and on this phone.
 *
 * THE PIPELINE (store.ts runRetakeSilence, Silero-only default), in order:
 *   1. Noise removal on the decoded 16 kHz mono PCM.
 *   2. +40 dB gain on the cleaned PCM before model normalization.
 *   3. Silero VAD (silero_vad_legacy.onnx via vad-web's NonRealTimeVAD
 *      semantics): 1536-sample frames @16 kHz (96 ms), speech threshold 0.55
 *      (negative 0.40), ONE redemption frame ends a segment, segments with
 *      < 250 ms of speech-positive frames are misfires. Speech segments invert
 *      to silence regions ≥ minSilenceS (redemption overshoot subtracted from
 *      each non-EOF segment end first).
 *   4. breathRefine (Flash / Cut Throat): walk each region's LEFT edge (the
 *      sentence ENDING) backward over 20 ms RMS frames quieter than the clip's
 *      own voice cutoff — breaths score as speech to the VAD, so the cut lands
 *      where the VOICE stops. Endings only; onsets are never walked. Cap 1.5 s.
 *   5. padTrimRegions: padLeft/padRight KEEP silence at the region's edges;
 *      trimLeft/trimRight cut PAST the detected edge into the sentence ending /
 *      next sentence's onset. Regions touching the media's start/end stay
 *      flush with it.
 *   6. unionCutRegions: sort, join regions within 20 ms, drop slivers < 30 ms.
 * No transcript involvement — Silero's ear is the truth on this engine.
 *
 * THIS CODE RUNS IN ITS OWN OS PROCESS (see [VadProvider], android:process=
 * ":vadengine"): the media decoder and the ONNX runtime are native code, and a
 * native fault kills only the helper — the app's binder call throws, EcVad
 * reports the stage recorded in [stageFile] and falls back gracefully.
 *
 * Memory: the decode resamples to 16 kHz mono 16-bit inline (~19 MB / 10 min);
 * Silero sees one 1536-sample frame at a time through reused direct buffers.
 */
object SilenceEngine {

    // ---- Silero fixed tuning (sileroVad.ts — NOT user settings) -------------
    private const val FRAME_SAMPLES = 1536 // 96 ms @ 16 kHz
    private const val FRAME_S = FRAME_SAMPLES / 16000.0
    private const val SPEECH_THRESHOLD = 0.55f
    private const val NEG_THRESHOLD = SPEECH_THRESHOLD - 0.15f
    private const val MIN_SPEECH_FRAMES = 250.0 / 96.0 // vad-web minSpeechMs / frameMs
    private const val REDEMPTION_S = FRAME_S // one redemption frame's overshoot

    // ---- RMS refinement constants (silenceMastery.ts) ------------------------
    private const val RMS_FRAME_S = 0.02
    private const val RMS_SENSITIVITY_DB = 12.0
    private const val RMS_SPEECH_HEADROOM_DB = 8.0
    private const val RMS_MIN_RANGE_DB = 6.0
    private const val EDGE_REFINE_MAX_S = 1.5
    private const val EDGE_REFINE_VOICE_MARGIN_DB = 15.0
    /** dB over the measured noise floor at which a SHORT burst counts as a word. */
    private const val SHORT_WORD_MARGIN_DB = 9.0
    /** A stretch of kept speech between two cuts never shrinks below this... */
    private const val MIN_KEEP_ISLAND_S = 0.12
    /** ...nor loses more than this fraction of itself to the trims. */
    private const val ISLAND_MAX_EATEN = 0.5

    private const val TARGET_RATE = 16000
    private const val MAX_DURATION_US = 45L * 60L * 1_000_000L

    // Loaded once per process, reused across runs.
    @Volatile private var env: OrtEnvironment? = null
    @Volatile private var session: OrtSession? = null

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
     * Full pipeline; settings are the web's SilenceMasterySettings numeric fields.
     * Returns cut regions [startS, endS] (seconds) to REMOVE plus a one-line stats
     * string (probability bands / segment count / speech coverage) so a surprising
     * result can be diagnosed from the phone alone. Throws on any catchable
     * failure; a native fault kills this process and the caller learns the stage
     * from [stageFile].
     */
    fun detect(
        context: Context,
        uri: String,
        minSilenceS: Double,
        padLeftMs: Double,
        padRightMs: Double,
        trimLeftMs: Double,
        trimRightMs: Double,
        breathRefine: Boolean
    ): Pair<List<DoubleArray>, String> {
        stage(context, "audio decode")
        val (decodedPcm, count) = decodeMono16k(context, uri)
        if (count <= 0) throw IllegalStateException("decoder produced no audio samples")
        stage(context, "noise removal")
        val denoisedPcm = NoiseRemovalProcessor.process(decodedPcm, count)
        stage(context, "audio gain +40 dB")
        val pcm = VadGainProcessor.process(denoisedPcm, count)
        val durationS = count.toDouble() / TARGET_RATE

        stage(context, "silero model load")
        ensureRuntime(context)

        // Decoded-audio levels ride along in the stats: a broken decode (e.g. a
        // PCM-format mix-up turning the track into full-scale noise) shows up as a
        // "floor" within a few dB of the "speech" level.
        val allDb = frameRmsDb(pcm, count)
        val sortedDb = allDb.copyOf().also { it.sort() }
        val levels = "audio floor ${percentile(sortedDb, 0.1).toInt()}dB / speech ${percentile(sortedDb, 0.9).toInt()}dB"

        val (raw, sileroStats) = detectSileroSilences(context, pcm, count, durationS, minSilenceS, allDb)
        val stats = "$sileroStats · $levels"

        val shaped = if (breathRefine) {
            stage(context, "breath cleanup")
            refineRegionEdgesByRms(raw, allDb, RMS_FRAME_S, durationS)
        } else raw

        stage(context, "cut geometry")
        val padded = padTrimRegions(shaped, padLeftMs / 1000.0, padRightMs / 1000.0,
            trimLeftMs / 1000.0, trimRightMs / 1000.0, durationS)
        val out = unionCutRegions(padded, durationS)
        stage(context, "done")
        return out to stats
    }

    // --- ONNX runtime (lazy) ------------------------------------------------

    private fun ensureRuntime(context: Context) {
        if (session != null) return
        synchronized(this) {
            if (session == null) {
                val e = OrtEnvironment.getEnvironment()
                val bytes = context.assets.open("silero/silero_vad_legacy.onnx").use { it.readBytes() }
                val opts = OrtSession.SessionOptions()
                opts.setIntraOpNumThreads(1)
                opts.setInterOpNumThreads(1)
                val sess = e.createSession(bytes, opts)
                val ins = sess.inputNames
                val outs = sess.outputNames
                if (!ins.containsAll(listOf("input", "sr", "h", "c")) ||
                    !outs.containsAll(listOf("output", "hn", "cn"))
                ) {
                    try {
                        sess.close()
                    } catch (_: Exception) {
                    }
                    throw IllegalStateException(
                        "silero model i/o unexpected: in=$ins out=$outs"
                    )
                }
                env = e
                session = sess
            }
        }
    }

    // --- stage 3: Silero speech → silence regions ----------------------------

    /**
     * vad-web NonRealTimeVAD semantics over the decoded PCM: full 1536-sample
     * frames, LSTM state carried across the whole run, ONE redemption frame ends
     * a segment (its 96 ms overshoot subtracted from each non-EOF segment end),
     * segments with < ~2.6 speech-positive frames are misfires. Speech is then
     * inverted to silence over [0, durationS], keeping runs ≥ max(0.03, minSilenceS)
     * (sileroVad.ts detectSileroSilences).
     */
    private fun detectSileroSilences(
        context: Context,
        pcm: ShortArray,
        count: Int,
        durationS: Double,
        minSilenceS: Double,
        framesDb: DoubleArray
    ): Pair<List<DoubleArray>, String> {
        val s = session ?: return emptyList<DoubleArray>() to "no session"
        val ortEnv = env ?: return emptyList<DoubleArray>() to "no env"
        val frames = count / FRAME_SAMPLES
        if (frames == 0) return emptyList<DoubleArray>() to "clip shorter than one frame"
        var nBelow = 0 // prob < NEG (true silence to Silero)
        var nMid = 0 // NEG..POS (the dead zone — keeps a running segment open)
        var nAbove = 0 // ≥ POS (speech)
        var rescued = 0 // short bursts kept because they are audibly speech
        var dropped = 0 // short bursts at room-tone level — genuinely cuttable
        // "Audibly above the room" — the bar a SHORT burst must clear to count as
        // a word rather than nothing. No dynamic range at all -> keep everything.
        val audibleDb = run {
            val sorted = framesDb.copyOf().also { it.sort() }
            val floorDb = percentile(sorted, 0.1)
            val speechDb = percentile(sorted, 0.9)
            if (speechDb - floorDb < RMS_MIN_RANGE_DB) -300.0 else floorDb + SHORT_WORD_MARGIN_DB
        }

        /** Loudest 20ms RMS inside a span of Silero frames. */
        fun peakDb(fromFrame: Int, toFrame: Int): Double {
            if (framesDb.isEmpty()) return 0.0
            val a = ((fromFrame * FRAME_S) / RMS_FRAME_S).toInt().coerceIn(0, framesDb.size - 1)
            val b = ((toFrame * FRAME_S) / RMS_FRAME_S).toInt().coerceIn(a, framesDb.size - 1)
            var m = -300.0
            for (i in a..b) if (framesDb[i] > m) m = framesDb[i]
            return m
        }

        /**
         * Does this speech segment survive?
         *
         * vad-web's minSpeechMs (250ms) rejects MISFIRES when you are EXTRACTING
         * speech — dropping one costs nothing there. Here the segments are
         * INVERTED into silence, so discarding a real short word ("yes", "no",
         * "right") does not ignore it, it DELETES it: the silence on both sides
         * merges straight through where the word was. That is the "……yes……"
         * swallow.
         *
         * A long segment is therefore always kept, and a SHORT one is kept
         * whenever it is audibly above the room. Only near-floor blips go. The
         * asymmetry is deliberate: keeping a click costs ~96ms of dead air,
         * deleting a word costs the sentence.
         */
        fun keepSegment(pos: Int, fromFrame: Int, toFrame: Int): Boolean {
            if (pos >= MIN_SPEECH_FRAMES) return true
            if (framesDb.isEmpty()) return true
            if (peakDb(fromFrame, toFrame) >= audibleDb) {
                rescued++
                return true
            }
            dropped++
            return false
        }

        // Reused direct buffers: the audio frame and the LSTM h/c states.
        val frameBuf = ByteBuffer.allocateDirect(FRAME_SAMPLES * 4)
            .order(ByteOrder.nativeOrder()).asFloatBuffer()
        val hBuf = ByteBuffer.allocateDirect(2 * 64 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        val cBuf = ByteBuffer.allocateDirect(2 * 64 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        val hData = FloatArray(2 * 64)
        val cData = FloatArray(2 * 64)
        val stateShape = longArrayOf(2, 1, 64)
        val frameShape = longArrayOf(1, FRAME_SAMPLES.toLong())
        // `sr` is a SCALAR int64 tensor (shape []) — direct buffer like the rest.
        val srBuf = ByteBuffer.allocateDirect(8).order(ByteOrder.nativeOrder()).asLongBuffer()
        srBuf.put(TARGET_RATE.toLong())
        srBuf.flip()
        val srTensor = OnnxTensor.createTensor(ortEnv, srBuf, longArrayOf())

        val speech = ArrayList<DoubleArray>() // [startS, endS] raw speech segments
        var speaking = false
        var segStartFrame = 0
        var posCount = 0

        try {
            for (f in 0 until frames) {
                if (f % 250 == 0) stage(context, "silero vad ${f + 1}/$frames")
                frameBuf.clear()
                val base = f * FRAME_SAMPLES
                for (i in 0 until FRAME_SAMPLES) frameBuf.put(pcm[base + i] / 32768f)
                frameBuf.flip()
                hBuf.clear(); hBuf.put(hData); hBuf.flip()
                cBuf.clear(); cBuf.put(cData); cBuf.flip()

                val feeds = HashMap<String, OnnxTensor>()
                feeds["input"] = OnnxTensor.createTensor(ortEnv, frameBuf, frameShape)
                feeds["sr"] = srTensor
                feeds["h"] = OnnxTensor.createTensor(ortEnv, hBuf, stateShape)
                feeds["c"] = OnnxTensor.createTensor(ortEnv, cBuf, stateShape)
                val res = try {
                    s.run(feeds)
                } catch (t: Throwable) {
                    feeds.values.forEach { if (it !== srTensor) runCatching { it.close() } }
                    throw t
                }
                val prob: Float
                try {
                    prob = (res.get("output").get() as OnnxTensor).floatBuffer.get(0)
                    val hn = (res.get("hn").get() as OnnxTensor).floatBuffer
                    val cn = (res.get("cn").get() as OnnxTensor).floatBuffer
                    hn.get(hData, 0, min(hData.size, hn.remaining()))
                    cn.get(cData, 0, min(cData.size, cn.remaining()))
                } finally {
                    res.close()
                    feeds.values.forEach { if (it !== srTensor) it.close() }
                }

                if (prob < NEG_THRESHOLD) nBelow++ else if (prob < SPEECH_THRESHOLD) nMid++ else nAbove++
                // vad-web FrameProcessor: pos resets redemption + starts/extends the
                // segment; a frame under the negative threshold while speaking ends it
                // (redemptionFrames == 1); the in-between zone changes nothing.
                if (prob >= SPEECH_THRESHOLD) {
                    if (!speaking) {
                        speaking = true
                        segStartFrame = f
                        posCount = 0
                    }
                    posCount++
                } else if (speaking && prob < NEG_THRESHOLD) {
                    speaking = false
                    if (keepSegment(posCount, segStartFrame, f + 1)) {
                        speech.add(doubleArrayOf(segStartFrame * FRAME_S, (f + 1) * FRAME_S))
                    }
                    posCount = 0
                }
            }
            if (speaking && keepSegment(posCount, segStartFrame, frames)) {
                speech.add(doubleArrayOf(segStartFrame * FRAME_S, frames * FRAME_S))
            }
        } finally {
            try {
                srTensor.close()
            } catch (_: Exception) {
            }
        }

        // Undo the redemption-frame overshoot (EOF-closed segments left alone),
        // merge overlaps, then invert SPEECH → silence ≥ minSilenceS.
        speech.sortBy { it[0] }
        val padded = ArrayList<DoubleArray>()
        for (seg in speech) {
            val end = if (seg[1] >= durationS - 0.15) seg[1] else max(seg[0], seg[1] - REDEMPTION_S)
            val a = max(0.0, seg[0])
            val b = min(durationS, end)
            val last = padded.lastOrNull()
            if (last != null && a <= last[1]) last[1] = max(last[1], b)
            else padded.add(doubleArrayOf(a, b))
        }
        val minDur = max(0.03, minSilenceS)
        val regions = ArrayList<DoubleArray>()
        var cursor = 0.0
        for (seg in padded) {
            if (seg[0] > cursor + 0.02) regions.add(doubleArrayOf(cursor, seg[0]))
            cursor = max(cursor, seg[1])
        }
        if (durationS > cursor + 0.02) regions.add(doubleArrayOf(cursor, durationS))
        val kept = regions.filter { it[1] - it[0] >= minDur }
        val covered = padded.sumOf { it[1] - it[0] }
        fun pct(n: Int) = if (frames > 0) (n * 100 / frames) else 0
        val stats = "probs <.40:${pct(nBelow)}% mid:${pct(nMid)}% ≥.55:${pct(nAbove)}% · " +
            "${speech.size} speech segs cover ${(covered * 100 / max(0.001, durationS)).toInt()}% " +
            "of ${durationS.toInt()}s · ${kept.size} gaps ≥${minDur}s · short kept $rescued dropped $dropped"
        return kept to stats
    }

    // --- stage 4: breath cleanup (silenceMastery.ts refineRegionEdgesByRms) ---

    /** Per-frame RMS level in dBFS — NON-overlapping 20 ms frames, matching the
     *  web's frameRmsDb exactly. */
    private fun frameRmsDb(pcm: ShortArray, count: Int): DoubleArray {
        val n = max(1, (RMS_FRAME_S * TARGET_RATE).toInt())
        val frames = count / n
        val out = DoubleArray(frames)
        for (f in 0 until frames) {
            var acc = 0.0
            val base = f * n
            for (i in 0 until n) {
                val v = pcm[base + i] / 32768.0
                acc += v * v
            }
            out[f] = 20 * log10(sqrt(acc / n) + 1e-9)
        }
        return out
    }

    /** index = floor(p·(n−1)), matching the web percentile helper. */
    private fun percentile(sorted: DoubleArray, p: Double): Double =
        if (sorted.isEmpty()) -100.0
        else sorted[(p * (sorted.size - 1)).toInt().coerceIn(0, sorted.size - 1)]

    private fun refineRegionEdgesByRms(
        regions: List<DoubleArray>,
        framesDb: DoubleArray,
        frameS: Double,
        durationS: Double
    ): List<DoubleArray> {
        if (regions.isEmpty() || framesDb.isEmpty() || frameS <= 0) return regions
        val sorted = framesDb.copyOf()
        sorted.sort()
        val floorDb = percentile(sorted, 0.1)
        val speechDb = percentile(sorted, 0.9)
        if (speechDb - floorDb < RMS_MIN_RANGE_DB) return regions // no usable range
        val thresholdDb = min(floorDb + RMS_SENSITIVITY_DB, speechDb - RMS_SPEECH_HEADROOM_DB)
        val cutoffDb = max(thresholdDb, speechDb - EDGE_REFINE_VOICE_MARGIN_DB)
        fun frameAt(t: Double): Double =
            framesDb[(t / frameS).toInt().coerceIn(0, framesDb.size - 1)]
        val out = regions.map { doubleArrayOf(it[0], it[1]) }.toMutableList()
        for (r in out) {
            var ext = 0.0
            while (r[0] > 0 && ext < EDGE_REFINE_MAX_S && frameAt(r[0] - frameS / 2) < cutoffDb) {
                r[0] = max(0.0, r[0] - frameS)
                ext += frameS
            }
        }
        out.sortBy { it[0] }
        val merged = ArrayList<DoubleArray>()
        for (r in out) {
            val last = merged.lastOrNull()
            if (last != null && r[0] <= last[1]) last[1] = max(last[1], r[1])
            else merged.add(r)
        }
        return merged
    }

    // --- stages 5+6: pads/trims + union (silenceMastery.ts) -------------------

    /** Pads KEEP silence at the region's edges; trims cut PAST the detected edge
     *  into speech. Regions touching the media's start/end stay flush with it. */
    private fun padTrimRegions(
        regions: List<DoubleArray>,
        padLeftS: Double,
        padRightS: Double,
        trimLeftS: Double,
        trimRightS: Double,
        durationS: Double
    ): List<DoubleArray> {
        val out = ArrayList<DoubleArray>()
        for (i in regions.indices) {
            val r = regions[i]
            val atStart = r[0] <= 0.01
            val atEnd = durationS > 0 && r[1] >= durationS - 0.01
            var a = if (atStart) 0.0 else r[0] + padLeftS - trimLeftS
            var b = if (atEnd) r[1] else r[1] - padRightS + trimRightS

            // ISLAND-CORE GUARD. A trim deliberately cuts PAST the detected edge
            // into speech — but the speech either side of a cut may be a single
            // short word, and two cuts bracketing it each bite from the same
            // island. Unbounded, a "……yes……" island is nibbled to nothing (or the
            // two cuts meet and unionCutRegions merges them straight through it,
            // deleting the word). So each edge may eat at most half of what the
            // island can spare: never past ISLAND_MAX_EATEN of it, and never
            // below MIN_KEEP_ISLAND_S of kept audio.
            val prevEnd = if (i > 0) regions[i - 1][1] else 0.0
            val nextStart = if (i < regions.size - 1) regions[i + 1][0] else durationS
            fun share(island: Double): Double =
                if (island <= 0) 0.0
                else max(0.0, min(island * ISLAND_MAX_EATEN, island - MIN_KEEP_ISLAND_S)) / 2.0
            if (!atStart) {
                val eaten = r[0] - a // >0 when the trim reaches back into speech
                if (eaten > 0) a = r[0] - min(eaten, share(r[0] - prevEnd))
            }
            if (!atEnd) {
                val eaten = b - r[1]
                if (eaten > 0) b = r[1] + min(eaten, share(nextStart - r[1]))
            }

            val start = max(0.0, a)
            val end = if (durationS > 0) min(b, durationS) else b
            if (end - start >= 0.03) out.add(doubleArrayOf(start, end))
        }
        return out
    }

    /** Sort, join regions within 20 ms, drop slivers < 30 ms. */
    private fun unionCutRegions(regions: List<DoubleArray>, durationS: Double): List<DoubleArray> {
        val all = regions
            .map { doubleArrayOf(max(0.0, it[0]), if (durationS > 0) min(it[1], durationS) else it[1]) }
            .filter { it[1] - it[0] >= 0.03 }
            .sortedBy { it[0] }
        val merged = ArrayList<DoubleArray>()
        for (c in all) {
            val last = merged.lastOrNull()
            if (last != null && c[0] <= last[1] + 0.02) last[1] = max(last[1], c[1])
            else merged.add(doubleArrayOf(c[0], c[1]))
        }
        return merged
    }

    // --- audio decode: any source → 16 kHz mono 16-bit PCM ------------------

    /**
     * Decodes the first audio track, downmixing to mono and resampling to 16 kHz
     * INLINE — the source-rate audio is never accumulated, so a 10-minute 48 kHz
     * stereo clip costs ~19 MB of shorts instead of ~230 MB of floats. Returns the
     * backing array plus the number of valid samples (the array may be longer).
     * Failures THROW with a named reason so the app can show it — a silent empty
     * return here used to read as "engine found nothing".
     *
     * PUBLIC: EcExport reuses this for the transcription WAV (the stt edge
     * function only accepts WAV — its AI-minute meter reads the WAV header).
     */
    fun decodeMono16k(context: Context, uri: String): Pair<ShortArray, Int> {
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
            // Past this the PCM alone would dominate the heap; the caller falls back.
            if (durationUs > MAX_DURATION_US) throw IllegalStateException("clip over 45 min — silence scan skipped")

            // Pre-size from the container duration so the decode never reallocates.
            val estimate = if (durationUs > 0) (durationUs / 1_000_000.0 * TARGET_RATE).toInt() + TARGET_RATE
            else 10 * 60 * TARGET_RATE
            out = ShortArray(max(TARGET_RATE, estimate))

            // Streaming BOX-AVERAGE decimation (the same shape as vad-web's Resampler,
            // which the web app feeds Silero through): each 16 kHz output sample is the
            // MEAN of the source samples in its window. The mean is a crude lowpass —
            // essential, because a bare linear pick-off ALIASES high-frequency content
            // (cabin hiss, road noise) back into the band, raising Silero's speech
            // score on "silence" until segments never close.
            var ratio = if (sampleRate > 0) sampleRate.toDouble() / TARGET_RATE else 1.0
            var outIdx = 0L
            var globalIn = 0L
            var acc = 0.0
            var accN = 0
            var lastOut: Short = 0

            fun ensure(need: Int) {
                if (need <= out.size) return
                out = out.copyOf(max(need, out.size * 2))
            }

            fun push(mono: FloatArray, len: Int) {
                for (i in 0 until len) {
                    acc += mono[i]
                    accN++
                    globalIn++
                    while (globalIn >= (outIdx + 1) * ratio) {
                        ensure(written + 1)
                        val v: Short = if (accN > 0) {
                            val m = (acc / accN).toFloat()
                            max(-32768, min(32767, (m * 32767f).toInt())).toShort()
                        } else lastOut // upsampling edge (source < 16 kHz): repeat
                        out[written++] = v
                        lastOut = v
                        outIdx++
                        acc = 0.0
                        accN = 0
                    }
                }
            }

            // Some decoders output FLOAT PCM (or ignore a 16-bit request) — reading
            // float bytes as shorts turns the whole track into full-scale garbage
            // noise, which Silero then scores as wall-to-wall speech. Ask for 16-bit,
            // but ALWAYS honor whatever encoding the output format declares.
            try {
                format.setInteger(MediaFormat.KEY_PCM_ENCODING, android.media.AudioFormat.ENCODING_PCM_16BIT)
            } catch (_: Exception) {
            }
            var pcmFloat = false
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
                    pcmFloat = of.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
                        of.getInteger(MediaFormat.KEY_PCM_ENCODING) == android.media.AudioFormat.ENCODING_PCM_FLOAT
                } else if (outIndex >= 0) {
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEOS = true
                    if (info.size > 0) {
                        val outBuf = codec.getOutputBuffer(outIndex)!!
                        outBuf.position(info.offset)
                        outBuf.limit(info.offset + info.size)
                        val ch = max(1, channels)
                        if (pcmFloat) {
                            val fb2 = outBuf.order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
                            val frames = fb2.remaining() / ch
                            if (frames > 0) {
                                if (scratch.size < frames) scratch = FloatArray(frames)
                                var idx = 0
                                for (fr in 0 until frames) {
                                    var acc = 0f
                                    for (c in 0 until ch) acc += fb2.get(idx++)
                                    scratch[fr] = acc / ch
                                }
                                push(scratch, frames)
                            }
                        } else {
                            val sb = outBuf.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                            val frames = sb.remaining() / ch
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
}
