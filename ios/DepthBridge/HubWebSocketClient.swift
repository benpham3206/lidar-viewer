import Foundation
import UIKit

final class HubWebSocketClient: NSObject, URLSessionWebSocketDelegate {
    var onStatus: ((String) -> Void)?
    var onDroppedFrames: ((Int) -> Void)?
    var onCommand: ((String) -> Void)?

    private let delegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pendingFrame: Data?
    private var frameInFlight = false
    private var droppedFrames = 0
    private var deviceID = ""
    private var capabilities: [SensorCapability] = []
    private var terminalStatusReported = true
    private var socketOpen = false

    func connect(hubURL: String, token: String, deviceID: String, capabilities: [SensorCapability]) {
        disconnect()
        terminalStatusReported = false
        guard var components = URLComponents(string: hubURL) else {
            onStatus?("Invalid hub URL")
            return
        }
        let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedToken.isEmpty else {
            onStatus?("Pairing token is required")
            return
        }
        switch components.scheme?.lowercased() {
        case "https", "wss": components.scheme = "wss"
        default: components.scheme = "ws"
        }
        guard components.host != nil else {
            onStatus?("Hub URL must include a host")
            return
        }
        components.path = "/ws/device"
        components.queryItems = [URLQueryItem(name: "token", value: normalizedToken)]
        guard let url = components.url else {
            onStatus?("Invalid hub URL")
            return
        }
        self.deviceID = deviceID
        self.capabilities = capabilities
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.waitsForConnectivity = false
        let newSession = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        session = newSession
        let newTask = newSession.webSocketTask(with: url)
        task = newTask
        newTask.resume()
        receiveLoop()
    }

    func disconnect() {
        terminalStatusReported = true
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        task = nil
        session = nil
        socketOpen = false
        pendingFrame = nil
        frameInFlight = false
    }

    func sendEvent(_ status: String, message: String? = nil) {
        var event: [String: Any] = ["type": "event", "status": status, "droppedFrames": droppedFrames]
        if let message { event["message"] = message }
        sendText(event)
    }

    func send(frame: CaptureFrame) {
        do {
            let packet = try FrameEncoder.encode(frame)
            guard !frameInFlight else {
                pendingFrame = packet
                droppedFrames += 1
                onDroppedFrames?(droppedFrames)
                return
            }
            sendData(packet)
        } catch {
            onStatus?(error.localizedDescription)
        }
    }

    private func sendData(_ data: Data) {
        guard socketOpen, let task else { return }
        frameInFlight = true
        task.send(.data(data)) { [weak self] error in
            guard let self, task === self.task else { return }
            self.frameInFlight = false
            if let error {
                self.reportTerminalStatus(error.localizedDescription)
                return
            }
            if let pending = self.pendingFrame {
                self.pendingFrame = nil
                self.sendData(pending)
            }
        }
    }

    private func sendText(_ value: [String: Any]) {
        guard socketOpen, let task, let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            guard let self, task === self.task, let error else { return }
            self.reportTerminalStatus(error.localizedDescription)
        }
    }

    private func receiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self, task === self.task else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message, let data = text.data(using: .utf8), let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let command = event["command"] as? String, event["type"] as? String == "command" {
                        self.onCommand?(command)
                    } else if let status = event["status"] as? String {
                        self.onStatus?(event["message"] as? String ?? status)
                    }
                }
                self.receiveLoop()
            case .failure(let error):
                self.reportTerminalStatus(error.localizedDescription)
            }
        }
    }

    private func reportTerminalStatus(_ status: String) {
        guard !terminalStatusReported else { return }
        terminalStatusReported = true
        socketOpen = false
        pendingFrame = nil
        frameInFlight = false
        onStatus?(status)
    }

    private func encodeCapability(_ capability: SensorCapability) -> [String: Any] {
        [
            "id": capability.id,
            "name": capability.name,
            "deviceType": capability.deviceType,
            "position": capability.position.rawValue,
            "formats": capability.formats.map { format in
                ["id": format.id, "width": format.dimensions.x, "height": format.dimensions.y, "pixelFormat": format.pixelFormatName, "maxFrameRate": format.maxFrameRate]
            },
        ]
    }
}

extension HubWebSocketClient {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        socketOpen = true
        onStatus?("Connected to hub as \(deviceID)")
        sendText([
            "type": "hello",
            "deviceID": deviceID,
            "name": UIDevice.current.name,
            "capabilities": capabilities.map(encodeCapability),
        ])
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        socketOpen = false
        reportTerminalStatus("Hub disconnected")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return }
        guard let error else { return }
        socketOpen = false
        reportTerminalStatus("Connection failed: \(error.localizedDescription)")
    }
}
