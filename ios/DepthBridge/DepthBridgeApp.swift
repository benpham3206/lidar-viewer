import AVFoundation
import Foundation
import SwiftUI

@main
struct DepthBridgeApp: App {
    @StateObject private var model = CaptureViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
        }
    }
}

@MainActor
final class CaptureViewModel: ObservableObject {
    @Published var capabilities: [SensorCapability] = []
    @Published var selectedDeviceID = ""
    @Published var selectedFormatID = ""
    @Published var selectedResolutionID = ""
    @Published var selectedPixelFormatID = ""
    @Published var providerKind: CaptureProviderKind = .avFoundation
    @Published var hubURL = "ws://10.0.0.17:4317"
    @Published var pairingToken = ""
    @Published var status = "Ready to scan"
    @Published var droppedFrames = 0
    @Published var capturing = false
    @Published var connectionStatus = "Not connected"
    @Published var connectionNotice: ConnectionNotice?
    @Published var depthPreview: DepthPreview?
    @Published var latestTimecode = "—"
    @Published var targetFPS = 5.0

    private let scanner = CapabilityScanner()
    private let client = HubWebSocketClient()
    private var provider: CaptureProvider?
    private var captureTask: Task<Void, Never>?

    init() {
        client.onStatus = { [weak self] status in
            Task { @MainActor in
                guard let self else { return }
                if status == "registered" || status.hasPrefix("Connected to hub as ") {
                    self.connectionStatus = "Connected"
                    self.status = status == "registered" ? "Device connected to hub" : status
                    if status == "registered" {
                        self.connectionNotice = ConnectionNotice(title: "Device connected", message: "The selected sensor is registered with the depth hub.")
                    }
                } else {
                    let lowercased = status.lowercased()
                    let failed = lowercased.contains("error") || lowercased.contains("failed") || lowercased.contains("lost") || lowercased.contains("timed out") || lowercased.contains("disconnected")
                    self.connectionStatus = failed ? "Connection failed" : status
                    self.status = status
                    if failed { self.connectionNotice = ConnectionNotice(title: "Connection failed", message: status) }
                }
            }
        }
        client.onDroppedFrames = { [weak self] count in
            Task { @MainActor in self?.droppedFrames = count }
        }
        client.onCommand = { [weak self] command in
            Task { @MainActor in
                if command == "start" { self?.startCapture() }
                if command == "stop" { self?.stopCapture() }
            }
        }
        refreshCapabilities()
    }

    var selectedCapability: SensorCapability? {
        captureCapabilities.first { $0.id == selectedDeviceID } ?? captureCapabilities.first
    }

    var captureCapabilities: [SensorCapability] {
        switch providerKind {
        case .avFoundation:
            return capabilities
        case .arKit:
            return capabilities.filter { $0.position == .back && $0.deviceType.contains("LiDAR") }
        }
    }

    var selectedFormat: DepthFormatDescriptor? {
        availableDepthFormats.first { $0.id == selectedFormatID }
            ?? availableDepthFormats.first { $0.resolutionID == selectedResolutionID && $0.pixelFormatID == selectedPixelFormatID }
            ?? availableDepthFormats.first
    }

    var availableDepthFormats: [DepthFormatDescriptor] {
        guard providerKind == .avFoundation else { return [] }
        var grouped: [String: DepthFormatDescriptor] = [:]
        for format in selectedCapability?.formats ?? [] {
            let key = "\(format.resolutionID)-\(format.pixelFormatID)"
            if let existing = grouped[key] {
                let replacesExisting = (format.isFloat32 && !existing.isFloat32)
                    || (format.isFloat32 == existing.isFloat32 && format.maxFrameRate > existing.maxFrameRate)
                if replacesExisting { grouped[key] = format }
            } else {
                grouped[key] = format
            }
        }
        return grouped.values.sorted {
            let leftPixels = Int($0.dimensions.x) * Int($0.dimensions.y)
            let rightPixels = Int($1.dimensions.x) * Int($1.dimensions.y)
            if leftPixels != rightPixels { return leftPixels > rightPixels }
            if $0.isFloat32 != $1.isFloat32 { return $0.isFloat32 }
            return $0.pixelFormatName < $1.pixelFormatName
        }
    }

    var availableResolutions: [String] {
        var seen = Set<String>()
        return availableDepthFormats.compactMap { format in
            seen.insert(format.resolutionID).inserted ? format.resolutionID : nil
        }
    }

    var availablePixelFormats: [DepthFormatDescriptor] {
        var seen = Set<String>()
        return availableDepthFormats.filter {
            $0.resolutionID == selectedResolutionID && seen.insert($0.pixelFormatID).inserted
        }
    }

    func refreshCapabilities() {
        capabilities = scanner.scan()
        if selectedDeviceID.isEmpty {
            let defaultCapability = capabilities.first(where: {
                $0.position == .back && $0.deviceType.contains("LiDAR")
            }) ?? capabilities.first
            selectedDeviceID = defaultCapability?.id ?? ""
            providerKind = defaultCapability.map(preferredProvider) ?? .avFoundation
        }
        normalizeCaptureSelection()
        status = capabilities.isEmpty ? "No LiDAR or TrueDepth camera found" : "Capabilities refreshed"
    }

    private func preferredProvider(for capability: SensorCapability) -> CaptureProviderKind {
        capability.position == .back && capability.deviceType.contains("LiDAR") ? .arKit : .avFoundation
    }

    func selectProvider(_ kind: CaptureProviderKind) {
        providerKind = kind
        normalizeCaptureSelection()
        client.sendEvent("provider_changed", message: kind.title)
        restartCaptureIfNeeded()
    }

