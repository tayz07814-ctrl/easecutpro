package com.easecutpro.easecut.background

import android.content.Context
import android.graphics.Bitmap
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer

/**
 * ONNX Runtime wrapper for the MediaPipe Selfie Segmentation model.
 *
 * Model I/O (verified from actual ONNX file):
 *   input:  "pixel_values"  [batch, 3, 256, 256]  float32  (NCHW, RGB, 0..1)
 *   output: "alphas"        [batch, 1, 256, 256]  float32  (raw logits)
 *
 * The session is created once and reused across all frames.
 */
class SelfieSegmenter(private val context: Context) {

    @Volatile private var env: OrtEnvironment? = null
    @Volatile private var session: OrtSession? = null
    @Volatile private var inputName: String = "pixel_values"
    @Volatile private var outputName: String = "alphas"
    private val lock = Any()

    /** Pre-allocated input buffer: [1, 3, 256, 256] = 196608 floats. */
    private var inputBuffer: FloatBuffer? = null

    /** Pre-allocated output array for reading results. */
    private var outputArray: FloatArray? = null

    /** Model resolution (always 256 for this model). */
    val modelSize: Int = 256

    /**
     * Initialize ONNX Runtime and load the model from assets.
     * Safe to call multiple times — subsequent calls are no-ops.
     *
     * @param threads Number of intra-op threads for ONNX Runtime.
     */
    fun ensureInitialized(threads: Int = 2) {
        if (session != null) return
        synchronized(lock) {
            if (session != null) return
            val e = OrtEnvironment.getEnvironment()
            val bytes = context.assets.open("segmentation_model.onnx").use { it.readBytes() }
            val opts = OrtSession.SessionOptions().apply {
                setIntraOpNumThreads(threads)
                setInterOpNumThreads(1)
            }
            val sess = e.createSession(bytes, opts)

            // Validate expected I/O
            val inputs = sess.inputNames
            val outputs = sess.outputNames
            require(inputs.contains("pixel_values") && outputs.contains("alphas")) {
                "Unexpected model I/O: inputs=$inputs outputs=$outputs"
            }
            inputName = "pixel_values"
            outputName = "alphas"

            env = e
            session = sess
            inputBuffer = FloatBuffer.allocate(1 * 3 * modelSize * modelSize)
            outputArray = FloatArray(1 * 1 * modelSize * modelSize)
        }
    }

    /**
     * Run segmentation on a bitmap.
     *
     * @param bitmap Input image (any size — will be resized internally).
     * @return Float array of raw logits, shape [1, 1, 256, 256], or null on failure.
     */
    fun segment(bitmap: Bitmap): FloatArray? {
        val sess = session ?: return null
        val e = env ?: return null
        val buf = inputBuffer ?: return null
        val out = outputArray ?: return null

        // 1. Resize to model resolution
        val resized = if (bitmap.width != modelSize || bitmap.height != modelSize) {
            Bitmap.createScaledBitmap(bitmap, modelSize, modelSize, true)
        } else {
            bitmap
        }

        // 2. Convert bitmap pixels to NCHW float32 tensor [0..1]
        buf.clear()
        val pixels = IntArray(modelSize * modelSize)
        resized.getPixels(pixels, 0, modelSize, 0, 0, modelSize, modelSize)
        for (px in pixels) {
            // ARGB → RGB, normalize to [0, 1]
            buf.put(((px shr 16) and 0xFF) / 255.0f) // R
            buf.put(((px shr 8) and 0xFF) / 255.0f)  // G
            buf.put((px and 0xFF) / 255.0f)            // B
        }
        buf.flip()

        if (resized !== bitmap) resized.recycle()

        // 3. Run inference
        val shape = longArrayOf(1, 3, modelSize.toLong(), modelSize.toLong())
        val tensor = OnnxTensor.createTensor(e, buf, shape)
        return try {
            val result = sess.run(mapOf(inputName to tensor))
            val outputTensor = result.get(outputName).get() as OnnxTensor
            val outputBuf = outputTensor.floatBuffer
            val total = 1 * 1 * modelSize * modelSize
            outputBuf.rewind()
            outputBuf.get(out, 0, minOf(total, out.size, outputBuf.remaining()))
            result.close()
            out
        } catch (t: Throwable) {
            null
        } finally {
            tensor.close()
        }
    }

    /** Release all ONNX resources. Safe to call multiple times. */
    fun close() {
        synchronized(lock) {
            try { session?.close() } catch (_: Exception) {}
            session = null
            env = null
            inputBuffer = null
            outputArray = null
        }
    }
}
