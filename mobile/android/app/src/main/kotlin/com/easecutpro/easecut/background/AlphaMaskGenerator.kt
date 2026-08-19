package com.easecutpro.easecut.background

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import kotlin.math.max
import kotlin.math.min

/**
 * Converts raw model output (logits) into a high-quality alpha mask bitmap.
 *
 * Pipeline:
 *   1. Sigmoid activation on raw logits → [0, 1] confidence
 *   2. Configurable threshold / soft mapping
 *   3. Spatial smoothing (box blur) for cleaner edges
 *   4. Output: ARGB_8888 bitmap where alpha = person confidence
 */
object AlphaMaskGenerator {

    /**
     * Generate an alpha mask bitmap from raw model logits.
     *
     * @param logits Raw output from the model, length = modelSize * modelSize.
     * @param modelSize Width/height of the model output (256).
     * @param outputWidth Target mask width (source bitmap width).
     * @param outputHeight Target mask height (source bitmap height).
     * @param threshold Confidence threshold (0..1). Below this → transparent.
     * @param smoothRadius Spatial smoothing radius (0 = no smoothing).
     * @return ARGB_8888 bitmap: white pixels with alpha = confidence.
     */
    fun generate(
        logits: FloatArray,
        modelSize: Int,
        outputWidth: Int,
        outputHeight: Int,
        threshold: Float = 0.5f,
        smoothRadius: Int = 0,
    ): Bitmap {
        val total = modelSize * modelSize

        // 1. Model outputs raw logits — apply sigmoid → [0, 1] confidence
        val alpha = FloatArray(total)
        for (i in 0 until total) {
            val logit = logits[i].coerceIn(-10f, 10f)
            val prob = 1.0f / (1.0f + kotlin.math.exp(-logit))
            // Soft mapping: below threshold ramps down smoothly
            alpha[i] = if (prob >= threshold) {
                // Remap [threshold..1] → [0..1] for better edge contrast
                ((prob - threshold) / (1.0f - threshold)).coerceIn(0f, 1f)
            } else {
                0f
            }
        }

        // 2. Spatial smoothing (simple box blur)
        val smoothed = if (smoothRadius > 0) {
            boxBlur(alpha, modelSize, modelSize, smoothRadius)
        } else {
            alpha
        }

        // 3. Build ARGB bitmap at model resolution, then scale to output
        val modelBitmap = Bitmap.createBitmap(modelSize, modelSize, Bitmap.Config.ARGB_8888)
        val pixels = IntArray(total)
        for (i in 0 until total) {
            val a = (smoothed[i] * 255f).toInt().coerceIn(0, 255)
            // White foreground, alpha = person confidence
            pixels[i] = Color.argb(a, 255, 255, 255)
        }
        modelBitmap.setPixels(pixels, 0, modelSize, 0, 0, modelSize, modelSize)

        // 4. Scale to output resolution with bilinear interpolation
        val output = if (modelSize != outputWidth || modelSize != outputHeight) {
            Bitmap.createScaledBitmap(modelBitmap, outputWidth, outputHeight, true).also {
                modelBitmap.recycle()
            }
        } else {
            modelBitmap
        }

        return output
    }

    /** Clamp to safe range. */
    private fun clamp(x: Float): Float = max(-10f, min(10f, x))

    /**
     * Simple 2-pass box blur for spatial smoothing.
     * Separable: horizontal pass then vertical pass.
     */
    private fun boxBlur(src: FloatArray, w: Int, h: Int, radius: Int): FloatArray {
        val tmp = FloatArray(w * h)
        val dst = FloatArray(w * h)
        val kernelSize = 2 * radius + 1
        val invSize = 1.0f / kernelSize

        // Horizontal pass
        for (y in 0 until h) {
            var sum = 0f
            // Initialize window for x=0
            for (dx in -radius..radius) {
                val x = max(0, min(w - 1, dx))
                sum += src[y * w + x]
            }
            for (x in 0 until w) {
                tmp[y * w + x] = sum * invSize
                // Slide window: remove left edge, add right edge
                val removeX = max(0, x - radius)
                val addX = min(w - 1, x + radius + 1)
                sum -= src[y * w + removeX]
                sum += src[y * w + addX]
            }
        }

        // Vertical pass
        for (x in 0 until w) {
            var sum = 0f
            for (dy in -radius..radius) {
                val y = max(0, min(h - 1, dy))
                sum += tmp[y * w + x]
            }
            for (y in 0 until h) {
                dst[y * w + x] = sum * invSize
                val removeY = max(0, y - radius)
                val addY = min(h - 1, y + radius + 1)
                sum -= tmp[removeY * w + x]
                sum += tmp[addY * w + x]
            }
        }

        return dst
    }
}
