# ============================================================================
# R8 / ProGuard rules — YET Driver (§STARTUP-OPTIMIZATION.md §5.3)
# ----------------------------------------------------------------------------
# Baseline comes from proguard-android-optimize.txt (wired in build.gradle).
# These additions protect exactly the reflection surfaces this app uses, so
# shrinking can stay aggressive without breaking runtime behaviour.
# ============================================================================

# ── Flutter engine ───────────────────────────────────────────────────────────
# The embedding already ships consumer rules via its AAR; these two lines are
# the documented safety net for MethodChannel / plugin registrant reflection.
-keep class io.flutter.**  { *; }
-keep class io.flutter.plugins.** { *; }

# Our custom platform channel handler (MainActivity.configureFlutterEngine
# registers MethodChannel("yet.dev/battery_exemption")) — Activity itself must
# survive under a stable name because the manifest references ".MainActivity".
-keep class com.yet.driver.MainActivity { *; }

# ── Firebase Messaging (FCM push, Phase 5) ───────────────────────────────────
# firebase-messaging's consumer rules cover most of it; keep the service entry
# point explicitly since it is instantiated by Google Play services via the
# manifest-declared service (reflection by class NAME).
-keep class com.google.firebase.messaging.** { *; }
-keep class * extends com.google.firebase.messaging.FirebaseMessagingService { *; }

# ── JSON models touched by dart:convert round-tripping ───────────────────────
# All encode/decode paths in lib/ use Map<String,Object> literals (no
# reflection-based (de)serializers), so NO GSON/Moshi keep-rules are needed —
# if one is ever introduced, add its rules HERE or R8 will strip getters.

# ── Keep annotations used at runtime ─────────────────────────────────────────
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# ── Crash readability ────────────────────────────────────────────────────────
# Upload mapping files to the crash backend so obfuscated stacks remain
# debuggable during the pilot.
-renamesourcefileattribute SourceFile
-keepattributes SourceFile,LineNumberTable

# ── Aggressive but safe optimizations ────────────────────────────────────────
-dontwarn org.jetbrains.annotations.**
