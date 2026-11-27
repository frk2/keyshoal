import Foundation
import ExpoModulesCore
import CryptoKit
import Security
import UIKit

private let maxVault = 4 * 1024 * 1024
private let maxStore = 2 * maxVault + 4

public class KeyshoalNativeModule: Module {
    public func definition() -> ModuleDefinition {
        Name("KeyshoalNative")
        AsyncFunction("load") { () throws -> String? in
            let file = try storeURL()
            guard FileManager.default.fileExists(atPath: file.path) else { return nil }
            let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
            guard let size = attributes[.size] as? NSNumber, size.intValue <= maxStore else {
                throw StoreError.invalid
            }
            return try Data(contentsOf: file).base64EncodedString()
        }
        AsyncFunction("save") { (encoded: String) throws in
            guard encoded.count <= ((maxStore + 2) / 3) * 4,
                  let data = Data(base64Encoded: encoded), data.count <= maxStore, data.count > 4 else {
                throw StoreError.invalid
            }
            try data.write(to: storeURL(), options: [.atomic, .completeFileProtection])
        }
        AsyncFunction("copy") { (password: String) in
            UIPasteboard.general.setItems([["public.utf8-plain-text": password]],
                                          options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(30)])
        }.runOnQueue(.main)
        AsyncFunction("request") { (options: LANOptions, promise: Promise) in
            guard let request = options.makeRequest() else {
                promise.reject("LAN_INVALID", "Invalid Keyshoal LAN request.")
                return
            }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.httpCookieStorage = nil
            configuration.urlCredentialStorage = nil
            configuration.urlCache = nil
            configuration.connectionProxyDictionary = [:]
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.tlsMinimumSupportedProtocolVersion = .TLSv13
            configuration.timeoutIntervalForRequest = 12
            configuration.timeoutIntervalForResource = 15
            let delegate = PinnedRequest(ip: options.ip, fingerprint: options.fingerprint, promise: promise)
            let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
            session.dataTask(with: request).resume()
        }
    }
}

private enum StoreError: Error { case invalid }

private func storeURL() throws -> URL {
    let fm = FileManager.default
    var directory = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask,
                               appropriateFor: nil, create: true).appendingPathComponent("Keyshoal", isDirectory: true)
    try fm.createDirectory(at: directory, withIntermediateDirectories: true,
                           attributes: [.protectionKey: FileProtectionType.complete])
    var resource = URLResourceValues()
    resource.isExcludedFromBackup = true
    try directory.setResourceValues(resource)
    return directory.appendingPathComponent("mobile.vault", isDirectory: false)
}

private func isHexKey(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

private func isPrivateIP(_ value: String) -> Bool {
    let parts = value.split(separator: ".", omittingEmptySubsequences: false)
    let numbers = parts.compactMap { UInt8($0) }
    guard parts.count == 4, numbers.count == 4,
          zip(parts, numbers).allSatisfy({ String($0.0) == String($0.1) }) else { return false }
    let a = numbers[0], b = numbers[1]
    return a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
}

private struct LANOptions: Record {
    @Field var ip: String = ""
    @Field var fingerprint: String = ""
    @Field var method: String = ""
    @Field var kind: String = ""
    @Field var token: String = ""
    @Field var proof: String?
    @Field var match: String?
    @Field var body: String?

    init() {}

    func makeRequest() -> URLRequest? {
        guard isPrivateIP(ip), isHexKey(fingerprint), isHexKey(token),
              ["Invite", "Device"].contains(kind), ["GET", "POST", "PUT"].contains(method),
              let url = URL(string: "https://\(ip):46321/v1/" + (method == "POST" ? "enrol" : "vault"))
        else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("\(kind) \(token)", forHTTPHeaderField: "Authorization")
        if method == "POST" {
            guard kind == "Invite", let proof, isHexKey(proof) else { return nil }
            request.setValue(proof, forHTTPHeaderField: "X-Keyshoal-Proof")
        } else if method == "PUT" {
            guard kind == "Device", let match, isHexKey(match), let body,
                  body.count <= ((maxVault + 2) / 3) * 4, let data = Data(base64Encoded: body),
                  data.count > 0, data.count <= maxVault else { return nil }
            request.setValue("\"\(match)\"", forHTTPHeaderField: "If-Match")
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.httpBody = data
        }
        return request
    }
}

private final class PinnedRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let ip: String
    let fingerprint: String
    let promise: Promise
    var response: HTTPURLResponse?
    var data = Data()
    var pinned = false

    init(ip: String, fingerprint: String, promise: Promise) {
        self.ip = ip
        self.fingerprint = fingerprint
        self.promise = promise
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == ip,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else { return completionHandler(.cancelAuthenticationChallenge, nil) }
        let hash = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
            .map { String(format: "%02x", $0) }.joined()
        guard fingerprint == hash,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, ip as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [leaf] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil)
        else { return completionHandler(.cancelAuthenticationChallenge, nil) }
        pinned = true
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard pinned, let http = response as? HTTPURLResponse, http.expectedContentLength <= Int64(maxVault) else {
            return completionHandler(.cancel)
        }
        self.response = http
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard data.count + chunk.count <= maxVault else { return dataTask.cancel() }
        data.append(chunk)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { session.finishTasksAndInvalidate() }
        guard error == nil, let response else {
            promise.reject("LAN_CONNECTION", "Could not reach the pinned desktop. Check Wi-Fi, LAN permission, and desktop sync.")
            return
        }
        var result: [String: Any] = ["status": response.statusCode, "body": data.base64EncodedString()]
        if let token = response.value(forHTTPHeaderField: "X-Keyshoal-Device"), isHexKey(token) {
            result["device"] = token
        }
        promise.resolve(result)
    }
}
