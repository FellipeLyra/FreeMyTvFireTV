package io.github.fellipelyra.freemytv

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipInputStream

/**
 * Keeps the layouts published from Free My TV Studio on the device.
 *
 *   files/layouts/current/    layout being shown (layout.json + assets/)
 *   files/layouts/previous/   last layout that rendered correctly, for rollback
 *   files/layouts/state.json  {"id", "status": "pending"|"verified", "attempts"}
 *   files/layouts/log.txt     short history of imports, rollbacks and failures
 *
 * Packages arrive in the app's external files folder (`.../files/inbox/layout.fmtv`),
 * which `adb push` can write without root. A package is a zip with `layout.json`
 * and `assets/<file>` only. Everything is checked before anything is replaced:
 * entry names, sizes, the declared SHA-256 of every asset and the schema version.
 * The deep schema check happens in the WebView (fmtv/engine.js) and a layout only
 * becomes "verified" after the page reports that it rendered; a layout that fails,
 * or that never confirms after [MAX_ATTEMPTS] starts, is rolled back automatically.
 *
 * Layouts are data: no file from a package is ever executed or loaded as a page.
 */
class LayoutStore(private val context: Context) {

    private val base = File(context.filesDir, "layouts")
    val currentDir = File(base, "current")
    private val previousDir = File(base, "previous")
    private val stagingDir = File(base, "staging")
    private val stateFile = File(base, "state.json")
    private val logFile = File(base, "log.txt")

    /** Told about every result (import, render, rollback, reset); used by [CloudSync]. */
    @Volatile var onReport: ((String, JSONObject) -> Unit)? = null

    init {
        base.mkdirs()
        currentDir.mkdirs()
    }

    // ---------------------------------------------------------------- reading

    /** The layout to render now, or null for the built-in screen. Counts start attempts. */
    @Synchronized
    fun activeLayoutJson(): String? {
        val layout = File(currentDir, LAYOUT_FILE)
        if (!layout.isFile) return null
        val state = readState()
        if (state.optString("status") == STATUS_PENDING) {
            val attempts = state.optInt("attempts", 0)
            if (attempts >= MAX_ATTEMPTS) {
                rollback("o layout ${state.optString("id")} não confirmou a renderização após $attempts tentativas")
                return activeLayoutJson()
            }
            writeState(state.put("attempts", attempts + 1))
        }
        return try {
            layout.readText()
        } catch (e: IOException) {
            rollback("não foi possível ler o layout: ${e.message}")
            null
        }
    }

    @Synchronized
    fun status(): JSONObject {
        val state = readState()
        val prev = File(previousDir, LAYOUT_FILE)
        return JSONObject()
            .put("active", File(currentDir, LAYOUT_FILE).isFile)
            .put("id", state.optString("id"))
            .put("name", state.optString("name"))
            .put("status", state.optString("status"))
            .put("previous", if (prev.isFile) layoutName(prev) else JSONObject.NULL)
    }

    // ---------------------------------------------------------------- page reports

    @Synchronized
    fun confirmRendered(id: String) {
        val state = readState()
        if (state.optString("status") == STATUS_PENDING && state.optString("id") == id) {
            writeState(state.put("status", STATUS_VERIFIED).put("attempts", 0))
            log("layout $id confirmado na tela")
            report("render", JSONObject().put("ok", true).put("id", id))
        }
    }

    @Synchronized
    fun renderFailed(id: String, reason: String) {
        rollback("o layout $id falhou: ${reason.take(500)}")
    }

    // ---------------------------------------------------------------- changes

    /** Import `inbox/layout.fmtv`. Returns a result object (also written to outbox/result.json). */
    @Synchronized
    fun importFromInbox(): JSONObject {
        val inbox = context.getExternalFilesDir("inbox")
        val pkg = File(inbox, PACKAGE_FILE)
        val result = try {
            if (!pkg.isFile) throw ImportException("pacote não encontrado: ${pkg.absolutePath}")
            if (pkg.length() > MAX_PACKAGE_BYTES) throw ImportException("pacote maior que $MAX_PACKAGE_BYTES bytes")
            val layout = unpackToStaging(pkg)
            promoteStaging(layout)
            log("importado ${layout.optString("id")} (${layout.optString("name")})")
            JSONObject().put("ok", true).put("id", layout.optString("id")).put("name", layout.optString("name"))
        } catch (e: ImportException) {
            stagingDir.deleteRecursively()
            log("importação recusada: ${e.message}")
            JSONObject().put("ok", false).put("error", e.message)
        } catch (e: Exception) {
            stagingDir.deleteRecursively()
            log("importação falhou: $e")
            JSONObject().put("ok", false).put("error", e.toString())
        } finally {
            pkg.delete()
        }
        return report("import", result)
    }

