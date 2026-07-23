package com.easecutpro.tals;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.annotation.OptIn;
import androidx.media3.common.Effect;
import androidx.media3.common.MediaItem;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.OverlayEffect;
import androidx.media3.effect.Presentation;
import androidx.media3.effect.TextureOverlay;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.EditedMediaItemSequence;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.Transformer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.collect.ImmutableList;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Native FULL export via Media3 Transformer — the phone's hardware codecs encode
 * the whole edit, no WebCodecs fallback on Android:
 *   - base video track: each clip trimmed + concatenated (sequence 0), audio kept;
 *   - captions / text: baked to full-frame bitmaps in JS, composited as a timed
 *     OverlayEffect at the output resolution (see {@link TimedOverlay});
 *   - extra audio tracks (music / voiceover): each an audio-only sequence, mixed in.
 *
 * The output is forced to the requested width×height (Presentation) so the baked
 * caption bitmaps map 1:1. On success it's published into Movies/EaseCutPro.
 *
 * v1 does NOT yet apply per-clip speed / Ken Burns / crop or VIDEO b-roll overlays
 * — those are added in later rounds; a project using them exports without them.
 */
@CapacitorPlugin(name = "EcNativeExport")
public class EcNativeExportPlugin extends Plugin {

    @PluginMethod
    public void ping(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @OptIn(markerClass = UnstableApi.class)
    @PluginMethod
    public void export(final PluginCall call) {
        final JSArray segments = call.getArray("segments");
        if (segments == null || segments.length() == 0) {
            call.reject("No segments to export");
            return;
        }
        final String outName = call.getString("filename", "EaseCutPro_" + System.currentTimeMillis() + ".mp4");
        final int width = call.getInt("width", 1080);
        final int height = call.getInt("height", 1920);
        final JSArray captions = call.getArray("captions");       // [{ base64, startMs, endMs }]
        final JSArray images = call.getArray("images");           // [{ base64, startMs, endMs }]
        final JSArray audioTracks = call.getArray("audioTracks"); // [{ uri, startMs, endMs }]

        // --- base video sequence (trim + concat, audio kept) ---
        final List<EditedMediaItem> baseItems = new ArrayList<>();
        try {
            for (int i = 0; i < segments.length(); i++) {
                JSObject seg = JSObject.fromJSONObject(segments.getJSONObject(i));
                String uri = seg.getString("uri");
                if (uri == null) { call.reject("Segment " + i + " has no uri"); return; }
                long startMs = seg.optLong("startMs", 0L);
                long endMs = seg.optLong("endMs", 0L);
                MediaItem.ClippingConfiguration.Builder clip = new MediaItem.ClippingConfiguration.Builder()
                        .setStartPositionMs(startMs);
                if (endMs > startMs) clip.setEndPositionMs(endMs);
                MediaItem mi = new MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build();
                baseItems.add(new EditedMediaItem.Builder(mi).build());
            }
        } catch (Exception e) {
            call.reject("Bad segments: " + e.getMessage());
            return;
        }

        final List<EditedMediaItemSequence> sequences = new ArrayList<>();
        sequences.add(new EditedMediaItemSequence(baseItems));

        // --- extra audio sequences (music / voiceover) — audio only, mixed in ---
        try {
            if (audioTracks != null) {
                for (int i = 0; i < audioTracks.length(); i++) {
                    JSObject a = JSObject.fromJSONObject(audioTracks.getJSONObject(i));
                    String uri = a.getString("uri");
                    if (uri == null) continue;
                    long startMs = a.optLong("startMs", 0L);
                    long endMs = a.optLong("endMs", 0L);
                    MediaItem.ClippingConfiguration.Builder clip = new MediaItem.ClippingConfiguration.Builder()
                            .setStartPositionMs(startMs);
                    if (endMs > startMs) clip.setEndPositionMs(endMs);
                    MediaItem mi = new MediaItem.Builder().setUri(uri).setClippingConfiguration(clip.build()).build();
                    EditedMediaItem item = new EditedMediaItem.Builder(mi).setRemoveVideo(true).build();
                    List<EditedMediaItem> one = new ArrayList<>();
                    one.add(item);
                    sequences.add(new EditedMediaItemSequence(one));
                }
            }
        } catch (Exception e) {
            // audio track parse failed — export the video without it rather than aborting
        }

        // --- video effects: force output size + composite caption / image overlays ---
        final List<Effect> videoEffects = new ArrayList<>();
        videoEffects.add(Presentation.createForWidthAndHeight(width, height, Presentation.LAYOUT_SCALE_TO_FIT));
        final List<TextureOverlay> overlays = new ArrayList<>();
        TimedOverlay imageTrack = buildTrack(images);
        if (imageTrack != null) overlays.add(imageTrack); // images UNDER text
        TimedOverlay textTrack = buildTrack(captions);
        if (textTrack != null) overlays.add(textTrack);
        if (!overlays.isEmpty()) {
            videoEffects.add(new OverlayEffect(ImmutableList.copyOf(overlays)));
        }

        final File out = new File(getContext().getCacheDir(), "ec_export_" + System.currentTimeMillis() + ".mp4");

        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Effects effects = new Effects(ImmutableList.<AudioProcessor>of(), videoEffects);
                    // Composition.Builder(List<EditedMediaItemSequence>) — pass the List directly.
                    Composition composition = new Composition.Builder(sequences).setEffects(effects).build();

                    final android.os.Handler pollHandler = new android.os.Handler(android.os.Looper.getMainLooper());
                    final Transformer[] holder = new Transformer[1];
                    final ProgressHolder progressHolder = new ProgressHolder();
                    final Runnable[] pollRef = new Runnable[1];

                    Transformer transformer = new Transformer.Builder(getContext())
                            .addListener(new Transformer.Listener() {
                                @Override
                                public void onCompleted(Composition composition, ExportResult result) {
                                    pollHandler.removeCallbacksAndMessages(null);
                                    JSObject ret = new JSObject();
                                    ret.put("path", out.getAbsolutePath());
                                    ret.put("durationMs", result.durationMs);
                                    try {
                                        String savedTo = saveToGallery(out, outName);
                                        if (savedTo != null) ret.put("savedTo", savedTo);
                                    } catch (Exception e) { /* file still at path */ }
                                    call.resolve(ret);
                                }

                                @Override
                                public void onError(Composition composition, ExportResult result, ExportException exception) {
                                    pollHandler.removeCallbacksAndMessages(null);
                                    call.reject("Export failed: " + exception.getMessage(), exception);
                                }
                            })
                            .build();
                    holder[0] = transformer;

                    pollRef[0] = new Runnable() {
                        @Override
                        public void run() {
                            try {
                                int state = holder[0].getProgress(progressHolder);
                                if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
                                    JSObject ev = new JSObject();
                                    ev.put("percent", progressHolder.progress);
                                    notifyListeners("nativeExportProgress", ev);
                                }
                            } catch (Exception ignore) {
                            }
                            pollHandler.postDelayed(pollRef[0], 250);
                        }
                    };

                    transformer.start(composition, out.getAbsolutePath());
                    pollHandler.postDelayed(pollRef[0], 250);
                } catch (Exception e) {
                    call.reject("Export could not start: " + e.getMessage(), e);
                }
            }
        });
    }

    /** Build a timed overlay track from [{ base64, startMs, endMs }], or null if empty. */
    private TimedOverlay buildTrack(JSArray arr) {
        if (arr == null || arr.length() == 0) return null;
        List<TimedOverlay.Item> items = new ArrayList<>();
        try {
            for (int i = 0; i < arr.length(); i++) {
                JSObject o = JSObject.fromJSONObject(arr.getJSONObject(i));
                String b64 = o.getString("base64");
                if (b64 == null) continue;
                byte[] png = Base64.decode(b64, Base64.DEFAULT);
                long s = o.optLong("startMs", 0L) * 1000L;
                long e = o.optLong("endMs", 0L) * 1000L;
                items.add(new TimedOverlay.Item(png, s, e));
            }
        } catch (Exception e) {
            return null;
        }
        return items.isEmpty() ? null : new TimedOverlay(items);
    }

    /** Publish the finished MP4 into Movies/EaseCutPro so it appears in the gallery. */
    private String saveToGallery(File src, String displayName) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Video.Media.DISPLAY_NAME, displayName);
            values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");

            if (Build.VERSION.SDK_INT >= 29) {
                values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/EaseCutPro");
                values.put(MediaStore.Video.Media.IS_PENDING, 1);
                Uri collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                Uri item = resolver.insert(collection, values);
                if (item == null) return null;
                OutputStream os = resolver.openOutputStream(item);
                copyStream(src, os);
                values.clear();
                values.put(MediaStore.Video.Media.IS_PENDING, 0);
                resolver.update(item, values, null, null);
                return "Movies/EaseCutPro/" + displayName;
            } else {
                File moviesDir = new File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "EaseCutPro");
                if (!moviesDir.exists()) moviesDir.mkdirs();
                File dest = new File(moviesDir, displayName);
                OutputStream os = new java.io.FileOutputStream(dest);
                copyStream(src, os);
                values.put(MediaStore.Video.Media.DATA, dest.getAbsolutePath());
                resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
                return "Movies/EaseCutPro/" + displayName;
            }
        } catch (Exception e) {
            return null;
        }
    }

    private void copyStream(File src, OutputStream os) throws Exception {
        if (os == null) throw new Exception("no output stream");
        InputStream in = null;
        try {
            in = new java.io.FileInputStream(src);
            byte[] buf = new byte[1024 * 256];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            os.flush();
        } finally {
            if (in != null) try { in.close(); } catch (Exception ignore) {}
            try { os.close(); } catch (Exception ignore) {}
        }
    }
}
