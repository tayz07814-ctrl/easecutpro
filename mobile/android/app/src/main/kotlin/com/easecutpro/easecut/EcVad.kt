package com.easecutpro.easecut

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * EcVad — the app-side client of the on-device two-pass silence engine. ("Vad" in
 * the class/channel names is legacy — the FSMN VAD is retired; the engine is now
 * transcript timestamps + RMS energy, see [SilenceEngine].)
 *
 * The engine runs in a SEPARATE OS PROCESS behind [VadProvider] (":vadengine").
 * That is the crash fix: the media decoder is native code, and a native fault
 * (SIGSEGV/SIGABRT) cannot be caught from Kotlin — hosted in-process it killed the
 * whole app at "Cleaning silence…", silently, past every try/catch. Isolated, the
 * same fault kills only the helper: the binder call throws here, we read the stage
 * the engine recorded before dying and show it, then return [] so Dart falls back
 * to transcript word-gap silence. The app can no longer die on this path, by
 * construction — and the toast names the real culprit.
 *
 * Channel: MethodChannel "ec/vad" → "detectSilences"
 *   args  {uri, wordsS (flattened kept-word [start,end,…] seconds), minSilenceS,
 *          padLeftS, padRightS, trimEdgeS, removeBreaths, sensitivityDb}
 *   reply List<[startS, endS]>  — silence regions to REMOVE (seconds), or [] on any
 *         failure so the Dart caller can fall back to its transcript-gap silence.
 */
class EcVad(
    private val context: Context,
    messenger: BinaryMessenger
) : MethodChannel.MethodCallHandler {

    private val channel = MethodChannel(messenger, "ec/vad")
    private val main = Handler(Looper.getMainLooper())
    private val runningGate = AtomicBoolean(false)

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "detectSilences" -> detectSilences(call, result)
            else -> result.notImplemented()
        }
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
    }

    /** Surface a fault on-screen — the VAD runs on a background thread and any failure
     *  otherwise silently falls back to word-gap silence, hiding the real cause. */
    private fun toast(msg: String) {
        main.post {
            try {
                Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
            } catch (_: Exception) {
            }
        }
    }

    // --- crash guard --------------------------------------------------------
    // Engine deaths no longer take the app down, but there is no point burning
    // minutes re-running an engine that dies every time on this device. A strike is
    // written before each call and cleared when the engine comes back (success OR a
    // cleanly-reported error); only a helper-process death leaves it standing. Two
    // strikes and the engine steps aside for word-gap silence; a reinstall/update
    // re-arms it.

    private fun guardFile() = File(context.filesDir, "ec_vad_guard")

    private fun appStamp(): String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
    } catch (_: Exception) {
        "0"
    }

    private fun guardStrikes(): Int = try {
        val parts = guardFile().readText().trim().split(":")
        if (parts.size == 2 && parts[0] == appStamp()) parts[1].toInt() else 0
    } catch (_: Exception) {
        0
    }

    private fun setGuardStrikes(n: Int) {
        try {
            if (n <= 0) guardFile().delete() else guardFile().writeText("${appStamp()}:$n")
        } catch (_: Exception) {
        }
    }

    /** The stage the engine process recorded before it died (shared filesDir). */
    private fun lastStage(): String = try {
        File(context.filesDir, "ec_vad_stage").readText().trim().ifEmpty { "?" }
    } catch (_: Exception) {
        "?"
    }

    // --- public entry -------------------------------------------------------

    private fun detectSilences(call: MethodCall, result: MethodChannel.Result) {
        val uri = call.argument<String>("uri")
        if (uri == null) {
            result.error("ec_vad", "no uri", null)
            return
        }
        val extras = Bundle()
        val words = call.argument<List<Number>>("wordsS") ?: emptyList()
        extras.putDoubleArray("wordsS", DoubleArray(words.size) { words[it].toDouble() })
        extras.putDouble("minSilenceS", (call.argument<Number>("minSilenceS"))?.toDouble() ?: 0.3)
        extras.putDouble("padLeftS", (call.argument<Number>("padLeftS"))?.toDouble() ?: 0.12)
        extras.putDouble("padRightS", (call.argument<Number>("padRightS"))?.toDouble() ?: 0.1)
        extras.putDouble("trimEdgeS", (call.argument<Number>("trimEdgeS"))?.toDouble() ?: 0.0)
        extras.putBoolean("removeBreaths", call.argument<Boolean>("removeBreaths") ?: false)
        extras.putDouble("sensitivityDb", (call.argument<Number>("sensitivityDb"))?.toDouble() ?: 10.0)

        // One run at a time — a second concurrent run would double the decode + ONNX
        // working set at exactly the moment memory is tightest.
        if (!runningGate.compareAndSet(false, true)) {
            result.success(emptyList<List<Double>>())
            return
        }
        Thread {
            val regions: List<List<Double>> = try {
                val strikes = guardStrikes()
                if (strikes >= MAX_STRIKES) {
                    toast("On-device silence engine is off after repeated failures — using transcript gaps.")
                    emptyList()
                } else {
                    setGuardStrikes(strikes + 1)
                    val reply = context.contentResolver.call(
                        Uri.parse("content://${VadProvider.AUTHORITY}"), "detect", uri, extras
                    )
                    val err = reply?.getString("error")
                    if (err != null) {
                        // The engine failed but came back cleanly — not a strike.
                        setGuardStrikes(0)
                        toast("Silence VAD: $err")
                        emptyList()
                    } else {
                        setGuardStrikes(0)
                        val flat = reply?.getDoubleArray("regions") ?: DoubleArray(0)
                        val out = ArrayList<List<Double>>(flat.size / 2)
                        var i = 0
                        while (i + 1 < flat.size) {
                            out.add(listOf(flat[i], flat[i + 1]))
                            i += 2
                        }
                        out
                    }
                }
            } catch (e: Throwable) {
                // The ENGINE PROCESS died mid-call (native fault) — the strike written
                // above stays. The app survives; say what killed it and fall back.
                toast(
                    "Silence engine crashed during [${lastStage()}] — using transcript gaps. " +
                        "(${e.javaClass.simpleName})"
                )
                emptyList()
            } finally {
                runningGate.set(false)
            }
            main.post { result.success(regions) }
        }.start()
    }

    private companion object {
        const val MAX_STRIKES = 2
    }
}
