package com.easecutpro.tals;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.BitmapOverlay;

import java.util.List;

/**
 * A Media3 overlay that shows a different FULL-FRAME bitmap depending on the
 * composition time — one "track" of timed overlays (e.g. every caption bitmap with
 * its [start,end) window). Baked at the output resolution in JS, so a full-frame
 * bitmap maps 1:1 onto the frame; when nothing is active it returns a 1×1
 * transparent bitmap (invisible), so show/hide needs no alpha settings.
 *
 * Memory-bounded: only the currently-visible bitmap is decoded/held; switching
 * windows drops the previous one. Captions change every few seconds, so decoding
 * happens rarely, not per frame.
 */
@OptIn(markerClass = UnstableApi.class)
public class TimedOverlay extends BitmapOverlay {

    public static class Item {
        final byte[] png;
        final long startUs;
        final long endUs;
        Bitmap cached;

        public Item(byte[] png, long startUs, long endUs) {
            this.png = png;
            this.startUs = startUs;
            this.endUs = endUs;
        }
    }

    private final List<Item> items;
    private final Bitmap transparent;
    private int activeIdx = -1;

    public TimedOverlay(List<Item> items) {
        this.items = items;
        this.transparent = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888); // fully transparent
    }

    private int indexAt(long tUs) {
        for (int i = 0; i < items.size(); i++) {
            Item it = items.get(i);
            if (tUs >= it.startUs && tUs < it.endUs) return i;
        }
        return -1;
    }

    private void dropAllExcept(int keep) {
        for (int i = 0; i < items.size(); i++) {
            if (i != keep && items.get(i).cached != null) {
                items.get(i).cached = null; // drop the ref (GC); don't recycle — the GL texture may still be in use
            }
        }
    }

    @Override
    public Bitmap getBitmap(long presentationTimeUs) {
        int idx = indexAt(presentationTimeUs);
        if (idx < 0) {
            if (activeIdx != -1) {
                dropAllExcept(-1);
                activeIdx = -1;
            }
            return transparent;
        }
        Item it = items.get(idx);
        if (it.cached == null) {
            it.cached = BitmapFactory.decodeByteArray(it.png, 0, it.png.length);
        }
        if (idx != activeIdx) {
            dropAllExcept(idx);
            activeIdx = idx;
        }
        return it.cached != null ? it.cached : transparent;
    }
}
