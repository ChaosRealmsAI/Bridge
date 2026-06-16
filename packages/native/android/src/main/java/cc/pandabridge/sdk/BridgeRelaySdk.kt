package cc.pandabridge.sdk

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class BridgeRelayContext(
    val baseUrl: String,
    val productId: String,
    val authHeaderName: String = "",
    val authHeaderValue: String = "",
    val appOrigin: String = "",
    val deviceId: String,
    val relayKeyB64: String,
    val authorizationId: String = "",
    val authorizationEpoch: Long = 1,
    val relayKeyId: String = "",
    val senderKeyId: String = "bridge-product",
    val recipientKeyId: String = "bridge-adapter",
    val channelPrefix: String = "bridge-android",
    val adapterId: String = productId,
    val schemaId: String = "bridge-relay-v1",
    val requestGzipThresholdBytes: Int = 16 * 1024,
) {
    val ready: Boolean get() = baseUrl.isNotEmpty() && productId.isNotEmpty() && deviceId.isNotEmpty() && relayKeyB64.isNotEmpty()
}

class BridgeRelayError(val code: String, val detail: String, val causeCode: String = "") :
    RuntimeException(detail.ifBlank { code })

class BridgeRelayHttpClient(
    private val context: BridgeRelayContext,
    private val pathMapper: (String) -> String = { it },
) {
    fun post(path: String, body: JSONObject): JSONObject = request("POST", path, body)

    fun get(path: String): JSONObject = request("GET", path, null)

    private fun request(method: String, path: String, body: JSONObject?): JSONObject {
        val mappedPath = pathMapper(path)
        val conn = (URL(context.baseUrl + mappedPath).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 8000
            readTimeout = 30000
            setRequestProperty("accept", "application/json")
            if (context.appOrigin.isNotEmpty()) setRequestProperty("Origin", context.appOrigin)
            if (context.authHeaderName.isNotEmpty() && context.authHeaderValue.isNotEmpty()) {
                setRequestProperty(context.authHeaderName, context.authHeaderValue)
            }
            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", "application/json; charset=utf-8")
                outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use(BufferedReader::readText) ?: "{}"
        if (code !in 200..299) throw BridgeRelayError("http_$code", "http_$code: ${text.take(180)}")
        return JSONObject(text)
    }
}

class BridgeRelayClient(
    private val context: BridgeRelayContext,
    private val http: BridgeRelayHttpClient = BridgeRelayHttpClient(context),
) {
    suspend fun call(
        command: JSONObject,
        timeoutMs: Long = 270_000L,
        onProgress: (suspend (JSONObject) -> Unit)? = null,
        isProgress: (JSONObject) -> Boolean = { it.optBoolean("progress", false) },
    ): JSONObject {
        require(context.ready) { "bridge_not_ready" }
        val now = System.currentTimeMillis()
        val channelId = "${context.channelPrefix}-$now-${BridgeRelayIds.randomSuffix()}"
        val requestKey = command.optString("request_id").ifBlank { "bridge-$now-${BridgeRelayIds.randomSuffix()}" }
        val requestCommand = JSONObject(command.toString()).put("request_id", requestKey)
        val envelope = BridgeRelayCrypto.encryptEnvelope(context, requestCommand, channelId, 1, requestKey)
        http.post("/v1/products/${BridgeRelayIds.urlEncode(context.productId)}/relay/envelopes", envelope)

        var afterSeq = 1L
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val payload = http.get(
                "/v1/products/${BridgeRelayIds.urlEncode(context.productId)}/relay/envelopes" +
                    "?device_id=${BridgeRelayIds.urlEncode(context.deviceId)}" +
                    "&channel_id=${BridgeRelayIds.urlEncode(channelId)}" +
                    "&after_seq=$afterSeq&limit=${if (onProgress == null) 1 else 10}&wait_ms=1000",
            )
            val items = payload.optJSONArray("items") ?: JSONArray()
            for (i in 0 until items.length()) {
                val responseEnvelope = items.getJSONObject(i)
                val direction = responseEnvelope.optString("direction")
                if (direction.isNotEmpty() && direction != "device_to_product") {
                    throw BridgeRelayError("unexpected_response_direction", direction)
                }
                val result = BridgeRelayCrypto.decryptEnvelope(context, responseEnvelope)
                val responseId = responseEnvelope.optString("id")
                val seq = responseEnvelope.optLong("seq", afterSeq)
                if (seq > afterSeq) afterSeq = seq
                if (responseId.isNotEmpty()) {
                    http.post(
                        "/v1/products/${BridgeRelayIds.urlEncode(context.productId)}/relay/envelopes/${BridgeRelayIds.urlEncode(responseId)}/ack",
                        JSONObject().put("status", "acked").put("device_id", context.deviceId),
                    )
                }
                if (!result.optBoolean("ok", true)) {
                    val code = result.optString("error").ifEmpty { "bridge_adapter_error" }
                    val message = result.optString("message").ifEmpty { code }
                    val causeCode = result.optString("cause_code").ifEmpty { result.optString("code") }
                    throw BridgeRelayError(code, message, causeCode)
                }
                if (onProgress != null && isProgress(result)) {
                    onProgress(result.optJSONObject("data") ?: result)
                    continue
                }
                return result
            }
            Thread.sleep(if (onProgress == null) 700 else 350)
        }
        throw BridgeRelayError("bridge_relay_timeout", "Bridge relay timed out.")
    }
}

