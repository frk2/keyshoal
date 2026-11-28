import Foundation
import ExpoModulesCore
import Network
import CoreImage
import UIKit

private let maxStore = 8 * 1024 * 1024 + 4
private let maxPacket = maxStore + 60
private let maxInventory = 4 + 32 * 8192 + 40
private let serviceType = "_keyshoal-v2._tcp"

public final class KeyshoalNativeModule: Module {
    private let peers = NearbyPeers()

    public func definition() -> ModuleDefinition {
        Name("KeyshoalNative")
        Events("peerInventory")
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
            guard let data = decode(encoded, maxStore), data.count >= 76 else {
                throw StoreError.invalid
            }
            try data.write(to: storeURL(), options: [.atomic, .completeFileProtection])
        }
        AsyncFunction("copy") { (text: String) in
            UIPasteboard.general.setItems([["public.utf8-plain-text": text]],
                                          options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(30)])
        }.runOnQueue(.main)
        AsyncFunction("qr") { (text: String) throws -> String in
            guard text.utf8.count <= 240, let filter = CIFilter(name: "CIQRCodeGenerator") else {
                throw StoreError.invalid
            }
            filter.setValue(Data(text.utf8), forKey: "inputMessage")
            filter.setValue("M", forKey: "inputCorrectionLevel")
            guard let result = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 5, y: 5)),
                  let cgImage = CIContext().createCGImage(result, from: result.extent),
                  let png = UIImage(cgImage: cgImage).pngData() else { throw StoreError.invalid }
            return "data:image/png;base64," + png.base64EncodedString()
        }.runOnQueue(.main)
        AsyncFunction("peerStart") { (promise: Promise) in
            self.peers.start { [weak self] id, packet in
                self?.sendEvent("peerInventory", ["id": id, "packet": packet])
            } complete: { promise.resolve(nil) }
        }
        AsyncFunction("peerStop") { (promise: Promise) in
            self.peers.stop { promise.resolve(nil) }
        }
        AsyncFunction("peerList") { (promise: Promise) in
            self.peers.list { promise.resolve($0) }
        }
        AsyncFunction("peerRequest") { (id: String, encoded: String, promise: Promise) in
            guard let inventory = decode(encoded, maxInventory), inventory.count >= 40 else {
                promise.reject("PEER_DATA", "Invalid peer inventory.")
                return
            }
            self.peers.request(id, inventory, promise)
        }
        AsyncFunction("peerRespond") { (id: String, encoded: String) in
            self.peers.respond(id, decode(encoded, maxPacket))
        }
    }
}

private enum StoreError: Error { case invalid }

private func decode(_ encoded: String, _ limit: Int) -> Data? {
    guard encoded.utf8.count <= 4 * ((limit + 2) / 3),
          let data = Data(base64Encoded: encoded), data.count <= limit else { return nil }
    return data
}

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

private func privateV4(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 4 else { return false }
    return bytes[0] == 10 || bytes[0] == 127 ||
        (bytes[0] == 172 && (16...31).contains(bytes[1])) ||
        (bytes[0] == 192 && bytes[1] == 168) || (bytes[0] == 169 && bytes[1] == 254)
}

private func localPeer(_ endpoint: NWEndpoint) -> Bool {
    guard case let .hostPort(host, _) = endpoint else { return false }
    switch host {
    case .ipv4(let ip): return privateV4(Array(ip.rawValue))
    case .ipv6(let ip):
        let b = Array(ip.rawValue)
        if b[0] == 0xfc || b[0] == 0xfd || (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) { return true }
        if b.prefix(10).allSatisfy({ $0 == 0 }) && b[10] == 0xff && b[11] == 0xff {
            return privateV4(Array(b.suffix(4)))
        }
        return b.prefix(15).allSatisfy({ $0 == 0 }) && b[15] == 1
    default: return false
    }
}

private func makeFrame(_ packet: Data) -> Data {
    let n = UInt32(packet.count)
    var frame = Data([UInt8(n >> 24), UInt8(truncatingIfNeeded: n >> 16),
                      UInt8(truncatingIfNeeded: n >> 8), UInt8(truncatingIfNeeded: n)])
    frame.append(packet)
    return frame
}

private func receiveFrame(_ connection: NWConnection, limit: Int, completion: @escaping (Data?) -> Void) {
    connection.receive(minimumIncompleteLength: 4, maximumLength: 4) { header, _, _, error in
        guard error == nil, let header, header.count == 4 else { completion(nil); return }
        let count = header.reduce(0) { ($0 << 8) | Int($1) }
        guard count >= 40, count <= limit else { completion(nil); return }
        connection.receive(minimumIncompleteLength: count, maximumLength: count) { packet, _, _, err in
            guard err == nil, let packet, packet.count == count else { completion(nil); return }
            completion(packet)
        }
    }
}

