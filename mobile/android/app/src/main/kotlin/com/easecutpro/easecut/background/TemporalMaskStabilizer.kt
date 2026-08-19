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
     * @param currentAlphas Raw model output [0..1] for the current frame.
     * @param modelSize Model resolution (256).
     * @return Stabilized alphas (blended with previous frame where appropriate).
     */
    fun stabilize(currentAlphas: FloatArray, modelSize: Int): FloatArray {
        val prev = prevAlpha
        val total = modelSize * modelSize

        if (prev == null || prevSize != modelSize) {
            // First frame — no stabilization possible
            prevAlpha = toAlpha(currentAlphas, total)
            prevSize = modelSize
            return currentAlphas
        }

        // Compute motion level: how different is this frame from the previous?
        var diffSum = 0f
        val currentAlpha = toAlpha(currentAlphas, total)
        for (i in 0 until total) {
            diffSum += kotlin.math.abs(currentAlpha[i] - prev[i])
        }
        val avgDiff = diffSum / total

        // Motion-adaptive blending: high motion → less smoothing
        // avgDiff typically ranges 0..0.3; map to alpha [0.05..baseAlpha]
        val motionFactor = (avgDiff / 0.3f).coerceIn(0f, 1f)
        val blendAlpha = baseAlpha * (1f - motionFactor * 0.85f)

        // Blend
        val result = FloatArray(total)
        for (i in 0 until total) {
            result[i] = prev[i] * blendAlpha + currentAlphas[i] * (1f - blendAlpha)
        }

        prevAlpha = currentAlpha
        return result
    }

    /** Reset state (call when starting a new video). */
    fun reset() {
        prevAlpha = null
        prevSize = 0
    }

    /** Clamp model output to [0..1] alpha range. */
    private fun toAlpha(alphas: FloatArray, total: Int): FloatArray {
        val out = FloatArray(total)
        for (i in 0 until total) {
            out[i] = alphas[i].coerceIn(0f, 1f)
        }
        return out
    }
}
