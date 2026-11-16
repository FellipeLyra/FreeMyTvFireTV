plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing comes from the environment (GitHub Actions secrets). Without it the
// release APK is signed with the debug key so it can still be sideloaded for testing.
val releaseKeystore: String? = System.getenv("FMTV_KEYSTORE")

android {
    namespace = "io.github.fellipelyra.freemytv"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.fellipelyra.freemytv"
        minSdk = 22 // Fire OS 5
        targetSdk = 34
        versionCode = (System.getenv("FMTV_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("FMTV_VERSION_NAME") ?: "1.0.0"
        // Default server for publishing over the internet (phase 8); empty = the person types it.
        val cloudUrl = (System.getenv("FMTV_CLOUD_URL") ?: "").replace("\"", "")
        buildConfigField("String", "CLOUD_URL", "\"$cloudUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("FMTV_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("FMTV_KEY_ALIAS") ?: "freemytv"
                keyPassword = System.getenv("FMTV_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (releaseKeystore != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