    /** Go back to the previous layout (or to the built-in screen when there is none). */
    @Synchronized
    fun rollback(reason: String): JSONObject {
        val hadPrevious = File(previousDir, LAYOUT_FILE).isFile
        currentDir.deleteRecursively()
        if (hadPrevious) {
            if (!previousDir.renameTo(currentDir)) throw IOException("rollback: rename falhou")
            val restored = File(currentDir, LAYOUT_FILE)
            val info = layoutName(restored)
            writeState(JSONObject().put("id", info.optString("id")).put("name", info.optString("name"))
                .put("status", STATUS_VERIFIED).put("attempts", 0))
        } else {
            currentDir.mkdirs()
            stateFile.delete()
        }
        log("rollback ($reason) → ${if (hadPrevious) "layout anterior" else "tela original"}")
        return report("rollback", JSONObject().put("ok", true).put("reason", reason.take(2000))
            .put("restored", if (hadPrevious) "previous" else "default"))
    }

    /** Stop using the published layout. It is kept as "previous" so it can be restored. */
    @Synchronized
    fun reset(): JSONObject {
        if (File(currentDir, LAYOUT_FILE).isFile) {
            if (readState().optString("status") == STATUS_VERIFIED) {
                previousDir.deleteRecursively()
                currentDir.renameTo(previousDir)
            } else {
                currentDir.deleteRecursively()
            }
            currentDir.mkdirs()
            stateFile.delete()
            log("layout desativado; tela original")
        }
        return report("reset", JSONObject().put("ok", true))
    }

    // ---------------------------------------------------------------- internals

