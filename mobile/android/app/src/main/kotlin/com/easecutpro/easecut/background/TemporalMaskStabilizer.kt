package com.easecutpro.easecut.background

import android.graphics.Bitmap
import android.graphics.Color

/**
 * Reduces temporal flickering between consecutive video frame masks.
 *
 * Blends the current frame's mask with the previous frame's mask to prevent
 * visible edge jitter. Uses motion-aware blending: when the scene changes
 * rapidly (high motion), trust the current segmentation more.
 */
class TemporalMaskStabilizer(
    /** Base blending factor (0 = no smoothing, 1 = fully previous frame). */
    private val baseAlpha: Float = 0.3f,
) {
    /** Previous frame's alpha data (model resolution). */
    private var prevAlpha: FloatArray? = null

    /** Previous frame's model resolution. */
    private var prevSize: Int = 0

    /**
     * Stabilize a mask against the previous frame.
     *
     * @param currentLogits Raw model output for the current frame.
     * @param modelSize Model resolution (256).
     * @return Stabilized logits (blended with previous frame where appropriate).
     */
    fun stabilize(currentLogits: FloatArray, modelSize: Int): FloatArray {
        val prev = prevAlpha
        val total = modelSize * modelSize

        if (prev == null || prevSize != modelSize) {
            // First frame — no stabilization possible
            prevAlpha = convertToAlpha(currentLogits, total)
            prevSize = modelSize
            return currentLogits
        }

        // Compute motion level: how different is this frame from the previous?
        var diffSum = 0f
        val currentAlpha = convertToAlpha(currentLogits, total)
        for (i in 0 until total) {
            diffSum += kotlin.math.abs(currentAlpha[i] - prev[i])
        }
        val avgDiff = diffSum / total

        // Motion-adaptive blending: high motion → less smoothing
        // avgDiff typically ranges 0..0.3; map to alpha [0.05..baseAlpha]
        val motionFactor = (avgDiff / 0.3f).coerceIn(0f, 1f)
        val alpha = baseAlpha * (1f - motionFactor * 0.85f)

        // Blend
        val result = FloatArray(total)
        for (i in 0 until total) {
            result[i] = prev[i] * alpha + currentLogits[i] * (1f - alpha)
        }

        prevAlpha = currentAlpha
        return result
    }

    /** Reset state (call when starting a new video). */
    fun reset() {
        prevAlpha = null
        prevSize = 0
    }

    /** Convert raw logits to alpha [0..1] via sigmoid. */
    private fun convertToAlpha(logits: FloatArray, total: Int): FloatArray {
        val alpha = FloatArray(total)
        for (i in 0 until total) {
            val clamped = (-10f).coerceAtLeast(10f.coerceAtMost(logits[i]))
            alpha[i] = 1.0f / (1.0f + kotlin.math.exp(-clamped))
        }
        return alpha
    }
}
