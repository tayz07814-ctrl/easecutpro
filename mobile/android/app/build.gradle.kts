plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.easecutpro.easecut"
    // Media3 needs 34+; androidx.core 1.17 / androidx.browser 1.9 (pulled by
    // supabase_flutter / url_launcher) require compileSdk 36.
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Distinct from the current Capacitor app (com.easecutpro.tals) so this
        // native rebuild installs ALONGSIDE it while we develop.
        applicationId = "com.easecutpro.easecut"
        minSdk = 24
        targetSdk = 34
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // Debug-signed for now so `flutter build apk` produces an installable APK.
            signingConfig = signingConfigs.getByName("debug")
            // R8 was renaming ai.onnxruntime.* — whose native code resolves those
            // classes BY NAME — so every session.run() aborted the engine process
            // with "JNI DETECTED ERROR: java_class == null" (SIGABRT). Belt and
            // braces: shrinking off, plus keep rules in case it is turned back on.
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
        // Media3 Transformer / effect APIs are marked @UnstableApi — opt in project-wide
        // so we don't need per-call annotations.
        freeCompilerArgs.add("-opt-in=androidx.media3.common.util.UnstableApi")
    }
}

flutter {
    source = "../.."
}

dependencies {
    // 1.9+: CompositionPlayer.setComposition is repeatable — the preview swaps cut
    // lists inside ONE live player (EcPlayer), which is what kills the black flash
    // on edits and the per-edit teardown that could ANR-kill the app.
    val media3 = "1.9.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-transformer:$media3")
    implementation("androidx.media3:media3-effect:$media3")
    implementation("androidx.media3:media3-common:$media3")
    // ImmutableList for OverlayEffect / Effects.
    implementation("com.google.guava:guava:33.0.0-android")
    // Silero VAD (Silence Mastery — the SAME engine the web app runs). The ONNX
    // runtime lives in the crash-isolated :vadengine process, so a native fault
    // there can never take the app down. 1.20 had known native crashes on some
    // budget SoCs (and no 16KB-page support) — pin the current stable instead.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.28.0")
}