    private fun unpackToStaging(pkg: File): JSONObject {
        stagingDir.deleteRecursively()
        val assetsDir = File(stagingDir, "assets")
        assetsDir.mkdirs()
        var total = 0L
        var entries = 0
        ZipInputStream(pkg.inputStream().buffered()).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                entries++
                if (entries > MAX_ENTRIES) throw ImportException("pacote com arquivos demais")
                val name = entry.name
                if (entry.isDirectory) {
                    if (name != "assets/") throw ImportException("pasta não permitida: $name")
                    continue
                }
                val target = when {
                    name == LAYOUT_FILE -> File(stagingDir, LAYOUT_FILE)
                    name.startsWith("assets/") && ASSET_FILE.matches(name.removePrefix("assets/")) ->
                        File(assetsDir, name.removePrefix("assets/"))
                    else -> throw ImportException("arquivo não permitido no pacote: $name")
                }
                // Defence in depth against path traversal, on top of the name patterns.
                if (!target.canonicalPath.startsWith(stagingDir.canonicalPath + File.separator)) {
                    throw ImportException("caminho inválido: $name")
                }
                if (target.exists()) throw ImportException("arquivo repetido: $name")
                val limit = if (name == LAYOUT_FILE) MAX_LAYOUT_BYTES else MAX_ASSET_BYTES
                total += copyLimited(zip, target, limit, name)
                if (total > MAX_UNPACKED_BYTES) throw ImportException("conteúdo descompactado grande demais")
            }
        }

        val layoutFile = File(stagingDir, LAYOUT_FILE)
        if (!layoutFile.isFile) throw ImportException("layout.json ausente")
        val layout = try {
            JSONObject(layoutFile.readText())
        } catch (e: Exception) {
            throw ImportException("layout.json não é JSON válido")
        }
        val version = layout.optInt("schemaVersion", -1)
        if (version < 1) throw ImportException("schemaVersion ausente")
        if (version > SUPPORTED_SCHEMA) {
            throw ImportException("layout usa o schema $version; este app entende até o $SUPPORTED_SCHEMA. Atualize o Free My TV.")
        }
        if (!ID.matches(layout.optString("id"))) throw ImportException("id do layout inválido")

        // Every file must be declared, with matching size and SHA-256; nothing extra.
        val declared = HashSet<String>()
        val assets = layout.optJSONArray("assets")
        if (assets != null) {
            for (i in 0 until assets.length()) {
                val a = assets.optJSONObject(i) ?: throw ImportException("asset $i inválido")
                val file = a.optString("file")
                if (!ASSET_FILE.matches(file)) throw ImportException("nome de asset inválido: $file")
                val f = File(assetsDir, file)
                if (!f.isFile) throw ImportException("asset declarado mas ausente: $file")
                if (f.length() != a.optLong("bytes", -1)) throw ImportException("tamanho não confere: $file")
                if (sha256(f) != a.optString("sha256").lowercase(Locale.ROOT)) throw ImportException("SHA-256 não confere: $file")
                declared.add(file)
            }
        }
        assetsDir.listFiles()?.forEach { if (it.name !in declared) throw ImportException("asset não declarado: ${it.name}") }
        return layout
    }

    private fun promoteStaging(layout: JSONObject) {
        val state = readState()
        val currentExists = File(currentDir, LAYOUT_FILE).isFile
        // Only a layout that rendered correctly is worth keeping as the rollback target.
        if (currentExists && state.optString("status") == STATUS_VERIFIED) {
            previousDir.deleteRecursively()
            if (!currentDir.renameTo(previousDir)) throw IOException("não foi possível guardar o layout anterior")
        } else {
            currentDir.deleteRecursively()
        }
        if (!stagingDir.renameTo(currentDir)) throw IOException("não foi possível ativar o novo layout")
        writeState(JSONObject().put("id", layout.optString("id")).put("name", layout.optString("name"))
            .put("status", STATUS_PENDING).put("attempts", 0))
    }

    private fun copyLimited(input: InputStream, target: File, limit: Long, name: String): Long {
        var written = 0L
        val buf = ByteArray(16 * 1024)
        FileOutputStream(target).use { out ->
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                written += n
                if (written > limit) throw ImportException("$name maior que $limit bytes")
                out.write(buf, 0, n)
            }
        }
        return written
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(16 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun layoutName(file: File): JSONObject = try {
        val j = JSONObject(file.readText())
        JSONObject().put("id", j.optString("id")).put("name", j.optString("name"))
    } catch (e: Exception) {
        JSONObject()
    }

    private fun readState(): JSONObject = try {
        if (stateFile.isFile) JSONObject(stateFile.readText()) else JSONObject()
    } catch (e: Exception) {
        JSONObject()
    }

    private fun writeState(state: JSONObject) {
        val tmp = File(base, "state.json.tmp")
        tmp.writeText(state.toString())
        if (!tmp.renameTo(stateFile)) {
            stateFile.delete()
            tmp.renameTo(stateFile)
        }
    }

    private fun log(line: String) {
        try {
            if (logFile.length() > MAX_LOG_BYTES) {
                val keep = logFile.readText().takeLast((MAX_LOG_BYTES / 2).toInt())
                logFile.writeText(keep)
            }
            val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(Date())
            logFile.appendText("$ts $line\n")
        } catch (_: IOException) {
        }
    }

    /** Mirror the result and the log where `adb pull` can read them. */
    private fun report(op: String, result: JSONObject): JSONObject {
        result.put("op", op).put("status", status()).put("time", System.currentTimeMillis())
            .put("supportedSchema", SUPPORTED_SCHEMA)
        try {
            val outbox = context.getExternalFilesDir("outbox")
            if (outbox != null) {
                File(outbox, "result.json").writeText(result.toString(2))
                if (logFile.isFile) logFile.copyTo(File(outbox, "log.txt"), overwrite = true)
            }
        } catch (_: IOException) {
        }
        try { onReport?.invoke(op, result) } catch (_: Exception) { }
        return result
    }

    private class ImportException(message: String) : Exception(message)

    companion object {
        const val SUPPORTED_SCHEMA = 1
        const val LAYOUT_FILE = "layout.json"
        const val PACKAGE_FILE = "layout.fmtv"
        private const val STATUS_PENDING = "pending"
        private const val STATUS_VERIFIED = "verified"
        private const val MAX_ATTEMPTS = 2
        private const val MAX_ENTRIES = 80
        private const val MAX_LAYOUT_BYTES = 1024L * 1024
        private const val MAX_ASSET_BYTES = 8L * 1024 * 1024
        private const val MAX_UNPACKED_BYTES = 26L * 1024 * 1024
        private const val MAX_PACKAGE_BYTES = 26L * 1024 * 1024
        private const val MAX_LOG_BYTES = 64L * 1024
        private val ASSET_FILE = Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\\.(png|jpg|jpeg|webp)$")
        private val ID = Regex("^[A-Za-z][A-Za-z0-9_-]{0,63}$")
    }
}
