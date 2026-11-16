package io.github.fellipelyra.freemytv

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.net.Uri
import android.provider.Settings
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * Exposed to the page as `window.FireTV`. Each call gets a numeric id and answers
 * asynchronously through `window.__fmtvResolve(id, result)` (see firetv-bridge.js).
 * Result objects follow the webOS Luna shape: `returnValue` plus `errorText`.
 */
class AppBridge(
    private val activity: Activity,
    private val webView: WebView,
    private val layouts: LayoutStore,
    private val cloud: CloudSync? = null,
) {

    private val pm: PackageManager = activity.packageManager
    private val worker = Executors.newSingleThreadExecutor()

    // ---- Published layouts (see fmtv/runtime.js and LayoutStore) ----

    /** JSON text of the layout to show, or "" for the built-in screen. Called once per page load. */
    // ---- Publishing over the internet (see CloudSync and fmtv/runtime.js) ----

    @JavascriptInterface
    fun cloudInfo(): String = cloud?.info()?.toString() ?: ""

    /** Returns an error message, or "" when the address was accepted. */
    @JavascriptInterface
    fun cloudSetServer(url: String): String = cloud?.setServer(url) ?: ""

    @JavascriptInterface
    fun cloudPair() { cloud?.startPairing() }

    @JavascriptInterface
    fun cloudUnpair() { cloud?.unpair() }

    @JavascriptInterface
    fun getLayoutJson(): String = layouts.activeLayoutJson() ?: ""

    @JavascriptInterface
    fun getLayoutStatus(): String = layouts.status().toString()

    /** The page painted the layout: it becomes the rollback target for the next one. */
    @JavascriptInterface
    fun layoutRendered(id: String) = layouts.confirmRendered(id)

    /** The page could not validate or render the layout: roll back and reload. */
    @JavascriptInterface
    fun layoutFailed(id: String, reason: String) {
        layouts.renderFailed(id, reason)
        webView.post { webView.reload() }
    }

    /** "Layout padrão" button in Customize: back to the original screen (the page reloads itself). */
    @JavascriptInterface
    fun resetLayout() {
        layouts.reset()
    }

    @JavascriptInterface
    fun listLaunchPoints(callId: Int) {
        worker.execute {
            val result = try {
                JSONObject().put("returnValue", true).put("launchPoints", launchPoints())
            } catch (e: Exception) {
                failure(e.message ?: "Could not list apps")
            }
            resolve(callId, result)
        }
    }

    @JavascriptInterface
    fun launch(callId: Int, appId: String, paramsJson: String) {
        activity.runOnUiThread {
            val result = try {
                start(appId, if (paramsJson.isBlank()) JSONObject() else JSONObject(paramsJson))
                JSONObject().put("returnValue", true)
            } catch (e: ActivityNotFoundException) {
                failure("$appId is not installed")
            } catch (e: Exception) {
                failure(e.message ?: "Launch failed")
            }
            resolve(callId, result)
        }
    }

    private fun launchPoints(): JSONArray {
        val found = LinkedHashMap<String, ResolveInfo>()
        for (category in listOf(Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER)) {
            val query = Intent(Intent.ACTION_MAIN).addCategory(category)
            for (info in pm.queryIntentActivities(query, 0)) {
                val pkg = info.activityInfo.packageName
                if (pkg != activity.packageName && pkg !in found) found[pkg] = info
            }
        }
        val list = JSONArray()
        for ((pkg, info) in found) {
            val app = info.activityInfo.applicationInfo
            val item = JSONObject()
                .put("id", pkg)
                .put("title", info.loadLabel(pm).toString())
                .put("systemApp", app.flags and ApplicationInfo.FLAG_SYSTEM != 0)
            artwork(info, app)?.let { item.put("largeIcon", it) }
            list.put(item)
            // Let the catalog's canonical tile pick up the icon of an installed alternative.
            ALIASES.entries.firstOrNull { pkg in it.value }?.let { (canonical, _) ->
                if (canonical !in found) artwork(info, app)?.let {
                    list.put(JSONObject().put("id", canonical).put("title", info.loadLabel(pm).toString())
                        .put("systemApp", true).put("largeIcon", it))
                }
            }
        }
        return list
    }

    /** The TV banner when the app has one (it fits the wide tiles), else its icon, as a data: URL. */
    private fun artwork(info: ResolveInfo, app: ApplicationInfo): String? = try {
        val drawable: Drawable? = info.activityInfo.loadBanner(pm) ?: app.loadBanner(pm) ?: info.loadIcon(pm)
        drawable?.let { toDataUrl(it) }
    } catch (e: Exception) {
        null
    }

    private fun toDataUrl(drawable: Drawable): String {
        var w = drawable.intrinsicWidth.takeIf { it > 0 } ?: 320
        var h = drawable.intrinsicHeight.takeIf { it > 0 } ?: 180
        if (w > 320) { h = h * 320 / w; w = 320 }
        val bitmap = Bitmap.createBitmap(w, h.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        val d = drawable.mutate()
        d.setBounds(0, 0, bitmap.width, bitmap.height)
        d.draw(Canvas(bitmap))
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private fun start(appId: String, params: JSONObject) {
        when (appId) {
            SETTINGS_ID -> return startNew(Intent(Settings.ACTION_SETTINGS))
            AMAZON_HOME_ID -> {
                HomeButtonService.allowStockLauncher()
                val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                return try {
                    startNew(Intent(home).setPackage(AMAZON_LAUNCHER))
                } catch (e: ActivityNotFoundException) {
                    startNew(home)
                }
            }
        }
        val candidates = listOf(appId) + ALIASES[appId].orEmpty()

        // Trailer deep links from the trending row: https://www.youtube.com/tv?v=<id>
        val videoId = params.optString("contentTarget").takeIf { it.isNotEmpty() }
            ?.let { Uri.parse(it).getQueryParameter("v") }
        if (videoId != null) {
            for (pkg in candidates) {
                try {
                    return startNew(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/watch?v=$videoId")).setPackage(pkg))
                } catch (_: ActivityNotFoundException) {
                }
            }
        }
        for (pkg in candidates) {
            val intent = pm.getLeanbackLaunchIntentForPackage(pkg) ?: pm.getLaunchIntentForPackage(pkg)
            if (intent != null) return startNew(intent)
        }
        throw ActivityNotFoundException(appId)
    }

    private fun startNew(intent: Intent) {
        activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun failure(text: String) = JSONObject().put("returnValue", false).put("errorCode", -1).put("errorText", text)

    private fun resolve(callId: Int, result: JSONObject) {
        webView.post { webView.evaluateJavascript("window.__fmtvResolve($callId, $result)", null) }
    }

    companion object {
        const val SETTINGS_ID = "fmtv.settings"
        const val AMAZON_HOME_ID = "fmtv.amazonhome"
        const val AMAZON_LAUNCHER = "com.amazon.tv.launcher"

        /** Other packages that provide the same service, tried in order when the catalog one is missing. */
        val ALIASES = mapOf(
            "com.amazon.firetv.youtube" to listOf(
                "com.google.android.youtube.tv",
                "com.teamsmart.videomanager.tv",
                "com.liskovsoft.smarttubetv.beta",
            ),
            "com.amazon.avod" to listOf("com.amazon.avod.thirdpartyclient"),
            "com.wbd.stream" to listOf("com.hbo.hbonow"),
            "com.disney.disneyplus" to listOf("com.disney.disneyplus.prod"),
        )
    }
}
