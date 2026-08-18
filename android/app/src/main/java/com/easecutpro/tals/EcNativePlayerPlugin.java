package com.easecutpro.tals;

import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.TextureView;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

/**
 * Native preview PLAYER — smooth, hardware-decoded playback of the timeline's base
 * track via Media3 ExoPlayer, so mobile playback is glassy (no WebView per-frame
 * seek stutter). Renders into a {@link TextureView} placed BEHIND the Capacitor
 * WebView; while active the WebView is made transparent so the HTML caption / overlay
 * layers composite ON TOP of the native video (CapCut-style).
 *
 * The JS side (useNativePreview) only turns this on for a plain cut (base video, no
 * speed / Ken Burns / crop / added audio / per-clip mute-gain) whose sources were
 * imported natively (real file paths). Anything else, or ANY failure here, keeps the
 * proven HTML `<video>` preview — this player is strictly additive.
 *
 * Position sync: each segment carries its timeline offset; we report a GLOBAL
 * timeline position (segment offset + in-clip position) at ~10 Hz so the JS clock,
 * caption layer and music stay locked to the native picture.
 */
@CapacitorPlugin(name = "EcNativePlayer")
public class EcNativePlayerPlugin extends Plugin {

    private ExoPlayer player;
    private TextureView textureView;
    private boolean added = false;
    private long[] timelineStarts = new long[0];
    private long[] timelineEnds = new long[0];

    private final Handler pollHandler = new Handler(Looper.getMainLooper());
    private boolean polling = false;

    // Latest-wins seek coalescing. A scrub can push dozens of seek() calls per
    // second across the bridge; applying each one immediately thrashes the
    // decoder and wedges the UI thread under a fast drag. Only the most recent
    // target is applied, at most once per SEEK_COALESCE_MS — and play() flushes
    // a pending target first so it never starts from a stale position.
    private static final long SEEK_COALESCE_MS = 60;
    private Long pendingSeekMs = null;
    private boolean seekScheduled = false;

    private final Runnable seekFlush = new Runnable() {
        @Override
        public void run() {
            seekScheduled = false;
            Long ms = pendingSeekMs;
            pendingSeekMs = null;
            if (ms != null) applySeek(ms);
        }
    };

    private final Runnable poller = new Runnable() {
        @Override
        public void run() {
            if (player != null) {
                try {
                    int idx = player.getCurrentMediaItemIndex();
                    long pos = Math.max(0, player.getContentPosition());
                    long base = (idx >= 0 && idx < timelineStarts.length) ? timelineStarts[idx] : 0;
                    JSObject ev = new JSObject();
                    ev.put("timelineMs", base + pos);
                    ev.put("playing", player.isPlaying());
                    ev.put("ended", player.getPlaybackState() == Player.STATE_ENDED);
                    ev.put("ready", player.getPlaybackState() == Player.STATE_READY);
                    notifyListeners("state", ev);
                } catch (Exception ignore) {
                }
            }
            if (polling) pollHandler.postDelayed(this, 100);
        }
    };

