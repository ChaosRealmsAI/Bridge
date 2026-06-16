import CryptoKit
import Foundation
import zlib

public struct BridgeRelayConfiguration: Sendable, Hashable {
    public var relayEnvelopeURL: URL?
    public var productId: String
    public var deviceId: String
    public var relayKeyB64: String
    public var authorizationId: String
    public var authorizationEpoch: Int
    public var relayKeyId: String
    public var senderKeyId: String
    public var recipientKeyId: String
    public var adapterId: String
    public var schemaId: String

    public init(
        relayEnvelopeURL: URL? = nil,
        productId: String,
        deviceId: String,
        relayKeyB64: String,
        authorizationId: String = "",
        authorizationEpoch: Int = 1,
        relayKeyId: String = "",
        senderKeyId: String = "bridge-ios",
        recipientKeyId: String = "bridge-adapter",
        adapterId: String,
        schemaId: String
    ) {
        self.relayEnvelopeURL = relayEnvelopeURL
        self.productId = productId
        self.deviceId = deviceId
        self.relayKeyB64 = relayKeyB64
        self.authorizationId = authorizationId
        self.authorizationEpoch = authorizationEpoch
        self.relayKeyId = relayKeyId
        self.senderKeyId = senderKeyId
        self.recipientKeyId = recipientKeyId
        self.adapterId = adapterId
        self.schemaId = schemaId
    }
}

public enum PandaBridgeError: Error, Sendable, CustomStringConvertible, LocalizedError {
    case notConfigured
    case invalidRelayKey
    case invalidResponse(String)
    case adapterError(String)

    public var description: String {
        switch self {
        case .notConfigured: return "bridge_not_configured"
        case .invalidRelayKey: return "relay_key_invalid"
        case .invalidResponse(let message): return "bridge_invalid_response:\(message)"
        case .adapterError(let message): return message
        }
    }

    public var errorDescription: String? { description }
}

