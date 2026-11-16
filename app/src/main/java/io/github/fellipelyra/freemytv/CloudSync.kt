package io.github.fellipelyra.freemytv

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

/**
 * Publishing over the internet (roadmap phase 8), the TV side of server/fmtv-cloud.mjs.
 *
 * - Pairing: on request, the TV registers with the server the person chose (HTTPS only),
 *   keeps its own secret token and shows a short code; the person types it in the Studio.
 * - While the home screen is visible, the TV waits for news with a long poll. A new
 *   package is downloaded into the same inbox the ADB path uses and imported by
 *   [LayoutStore], with every check it makes; rollback/reset commands run the same way.
 * - Every result LayoutStore reports (import, drawn, rolled back, reset) is sent back,
 *   so the Studio sees whether the layout really showed up.
 *
 * Nothing runs while the launcher is in the background, and nothing at all until the
 * person pairs. The token never leaves the app's private storage.
 */
class CloudSync(
    private val context: Context,
    private val layouts: LayoutStore,
    /** Called on the main thread when the screen must reload (new layout, rollback, reset). */
    private val onLayoutChanged: () -> Unit,
    /** Called on the main thread with [info] whenever it changes (for the settings screen). */
    private val onInfo: (JSONObject) -> Unit,
) {
    private val prefs = context.getSharedPreferences("cloud", Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())
    private val net = Executors.newSingleThreadExecutor()
    @Volatile private var running = false
    @Volatile private var loop: Thread? = null
    @Volatile private var me = JSONObject()
    @Volatile private var lastError: String? = null
    /** Etag/command of the operation the cloud started, sent along with LayoutStore's reports. */
    @Volatile private var activeEtag: String? = null
    @Volatile private var activeCmd: Int? = null

    private val server: String get() = prefs.getString(KEY_SERVER, null) ?: BuildConfig.CLOUD_URL
    private val token: String? get() = prefs.getString(KEY_TOKEN, null)

    init {
        layouts.onReport = { op, result -> forward(op, result) }
    }

    // ---------------------------------------------------------------- for the page

    fun info(): JSONObject = JSONObject()
        .put("server", server)
        .put("registered", token != null)
        .put("paired", me.optBoolean("paired", false))
        .put("publishers", me.optJSONArray("publishers") ?: org.json.JSONArray())
        .put("pairCode", if (me.isNull("pairCode")) JSONObject.NULL else me.optString("pairCode"))
        .put("pairExpires", me.optLong("pairExpires", 0))
        .put("online", running && lastError == null && token != null)
        .put("error", lastError ?: JSONObject.NULL)

    /** Returns an error message, or null when the address was accepted. */
    fun setServer(url: String): String? {
        val clean = url.trim().trimEnd('/')
        val parsed = try { URL(clean) } catch (e: Exception) { null }
        if (parsed == null || parsed.protocol != "https" || parsed.host.isNullOrEmpty()) {
            return "use um endereço https:// (por exemplo https://tv.seudominio.com)"
        }
        if (clean != server) {
            forget()
            prefs.edit().putString(KEY_SERVER, clean).apply()
        }
        publish()
        return null
    }

    /** Register if needed (or ask for a fresh code) and show the pairing code. */
    fun startPairing() {
        net.execute {
            try {
                if (server.isEmpty()) throw IOException("informe o endereço do servidor")
                val r = if (token == null) {
                    val body = JSONObject().put("model", Build.MODEL ?: "").put("name", deviceName())
                        .put("appVersion", appVersion())
                    val res = call("POST", "/v1/tv/register", body, auth = false)
                    prefs.edit().putString(KEY_TOKEN, res.getString("deviceToken")).apply()
                    res.remove("deviceToken")
                    res
                } else {
                    call("POST", "/v1/tv/pair-code", JSONObject())
                }
                me = r
                lastError = null
                if (running) ensureLoop()
            } catch (e: Exception) {
                lastError = message(e)
            }
            publish()
        }
    }

    /** Forget this TV on the server (every Studio loses access) and locally. */
    fun unpair() {
        net.execute {
            try { if (token != null) call("DELETE", "/v1/tv", null) } catch (_: Exception) { }
            forget()
            publish()
        }
    }

    // ---------------------------------------------------------------- lifecycle

    fun start() {
        running = true
        if (token != null) ensureLoop()
    }

    fun stop() {
        running = false
        loop?.interrupt()
    }

    private fun ensureLoop() {
        if (loop?.isAlive == true) return
        loop = Thread({ runLoop() }, "fmtv-cloud").apply { isDaemon = true; start() }
    }

    private fun runLoop() {
        var backoff = 2000L
        while (running && token != null) {
            try {
                val etag = URLEncoder.encode(prefs.getString(KEY_ETAG, "") ?: "", "UTF-8")
                val cmd = prefs.getInt(KEY_CMD, 0)
                val msg = call("GET", "/v1/tv/next?etag=$etag&cmd=$cmd&wait=25000", null, readTimeout = 40000)
                val before = info().toString()
                me = msg
                lastError = null
                backoff = 2000L
                when (msg.optString("type")) {
                    "layout" -> applyLayout(msg.getString("etag"))
                    "command" -> runCommand(msg.getInt("id"), msg.getString("op"))
                    "unpaired" -> { forget(); publish(); return }
                }
                if (info().toString() != before) publish()
            } catch (e: InterruptedException) {
                return
            } catch (e: Unauthorized) {
                forget()
                lastError = "esta TV foi despareada no servidor"
                publish()
                return
            } catch (e: Exception) {
                if (!running) return
                lastError = message(e)
                publish()
                try { Thread.sleep(backoff) } catch (_: InterruptedException) { return }
                backoff = minOf(backoff * 2, 60000L)
            }
        }
    }

    private fun applyLayout(etag: String) {
        val inbox = context.getExternalFilesDir("inbox") ?: throw IOException("sem pasta de entrada")
        inbox.mkdirs()
        download("/v1/tv/package?etag=" + URLEncoder.encode(etag, "UTF-8"), File(inbox, LayoutStore.PACKAGE_FILE))
        // Remember first: a package that fails must not be fetched again and again.
        prefs.edit().putString(KEY_ETAG, etag).apply()
        activeEtag = etag
        val result = layouts.importFromInbox()
        if (result.optBoolean("ok")) main.post(onLayoutChanged) else activeEtag = null
    }

    private fun runCommand(id: Int, op: String) {
        prefs.edit().putInt(KEY_CMD, id).apply()
        activeCmd = id
        when (op) {
            "rollback" -> layouts.rollback("pedido pela internet")
            "reset" -> layouts.reset()
        }
        activeCmd = null
        main.post(onLayoutChanged)
    }

    // ---------------------------------------------------------------- reports

    /** LayoutStore reported something (import, render, rollback, reset): tell the server. */
    private fun forward(op: String, result: JSONObject) {
        if (token == null) return
        val body = JSONObject(result.toString()).put("op", op).put("appVersion", appVersion())
        activeEtag?.let { body.put("etag", it) }
        activeCmd?.let { body.put("cmd", it) }
        // The operation is over once the TV drew it, rolled it back, or refused it.
        if (op == "render" || op == "rollback" || (op == "import" && !result.optBoolean("ok"))) activeEtag = null
        net.execute {
            try { call("POST", "/v1/tv/report", body) } catch (_: Exception) { }
        }
    }

    // ---------------------------------------------------------------- http

    private class Unauthorized : IOException("401")

    private fun open(path: String, method: String, auth: Boolean, readTimeout: Int): HttpURLConnection {
        val url = URL(server + path)
        if (url.protocol != "https") throw IOException("o servidor precisa ser https://")
        return (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10000
            this.readTimeout = readTimeout
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            if (auth) setRequestProperty("Authorization", "Bearer " + (token ?: throw Unauthorized()))
        }
    }

    private fun call(method: String, path: String, body: JSONObject?, auth: Boolean = true, readTimeout: Int = 20000): JSONObject {
        val c = open(path, method, auth, readTimeout)
        try {
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = c.responseCode
            if (code == 401) throw Unauthorized()
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (code !in 200..299) throw IOException(json.optString("error").ifEmpty { "servidor respondeu $code" })
            return json
        } finally {
            c.disconnect()
        }
    }

    private fun download(path: String, target: File) {
        val c = open(path, "GET", true, 60000)
        try {
            val code = c.responseCode
            if (code == 401) throw Unauthorized()
            if (code != 200) throw IOException("download falhou ($code)")
            val tmp = File(target.parentFile, target.name + ".part")
            var total = 0L
            c.inputStream.use { input ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(16 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_PACKAGE) throw IOException("pacote grande demais")
                        out.write(buf, 0, n)
                    }
                }
            }
            if (!tmp.renameTo(target)) { target.delete(); if (!tmp.renameTo(target)) throw IOException("não foi possível salvar o pacote") }
        } finally {
            c.disconnect()
        }
    }

    // ---------------------------------------------------------------- helpers

    private fun forget() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_ETAG).remove(KEY_CMD).apply()
        me = JSONObject()
        lastError = null
        loop?.interrupt()
    }

    private fun publish() {
        val i = info()
        main.post { onInfo(i) }
    }

    private fun message(e: Exception): String = when (e) {
        is java.net.UnknownHostException -> "servidor não encontrado (sem internet?)"
        is java.net.SocketTimeoutException -> "o servidor não respondeu"
        is javax.net.ssl.SSLException -> "falha no HTTPS do servidor: ${e.message}"
        else -> e.message ?: e.toString()
    }

    private fun appVersion(): String = try {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    } catch (e: Exception) { "" }

    private fun deviceName(): String = listOfNotNull(Build.MANUFACTURER, Build.MODEL).joinToString(" ")

    companion object {
        private const val KEY_SERVER = "server"
        private const val KEY_TOKEN = "token"
        private const val KEY_ETAG = "etag"
        private const val KEY_CMD = "cmd"
        private const val MAX_PACKAGE = 26L * 1024 * 1024
    }
}
