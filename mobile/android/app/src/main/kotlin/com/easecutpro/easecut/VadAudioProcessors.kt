package com.easecutpro.easecut

import kotlin.math.ceil
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** First Silero input processor: suppress stationary noise below the voice floor. */
object NoiseRemovalProcessor {
    private const val FRAME_SAMPLES = 320 // 20 ms at 16 kHz
    private const val OPEN_MARGIN_DB = 6.0
    private const val FULL_MARGIN_DB = 18.0

    fun process(input: ShortArray, count: Int): ShortArray {
        if (count <= 0) return ShortArray(0)
        val frames = max(1, ceil(count / FRAME_SAMPLES.toDouble()).toInt())
        val frameDb = DoubleArray(frames)
        for (frame in 0 until frames) {
            val from = frame * FRAME_SAMPLES
            val to = min(count, from + FRAME_SAMPLES)
            var sum = 0.0
            for (i in from until to) {
                val sample = input[i] / 32768.0
                sum += sample * sample
            }
            frameDb[frame] = if (to > from) {
                20.0 * log10(kotlin.math.sqrt(sum / (to - from)) + 1e-9)
            } else {
                -300.0
            }
        }

        val sorted = frameDb.copyOf()
        sorted.sort()
        val noiseFloorDb = sorted[(0.1 * (sorted.size - 1)).toInt().coerceIn(0, sorted.lastIndex)]
        val frameGain = DoubleArray(frames) { frame ->
            val db = frameDb[frame]
            ((db - noiseFloorDb - OPEN_MARGIN_DB) /
                (FULL_MARGIN_DB - OPEN_MARGIN_DB)).coerceIn(0.0, 1.0)
        }

        val output = ShortArray(input.size)
        for (i in 0 until count) {
            val frame = i / FRAME_SAMPLES
            val next = min(frames - 1, frame + 1)
            val within = (i % FRAME_SAMPLES) / FRAME_SAMPLES.toDouble()
            val gain = frameGain[frame] + (frameGain[next] - frameGain[frame]) * within
            output[i] = (input[i] * gain).toInt().coerceIn(-32768, 32767).toShort()
        }
        return output
    }
}

/** Second Silero input processor: apply the requested +40 dB input boost. */
object VadGainProcessor {
    const val GAIN_DB = 40.0
    private val gain = 10.0.pow(GAIN_DB / 20.0)

    fun process(input: ShortArray, count: Int): ShortArray {
        val output = ShortArray(input.size)
        for (i in 0 until min(count, input.size)) {
            val boosted = input[i].toDouble() * gain
            // Silero consumes normalized PCM. Limit the boosted signal instead of
            // wrapping 16-bit samples, which would turn loud speech into noise.
            output[i] = boosted.coerceIn(-32768.0, 32767.0).toInt().toShort()
        }
        return output
    }
}