public enum BridgeRelayClient {
    public static func call(
        configuration config: BridgeRelayConfiguration,
        payload command: [String: Any],
        timeoutSeconds: TimeInterval = 20,
        onProgress: (([String: Any]) async throws -> Void)? = nil
    ) async throws -> [String: Any] {
        guard let url = config.relayEnvelopeURL else { throw PandaBridgeError.notConfigured }
        guard let key = Data(base64Encoded: config.relayKeyB64), key.count == 32 else { throw PandaBridgeError.invalidRelayKey }
        let existingRequestKey = (command["request_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let requestKey = existingRequestKey.isEmpty
            ? "bridge-ios-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8))"
            : existingRequestKey
        var requestCommand = command
        requestCommand["request_id"] = requestKey
        let envelope = try BridgeRelayCrypto.encryptEnvelope(requestCommand, key: key, config: config, requestKey: requestKey)
        let postResponse = try await requestJson(url: url, method: "POST", body: envelope, timeoutSeconds: timeoutSeconds)
        if let responseEnvelope = postResponse["response_envelope"] as? [String: Any] {
            return try decodeRelayResult(responseEnvelope, key: key)
        }

        guard (postResponse["ok"] as? Bool) == true else {
            throw PandaBridgeError.invalidResponse("missing_response_envelope")
        }
        guard let channelId = envelope["channel_id"] as? String, !channelId.isEmpty else {
            throw PandaBridgeError.invalidResponse("missing_channel_id")
        }

        var afterSeq = 1
        let deadline = Date().addingTimeInterval(max(1, timeoutSeconds))
        while Date() < deadline {
            let limit = onProgress == nil ? 1 : 10
            let waitSeconds = min(max(1, deadline.timeIntervalSinceNow), 30)
            let inbox = try await requestJson(
                url: pollURL(base: url, config: config, channelId: channelId, afterSeq: afterSeq, limit: limit),
                method: "GET",
                body: nil,
                timeoutSeconds: waitSeconds
            )
            let items = envelopeItems(inbox["items"])
            for responseEnvelope in items {
                if let seq = intValue(responseEnvelope["seq"]), seq > afterSeq {
                    afterSeq = seq
                }
                if let responseId = responseEnvelope["id"] as? String, !responseId.isEmpty {
                    _ = try await requestJson(
                        url: ackURL(base: url, envelopeId: responseId),
                        method: "POST",
                        body: ["status": "acked", "device_id": config.deviceId],
                        timeoutSeconds: min(10, waitSeconds)
                    )
                }
                let result = try decodeRelayResult(responseEnvelope, key: key)
                if isProgress(result) {
                    if let onProgress {
                        try await onProgress((result["data"] as? [String: Any]) ?? result)
                    }
                    continue
                }
                return result
            }
            try await Task.sleep(nanoseconds: UInt64(onProgress == nil ? 700_000_000 : 350_000_000))
        }
        throw PandaBridgeError.adapterError("bridge_relay_timeout:Bridge relay timed out.")
    }

    private static func decodeRelayResult(_ responseEnvelope: [String: Any], key: Data) throws -> [String: Any] {
        if let direction = responseEnvelope["direction"] as? String, !direction.isEmpty, direction != "device_to_product" {
            throw PandaBridgeError.invalidResponse("unexpected_response_direction:\(direction)")
        }
        let result = try BridgeRelayCrypto.decryptEnvelope(responseEnvelope, key: key)
        if (result["ok"] as? Bool) == false {
            let code = (result["error"] as? String) ?? (result["code"] as? String) ?? "bridge_adapter_error"
            let message = (result["message"] as? String) ?? code
            throw PandaBridgeError.adapterError("\(code):\(message)")
        }
        return result
    }

    private static func requestJson(url: URL, method: String, body: [String: Any]?, timeoutSeconds: TimeInterval) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.timeoutInterval = max(1, timeoutSeconds)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let rawText = String(data: data, encoding: .utf8) ?? ""
        guard status >= 200 && status < 300 else {
            throw PandaBridgeError.adapterError("adapter_http_\(status):\(rawText)")
        }
        return try BridgeRelayCrypto.jsonObject(data)
    }

    private static func pollURL(base: URL, config: BridgeRelayConfiguration, channelId: String, afterSeq: Int, limit: Int) -> URL {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return base }
        let relayKeys = Set(["device_id", "channel_id", "after_seq", "limit", "wait_ms"])
        var queryItems = (components.queryItems ?? []).filter { !relayKeys.contains($0.name) }
        queryItems.append(URLQueryItem(name: "device_id", value: config.deviceId))
        queryItems.append(URLQueryItem(name: "channel_id", value: channelId))
        queryItems.append(URLQueryItem(name: "after_seq", value: "\(afterSeq)"))
        queryItems.append(URLQueryItem(name: "limit", value: "\(limit)"))
        queryItems.append(URLQueryItem(name: "wait_ms", value: "1000"))
        components.queryItems = queryItems
        return components.url ?? base
    }

    private static func ackURL(base: URL, envelopeId: String) -> URL {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return base.appendingPathComponent(envelopeId).appendingPathComponent("ack")
        }
        components.queryItems = nil
        guard var url = components.url else {
            return base.appendingPathComponent(envelopeId).appendingPathComponent("ack")
        }
        url.appendPathComponent(envelopeId)
        url.appendPathComponent("ack")
        return url
    }

    private static func envelopeItems(_ value: Any?) -> [[String: Any]] {
        if let items = value as? [[String: Any]] { return items }
        if let items = value as? [Any] { return items.compactMap { $0 as? [String: Any] } }
        return []
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? Int64 { return Int(value) }
        if let value = value as? Double { return Int(value) }
        if let value = value as? String { return Int(value) }
        return nil
    }

    private static func isProgress(_ result: [String: Any]) -> Bool {
        if let value = result["progress"] as? Bool { return value }
        if let type = result["type"] as? String, type == "progress" { return true }
        if let event = result["event"] as? String, event == "progress" { return true }
        return false
    }
}

