package com.easecutpro.tals;

import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.EditedMediaItemSequence;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.Transformer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Native hardware-codec export via Media3 Transformer. Takes a list of source
 * segments (uri + trim points), clips + concatenates them, and encodes to an MP4
 * using the device's hardware codecs. This is the "native export" engine — the JS
 * side (nativeExport.ts) prefers it over the WebCodecs path for plain cut-only
 * projects and falls back otherwise.
 *
 * v1 scope: trim + concatenate the base source. Overlays / text / Ken Burns / speed
 * are NOT applied here (those keep the WebCodecs path).
 */
@CapacitorPlugin(name = "EcNativeExport")
public class EcNativeExportPlugin extends Plugin {

    /** Lets JS detect that the native module is present. */
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

        final List<EditedMediaItem> items = new ArrayList<>();
        try {
            for (int i = 0; i < segments.length(); i++) {
                JSObject seg = JSObject.fromJSONObject(segments.getJSONObject(i));
                String uri = seg.getString("uri");
                if (uri == null) {
                    call.reject("Segment " + i + " has no uri");
                    return;
                }
                long startMs = seg.optLong("startMs", 0L);
                long endMs = seg.optLong("endMs", 0L);

                MediaItem.ClippingConfiguration.Builder clip = new MediaItem.ClippingConfiguration.Builder()
                        .setStartPositionMs(startMs);
                if (endMs > startMs) clip.setEndPositionMs(endMs);

                MediaItem mediaItem = new MediaItem.Builder()
                        .setUri(uri)
                        .setClippingConfiguration(clip.build())
                        .build();
                items.add(new EditedMediaItem.Builder(mediaItem).build());
            }
        } catch (Exception e) {
            call.reject("Bad segments: " + e.getMessage());
            return;
        }

        final File out = new File(getContext().getCacheDir(),
                "ec_export_" + System.currentTimeMillis() + ".mp4");

        // Transformer must be built + started on the main thread (it owns a Looper);
        // its listener callbacks arrive there too.
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    EditedMediaItemSequence sequence = new EditedMediaItemSequence(items);
                    Composition composition = new Composition.Builder(sequence).build();

                    Transformer transformer = new Transformer.Builder(getContext())
                            .addListener(new Transformer.Listener() {
                                @Override
                                public void onCompleted(Composition composition, ExportResult result) {
                                    JSObject ret = new JSObject();
                                    ret.put("path", out.getAbsolutePath());
                                    ret.put("durationMs", result.durationMs);
                                    call.resolve(ret);
                                }

                                @Override
                                public void onError(Composition composition, ExportResult result, ExportException exception) {
                                    call.reject("Export failed: " + exception.getMessage(), exception);
                                }
                            })
                            .build();

                    transformer.start(composition, out.getAbsolutePath());
                } catch (Exception e) {
                    call.reject("Export could not start: " + e.getMessage(), e);
                }
            }
        });
    }
}
