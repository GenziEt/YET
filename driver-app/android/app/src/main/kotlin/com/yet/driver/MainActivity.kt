package com.yet.driver

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * §Phase 4 (G4): platform bridge for the two pilot-blocking device settings:
 *
 *  1. Battery-optimization exemption — pilots run the app all day with the
 *     screen off; Doze kills the location foreground service otherwise.
 *     ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS is the direct prompt
 *     (permission declared in AndroidManifest.xml). On ROMs that refuse the
 *     implicit intent (some vendor builds throw ActivityNotFoundException) we
 *     fall back to the POWER_MANAGER settings list screen, which every
 *     Android 6+ device has. If even that fails the method completes normally:
 *     Dart treats this as best-effort and the PILOT-RUNBOOK manual steps +
 *     on-screen explainer remain the documented fallback. The channel NEVER
 *     returns an error to the UI thread — a driver must always be able to
 *     acknowledge the permissions screen.
 *
 *  2. "Allow all the time" location — geolocator can request while-in-use at
 *     runtime, but background collection needs the app-op set manually; we
 *     deep-link straight to the system location-settings page.
 *
 * Dart side: lib/main.dart `batteryExemptionChannel`
 * (MethodChannel("yet.dev/battery_exemption")).
 */
class MainActivity : FlutterActivity() {

    private fun isIgnoringBatteryOptimizations(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = getSystemService(POWER_MANAGER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            CHANNEL
        ).setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "isIgnoringBatteryOptimizations" ->
                        result.success(isIgnoringBatteryOptimizations())

                    "requestIgnoreBatteryOptimizations" -> {
                        if (!isIgnoringBatteryOptimizations()) {
                            val requested = runCatching {
                                startActivity(
                                    Intent(
                                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                        Uri.parse("package:$packageName")
                                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                )
                            }.isSuccess
                            if (!requested) {
                                // Vendor-ROM fallback: the ignore-list screen.
                                runCatching {
                                    startActivity(
                                        Intent(
                                            Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
                                        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    )
                                }
                            }
                        }
                        result.success(null)
                    }

                    "openLocationSettings" -> {
                        runCatching {
                            startActivity(
                                Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        }
                        result.success(null)
                    }

                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                // Best-effort intents only; never crash the engine binding.
                result.success(null)
            }
        }
    }

    companion object {
        const val CHANNEL = "yet.dev/battery_exemption"
    }
}