public enum BridgeRelayCrypto {
    public static func encryptEnvelope(_ command: [String: Any], key: Data, config: BridgeRelayConfiguration, requestKey: String) throws -> [String: Any] {
        let seq = 1
        let channelId = "bridge-ios-\(UUID().uuidString.prefix(12))"
        let aadText = relayEnvelopeAadText(
            productId: config.productId,
            deviceId: config.deviceId,
            channelId: channelId,
            direction: "product_to_device",
            seq: seq,
            authorizationId: config.authorizationId,
            authorizationEpoch: "\(config.authorizationEpoch)",
            relayKeyId: config.relayKeyId
        )
        let aad = Data(aadText.utf8)
        let nonce = AES.GCM.Nonce()
        let payload = try JSONSerialization.data(withJSONObject: command, options: [])
        let sealed = try AES.GCM.seal(payload, using: SymmetricKey(data: key), nonce: nonce, authenticating: aad)
        let ciphertext = sealed.ciphertext + sealed.tag
        return [
            "id": "env_ios_\(UUID().uuidString)",
            "product_id": config.productId,
            "device_id": config.deviceId,
            "channel_id": channelId,
            "direction": "product_to_device",
            "seq": seq,
            "request_key": requestKey,
            "ciphertext": ciphertext.base64EncodedString(),
            "aad": aad.base64EncodedString(),
            "nonce": Data(nonce).base64EncodedString(),
            "algorithm": "AES-GCM-256",
            "sender_key_id": config.senderKeyId,
            "recipient_key_id": config.recipientKeyId,
            "ttl_ms": 300_000,
            "meta": [
                "adapter_id": config.adapterId,
                "trace_id": requestKey,
                "schema_id": config.schemaId,
                "content_type": "application/json",
                "authorization_id": config.authorizationId,
                "authorization_epoch": "\(config.authorizationEpoch)",
                "relay_key_id": config.relayKeyId,
            ],
        ]
    }

    public static func decryptEnvelope(_ envelope: [String: Any], key: Data) throws -> [String: Any] {
        guard
            let nonceB64 = envelope["nonce"] as? String,
            let aadB64 = envelope["aad"] as? String,
            let ciphertextB64 = envelope["ciphertext"] as? String,
            let nonceData = Data(base64Encoded: nonceB64),
            let aad = Data(base64Encoded: aadB64),
            let sealedData = Data(base64Encoded: ciphertextB64),
            sealedData.count >= 16
        else { throw PandaBridgeError.invalidResponse("invalid_envelope") }
        let ciphertext = sealedData.prefix(sealedData.count - 16)
        let tag = sealedData.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonceData), ciphertext: ciphertext, tag: tag)
        let opened = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
        return try jsonObject(decodedPayload(opened, envelope: envelope))
    }

    public static func relayEnvelopeAadText(
        productId: String,
        deviceId: String,
        channelId: String,
        direction: String,
        seq: Int,
        authorizationId: String = "",
        authorizationEpoch: String = "1",
        relayKeyId: String = ""
    ) -> String {
        var parts = [
            "product:\(productId)",
            "device:\(deviceId)",
            "channel:\(channelId)",
            "direction:\(direction)",
            "seq:\(seq)",
        ]
        if !authorizationId.isEmpty && !relayKeyId.isEmpty {
            parts.append("authorization:\(authorizationId)")
            parts.append("epoch:\(authorizationEpoch)")
            parts.append("relay_key:\(relayKeyId)")
        }
        return parts.joined(separator: "|")
    }

    public static func jsonObject(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw PandaBridgeError.invalidResponse("json_root_not_object")
        }
        return object
    }

    private static func decodedPayload(_ data: Data, envelope: [String: Any]) throws -> Data {
        let meta = envelope["meta"] as? [String: Any] ?? [:]
        let encoding = (meta["content_encoding"] as? String ?? "").lowercased()
        switch encoding {
        case "", "identity":
            return data
        case "gzip":
            return try gunzip(data)
        default:
            throw PandaBridgeError.invalidResponse("unsupported_content_encoding:\(encoding)")
        }
    }

    private static func gunzip(_ data: Data) throws -> Data {
        if data.isEmpty { return Data() }
        var stream = z_stream()
        var status = inflateInit2_(&stream, MAX_WBITS + 16, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard status == Z_OK else { throw PandaBridgeError.invalidResponse("gzip_init_failed:\(status)") }
        defer { inflateEnd(&stream) }

        return try data.withUnsafeBytes { inputRaw in
            guard let inputBase = inputRaw.bindMemory(to: Bytef.self).baseAddress else { return Data() }
            stream.next_in = UnsafeMutablePointer<Bytef>(mutating: inputBase)
            stream.avail_in = uInt(data.count)
            var output = Data()
            let chunkSize = 16 * 1024
            repeat {
                var chunk = [UInt8](repeating: 0, count: chunkSize)
                try chunk.withUnsafeMutableBytes { outputRaw in
                    guard let outputBase = outputRaw.bindMemory(to: Bytef.self).baseAddress else {
                        throw PandaBridgeError.invalidResponse("gzip_output_buffer_unavailable")
                    }
                    stream.next_out = outputBase
                    stream.avail_out = uInt(chunkSize)
                    status = inflate(&stream, Z_NO_FLUSH)
                    guard status == Z_OK || status == Z_STREAM_END else {
                        throw PandaBridgeError.invalidResponse("gzip_inflate_failed:\(status)")
                    }
                    let produced = chunkSize - Int(stream.avail_out)
                    if produced > 0 {
                        output.append(outputBase, count: produced)
                    }
                }
            } while status != Z_STREAM_END
            return output
        }
    }
}