object BridgeRelayCrypto {
    fun encryptEnvelope(context: BridgeRelayContext, command: JSONObject, channelId: String, seq: Int, requestKey: String): JSONObject {
        val aadText = BridgeRelayAad.relayEnvelopeAadText(
            context.productId,
            context.deviceId,
            channelId,
            "product_to_device",
            seq,
            context.authorizationId,
            context.authorizationEpoch,
            context.relayKeyId,
        )
        val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, relayKeySpec(context), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aadText.toByteArray(Charsets.UTF_8))
        val encoded = encodeJsonPayload(command, context.requestGzipThresholdBytes)
        val ciphertext = cipher.doFinal(encoded.bytes)
        val meta = JSONObject()
            .put("adapter_id", context.adapterId)
            .put("trace_id", requestKey)
            .put("schema_id", context.schemaId)
            .put("content_type", "application/json")
        if (context.authorizationId.isNotBlank() && context.relayKeyId.isNotBlank()) {
            meta.put("authorization_id", context.authorizationId)
                .put("authorization_epoch", context.authorizationEpoch)
                .put("relay_key_id", context.relayKeyId)
        }
        if (encoded.contentEncoding.isNotEmpty()) meta.put("content_encoding", encoded.contentEncoding)
        return JSONObject()
            .put("product_id", context.productId)
            .put("device_id", context.deviceId)
            .put("channel_id", channelId)
            .put("direction", "product_to_device")
            .put("seq", seq)
            .put("request_key", requestKey)
            .put("ciphertext", BridgeRelayIds.b64(ciphertext))
            .put("aad", BridgeRelayIds.b64(aadText.toByteArray(Charsets.UTF_8)))
            .put("nonce", BridgeRelayIds.b64(nonce))
            .put("algorithm", "AES-GCM-256")
            .put("sender_key_id", context.senderKeyId)
            .put("recipient_key_id", context.recipientKeyId)
            .put("ttl_ms", 300_000)
            .put("meta", meta)
    }

    fun decryptEnvelope(context: BridgeRelayContext, envelope: JSONObject): JSONObject {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val nonce = Base64.decode(envelope.optString("nonce"), Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, relayKeySpec(context), GCMParameterSpec(128, nonce))
        cipher.updateAAD(Base64.decode(envelope.optString("aad"), Base64.NO_WRAP))
        val opened = cipher.doFinal(Base64.decode(envelope.optString("ciphertext"), Base64.NO_WRAP))
        val encoding = envelope.optJSONObject("meta")?.optString("content_encoding", "") ?: ""
        val jsonBytes = if (encoding.equals("gzip", ignoreCase = true)) {
            GZIPInputStream(ByteArrayInputStream(opened)).use { it.readBytes() }
        } else {
            opened
        }
        return JSONObject(String(jsonBytes, Charsets.UTF_8))
    }

    private fun relayKeySpec(context: BridgeRelayContext): SecretKeySpec {
        val bytes = Base64.decode(context.relayKeyB64, Base64.NO_WRAP)
        require(bytes.size == 32) { "relay_key_must_be_32_bytes" }
        return SecretKeySpec(bytes, "AES")
    }

    private fun encodeJsonPayload(command: JSONObject, gzipThresholdBytes: Int): EncodedPayload {
        val raw = command.toString().toByteArray(Charsets.UTF_8)
        if (raw.size <= gzipThresholdBytes) return EncodedPayload(raw)
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(raw) }
        return EncodedPayload(out.toByteArray(), "gzip")
    }
}

