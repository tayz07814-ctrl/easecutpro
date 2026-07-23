package com.easecutpro.easecut

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.media3.effect.BitmapOverlay

/**
 * A Media3 overlay that shows a different FULL-FRAME bitmap depending on the
 * composition time — one "track" of timed overlays (e.g. every caption bitmap with
 * its [start,end) window). Bitmaps are baked at the output resolution, so a full-frame
 * bitmap maps 1:1 onto the frame; when nothing is active it returns a 1×1 transparent
 * bitmap (invisible), so show/hide needs no alpha settings.
 *
 * Memory-bounded: only the currently-visible bitmap is decoded/held; switching windows
 * drops the previous one.
 */
class TimedOverlay(private val items: List<Item>) : BitmapOverlay() {

    class Item(val png: ByteArray, val startUs: Long, val endUs: Long) {
        var cached: Bitmap? = null
    }

    private val transparent: Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    private var activeIdx = -1

    private fun indexAt(tUs: Long): Int {
        for (i in items.indices) {
            val it = items[i]
            if (tUs >= it.startUs && tUs < it.endUs) return i
        }
        return -1
    }

    private fun dropAllExcept(keep: Int) {
        for (i in items.indices) {
            if (i != keep && items[i].cached != null) {
                items[i].cached = null // drop ref (GC); don't recycle — GL texture may still be in use
            }
        }
    }

    override fun getBitmap(presentationTimeUs: Long): Bitmap {
        val idx = indexAt(presentationTimeUs)
        if (idx < 0) {
            if (activeIdx != -1) {
                dropAllExcept(-1)
                activeIdx = -1
            }
            return transparent
        }
        val it = items[idx]
        if (it.cached == null) {
            it.cached = BitmapFactory.decodeByteArray(it.png, 0, it.png.size)
        }
        if (idx != activeIdx) {
            dropAllExcept(idx)
            activeIdx = idx
        }
        return it.cached ?: transparent
    }
}
