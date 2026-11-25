# 0001 — Android native app plus a Node hub on the PC

## Status

Accepted

## Context

The core requirement is that a screenshot taken on the phone reaches the PC "immediately". On Android, knowing that a screenshot happened requires observing `MediaStore`. A web page or PWA cannot observe `MediaStore`, and cannot run after the browser is backgrounded. Therefore the phone side cannot be a web app.

Three shapes were considered:

1. A Flutter or React Native cross-platform app.
2. An Android native app (Kotlin + Jetpack Compose) with a Node hub on the PC.
3. A web/PWA pair on both sides.

## Decision

The phone side is a native Android app built with Kotlin and Jetpack Compose on Material 3. The PC side is a Node.js background process that owns all state, exposed to the phone over HTTP/WebSocket on the LAN and to the user through a browser-based Material 3 settings page.

## Consequences

- The PC needs no Electron or other desktop runtime; the whole PC side is one Node process plus static assets, which suits a single-user tool.
- Both surfaces can share one Material 3 design language, keeping the phone app and the settings page visually consistent.
- iOS is out of scope. The `MediaStore` observation and the `AccessibilityService` fallback are Android-only.
- A full Android build toolchain (JDK 17, Android SDK, Gradle) is a prerequisite on the PC.
- The PWA option was rejected on a factual basis: it cannot satisfy "the PC knows immediately when the phone takes a screenshot".
