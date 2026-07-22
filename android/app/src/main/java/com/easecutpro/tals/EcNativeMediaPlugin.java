package com.easecutpro.tals;

import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Native media import ("file bridge"). The WebCodecs/blob world can't hand the
 * native encoder (Media3 Transformer) a readable file — a browser blob: URL means
 * nothing to native code. So on Android we pick media with the system picker and
 * COPY the chosen content:// stream into an app-private file up front. That single
 * copy:
 *   - fixes the "requested file could not be read" bug (the transient content://
 *     grant is consumed immediately, never read lazily after it's revoked), and
 *   - gives every source a real filesystem path, which is exactly what the native
 *     export needs and what a native player can open directly.
 *
 * Returns { files: [{ path, name, mimeType, size }] }. The JS side registers each
 * path in webmedia (blob URL for preview, path stashed for native export).
 *
 * Visual media (video/image) uses the Android Photo Picker on API 33+ (a real
 * gallery, no storage permission needed) and ACTION_GET_CONTENT below that. Audio
 * (and "any") uses the Storage Access Framework document picker (files/storage).
 */
@CapacitorPlugin(name = "EcNativeMedia")
public class EcNativeMediaPlugin extends Plugin {

    /** Lets JS detect that the native module is present. */
    @PluginMethod
    public void ping(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * Launch the platform picker. `kind`:
     *   "visual" -> gallery (images + videos)
     *   "audio"  -> files/storage, audio only
     *   "any"    -> files/storage, everything
     */
    @PluginMethod
    public void pick(PluginCall call) {
        String kind = call.getString("kind", "visual");
        Intent intent;

        if ("visual".equals(kind) && Build.VERSION.SDK_INT >= 33) {
            // Android Photo Picker: real gallery, no permission, images + videos.
            intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
            intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 30);
        } else if ("visual".equals(kind)) {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "video/*", "image/*" });
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        } else {
            // Audio / any -> Storage Access Framework (files, downloads, drive…).
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("audio".equals(kind) ? "audio/*" : "*/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }

        startActivityForResult(call, intent, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK) {
            // User cancelled — resolve with an empty list, not an error.
            JSObject ret = new JSObject();
            ret.put("files", new JSArray());
            call.resolve(ret);
            return;
        }

        List<Uri> uris = new ArrayList<>();
        Intent data = result.getData();
        if (data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }

        JSArray files = new JSArray();
        for (Uri uri : uris) {
            try {
                JSObject f = copyToAppFile(uri);
                if (f != null) files.put(f);
            } catch (Exception e) {
                // Skip a single unreadable pick; the rest still import.
            }
        }

        JSObject ret = new JSObject();
        ret.put("files", files);
        call.resolve(ret);
    }

    /** Copy a picked content:// stream into files/ecmedia/<uuid>.<ext>. */
    private JSObject copyToAppFile(Uri uri) throws Exception {
        String displayName = queryDisplayName(uri);
        String mime = getContext().getContentResolver().getType(uri);
        String ext = extensionFor(displayName, mime);

        File dir = new File(getContext().getFilesDir(), "ecmedia");
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, UUID.randomUUID().toString() + (ext.isEmpty() ? "" : "." + ext));

        long size = 0;
        InputStream in = null;
        OutputStream os = null;
        try {
            in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) return null;
            os = new FileOutputStream(out);
            byte[] buf = new byte[1024 * 256];
            int n;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                size += n;
            }
            os.flush();
        } finally {
            if (in != null) try { in.close(); } catch (Exception ignore) {}
            if (os != null) try { os.close(); } catch (Exception ignore) {}
        }

        JSObject f = new JSObject();
        f.put("path", out.getAbsolutePath());
        f.put("name", displayName != null ? displayName : out.getName());
        f.put("mimeType", mime != null ? mime : "");
        f.put("size", size);
        return f;
    }

    private String queryDisplayName(Uri uri) {
        try {
            Cursor c = getContext().getContentResolver()
                    .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
            if (c != null) {
                try {
                    if (c.moveToFirst()) {
                        int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (idx >= 0) return c.getString(idx);
                    }
                } finally {
                    c.close();
                }
            }
        } catch (Exception ignore) {}
        return null;
    }

    /** Best-effort extension from the display name, else from the mime type. */
    private String extensionFor(String name, String mime) {
        if (name != null) {
            int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot < name.length() - 1) {
                return name.substring(dot + 1).toLowerCase();
            }
        }
        if (mime != null) {
            String fromMime = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (fromMime != null) return fromMime;
        }
        return "";
    }
}
