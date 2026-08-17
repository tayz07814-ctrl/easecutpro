package com.easecutpro.easecut

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.opengl.GLES20
import androidx.media3.common.Effect
import androidx.media3.common.GlTextureInfo
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.GlEffect

/**
 * Applies a sampled foreground-alpha PNG to every frame of a video item.
 * Mask times are local to that item, in milliseconds. This is deliberately a
 * Media3 effect rather than a Flutter overlay, so export and native preview use
 * the same mask semantics for primary-track clips.
 */
class BackgroundMaskEffect(
    private val masks: List<MaskFrame>,
) : GlEffect {
    data class MaskFrame(val timeMs: Long, val path: String)

    override fun toGlShaderProgram(
        context: android.content.Context,
        useHdr: Boolean,
    ): androidx.media3.effect.GlShaderProgram = MaskShaderProgram(masks, useHdr)
}

private class MaskShaderProgram(
    private val masks: List<BackgroundMaskEffect.MaskFrame>,
    useHdr: Boolean,
) : BaseGlShaderProgram(useHdr, 1) {
    private val program = GlProgram(VERTEX_SHADER, FRAGMENT_SHADER)
    private val textures = HashMap<String, Int>()
    private val bitmaps = HashMap<String, Bitmap>()

    init {
        program.setBufferAttribute(
            "aFramePosition",
            GlUtil.getNormalizedCoordinateBounds(),
            GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE,
        )
    }

    override fun configure(inputWidth: Int, inputHeight: Int): Size {
        for (mask in masks) {
            if (textures.containsKey(mask.path)) continue
            val bitmap = BitmapFactory.decodeFile(mask.path) ?: Bitmap.createBitmap(
                1, 1, Bitmap.Config.ARGB_8888
            ).also { it.setPixel(0, 0, android.graphics.Color.WHITE) }
            try {
                val texture = GlUtil.generateTexture()
                GlUtil.setTexture(texture, bitmap)
                textures[mask.path] = texture
                bitmaps[mask.path] = bitmap
            } catch (e: GlUtil.GlException) {
                bitmap.recycle()
            }
        }
        return Size(inputWidth, inputHeight)
    }

    override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
        try {
            val mask = nearestMask(presentationTimeUs / 1000L)
            val maskTexture = mask?.let { textures[it.path] } ?: return
            program.use()
            program.setSamplerTexIdUniform("uVideoTexSampler", inputTexId, 0)
            program.setSamplerTexIdUniform("uMaskTexSampler", maskTexture, 1)
            program.bindAttributesAndUniforms()
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            GlUtil.checkGlError()
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        }
    }

    private fun nearestMask(timeMs: Long): BackgroundMaskEffect.MaskFrame? {
        var best: BackgroundMaskEffect.MaskFrame? = null
        var distance = Long.MAX_VALUE
        for (mask in masks) {
            val next = kotlin.math.abs(mask.timeMs - timeMs)
            if (next < distance) {
                best = mask
                distance = next
            }
        }
        return best
    }

    override fun release() {
        super.release()
        try {
            program.delete()
            for (texture in textures.values) GlUtil.deleteTexture(texture)
        } catch (_: GlUtil.GlException) {
        }
        for (bitmap in bitmaps.values) bitmap.recycle()
        textures.clear()
        bitmaps.clear()
    }

    companion object {
        private const val VERTEX_SHADER = """
            attribute vec4 aFramePosition;
            varying vec2 vTex;
            void main() {
              gl_Position = aFramePosition;
              vTex = vec2(aFramePosition.x * 0.5 + 0.5,
                          aFramePosition.y * 0.5 + 0.5);
            }
        """

        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform sampler2D uVideoTexSampler;
            uniform sampler2D uMaskTexSampler;
            varying vec2 vTex;
            void main() {
              vec4 video = texture2D(uVideoTexSampler, vTex);
              float alpha = texture2D(uMaskTexSampler, vec2(vTex.x, 1.0 - vTex.y)).a;
              gl_FragColor = vec4(video.rgb, video.a * alpha);
            }
        """
    }
}
