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
    val media3 = "1.7.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-transformer:$media3")
    implementation("androidx.media3:media3-effect:$media3")
    implementation("androidx.media3:media3-common:$media3")
    // ImmutableList for OverlayEffect / Effects.
    implementation("com.google.guava:guava:33.0.0-android")
}
