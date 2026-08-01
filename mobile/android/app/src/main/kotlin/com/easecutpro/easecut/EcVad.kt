package com.easecutpro.easecut

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.Handler
import android.os.Looper
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
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

        Thread {
            val regions: List<DoubleArray> = try {
                val (mono, rate) = decodePcmMono(uri)
                if (mono.isEmpty() || rate <= 0) {
                    emptyList()
                } else {
                    val durationS = mono.size.toDouble() / rate
                    val raw = detectFsmnSilences(mono, rate, durationS)
                    val aligned = alignFinalBossFsmnGaps(raw, durationS)
                    val planned = planFinalBossSilenceCuts(aligned, padBefore, padAfter, trimEdges, durationS)
                    if (tailTrim) trimQuietTails(planned, mono, rate) else planned
                }
            } catch (_: Throwable) {
                emptyList()
            }
            val out = regions.map { listOf(it[0], it[1]) }
            main.post { result.success(out) }
        }.start()
    }

    // --- ONNX runtime (lazy) ------------------------------------------------

    private fun ensureRuntime() {
        if (session != null && cmvnMeans != null) return
        synchronized(this) {
            if (session == null) {
                val e = OrtEnvironment.getEnvironment()
                val bytes = context.assets.open("fsmn/model_quant.onnx").use { it.readBytes() }
                val opts = OrtSession.SessionOptions()
                env = e
                session = e.createSession(bytes, opts)
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

    // --- pipeline: PCM → silence gaps ---------------------------------------

    private fun detectFsmnSilences(input: FloatArray, sourceRate: Int, durationS: Double): List<DoubleArray> {
        ensureRuntime()
        val s = session ?: return emptyList()
        val means = cmvnMeans ?: return emptyList()
        val scales = cmvnScales ?: return emptyList()

        val samples = resampleMono(input, sourceRate)
        val (features, frames) = fbankLfrCmvn(samples, means, scales)
        if (frames == 0) return emptyList()

        val ortEnv = env ?: return emptyList()
        // Four FSMN caches, [1, 128, 19, 1], carried across chunks.
        val cacheData = Array(CACHE_LAYERS) { FloatArray(CACHE_PROJ * CACHE_ORDER) }
        val speechProb = FloatArray(frames)
        val cacheShape = longArrayOf(1, CACHE_PROJ.toLong(), CACHE_ORDER.toLong(), 1)

        var offset = 0
        while (offset < frames) {
            val n = min(MAX_CHUNK_FRAMES, frames - offset)
            val slice = features.copyOfRange(offset * FEATURE_DIM, (offset + n) * FEATURE_DIM)
            val feeds = HashMap<String, OnnxTensor>()
            val speechTensor = OnnxTensor.createTensor(
                ortEnv, FloatBuffer.wrap(slice), longArrayOf(1, n.toLong(), FEATURE_DIM.toLong())
            )
            feeds["speech"] = speechTensor
            for (i in 0 until CACHE_LAYERS) {
                feeds["in_cache$i"] = OnnxTensor.createTensor(ortEnv, FloatBuffer.wrap(cacheData[i]), cacheShape)
            }
            val res = s.run(feeds)
            try {
                val logits = (res.get("logits").get() as OnnxTensor).floatBuffer
                for (i in 0 until n) speechProb[offset + i] = 1f - logits.get(i * LOGITS_STRIDE)
                for (i in 0 until CACHE_LAYERS) {
                    val outCache = (res.get("out_cache$i").get() as OnnxTensor).floatBuffer
                    val dst = cacheData[i]
                    outCache.get(dst, 0, min(dst.size, outCache.remaining()))
                }
            } finally {
                res.close()
                feeds.values.forEach { it.close() }
            }
            offset += n
        }
        return speechToSilence(speechProb, durationS)
    }

    /** Linear-interpolation resample to 16 kHz mono. */
    private fun resampleMono(input: FloatArray, sourceRate: Int): FloatArray {
        if (sourceRate == TARGET_RATE) return input
        val length = max(1, round(input.size.toDouble() * TARGET_RATE / sourceRate).toInt())
        val out = FloatArray(length)
        val ratio = sourceRate.toDouble() / TARGET_RATE
        for (i in 0 until length) {
            val position = i * ratio
            val left = min(input.size - 1, floor(position).toInt())
            val right = min(input.size - 1, left + 1)
            val mix = (position - left).toFloat()
            out[i] = input[left] * (1 - mix) + input[right] * mix
        }
        return out
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
     *  radix-2 FFT (512). Mirrors fsmnVad.ts fftPower exactly. */
    private fun fftPower(frame: FloatArray, start: Int): FloatArray {
        val real = FloatArray(FFT_SIZE)
        val imag = FloatArray(FFT_SIZE)
        var mean = 0f
        for (i in 0 until FRAME_LENGTH) mean += frame[start + i]
        mean /= FRAME_LENGTH
        var previous = frame[start] - mean
        for (i in 0 until FRAME_LENGTH) {
            val current = frame[start + i] - mean
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

    private fun fbankLfrCmvn(samples: FloatArray, means: FloatArray, scales: FloatArray): Pair<FloatArray, Int> {
        val frameCount = if (samples.size >= FRAME_LENGTH) 1 + (samples.size - FRAME_LENGTH) / FRAME_SHIFT else 0
        if (frameCount == 0) return FloatArray(0) to 0
        val filters = melFilters()
        val fbanks = FloatArray(frameCount * MEL_BINS)
        val eps = Math.ulp(1.0).toFloat().coerceAtLeast(Float.MIN_VALUE) // ~Number.EPSILON floor
        for (t in 0 until frameCount) {
            val power = fftPower(samples, t * FRAME_SHIFT)
            for (m in 0 until MEL_BINS) {
                var energy = 0f
                val filter = filters[m]
                for (k in power.indices) energy += power[k] * filter[k]
                fbanks[t * MEL_BINS + m] = ln(max(eps, energy).toDouble()).toFloat()
            }
        }
        val output = FloatArray(frameCount * FEATURE_DIM)
        val leftContext = (LFR_M - 1) shr 1
        for (t in 0 until frameCount) {
            for (ctx in 0 until LFR_M) {
                val sourceFrame = max(0, min(frameCount - 1, t + ctx - leftContext))
                for (m in 0 until MEL_BINS) {
                    val d = ctx * MEL_BINS + m
                    output[t * FEATURE_DIM + d] = (fbanks[sourceFrame * MEL_BINS + m] + means[d]) * scales[d]
                }
            }
        }
        return output to frameCount
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

    /** dBFS of [t0, t1) over the ORIGINAL (unresampled) mono PCM. */
    private fun windowDb(mono: FloatArray, sampleRate: Int, t0: Double, t1: Double): Double {
        val a = max(0, floor(t0 * sampleRate).toInt())
        val b = min(mono.size, kotlin.math.ceil(t1 * sampleRate).toInt())
        if (b <= a) return Double.NEGATIVE_INFINITY
        var sum = 0.0
        for (i in a until b) sum += mono[i].toDouble() * mono[i]
        val rms = sqrt(sum / (b - a))
        return if (rms > 0) 20 * log10(rms) else Double.NEGATIVE_INFINITY
    }

    /** Walk a cut backward while the audio it would keep is dead air (only trims clip
     *  ENDINGS; bounded by TAIL_TRIM_MAX_S and never crosses the previous cut/start). */
    private fun trimQuietTails(regions: List<DoubleArray>, mono: FloatArray, sampleRate: Int): List<DoubleArray> {
        val out = ArrayList<DoubleArray>()
        for (region in regions) {
            val clipStart = if (out.isNotEmpty()) out.last()[1] else 0.0
            val floorS = max(clipStart, region[0] - TAIL_TRIM_MAX_S)
            var cut = region[0]
            while (cut - TAIL_TRIM_STEP_S >= floorS &&
                windowDb(mono, sampleRate, cut - TAIL_TRIM_STEP_S, cut) < TAIL_TRIM_DB
            ) {
                cut -= TAIL_TRIM_STEP_S
            }
            out.add(if (cut < region[0]) doubleArrayOf(cut, region[1]) else doubleArrayOf(region[0], region[1]))
        }
        return out
    }

    // --- audio decode: any source → mono FloatArray + sampleRate ------------

    private fun decodePcmMono(uri: String): Pair<FloatArray, Int> {
        var extractor: MediaExtractor? = null
        var codec: MediaCodec? = null
        val chunks = ArrayList<FloatArray>()
        var total = 0
        var sampleRate = 0
        var channels = 1
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
            if (trackIndex < 0 || format == null) return FloatArray(0) to 0
            extractor.selectTrack(trackIndex)
            if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
            codec.configure(format, null, null, 0)
            codec.start()
            val info = MediaCodec.BufferInfo()
            var sawInputEOS = false
            var sawOutputEOS = false
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
                            val mono = FloatArray(frames)
                            var idx = 0
                            for (fr in 0 until frames) {
                                var acc = 0f
                                for (c in 0 until ch) acc += sb.get(idx++).toInt() / 32768f
                                mono[fr] = acc / ch
                            }
                            chunks.add(mono)
                            total += frames
                        }
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                }
            }
        } catch (_: Exception) {
            return FloatArray(0) to 0
        } finally {
            try { codec?.stop() } catch (_: Exception) {}
            try { codec?.release() } catch (_: Exception) {}
            try { extractor?.release() } catch (_: Exception) {}
        }
        if (total == 0 || sampleRate <= 0) return FloatArray(0) to 0
        val samples = FloatArray(total)
        var pos = 0
        for (c in chunks) {
            System.arraycopy(c, 0, samples, pos, c.size)
            pos += c.size
        }
        return samples to sampleRate
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
        const val MAX_CHUNK_FRAMES = 6000
        const val LOGITS_STRIDE = 248                 // speechProb = 1 - logits[i*248]
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
