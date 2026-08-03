package com.easecutpro.easecut

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle

/**
 * Binder front door of the FSMN VAD, hosted in its OWN OS process
 * (android:process=":vadengine" in the manifest). The app calls
 * `contentResolver.call(AUTHORITY, "detect", uri, params)`; the whole engine —
 * MediaCodec decode + ONNX inference ([VadEngine]) — runs here, on this process's
 * binder thread, and the regions come back in the reply Bundle.
 *
 * Why a ContentProvider: it is the lightest same-app cross-process call there is —
 * the system spawns the helper process on first use, call() is synchronous (the
 * app side already waits on a background thread with a Dart-side timeout), and if
 * native code brings this process down the caller gets a DeadObjectException
 * instead of dying with it. Catchable failures come back as {"error": …}; only a
 * genuine native fault (SIGSEGV in the codec or ONNX) kills the process — and now
 * that costs a fallback, not the app.
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
            val regions = VadEngine.detect(
                context!!,
                arg,
                extras?.getDouble("padBeforeS", 0.18) ?: 0.18,
                extras?.getDouble("padAfterS", 0.12) ?: 0.12,
                extras?.getDouble("trimEdgesS", 0.02) ?: 0.02,
                extras?.getBoolean("tailTrim", false) ?: false
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
