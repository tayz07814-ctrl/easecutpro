package com.easecutpro.easecut.background

import android.content.Context
import android.graphics.Bitmap
import java.io.File
import java.io.FileOutputStream

/**
 * High-level background removal engine.
 *
 * Orchestrates: segmentation → alpha mask → edge refinement → temporal stabilization → PNG output.
 *
 * Usage:
 *   val engine = BackgroundRemovalEngine(context)
 *   engine.initialize()
 *   val maskPath = engine.removeBackground(bitmap)
 *   engine.close()
 *
 * The engine maintains internal state for temporal stabilization across video frames.
 * Call [resetTemporal] when switching to a new video clip.
 */
class BackgroundRemovalEngine(private val context: Context) {

    private val segmenter = SelfieSegmenter(context)
    private var edgeRefiner: EdgeRefiner? = null
    private var temporalStabilizer: TemporalMaskStabilizer? = null

    @Volatile private var initialized = false
    @Volatile private var currentTier = DeviceCapability.Tier.BALANCED

    /** Output directory for mask PNGs. Created lazily. */
    private val maskDir: File by lazy {
        File(context.filesDir, "cutout_masks").also { it.mkdirs() }
    }

    /**
     * Initialize the engine with auto-detected or specified tier.
     *
     * @param tier Quality tier, or null for auto-detection.
     */
    fun initialize(tier: DeviceCapability.Tier? = null) {
        if (initialized) return
        currentTier = tier ?: DeviceCapability.detect(context)
        val threads = DeviceCapability.inferenceThreads(currentTier)
        segmenter.ensureInitialized(threads)

        val edgeRadius = DeviceCapability.edgeRadius(currentTier)
        if (edgeRadius > 0) {
            // EdgeRefiner is a singleton object — we just use it directly
        }

        temporalStabilizer = TemporalMaskStabilizer(
            baseAlpha = DeviceCapability.temporalAlpha(currentTier)
        )
        initialized = true
    }

    /**
     * Remove background from a single bitmap.
     *
     * @param bitmap Input image (any size).
     * @param threshold Confidence threshold (0..1), or null for tier default.
     * @param isVideoFrame If true, applies temporal stabilization.
     * @return Path to the saved mask PNG, or null on failure.
     */
    fun removeBackground(
        bitmap: Bitmap,
        threshold: Float? = null,
        isVideoFrame: Boolean = false,
    ): String? {
        if (!initialized) initialize()

        val effectiveThreshold = threshold ?: DeviceCapability.confidenceThreshold(currentTier)

        // 1. Run ONNX segmentation
        val logits = segmenter.segment(bitmap) ?: return null

        // 2. Temporal stabilization (for video sequences)
        val stabilized = if (isVideoFrame) {
            temporalStabilizer?.stabilize(logits, segmenter.modelSize) ?: logits
        } else {
            logits
        }

        // 3. Generate alpha mask bitmap
        val edgeRadius = DeviceCapability.edgeRadius(currentTier)
        val mask = AlphaMaskGenerator.generate(
            logits = stabilized,
            modelSize = segmenter.modelSize,
            outputWidth = bitmap.width,
            outputHeight = bitmap.height,
            threshold = effectiveThreshold,
            smoothRadius = if (edgeRadius > 0) 1 else 0,
        )

        // 4. Edge refinement
        if (edgeRadius > 0) {
            EdgeRefiner.refine(mask, strength = 0.4f, blurRadius = edgeRadius)
        }

        // 5. Save to PNG
        return saveMask(mask).also { mask.recycle() }
    }

    /**
     * Remove background from a single frame and return the raw alpha floats
     * (for callers that need the mask data in memory).
     */
    fun segmentToAlpha(
        bitmap: Bitmap,
        threshold: Float? = null,
        isVideoFrame: Boolean = false,
    ): FloatArray? {
        if (!initialized) initialize()
        val effectiveThreshold = threshold ?: DeviceCapability.confidenceThreshold(currentTier)
        val logits = segmenter.segment(bitmap) ?: return null
        val stabilized = if (isVideoFrame) temporalStabilizer?.stabilize(logits, segmenter.modelSize) ?: logits else logits
        // Model outputs raw logits — apply sigmoid
        val total = segmenter.modelSize * segmenter.modelSize
        return FloatArray(total) { i ->
            val logit = stabilized[i].coerceIn(-10f, 10f)
            val prob = 1.0f / (1.0f + kotlin.math.exp(-logit))
            if (prob >= effectiveThreshold) ((prob - effectiveThreshold) / (1f - effectiveThreshold)).coerceIn(0f, 1f) else 0f
        }
    }

    /** Reset temporal state for a new video clip. */
    fun resetTemporal() {
        temporalStabilizer?.reset()
    }

    /** Current quality tier. */
    val tier: DeviceCapability.Tier get() = currentTier

    /** Whether the engine is ready for inference. */
    val isReady: Boolean get() = initialized

    /** Release all resources. */
    fun close() {
        segmenter.close()
        initialized = false
    }

    private fun saveMask(mask: Bitmap): String {
        val file = File(maskDir, "mask_${System.currentTimeMillis()}_${kotlin.random.Random.nextInt(10000)}.png")
        FileOutputStream(file).use { mask.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return file.absolutePath
    }
}