public enum BridgeRelayKeyBootstrap {
    public static func relayKeyBootstrapAadText(productId: String, deviceId: String, authorizationId: String, authorizationEpoch: Int, keyId: String) -> String {
        ["bridge-relay-key-bootstrap-v1", productId, deviceId, authorizationId, "\(authorizationEpoch)", keyId].joined(separator: "|")
    }

    public static func wrapRelayKeyForDesktop(relayKey: Data, exchange: [String: Any], aadText: String) throws -> [String: Any] {
        guard
            let publicJwk = exchange["public_jwk"] as? [String: Any],
            let x = base64UrlDecode(publicJwk["x"] as? String ?? ""),
            let y = base64UrlDecode(publicJwk["y"] as? String ?? "")
        else { throw PandaBridgeError.invalidResponse("invalid_relay_key_exchange") }
        let desktopPublic = try P256.KeyAgreement.PublicKey(x963Representation: Data([0x04]) + x + y)
        let privateKey = P256.KeyAgreement.PrivateKey()
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: desktopPublic)
        let aad = Data(aadText.utf8)
        let wrappingKey = SymmetricKey(data: relayWrappingKey(sharedSecret: shared, aad: aad))
        let sealed = try AES.GCM.seal(relayKey, using: wrappingKey, nonce: AES.GCM.Nonce(), authenticating: aad)
        let publicJwkOut = publicJwkFor(privateKey.publicKey)
        return [
            "algorithm": "ECDH-P256+A256GCM",
            "key_id": exchange["key_id"] as? String ?? "",
            "app_public_jwk": publicJwkOut,
            "nonce_b64": Data(sealed.nonce).base64EncodedString(),
            "ciphertext_b64": (sealed.ciphertext + sealed.tag).base64EncodedString(),
            "aad_b64": aad.base64EncodedString(),
        ]
    }

    private static func relayWrappingKey(sharedSecret: SharedSecret, aad: Data) -> Data {
        let secret = sharedSecret.withUnsafeBytes { Data($0) }
        var material = Data()
        material.append(secret)
        material.append(Data("bridge-relay-key-bootstrap-v1".utf8))
        material.append(aad)
        return Data(SHA256.hash(data: material))
    }

    private static func publicJwkFor(_ key: P256.KeyAgreement.PublicKey) -> [String: Any] {
        let x963 = key.x963Representation
        let x = x963.dropFirst().prefix(32)
        let y = x963.dropFirst(33).prefix(32)
        return [
            "kty": "EC",
            "crv": "P-256",
            "x": base64UrlEncode(Data(x)),
            "y": base64UrlEncode(Data(y)),
        ]
    }

    private static func base64UrlDecode(_ value: String) -> Data? {
        var normalized = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while normalized.count % 4 != 0 { normalized.append("=") }
        return Data(base64Encoded: normalized)
    }

    private static func base64UrlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
