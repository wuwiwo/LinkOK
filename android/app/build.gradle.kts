import java.text.SimpleDateFormat
import java.util.Date
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// ── 版本号纪律 ─────────────────────────────────────────────
// 之前版本号写死 0.1.0，每次重新安装界面上都显示同样的版本，
// 根本无法判断手机上跑的是不是刚构建的那个 APK。
//
// 现在：
//   - 每次 assemble 递增 versionCode（从 version.properties 读，写回）
//   - versionName 带上构建日期时间
//   - BuildConfig 注入构建时间，App 的配对页/设置页可直接显示
//
// 注意：Kotlin DSL 脚本的隐式接收者不含 Project，所以 `gradle` 不能直接用。
// 这里不读 gradle 属性，改为恒定递增 —— 简单、可预期，且正是需要的语义。
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
        // 形如 0.2-1125-2214：主版本 + 构建日期时间，一眼能看出新旧
        versionName = "0.2-$buildDate"

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

    // QR 扫描：zxing（第三方库，ghost 版无需 Google Play Services）
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

