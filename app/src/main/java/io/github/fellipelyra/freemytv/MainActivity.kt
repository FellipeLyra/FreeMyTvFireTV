package io.github.fellipelyra.freemytv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * Full-screen WebView that hosts the Free My TV page from the APK's assets.
 *
 * The page is served from https://appassets.androidplatform.net so it gets a real
 * origin (working localStorage and CORS requests to the weather and movie APIs).
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var layouts: LayoutStore
    private lateinit var cloud: CloudSync
    private var resumedOnce = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        layouts = LayoutStore(this)
        cloud = CloudSync(this, layouts,
            onLayoutChanged = { if (::webView.isInitialized) webView.reload() },
            onInfo = { info -> if (::webView.isInitialized) webView.evaluateJavascript("window.FMTVCloud&&FMTVCloud.update($info)", null) })
        handleLayoutCommand(intent)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            // Images of the published layout (files/layouts/current/assets), read-only.
            .addPathHandler("/userlayout/", WebViewAssetLoader.InternalStoragePathHandler(this, layouts.currentDir))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            isFocusable = true
            isFocusableInTouchMode = true
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            // The page declares width=1920; scale that layout to the actual screen.
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.setSupportZoom(false)
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)

                @Deprecated("Used on Fire OS 5 (API 22)")
                override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(Uri.parse(url))

                // Never navigate the launcher away from its own page.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.url.host != WebViewAssetLoader.DEFAULT_DOMAIN

                @Deprecated("Used on Fire OS 5 (API 22)")
                override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                    Uri.parse(url).host != WebViewAssetLoader.DEFAULT_DOMAIN
            }
        }
        webView.addJavascriptInterface(AppBridge(this, webView, layouts, cloud), "FireTV")
        setContentView(webView)
        webView.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/web/index.html")
        webView.requestFocus()
    }

    /**
     * Layout commands sent by Free My TV Studio over ADB, for example:
     *   adb shell am start -n io.github.fellipelyra.freemytv/.MainActivity -a io.github.fellipelyra.freemytv.action.IMPORT_LAYOUT
     * The result is written to the app's external files folder (outbox/result.json).
     * Returns true when the page must reload to show the change.
     */
    private fun handleLayoutCommand(intent: Intent?): Boolean {
        when (intent?.action) {
            ACTION_IMPORT -> layouts.importFromInbox()
            ACTION_ROLLBACK -> layouts.rollback("pedido pelo Studio")
            ACTION_RESET -> layouts.reset()
            // Set the publishing server from the PC, without typing it with the remote:
            //   adb shell am start -n .../.MainActivity -a ...action.SET_CLOUD_SERVER --es url https://tv.example.com
            ACTION_SET_CLOUD -> { cloud.setServer(intent.getStringExtra("url") ?: ""); intent.action = null; return false }
            else -> return false
        }
        intent.action = null // a recreated activity must not repeat the command
        return true
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (handleLayoutCommand(intent)) webView.reload()
    }

    override fun onResume() {
        super.onResume()
        HomeButtonService.onLauncherShown()
        // Layouts published over the internet arrive while the home screen is showing.
        cloud.start()
        // Pick up apps installed while we were in the background.
        if (resumedOnce) webView.evaluateJavascript("typeof discoverTVApps==='function'&&discoverTVApps()", null)
        resumedOnce = true
    }

    override fun onPause() {
        cloud.stop()
        super.onPause()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        when (event.keyCode) {
            // BACK closes the page's dialogs; this is the home screen, so it never exits.
            KeyEvent.KEYCODE_BACK -> {
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) sendKeyToPage("Escape")
                return true
            }
            // The ≡ key on the Fire TV remote opens Customize.
            KeyEvent.KEYCODE_MENU -> {
                if (event.action == KeyEvent.ACTION_UP) {
                    webView.evaluateJavascript(
                        "typeof openSettingsModal==='function'&&!modalOpen&&!drawerOpen&&openSettingsModal()",
                        null,
                    )
                }
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun sendKeyToPage(key: String) {
        val js = """
            (function(){var e;
              try{e=new KeyboardEvent('keydown',{key:'$key',bubbles:true,cancelable:true});}
              catch(x){e=document.createEvent('Event');e.initEvent('keydown',true,true);}
              if(e.key!=='$key'){try{Object.defineProperty(e,'key',{value:'$key'});}catch(x){e.key='$key';}}
              (document.activeElement||document).dispatchEvent(e);})()
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val ACTION_IMPORT = "io.github.fellipelyra.freemytv.action.IMPORT_LAYOUT"
        const val ACTION_ROLLBACK = "io.github.fellipelyra.freemytv.action.ROLLBACK_LAYOUT"
        const val ACTION_RESET = "io.github.fellipelyra.freemytv.action.RESET_LAYOUT"
        const val ACTION_SET_CLOUD = "io.github.fellipelyra.freemytv.action.SET_CLOUD_SERVER"
    }
}
