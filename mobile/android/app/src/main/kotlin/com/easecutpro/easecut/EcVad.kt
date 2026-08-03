package com.easecutpro.easecut

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * EcVad — on-device FSMN (FunASR) VAD: the native ONNX port of the desktop web
 * "Retake Final Boss" silence engine (src/renderer/src/cloud/fsmnVad.ts +
 * retakeFinalBossVad.ts + shared/retakefinalboss.ts). Same 16 kHz / 80-bin Kaldi
 * fbank / 5-frame LFR / CMVN / 4-FSMN-cache contract and the same FunASR offline
 * endpoint state machine, then the Final Boss fixed-cushion removal + seam geometry
 * (+ optional dead-air tail trim). No edge round-trip — the audio never leaves the
 * phone.
 *
 * Channel: MethodChannel "ec/vad" → "detectSilences"
 *   args  {uri, padBeforeS, padAfterS, trimEdgesS, tailTrim}
 *   reply List<[startS, endS]>  — silence regions to REMOVE (seconds), or [] on any
 *         failure so the Dart caller can fall back to its transcript-gap silence.
 *
 * MEMORY IS THE CONTRACT HERE. The first cut of this engine materialised the whole
 * decode (at source rate, as floats), the resampled copy AND the full [frames × 400]
 * feature matrix at once — ~270 MB resident for a 10-minute clip, on top of ExoPlayer
 * and the Flutter engine. That doesn't raise OutOfMemoryError you can catch; the
 * kernel SIGKILLs the process, which is why it read as a bare crash with no
 * diagnostic. So: the decode resamples to 16 kHz inline and keeps 16-bit PCM (never
 * the source-rate float copy), and features are computed one CHUNK_FRAMES window at
 * a time straight into the tensor. Peak is now ~20 MB of working set plus the PCM.
 *
 * The FSMN caches make windowing exact — chunked inference is bit-identical to one
 * big pass, so the smaller window costs nothing but peak arena size.
 *
 * The model (model_quant.onnx) + CMVN (vad.mvn) ship in android assets/fsmn.
 */
