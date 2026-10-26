// ClaudeCall for Android: a full-screen window onto the ClaudeCall running on your own computer.
// Built by GitHub Actions (.github/workflows/build.yml): gradle -p android assembleRelease -PappVersion=1.2.3
plugins {
    id("com.android.application")
}

val appVersion = (findProperty("appVersion") as String?) ?: "0.1.0"
// 1.2.3 -> 10203: each release must have a larger number than the one before
val appVersionCode = appVersion.split(".").map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
    .let { (it + listOf(0, 0, 0)).take(3) }.let { (a, b, c) -> a * 10000 + b * 100 + c }.coerceAtLeast(1)

// A release key, when CI is given one (see README): updates then install over the old version.
// Without it the APK is signed with a throwaway debug key, which installs but cannot update.
val keystore = System.getenv("ANDROID_KEYSTORE")

android {
    namespace = "com.claudecall.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.claudecall.app"
        minSdk = 29 // Android 10: reading the certificate to show its fingerprint needs it
        targetSdk = 34 // 35 forces drawing under the status bar, which the page does not expect
        versionName = appVersion
        versionCode = appVersionCode
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (keystore != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