// One serial queue owns discovery, timeouts, and connection teardown. It
// handles encrypted packet bytes only. The shared replica authenticates them.
private final class NearbyPeers: @unchecked Sendable {
    typealias Incoming = @Sendable (String, String) -> Void
    private let queue = DispatchQueue(label: "keyshoal.peer-network")
    private var listener: NWListener?
    private var browser: NWBrowser?
    private var session = UUID()
    private var endpoints: [String: NWEndpoint] = [:]
    private var connections: [String: NWConnection] = [:]
    private var inbound = Set<String>()
    private var failures: [String: () -> Void] = [:]
    private var unavailable = false

    func start(incoming: @escaping Incoming, complete: @escaping @Sendable () -> Void) {
        queue.async {
            self.reset()
            let session = self.session
            let name = "ks-" + String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(24))
            do {
                let listener = try NWListener(using: .tcp)
                self.listener = listener
                listener.service = NWListener.Service(name: String(name), type: serviceType, domain: "local.")
                listener.stateUpdateHandler = { [weak self] state in
                    guard let self, self.session == session else { return }
                    if case .failed = state { self.unavailable = true }
                }
                listener.newConnectionHandler = { [weak self] connection in
                    guard let self, self.session == session, localPeer(connection.endpoint),
                          self.connections.count < 16 else { connection.cancel(); return }
                    self.accept(connection, incoming)
                }
                listener.start(queue: self.queue)
                let browser = NWBrowser(for: .bonjour(type: serviceType, domain: "local."), using: .tcp)
                self.browser = browser
                browser.stateUpdateHandler = { [weak self] state in
                    guard let self, self.session == session else { return }
                    switch state {
                    case .ready: self.unavailable = false
                    case .waiting, .failed: self.unavailable = true
                    default: break
                    }
                }
                browser.browseResultsChangedHandler = { [weak self] results, _ in
                    guard let self, self.session == session else { return }
                    var found: [String: NWEndpoint] = [:]
                    for result in results where found.count < 24 {
                        guard case let .service(peer, _, _, _) = result.endpoint,
                              peer != name, peer.range(of: "^ks-[a-f0-9]{24}$", options: .regularExpression) != nil else { continue }
                        found[peer] = result.endpoint
                    }
                    self.endpoints = found
                }
                browser.start(queue: self.queue)
            } catch { self.unavailable = true }
            complete()
        }
    }

    func stop(complete: @escaping @Sendable () -> Void) {
        queue.async { self.reset(); complete() }
    }

    func list(complete: @escaping @Sendable ([String: Any]) -> Void) {
        queue.async {
            complete(["ids": Array(self.endpoints.keys).sorted(), "unavailable": self.unavailable])
        }
    }

    private func reset() {
        session = UUID()
        listener?.cancel()
        browser?.cancel()
        listener = nil
        browser = nil
        endpoints.removeAll()
        unavailable = false
        for id in Array(connections.keys) { finish(id, failed: true) }
    }

    private func finish(_ id: String, failed: Bool) {
        let onFailure = failures.removeValue(forKey: id)
        inbound.remove(id)
        connections.removeValue(forKey: id)?.cancel()
        if failed { onFailure?() }
    }

    private func register(_ connection: NWConnection, failure: (() -> Void)? = nil) -> String {
        let id = UUID().uuidString
        connections[id] = connection
        if let failure { failures[id] = failure }
        queue.asyncAfter(deadline: .now() + 7) { [weak self] in self?.finish(id, failed: true) }
        return id
    }

    private func accept(_ connection: NWConnection, _ incoming: @escaping Incoming) {
        let id = register(connection)
        inbound.insert(id)
        connection.start(queue: queue)
        receiveFrame(connection, limit: maxInventory) { [weak self] data in
            guard let self, self.connections[id] != nil else { return }
            guard let data else { self.finish(id, failed: true); return }
            incoming(id, data.base64EncodedString())
        }
    }

    func respond(_ id: String, _ data: Data?) {
        queue.async {
            guard self.inbound.remove(id) != nil, let connection = self.connections[id] else { return }
            guard let data, data.count >= 40 else { self.finish(id, failed: true); return }
            connection.send(content: makeFrame(data), isComplete: true, completion: .contentProcessed { [weak self] error in
                if error != nil { self?.finish(id, failed: true); return }
                connection.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, _, _ in
                    self?.finish(id, failed: false)
                }
            })
        }
    }

    func request(_ peer: String, _ payload: Data, _ promise: Promise) {
        queue.async {
            guard let endpoint = self.endpoints[peer], self.connections.count < 16 else {
                promise.reject("PEER_UNAVAILABLE", "That peer is no longer nearby.")
                return
            }
            let connection = NWConnection(to: endpoint, using: .tcp)
            let id = self.register(connection) {
                promise.reject("PEER_CONNECTION", "Could not contact an authenticated nearby peer.")
            }
            connection.start(queue: self.queue)
            connection.send(content: makeFrame(payload), completion: .contentProcessed { [weak self] error in
                if error != nil { self?.finish(id, failed: true) }
            })
            receiveFrame(connection, limit: maxPacket) { [weak self] data in
                guard let self, self.connections[id] != nil else { return }
                guard let data else { self.finish(id, failed: true); return }
                self.finish(id, failed: false)
                promise.resolve(data.base64EncodedString())
            }
        }
    }
}
