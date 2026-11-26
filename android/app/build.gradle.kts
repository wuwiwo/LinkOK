import java.text.SimpleDateFormat
import java.util.Date
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// ── 版本号 ─────────────────────────────────────────────────
// 手机端与电脑端**各自独立**的语义版本：
//   android/version.config  ← 本文件（手机 App）
//   ../version.config       ← 电脑端（Node Hub + C# helper + 设置页）
//
// 规则：0.MINOR.PATCH —— MINOR = 功能变更/重大修复，PATCH = 小修复。
// 由 scripts/release-android.ps1 / release-pc.ps1 各自递增。
//
// versionCode 是 Android 的单调递增整数（覆盖安装要求），来自
// android/version.properties，与语义版本互不干扰。

val semanticVersion: String = run {
    val f = rootProject.file("version.config")
    if (f.exists()) {
        f.readLines()
            .firstOrNull { it.trim().startsWith("version=") }
            ?.substringAfter('=')
            ?.trim()
            ?: "0.0.0"
    } else {
        "0.0.0"
    }
}

val versionPropsFile = rootProject.file("version.properties")
val versionProps = Properties()
if (versionPropsFile.exists()) {
    versionPropsFile.inputStream().use { versionProps.load(it) }
}
val previousCode = (versionProps.getProperty("versionCode") ?: "0").toInt()
val buildCode = previousCode + 1
val buildDate = SimpleDateFormat("MMdd-HHmm").format(Date())

versionProps.setProperty("versionCode", buildCode.toString())
versionPropsFile.outputStream().use { versionProps.store(it, "Auto-incremented on build") }

android {
    namespace = "com.linkok.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.linkok.app"
        // 只在真机 Android 13 (SDK 33) 实测；声明 29 以免换机时被系统拒绝安装
        minSdk = 29
        targetSdk = 34
        versionCode = buildCode
        // 形如 0.3.0-1126-0930：语义版本 + 构建时间，一眼能看出新旧
        versionName = "$semanticVersion-$buildDate"

        buildConfigField("String", "BUILD_TIME", "\"$buildDate\"")
        buildConfigField("int", "BUILD_CODE", "$buildCode")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // 工程自带的 debug keystore。
    // 不能用默认的 ~/.android/debug.keystore：这台机器上该目录不可写，
    // validateSigningDebug 会以 AccessDeniedException 失败。
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("keystore/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }


    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.02")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-service:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.2")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material3:material3-window-size-class")
    implementation("androidx.compose.material:material-icons-extended")

    implementation("androidx.datastore:datastore-preferences:1.1.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // CameraX：配对页内嵌相机预览（参考图那种样式）。
    // zxing 的 ScanContract 会弹一个全屏 Activity，无法做成"页内取景框"，
    // 所以预览交给 CameraX，解码仍用 zxing 的 core。
    val cameraX = "1.3.4"
    implementation("androidx.camera:camera-core:$cameraX")
    implementation("androidx.camera:camera-camera2:$cameraX")
    implementation("androidx.camera:camera-lifecycle:$cameraX")
    implementation("androidx.camera:camera-view:$cameraX")
    // 只保留 zxing 的 core（解码器）。zxing-android-embedded 那个
    // 封装层已不再需要 —— 它只能弹全屏 Activity，且会额外带入
    // appcompat 相关依赖。
    implementation("com.google.zxing:core:3.5.3")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

