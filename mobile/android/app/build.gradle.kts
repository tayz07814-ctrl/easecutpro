import java.util.Properties
import java.io.FileInputStream

// Release signing. The upload key is supplied OUT of the repo — android/key.properties
// locally, or KEYSTORE_* env vars in CI (the workflow writes the base64 secret to a
// file). No keystore present -> fall back to the debug key so a dev/CI build still
// produces an installable APK, but a debug-signed build must NEVER ship: the Android
// debug key is a publicly known keypair, so anyone can forge an "update" that the OS
// accepts as the same app.
val keystorePropsFile = rootProject.file("key.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) FileInputStream(keystorePropsFile).use { load(it) }
}
val ksPath: String? = keystoreProps.getProperty("storeFile") ?: System.getenv("KEYSTORE_FILE")
val ksPassword: String? = keystoreProps.getProperty("storePassword") ?: System.getenv("KEYSTORE_PASSWORD")
val ksAlias: String? = keystoreProps.getProperty("keyAlias") ?: System.getenv("KEY_ALIAS")
val ksKeyPassword: String? = keystoreProps.getProperty("keyPassword") ?: System.getenv("KEY_PASSWORD")
val hasUploadKey = ksPath != null && file(ksPath).exists() && ksPassword != null && ksAlias != null

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
        // Play requires a current target API for new apps and updates; a higher
        // target also opts the app into the newer platform security defaults.
        targetSdk = 36
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasUploadKey) {
            create("upload") {
                storeFile = file(ksPath!!)
                storePassword = ksPassword
                keyAlias = ksAlias
                keyPassword = ksKeyPassword ?: ksPassword
            }
        }
    }

    buildTypes {
        release {
            // Real upload key when one is supplied; debug key only as a dev fallback.
            signingConfig = if (hasUploadKey) signingConfigs.getByName("upload")
                            else signingConfigs.getByName("debug")
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
    // ONNX Runtime for on-device ML inference (Silero VAD + background removal).
    // R8 was renaming ai.onnxruntime.* — whose native code resolves those
    // classes BY NAME — so every session.run() aborted the engine process
    // with "JNI DETECTED ERROR: java_class == null" (SIGABRT). Belt and
    // braces: shrinking off, plus keep rules in case it is turned back on.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.28.0")
}
