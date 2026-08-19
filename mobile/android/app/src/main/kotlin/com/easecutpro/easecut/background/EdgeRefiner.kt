package com.easecutpro.easecut.background

import android.graphics.Bitmap
import android.graphics.Color

/**
 * Lightweight edge refinement for segmentation masks.
 *
 * Improves hair, shoulders, fingers, and clothing edges without introducing
 * a heavy neural network. Uses unsharp masking on the alpha channel:
 *   refined = alpha + strength * (alpha - blurred(alpha))
 *
 * This sharpens edges while keeping flat regions stable.
 */
object EdgeRefiner {

    /**
     * Refine edges of an alpha mask bitmap (in-place).
     *
     * @param mask ARGB_8888 bitmap where alpha = person confidence.
     * @param strength Refinement intensity (0 = off, 0.5 = moderate, 1.0 = strong).
     * @param blurRadius Gaussian-like blur radius for edge detection (1-3).
     */
    fun refine(mask: Bitmap, strength: Float = 0.5f, blurRadius: Int = 2) {
        if (strength <= 0f || blurRadius <= 0) return

        val w = mask.width
        val h = mask.height
        val pixels = IntArray(w * h)
        mask.getPixels(pixels, 0, w, 0, 0, w, h)

        // Extract alpha channel
        val alpha = FloatArray(w * h)
        for (i in pixels.indices) {
            alpha[i] = Color.alpha(pixels[i]) / 255.0f
        }

        // Compute blurred version (box blur)
        val blurred = boxBlur(alpha, w, h, blurRadius)

        // Unsharp mask: sharpen = original + strength * (original - blurred)
        val refined = FloatArray(w * h)
        for (i in alpha.indices) {
            val sharpened = alpha[i] + strength * (alpha[i] - blurred[i])
            refined[i] = sharpened.coerceIn(0f, 1f)
        }

        // Write back to bitmap
        for (i in pixels.indices) {
            val a = (refined[i] * 255f).toInt().coerceIn(0, 255)
            pixels[i] = Color.argb(a, 255, 255, 255)
        }
        mask.setPixels(pixels, 0, w, 0, 0, w, h)
    }

    /**
     * Simple 2-pass separable box blur.
     */
    private fun boxBlur(src: FloatArray, w: Int, h: Int, radius: Int): FloatArray {
        val tmp = FloatArray(w * h)
        val dst = FloatArray(w * h)
        val kernelSize = 2 * radius + 1
        val invSize = 1.0f / kernelSize

        // Horizontal
        for (y in 0 until h) {
            var sum = 0f
            for (dx in -radius..radius) {
                sum += src[y * w + max(0, min(w - 1, dx))]
            }
            for (x in 0 until w) {
                tmp[y * w + x] = sum * invSize
                sum -= src[y * w + max(0, x - radius)]
                sum += src[y * w + min(w - 1, x + radius + 1)]
            }
        }

        // Vertical
        for (x in 0 until w) {
            var sum = 0f
            for (dy in -radius..radius) {
                sum += tmp[max(0, min(h - 1, dy)) * w + x]
            }
            for (y in 0 until h) {
                dst[y * w + x] = sum * invSize
                sum -= tmp[max(0, y - radius) * w + x]
                sum += tmp[min(h - 1, y + radius + 1) * w + x]
            }
        }

        return dst
    }

    private fun max(a: Int, b: Int) = if (a > b) a else b
    private fun min(a: Int, b: Int) = if (a < b) a else b
}