    @PluginMethod
    public void ping(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /** Build (or rebuild) the playlist from clipped segments. */
    @PluginMethod
    public void load(final PluginCall call) {
        final JSArray segments = call.getArray("segments");
        if (segments == null || segments.length() == 0) {
            call.reject("no segments");
            return;
        }
        final List<MediaItem> items = new ArrayList<>();
        final long[] starts = new long[segments.length()];
        final long[] ends = new long[segments.length()];
        try {
            for (int i = 0; i < segments.length(); i++) {
                JSObject seg = JSObject.fromJSONObject(segments.getJSONObject(i));
                String uri = seg.getString("uri");
                if (uri == null) {
                    call.reject("segment " + i + " has no uri");
                    return;
                }
                long startMs = seg.optLong("startMs", 0L);
                long endMs = seg.optLong("endMs", 0L);
                starts[i] = seg.optLong("timelineStartMs", 0L);
                ends[i] = seg.optLong("timelineEndMs", starts[i] + Math.max(0, endMs - startMs));

                MediaItem.ClippingConfiguration.Builder clip = new MediaItem.ClippingConfiguration.Builder()
                        .setStartPositionMs(startMs);
                if (endMs > startMs) clip.setEndPositionMs(endMs);
                items.add(new MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build());
            }
        } catch (Exception e) {
            call.reject("bad segments: " + e.getMessage());
            return;
        }

        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    ensurePlayer();
                    timelineStarts = starts;
                    timelineEnds = ends;
                    player.setMediaItems(items);
                    player.prepare();
                    startPolling();
                    call.resolve();
                } catch (Exception e) {
                    call.reject("load failed: " + e.getMessage());
                }
            }
        });
    }

    @PluginMethod
    public void play(final PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                // Flush any coalesced scrub target BEFORE starting playback so
                // the first audible/visible frame is the seeked one, not 60 ms
                // of the stale position.
                Long pending = pendingSeekMs;
                pendingSeekMs = null;
                pollHandler.removeCallbacks(seekFlush);
                seekScheduled = false;
                if (player != null) {
                    if (pending != null) applySeek(pending);
                    player.setPlayWhenReady(true);
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void pause(final PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (player != null) player.setPlayWhenReady(false);
                call.resolve();
            }
        });
    }

    /** Seek to a GLOBAL timeline position (ms). Coalesced: only the latest
     *  requested position is applied, at SEEK_COALESCE_MS cadence. */
    @PluginMethod
    public void seek(final PluginCall call) {
        final long ms = call.getLong("timelineMs", 0L);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                pendingSeekMs = ms;
                if (!seekScheduled) {
                    seekScheduled = true;
                    pollHandler.postDelayed(seekFlush, SEEK_COALESCE_MS);
                }
                call.resolve();
            }
        });
    }

    /** Apply a global-timeline seek NOW. UI thread only. */
    private void applySeek(long ms) {
        if (player == null) return;
        int idx = 0;
        for (int i = 0; i < timelineStarts.length; i++) {
            if (ms >= timelineStarts[i] && ms < timelineEnds[i]) { idx = i; break; }
            if (i == timelineStarts.length - 1) idx = i;
        }
        long inClip = Math.max(0, ms - (idx < timelineStarts.length ? timelineStarts[idx] : 0));
        try { player.seekTo(idx, inClip); } catch (Exception ignore) {}
    }

    /** Position the native surface (device px) under the HTML preview frame. */
    @PluginMethod
    public void setRect(final PluginCall call) {
        final int x = call.getInt("x", 0);
        final int y = call.getInt("y", 0);
        final int w = call.getInt("w", 0);
        final int h = call.getInt("h", 0);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (textureView != null && w > 0 && h > 0) {
                    // Update size on whatever LayoutParams type the parent generated, and
                    // position with setX/setY so it works under any ViewGroup (FrameLayout,
                    // CoordinatorLayout, …) without depending on that parent's margin params.
                    ViewGroup.LayoutParams lp = textureView.getLayoutParams();
                    if (lp == null) lp = new FrameLayout.LayoutParams(w, h);
                    lp.width = w;
                    lp.height = h;
                    textureView.setLayoutParams(lp);
                    textureView.setX(x);
                    textureView.setY(y);
                }
                call.resolve();
            }
        });
    }

    /** Show/hide the native surface and toggle WebView transparency so HTML
     *  composites over the video (active) or the normal HTML preview shows (inactive). */
    @PluginMethod
    public void setActive(final PluginCall call) {
        final boolean active = call.getBoolean("active", false);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    WebView web = getBridge().getWebView();
                    if (active) {
                        ensureSurface();
                        if (textureView != null) textureView.setVisibility(android.view.View.VISIBLE);
                        // The launch theme's window background is a splash drawable — force it
                        // black so the transparent WebView's letterbox regions read as black,
                        // not the splash image.
                        getActivity().getWindow().setBackgroundDrawable(
                                new android.graphics.drawable.ColorDrawable(Color.BLACK));
                        web.setBackgroundColor(Color.TRANSPARENT);
                    } else {
                        if (textureView != null) textureView.setVisibility(android.view.View.GONE);
                        web.setBackgroundColor(Color.BLACK);
                    }
                } catch (Exception ignore) {
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void release(final PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                stopPolling();
                pollHandler.removeCallbacks(seekFlush);
                pendingSeekMs = null;
                seekScheduled = false;
                try {
                    WebView web = getBridge().getWebView();
                    web.setBackgroundColor(Color.BLACK);
                } catch (Exception ignore) {
                }
                if (textureView != null) {
                    try {
                        ViewGroup parent = (ViewGroup) textureView.getParent();
                        if (parent != null) parent.removeView(textureView);
                    } catch (Exception ignore) {
                    }
                    textureView = null;
                    added = false;
                }
                if (player != null) {
                    try { player.release(); } catch (Exception ignore) {}
                    player = null;
                }
                call.resolve();
            }
        });
    }

    // ---- internals (UI thread) ----

    private void ensurePlayer() {
        if (player == null) {
            player = new ExoPlayer.Builder(getContext()).build();
            player.setRepeatMode(Player.REPEAT_MODE_OFF);
        }
        ensureSurface();
        if (textureView != null) player.setVideoTextureView(textureView);
    }

    private void ensureSurface() {
        if (textureView == null) {
            textureView = new TextureView(getContext());
            textureView.setVisibility(android.view.View.GONE);
        }
        if (!added) {
            try {
                WebView web = getBridge().getWebView();
                ViewGroup parent = (ViewGroup) web.getParent();
                if (parent != null) {
                    // index 0 → drawn first → BEHIND the (transparent) WebView.
                    parent.addView(textureView, 0, new FrameLayout.LayoutParams(1, 1));
                    added = true;
                }
            } catch (Exception ignore) {
            }
        }
    }

    private void startPolling() {
        if (!polling) {
            polling = true;
            pollHandler.postDelayed(poller, 100);
        }
    }

    private void stopPolling() {
        polling = false;
        pollHandler.removeCallbacks(poller);
    }
}
