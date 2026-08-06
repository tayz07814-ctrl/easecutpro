package com.easecutpro.easecut

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle

/**
 * Binder front door of the Silence Mastery engine (Silero VAD, the same engine
 * the web app on main runs), hosted in its OWN OS process (android:process=
 * ":vadengine"). The app calls `contentResolver.call(AUTHORITY, "detect", uri,
 * params)`; the whole engine — MediaCodec decode + Silero ONNX + the mastery
 * post-pipeline ([SilenceEngine]) — runs here, on this process's binder thread,
 * and the cut regions come back in the reply Bundle.
 *
 * Why a ContentProvider: it is the lightest same-app cross-process call there is —
 * the system spawns the helper process on first use, call() is synchronous (the
 * app side already waits on a background thread with a Dart-side timeout), and if
 * native code (the decoder) brings this process down the caller gets a
 * DeadObjectException instead of dying with it. Catchable failures come back as
 * {"error": …}; only a genuine native fault kills the process — and that costs a
 * fallback, not the app.
 */
class VadProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        val out = Bundle()
        if (method != "detect" || arg == null) {
            out.putString("error", "bad request")
            return out
        }
        return try {
            val regions = SilenceEngine.detect(
                context!!,
                arg,
                extras?.getDouble("minSilenceS", 0.15) ?: 0.15,
                extras?.getDouble("padLeftMs", 0.0) ?: 0.0,
                extras?.getDouble("padRightMs", 0.0) ?: 0.0,
                extras?.getDouble("trimLeftMs", 30.0) ?: 30.0,
                extras?.getDouble("trimRightMs", 10.0) ?: 10.0,
                extras?.getBoolean("breathRefine", true) ?: true
            )
            val flat = DoubleArray(regions.size * 2)
            for (i in regions.indices) {
                flat[i * 2] = regions[i][0]
                flat[i * 2 + 1] = regions[i][1]
            }
            out.putDoubleArray("regions", flat)
            out
        } catch (t: Throwable) {
            val top = t.stackTrace.firstOrNull()?.let {
                "${it.className.substringAfterLast('.')}.${it.methodName}:${it.lineNumber}"
            } ?: "?"
            out.putString("error", "${t.javaClass.simpleName}: ${t.message} @ $top")
            out
        }
    }

    // Unused ContentProvider surface — this provider only speaks call().
    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?
    ): Int = 0

    companion object {
        const val AUTHORITY = "com.easecutpro.easecut.vadengine"
    }
}