object BridgeRelayKeyBootstrap {
    fun wrapRelayKeyForDesktop(relayKey: ByteArray, exchange: JSONObject, aadText: String): JSONObject {
        val keyPairGenerator = KeyPairGenerator.getInstance("EC")
        keyPairGenerator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = keyPairGenerator.generateKeyPair()
        val desktopPublic = ecPublicKeyFromJwk(exchange.getJSONObject("public_jwk"))
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(pair.private)
        agreement.doPhase(desktopPublic, true)
        val aad = aadText.toByteArray(Charsets.UTF_8)
        val wrappingKey = relayWrappingKey(agreement.generateSecret(), aad)
        val nonce = ByteArray(12)
        SecureRandom().nextBytes(nonce)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(wrappingKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        val ciphertext = cipher.doFinal(relayKey)
        val publicJwk = ecPublicJwk(pair.public as ECPublicKey)
        return JSONObject()
            .put("algorithm", "ECDH-P256+A256GCM")
            .put("key_id", exchange.optString("key_id"))
            .put("app_public_jwk", publicJwk)
            .put("nonce_b64", BridgeRelayIds.b64(nonce))
            .put("ciphertext_b64", BridgeRelayIds.b64(ciphertext))
            .put("aad_b64", BridgeRelayIds.b64(aad))
    }

    private fun relayWrappingKey(sharedSecret: ByteArray, aad: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(sharedSecret)
        digest.update("bridge-relay-key-bootstrap-v1".toByteArray(Charsets.UTF_8))
        digest.update(aad)
        return digest.digest()
    }

    private fun ecPublicKeyFromJwk(jwk: JSONObject): java.security.PublicKey {
        val x = BigInteger(1, BridgeRelayIds.b64UrlDecode(jwk.getString("x")))
        val y = BigInteger(1, BridgeRelayIds.b64UrlDecode(jwk.getString("y")))
        val params = AlgorithmParameters.getInstance("EC")
        params.init(ECGenParameterSpec("secp256r1"))
        val spec = params.getParameterSpec(ECParameterSpec::class.java)
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), spec))
    }

    private fun ecPublicJwk(key: ECPublicKey): JSONObject = JSONObject()
        .put("kty", "EC")
        .put("crv", "P-256")
        .put("x", BridgeRelayIds.b64Url(BridgeRelayIds.ecCoordinate(key.w.affineX)))
        .put("y", BridgeRelayIds.b64Url(BridgeRelayIds.ecCoordinate(key.w.affineY)))
}

object BridgeRelayAad {
    fun relayEnvelopeAadText(
        productId: String,
        deviceId: String,
        channelId: String,
        direction: String,
        seq: Int,
        authorizationId: String = "",
        authorizationEpoch: Long = 1,
        relayKeyId: String = "",
    ): String {
        val base = "product:$productId|device:$deviceId|channel:$channelId|direction:$direction|seq:$seq"
        return if (authorizationId.isNotBlank() && relayKeyId.isNotBlank()) {
            "$base|authorization:$authorizationId|epoch:$authorizationEpoch|relay_key:$relayKeyId"
        } else {
            base
        }
    }

    fun relayKeyBootstrapAadText(productId: String, deviceId: String, authorizationId: String, authorizationEpoch: Long, keyId: String): String =
        listOf("bridge-relay-key-bootstrap-v1", productId, deviceId, authorizationId, authorizationEpoch.toString(), keyId)
            .joinToString("|")
}

object BridgeRelayIds {
    fun randomSuffix(): String = java.lang.Long.toHexString(SecureRandom().nextLong())

    fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    fun b64Url(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    fun b64UrlDecode(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    fun urlEncode(value: String): String = URLEncoder.encode(value, "utf-8")

    fun ecCoordinate(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        return when {
            raw.size == 32 -> raw
            raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
            else -> ByteArray(32 - raw.size) + raw
        }
    }
}

private data class EncodedPayload(val bytes: ByteArray, val contentEncoding: String = "")
