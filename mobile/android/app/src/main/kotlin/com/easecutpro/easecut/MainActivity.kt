package com.easecutpro.easecut

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {

    private var player: EcPlayer? = null
    private var exporter: EcExport? = null
    private var vad: EcVad? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger
        player = EcPlayer(applicationContext, messenger, flutterEngine.renderer)
        exporter = EcExport(applicationContext, messenger)
        vad = EcVad(applicationContext, messenger)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        player?.dispose()
        exporter?.dispose()
        vad?.dispose()
        player = null
        exporter = null
        vad = null
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
