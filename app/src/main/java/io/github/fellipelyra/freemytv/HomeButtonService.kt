package io.github.fellipelyra.freemytv

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent

/**
 * Optional: makes the remote's Home button open Free My TV.
 *
 * Fire OS does not let third-party apps become the default launcher, so this
 * accessibility service watches for Amazon's home screen coming to the front and
 * immediately opens Free My TV instead. The "Fire TV Home" tile turns this off
 * until the user opens some other app, so Amazon's store stays reachable.
 *
 * It only reads which app is in front; it never reads screen content.
 */
class HomeButtonService : AccessibilityService() {

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        when {
            pkg in STOCK_LAUNCHERS -> if (!allowStock) {
                startActivity(
                    Intent(this, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                )
            }
            pkg != packageName && pkg !in IGNORED -> allowStock = false
        }
    }

    override fun onInterrupt() {}

    companion object {
        private val STOCK_LAUNCHERS = setOf("com.amazon.tv.launcher", "com.amazon.firehomestarter")

        // Overlays that appear on top of the home screen without leaving it.
        private val IGNORED = setOf(
            "com.android.systemui",
            "com.amazon.tv.notificationcenter",
            "com.amazon.vizzini",
            "com.amazon.tv.inputpreference.service",
        )

        @Volatile
        private var allowStock = false

        fun allowStockLauncher() {
            allowStock = true
        }

        fun onLauncherShown() {
            allowStock = false
        }
    }
}