class EcVad(
    private val context: Context,
    messenger: BinaryMessenger
) : MethodChannel.MethodCallHandler {

    private val channel = MethodChannel(messenger, "ec/vad")
    private val main = Handler(Looper.getMainLooper())

    // Loaded once, reused across runs.
    @Volatile private var env: OrtEnvironment? = null
    @Volatile private var session: OrtSession? = null
    @Volatile private var cmvnMeans: FloatArray? = null
    @Volatile private var cmvnScales: FloatArray? = null
    private var melBank: Array<FloatArray>? = null

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "detectSilences" -> detectSilences(call, result)
            else -> result.notImplemented()
        }
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
        try {
            session?.close()
        } catch (_: Exception) {
        }
        session = null
    }

    /** Surface a fault on-screen — the VAD runs on a background thread and any failure
     *  otherwise silently falls back to word-gap silence, hiding the real cause. */
    private fun toast(msg: String) {
        main.post {
            try {
                Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
            } catch (_: Exception) {
            }
        }
    }

    // --- crash guard --------------------------------------------------------
    // A native fault (ONNX segfault, or the low-memory killer) takes the whole
    // process down with no catchable exception, so the only way to stop a crash
    // LOOP is to leave a mark on disk before we touch any of it and clear it once
    // we're back. Two strikes — one lost run could just be the user swiping the app
    // away mid-analysis — then the engine steps aside for word-gap silence instead
    // of killing the app every time. Reinstalling/updating re-arms it.

    private fun guardFile() = File(context.filesDir, "ec_vad_guard")

    private fun appStamp(): String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
    } catch (_: Exception) {
        "0"
    }

    private fun guardStrikes(): Int = try {
        val parts = guardFile().readText().trim().split(":")
        if (parts.size == 2 && parts[0] == appStamp()) parts[1].toInt() else 0
    } catch (_: Exception) {
        0
    }

    private fun setGuardStrikes(n: Int) {
        try {
            if (n <= 0) guardFile().delete() else guardFile().writeText("${appStamp()}:$n")
        } catch (_: Exception) {
        }
    }

    // --- public entry -------------------------------------------------------

    private fun detectSilences(call: MethodCall, result: MethodChannel.Result) {
        val uri = call.argument<String>("uri")
        if (uri == null) {
            result.error("ec_vad", "no uri", null)
            return
        }
        val padBefore = (call.argument<Number>("padBeforeS"))?.toDouble() ?: 0.18
        val padAfter = (call.argument<Number>("padAfterS"))?.toDouble() ?: 0.12
        val trimEdges = (call.argument<Number>("trimEdgesS"))?.toDouble() ?: 0.02
        val tailTrim = call.argument<Boolean>("tailTrim") ?: false

        // One run at a time — a second concurrent run would double the decode + ONNX
        // working set at exactly the moment memory is tightest.
        if (!runningGate.compareAndSet(false, true)) {
            result.success(emptyList<List<Double>>())
            return
        }
        Thread {
            val regions: List<DoubleArray> = try {
                val strikes = guardStrikes()
                if (strikes >= MAX_STRIKES) {
                    toast("On-device silence engine is off after repeated failures — using transcript gaps.")
                    emptyList()
                } else {
                    setGuardStrikes(strikes + 1)
                    val (pcm, count) = decodeMono16k(uri)
                    val out = if (count <= 0) {
                        emptyList()
                    } else {
                        val durationS = count.toDouble() / TARGET_RATE
                        val raw = detectFsmnSilences(pcm, count, durationS)
                        val aligned = alignFinalBossFsmnGaps(raw, durationS)
                        val planned = planFinalBossSilenceCuts(aligned, padBefore, padAfter, trimEdges, durationS)
                        if (tailTrim) trimQuietTails(planned, pcm, count) else planned
                    }
                    setGuardStrikes(0) // came back alive — re-arm for next time
                    out
                }
            } catch (e: Throwable) {
                // A CAUGHT failure already degrades gracefully, so it must not count
                // as a strike — clear the guard and let Dart fall back to word gaps.
                setGuardStrikes(0)
                val top = e.stackTrace.firstOrNull()?.let {
                    "${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}"
                } ?: "?"
                toast("Silence VAD: ${e.javaClass.simpleName}: ${e.message} @ $top")
                emptyList()
            } finally {
                runningGate.set(false)
            }
            main.post { result.success(regions.map { listOf(it[0], it[1]) }) }
        }.start()
    }

    private val runningGate = java.util.concurrent.atomic.AtomicBoolean(false)

    // --- ONNX runtime (lazy) ------------------------------------------------

    // Resolved from the model at load — validated so a name mismatch bails cleanly
    // instead of feeding run() wrong keys (which crashes native code).
    @Volatile private var inCacheNames: List<String> = emptyList()
    @Volatile private var outCacheNames: List<String> = emptyList()
    @Volatile private var ioValid = false

    private fun ensureRuntime() {
        if (session != null && cmvnMeans != null) return
        synchronized(this) {
            if (session == null) {
                val e = OrtEnvironment.getEnvironment()
                val bytes = context.assets.open("fsmn/model_quant.onnx").use { it.readBytes() }
                // Single-threaded: this is a 0.5 MB model on a short window, so extra
                // threads buy nothing and each one brings its own arena.
                val opts = OrtSession.SessionOptions()
                opts.setIntraOpNumThreads(1)
                opts.setInterOpNumThreads(1)
                val sess = e.createSession(bytes, opts)
                env = e
                session = sess
                // Resolve the model's ACTUAL i/o so we never feed run() a wrong key
                // (a name mismatch is a native crash, not a catchable exception).
                val ins = sess.inputNames.toList()
                val outs = sess.outputNames.toList()
                inCacheNames = ins.filter { it != "speech" }.sorted()
                outCacheNames = outs.filter { it != "logits" }.sorted()
                ioValid = ins.contains("speech") && outs.contains("logits") &&
                    inCacheNames.size == CACHE_LAYERS && outCacheNames.size == CACHE_LAYERS
                if (!ioValid) {
                    toast("Silence VAD model i/o unexpected: in=[${ins.joinToString(",")}] out=[${outs.joinToString(",")}]")
                }
            }
            if (cmvnMeans == null) {
                val text = context.assets.open("fsmn/vad.mvn").use { String(it.readBytes(), Charsets.UTF_8) }
                val (means, scales) = parseCmvn(text)
                cmvnMeans = means
                cmvnScales = scales
            }
        }
    }

    /** <AddShift> = per-dim negative mean, <Rescale> = per-dim inverse std. Both are
     *  400-long vectors printed after a `<LearnRateCoef> N [ … ]` marker. */
    private fun parseCmvn(text: String): Pair<FloatArray, FloatArray> {
        fun vectorAfter(tag: String): FloatArray {
            val at = text.indexOf(tag)
            val learn = text.indexOf("<LearnRateCoef>", at)
            val open = text.indexOf('[', learn)
            val close = text.indexOf(']', open)
            require(at >= 0 && learn >= 0 && open >= 0 && close >= 0) { "FSMN CMVN missing $tag" }
            return text.substring(open + 1, close).trim().split(Regex("\\s+")).map { it.toFloat() }.toFloatArray()
        }
        val means = vectorAfter("<AddShift>")
        val scales = vectorAfter("<Rescale>")
        require(means.size >= FEATURE_DIM && scales.size >= FEATURE_DIM) { "FSMN CMVN wrong dim" }
        return means.copyOf(FEATURE_DIM) to scales.copyOf(FEATURE_DIM)
    }

    // --- pipeline: 16 kHz PCM → silence gaps --------------------------------

    /**
     * Streams fbank → LFR+CMVN → FSMN over [CHUNK_FRAMES] windows, carrying the four
     * caches between them. Only the current window's features exist at any moment
     * (1.6 MB) instead of the whole [frames × 400] matrix (96 MB for 10 minutes).
     */
    private fun detectFsmnSilences(pcm: ShortArray, count: Int, durationS: Double): List<DoubleArray> {
        ensureRuntime()
        val s = session ?: return emptyList()
        val means = cmvnMeans ?: return emptyList()
        val scales = cmvnScales ?: return emptyList()

        if (!ioValid) return emptyList() // model i/o not what we expect — bail, don't crash

        val frames = if (count >= FRAME_LENGTH) 1 + (count - FRAME_LENGTH) / FRAME_SHIFT else 0
        if (frames == 0) return emptyList()
        val ortEnv = env ?: return emptyList()

        val filters = melFilters()
        val eps = Math.ulp(1.0).toFloat().coerceAtLeast(Float.MIN_VALUE) // ~Number.EPSILON floor
        val leftContext = (LFR_M - 1) shr 1

        // Four FSMN caches, [1, 128, 19, 1], carried across chunks. Names resolved from
        // the model (sorted in_cache*/out_cache*).
        val cacheData = Array(CACHE_LAYERS) { FloatArray(CACHE_PROJ * CACHE_ORDER) }
        val cacheShape = longArrayOf(1, CACHE_PROJ.toLong(), CACHE_ORDER.toLong(), 1)
        val speechProb = FloatArray(frames)

        // Reused across windows — allocated once. The DIRECT buffers are reused too:
        // allocating ~1.6 MB of fresh off-heap memory per 10 s window piled up faster
        // than the GC felt pressure to reclaim it (direct memory barely registers on
        // the Java heap), which on a phone already running the preview player is
        // exactly the kind of native growth the low-memory killer answers with SIGKILL.
        val feature = FloatArray(CHUNK_FRAMES * FEATURE_DIM)
        val fbWindow = FloatArray((CHUNK_FRAMES + 2 * leftContext) * MEL_BINS)
        val speechBuf = ByteBuffer.allocateDirect(CHUNK_FRAMES * FEATURE_DIM * 4)
            .order(ByteOrder.nativeOrder()).asFloatBuffer()
        val cacheBufs = Array(CACHE_LAYERS) {
            ByteBuffer.allocateDirect(CACHE_PROJ * CACHE_ORDER * 4)
                .order(ByteOrder.nativeOrder()).asFloatBuffer()
        }

        var start = 0
        while (start < frames) {
            val n = min(CHUNK_FRAMES, frames - start)
            // fbank rows for this window PLUS the LFR context either side, so the
            // stacked features are identical to the whole-signal computation.
            val lo = max(0, start - leftContext)
            val hi = min(frames - 1, start + n - 1 + leftContext)
            for (r in 0..(hi - lo)) {
                val power = fftPower(pcm, (lo + r) * FRAME_SHIFT)
                for (m in 0 until MEL_BINS) {
                    var energy = 0f
                    val filter = filters[m]
                    for (k in power.indices) energy += power[k] * filter[k]
                    fbWindow[r * MEL_BINS + m] = ln(max(eps, energy).toDouble()).toFloat()
                }
            }
            for (t in 0 until n) {
                for (ctx in 0 until LFR_M) {
                    val sourceFrame = max(0, min(frames - 1, start + t + ctx - leftContext))
                    val row = sourceFrame - lo
                    for (m in 0 until MEL_BINS) {
                        val d = ctx * MEL_BINS + m
                        feature[t * FEATURE_DIM + d] = (fbWindow[row * MEL_BINS + m] + means[d]) * scales[d]
                    }
                }
            }

            speechBuf.clear()
            speechBuf.put(feature, 0, n * FEATURE_DIM)
            speechBuf.flip()
            val feeds = HashMap<String, OnnxTensor>()
            feeds["speech"] = OnnxTensor.createTensor(
                ortEnv, speechBuf, longArrayOf(1, n.toLong(), FEATURE_DIM.toLong())
            )
            for (i in 0 until CACHE_LAYERS) {
                cacheBufs[i].clear()
                cacheBufs[i].put(cacheData[i], 0, cacheData[i].size)
                cacheBufs[i].flip()
                feeds[inCacheNames[i]] = OnnxTensor.createTensor(ortEnv, cacheBufs[i], cacheShape)
            }
            val res = try {
                s.run(feeds)
            } catch (t: Throwable) {
                // run() never took ownership — close the inputs or they leak native memory.
                feeds.values.forEach { runCatching { it.close() } }
                throw t
            }
            try {
                val logits = (res.get("logits").get() as OnnxTensor).floatBuffer
                for (i in 0 until n) speechProb[start + i] = 1f - logits.get(i * LOGITS_STRIDE)
                for (i in 0 until CACHE_LAYERS) {
                    val outCache = (res.get(outCacheNames[i]).get() as OnnxTensor).floatBuffer
                    outCache.get(cacheData[i], 0, min(cacheData[i].size, outCache.remaining()))
                }
            } finally {
                res.close()
                feeds.values.forEach { it.close() }
            }
            start += n
        }
        return speechToSilence(speechProb, durationS)
    }

    // --- Kaldi fbank + LFR + CMVN -------------------------------------------

    private fun melFilters(): Array<FloatArray> {
        melBank?.let { return it }
        val bins = FFT_SIZE / 2 + 1
        val hzToMel = { hz: Double -> 1127.0 * ln(1 + hz / 700.0) }
        val melToHz = { mel: Double -> 700.0 * (exp(mel / 1127.0) - 1) }
        val lowMel = hzToMel(20.0)
        val highMel = hzToMel(TARGET_RATE / 2.0)
        val centers = DoubleArray(MEL_BINS + 2) { i -> melToHz(lowMel + (highMel - lowMel) * i / (MEL_BINS + 1)) }
        val bank = Array(MEL_BINS) { m ->
            val weights = FloatArray(bins)
            val low = centers[m]
            val center = centers[m + 1]
            val high = centers[m + 2]
            for (k in 0 until bins) {
                val hz = k.toDouble() * TARGET_RATE / FFT_SIZE
                if (hz > low && hz <= center) weights[k] = ((hz - low) / (center - low)).toFloat()
                else if (hz > center && hz < high) weights[k] = ((high - hz) / (high - center)).toFloat()
            }
            weights
        }
        melBank = bank
        return bank
    }

    /** Power spectrum of one frame: DC-remove, pre-emphasis (0.97), Hamming, ×32768,
     *  radix-2 FFT (512). Mirrors fsmnVad.ts fftPower exactly — the PCM is 16-bit here,
     *  so the /32768 on the way in and the ×32768 on the way out cancel as before. */
    private fun fftPower(pcm: ShortArray, start: Int): FloatArray {
        val real = FloatArray(FFT_SIZE)
        val imag = FloatArray(FFT_SIZE)
        var mean = 0f
        for (i in 0 until FRAME_LENGTH) mean += pcm[start + i] / 32768f
        mean /= FRAME_LENGTH
        var previous = pcm[start] / 32768f - mean
        for (i in 0 until FRAME_LENGTH) {
            val current = pcm[start + i] / 32768f - mean
            val emphasized = if (i == 0) current * 0.03f else current - 0.97f * previous
            previous = current
            val hamming = (0.54 - 0.46 * cos(2 * Math.PI * i / (FRAME_LENGTH - 1))).toFloat()
            real[i] = emphasized * hamming * 32768f
        }
        // In-place radix-2 Cooley-Tukey.
        var j = 0
        for (i in 1 until FFT_SIZE) {
            var bit = FFT_SIZE shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j xor bit
            if (i < j) {
                val tr = real[i]; real[i] = real[j]; real[j] = tr
                val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
            }
        }
        var length = 2
        while (length <= FFT_SIZE) {
            val angle = -2 * Math.PI / length
            val wLenR = cos(angle).toFloat()
            val wLenI = sin(angle).toFloat()
            var base = 0
            while (base < FFT_SIZE) {
                var wr = 1f
                var wi = 0f
                for (k in 0 until length / 2) {
                    val even = base + k
                    val odd = even + length / 2
                    val tr = real[odd] * wr - imag[odd] * wi
                    val ti = real[odd] * wi + imag[odd] * wr
                    real[odd] = real[even] - tr
                    imag[odd] = imag[even] - ti
                    real[even] += tr
                    imag[even] += ti
                    val nextWr = wr * wLenR - wi * wLenI
                    wi = wr * wLenI + wi * wLenR
                    wr = nextWr
                }
                base += length
            }
            length = length shl 1
        }
        val power = FloatArray(FFT_SIZE / 2 + 1)
        for (i in power.indices) power[i] = real[i] * real[i] + imag[i] * imag[i]
        return power
    }

    // --- FunASR offline endpoint state machine → silence gaps ---------------

    private fun speechToSilence(speechProbability: FloatArray, durationS: Double): List<DoubleArray> {
        var ring = IntArray(WINDOW_FRAMES)
        val speech = ArrayList<DoubleArray>()
        var sum = 0
        var position = 0
        var windowSpeaking = false
        var segmentActive = false
        var speechStart = 0.0
        var continuousSilence = 0

        fun resetEndpoint() {
            ring = IntArray(WINDOW_FRAMES)
            sum = 0
            position = 0
            windowSpeaking = false
            continuousSilence = 0
        }

        for (i in speechProbability.indices) {
            val current = if (speechProbability[i] >= SPEECH_THRESHOLD) 1 else 0
            sum -= ring[position]
            sum += current
            ring[position] = current
            position = (position + 1) % WINDOW_FRAMES

            val wasWindowSpeaking = windowSpeaking
            if (!windowSpeaking && sum >= TRANSITION_FRAMES) windowSpeaking = true
            else if (windowSpeaking && sum <= TRANSITION_FRAMES) windowSpeaking = false

            if (!segmentActive) {
                if (!wasWindowSpeaking && windowSpeaking) {
                    segmentActive = true
                    speechStart = max(0.0, (i - WINDOW_FRAMES - START_LOOKBACK_FRAMES) * 0.01)
                }
                continue
            }
            if (windowSpeaking) {
                continuousSilence = 0
                continue
            }
            if (wasWindowSpeaking) {
                continuousSilence = 0 // transition frame counts as voice in the reference runtime
                continue
            }
            continuousSilence++
            if (continuousSilence >= END_SILENCE_FRAMES) {
                val endFrame = i - (END_SILENCE_FRAMES - END_LOOKAHEAD_FRAMES - 1)
                speech.add(doubleArrayOf(speechStart, min(durationS, (endFrame + 1) * 0.01)))
                segmentActive = false
                resetEndpoint()
            }
        }
        if (segmentActive) speech.add(doubleArrayOf(speechStart, min(durationS, speechProbability.size * 0.01)))

        // Merge speech, then invert to silence over [0, durationS].
        val merged = ArrayList<DoubleArray>()
        for (seg in speech) {
            val last = merged.lastOrNull()
            if (last != null && seg[0] <= last[1]) last[1] = max(last[1], seg[1])
            else merged.add(doubleArrayOf(seg[0], seg[1]))
        }
        val silence = ArrayList<DoubleArray>()
        var cursor = 0.0
        for (seg in merged) {
            if (seg[0] > cursor + 0.001) silence.add(doubleArrayOf(cursor, seg[0]))
            cursor = max(cursor, seg[1])
        }
        if (durationS > cursor + 0.001) silence.add(doubleArrayOf(cursor, durationS))
        return silence
    }

    // --- Retake Final Boss geometry -----------------------------------------

    private fun alignFinalBossFsmnGaps(rawGaps: List<DoubleArray>, durationS: Double): List<DoubleArray> {
        val edgeEpsilon = 0.002
        return rawGaps.map { raw ->
            val start = max(0.0, min(durationS, raw[0]))
            val end = max(start, min(durationS, raw[1]))
            doubleArrayOf(
                if (start <= edgeEpsilon) start else max(0.0, start - AFTER_SPEECH_CUSHION_S),
                if (end >= durationS - edgeEpsilon) end else min(durationS, end + BEFORE_SPEECH_CUSHION_S)
            )
        }
    }

    private fun planFinalBossSilenceCuts(
        rawGaps: List<DoubleArray>,
        padBefore: Double,
        padAfter: Double,
        trimEdges: Double,
        durationS: Double
    ): List<DoubleArray> {
        val pb = padBefore.coerceIn(0.0, 0.5)
        val pa = padAfter.coerceIn(0.0, 0.5)
        val te = trimEdges.coerceIn(0.0, 0.2)
        val output = ArrayList<DoubleArray>()
        for (source in rawGaps) {
            val start = max(0.0, min(durationS, source[0]))
            val end = max(0.0, min(durationS, source[1]))
            val cutStart = max(0.0, start + pa - te)
            val cutEnd = min(durationS, end - pb + te)
            if (cutEnd - cutStart < 0.04) continue
            output.add(doubleArrayOf(cutStart, cutEnd))
        }
        return output
    }

    /** dBFS of [t0, t1) over the 16 kHz mono PCM. */
    private fun windowDb(pcm: ShortArray, count: Int, t0: Double, t1: Double): Double {
        val a = max(0, floor(t0 * TARGET_RATE).toInt())
        val b = min(count, kotlin.math.ceil(t1 * TARGET_RATE).toInt())
        if (b <= a) return Double.NEGATIVE_INFINITY
        var sum = 0.0
        for (i in a until b) {
            val v = pcm[i] / 32768.0
            sum += v * v
        }
        val rms = sqrt(sum / (b - a))
        return if (rms > 0) 20 * log10(rms) else Double.NEGATIVE_INFINITY
    }

    /** Walk a cut backward while the audio it would keep is dead air (only trims clip
     *  ENDINGS; bounded by TAIL_TRIM_MAX_S and never crosses the previous cut/start). */
    private fun trimQuietTails(regions: List<DoubleArray>, pcm: ShortArray, count: Int): List<DoubleArray> {
        val out = ArrayList<DoubleArray>()
        for (region in regions) {
            val clipStart = if (out.isNotEmpty()) out.last()[1] else 0.0
            val floorS = max(clipStart, region[0] - TAIL_TRIM_MAX_S)
            var cut = region[0]
            while (cut - TAIL_TRIM_STEP_S >= floorS &&
                windowDb(pcm, count, cut - TAIL_TRIM_STEP_S, cut) < TAIL_TRIM_DB
            ) {
                cut -= TAIL_TRIM_STEP_S
            }
            out.add(if (cut < region[0]) doubleArrayOf(cut, region[1]) else doubleArrayOf(region[0], region[1]))
        }
        return out
    }

    // --- audio decode: any source → 16 kHz mono 16-bit PCM ------------------

    /**
     * Decodes the first audio track, downmixing to mono and resampling to 16 kHz
     * INLINE — the source-rate audio is never accumulated, so a 10-minute 48 kHz
     * stereo clip costs ~19 MB of shorts instead of ~230 MB of floats. Returns the
     * backing array plus the number of valid samples (the array may be longer).
     */
    private fun decodeMono16k(uri: String): Pair<ShortArray, Int> {
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
            if (trackIndex < 0 || format == null) return ShortArray(0) to 0
            extractor.selectTrack(trackIndex)
            if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0L
            // Past this the PCM alone would dominate the heap; word-gap silence is the
            // better trade for feature-length audio.
            if (durationUs > MAX_DURATION_US) return ShortArray(0) to 0

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
        } catch (_: Exception) {
            return ShortArray(0) to 0
        } finally {
            try { codec?.stop() } catch (_: Exception) {}
            try { codec?.release() } catch (_: Exception) {}
            try { extractor?.release() } catch (_: Exception) {}
        }
        if (written == 0 || sampleRate <= 0) return ShortArray(0) to 0
        return out to written
    }

    private fun sin(x: Double): Float = kotlin.math.sin(x).toFloat()

    private companion object {
        const val TARGET_RATE = 16000
        const val FRAME_LENGTH = 400
        const val FRAME_SHIFT = 160
        const val FFT_SIZE = 512
        const val MEL_BINS = 80
        const val LFR_M = 5
        const val FEATURE_DIM = MEL_BINS * LFR_M      // 400
        const val CACHE_LAYERS = 4
        const val CACHE_PROJ = 128
        const val CACHE_ORDER = 19
        // 10 s per inference window. The FSMN caches make this exact, so the only
        // thing a bigger window buys is a bigger native arena.
        const val CHUNK_FRAMES = 1000
        const val LOGITS_STRIDE = 248                 // speechProb = 1 - logits[i*248]
        const val MAX_DURATION_US = 45L * 60L * 1_000_000L
        const val MAX_STRIKES = 2
        // Published FunASR vad.yaml defaults (fixed — Final Boss never tunes the VAD).
        const val SPEECH_THRESHOLD = 0.8f
        const val WINDOW_FRAMES = 20
        const val TRANSITION_FRAMES = 15
        const val START_LOOKBACK_FRAMES = 20
        const val END_SILENCE_FRAMES = 65
        const val END_LOOKAHEAD_FRAMES = 10
        // Retake Final Boss fixed endpoint cushions + tail-trim.
        const val AFTER_SPEECH_CUSHION_S = 0.16
        const val BEFORE_SPEECH_CUSHION_S = 0.26
        const val TAIL_TRIM_DB = -22.0
        const val TAIL_TRIM_MAX_S = 0.2
        const val TAIL_TRIM_STEP_S = 0.02
    }
}