    func selectSensor(_ id: String) {
        guard let capability = capabilities.first(where: { $0.id == id }) else { return }
        selectedDeviceID = id
        providerKind = preferredProvider(for: capability)
        normalizeCaptureSelection()
        if let capability = selectedCapability {
            client.sendEvent("sensor_changed", message: "\(capability.name) · \(capability.position.rawValue)")
        }
        restartCaptureIfNeeded()
    }

    func selectResolution(_ id: String) {
        guard let format = availableDepthFormats.first(where: { $0.resolutionID == id && $0.isFloat32 })
            ?? availableDepthFormats.first(where: { $0.resolutionID == id }) else { return }
        selectedResolutionID = id
        selectedPixelFormatID = format.pixelFormatID
        selectedFormatID = format.id
        client.sendEvent("resolution_changed", message: format.resolutionLabel)
        restartCaptureIfNeeded()
    }

    func selectPixelFormat(_ id: String) {
        guard let format = availableDepthFormats.first(where: {
            $0.resolutionID == selectedResolutionID && $0.pixelFormatID == id
        }) else { return }
        selectedPixelFormatID = id
        selectedFormatID = format.id
        client.sendEvent("format_changed", message: format.pixelFormatName)
        restartCaptureIfNeeded()
    }

    func selectFrameRate(_ fps: Double) {
        targetFPS = fps
        client.sendEvent("frame_rate_changed", message: "\(Int(fps)) FPS")
        restartCaptureIfNeeded()
    }

    func normalizeCaptureSelection() {
        if !captureCapabilities.contains(where: { $0.id == selectedDeviceID }) {
            selectedDeviceID = captureCapabilities.first?.id ?? ""
        }
        guard providerKind == .avFoundation else { return }
        let formats = availableDepthFormats
        guard let first = formats.first else {
            selectedFormatID = ""
            selectedResolutionID = ""
            selectedPixelFormatID = ""
            return
        }
        let format = formats.first(where: { $0.id == selectedFormatID })
            ?? formats.first(where: {
                $0.resolutionID == selectedResolutionID && $0.pixelFormatID == selectedPixelFormatID
            })
            ?? formats.first(where: { $0.isFloat32 })
            ?? first
        selectedFormatID = format.id
        selectedResolutionID = format.resolutionID
        selectedPixelFormatID = format.pixelFormatID
    }

    private func restartCaptureIfNeeded() {
        guard capturing else { return }
        stopCapture()
        startCapture()
    }

    func connect() {
        guard let selectedCapability else {
            status = "Select a depth camera first"
            return
        }
        connectionStatus = "Connecting…"
        status = "Connecting to hub…"
        connectionNotice = nil
        client.connect(hubURL: hubURL, token: pairingToken, deviceID: selectedCapability.id, capabilities: capabilities)
    }

    func startCapture() {
        guard let capability = selectedCapability else {
            status = providerKind == .arKit ? "ARKit scene depth requires rear LiDAR" : "Select a depth camera first"
            return
        }
        if providerKind == .avFoundation {
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard granted else { self?.status = "Camera permission is required"; return }
                    self?.runProvider(capability: capability)
                }
            }
        } else {
            runProvider(capability: capability)
        }
    }

    func stopCapture() {
        let wasCapturing = capturing || provider != nil
        captureTask?.cancel()
        captureTask = nil
        provider?.stop()
        provider = nil
        capturing = false
        depthPreview = nil
        if wasCapturing { client.sendEvent("capture_stopped") }
        status = "Capture stopped"
    }

    private func runProvider(capability: SensorCapability) {
        stopCapture()
        let selectedProvider: CaptureProvider = providerKind == .avFoundation ? AVDepthProvider(scanner: scanner) : ARKitTrackingProvider()
        provider = selectedProvider
        let configuration = CaptureConfiguration(deviceID: capability.id, kind: providerKind, depthFormat: selectedFormat, useSmoothedDepth: false, targetFPS: targetFPS)
        captureTask = Task { [weak self, selectedProvider] in
            do {
                let stream = try await selectedProvider.start(configuration: configuration)
                await MainActor.run {
                    self?.capturing = true
                    self?.status = "Streaming \(capability.name)"
                    self?.client.sendEvent("capture_started", message: "\(capability.name) · \(self?.providerKind.title ?? "depth")")
                }
                for await frame in stream {
                    if Task.isCancelled { break }
                    self?.updatePreview(frame)
                    self?.client.send(frame: frame)
                }
            } catch {
                await MainActor.run {
                    self?.capturing = false
                    self?.status = error.localizedDescription
                    self?.client.sendEvent("capture_error", message: error.localizedDescription)
                }
            }
        }
    }

    private func updatePreview(_ frame: CaptureFrame) {
        let sourceWidth = frame.metadata.depthWidth
        let sourceHeight = frame.metadata.depthHeight
        let step = max(1, max(sourceWidth, sourceHeight) / 192)
        let width = (sourceWidth + step - 1) / step
        let height = (sourceHeight + step - 1) / step
        var values = [Float](repeating: .nan, count: width * height)
        for y in 0..<height {
            for x in 0..<width {
                let sourceX = min(sourceWidth - 1, x * step)
                let sourceY = min(sourceHeight - 1, y * step)
                values[y * width + x] = frame.depth[sourceY * sourceWidth + sourceX]
            }
        }
        depthPreview = DepthPreview(width: width, height: height, values: values)
        latestTimecode = String(format: "%.3f s", frame.metadata.deviceTimestamp)
    }
}

struct ConnectionNotice: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}
