import SwiftUI

struct ContentView: View {
    @ObservedObject var model: CaptureViewModel
    @State private var isDepthPreviewPresented = false
    @State private var previewPalette: DepthPreviewPalette = .blueOrange

    var body: some View {
        NavigationStack {
            Form {
                Section("Hub") {
                    TextField("Hub WebSocket URL", text: $model.hubURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Pairing token", text: $model.pairingToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Connect device") { model.connect() }
                    LabeledContent("Connection", value: model.connectionStatus)
                }
                Section("Capture") {
                    Picker("Provider", selection: Binding(get: { model.providerKind }, set: { model.selectProvider($0) })) {
                        ForEach(CaptureProviderKind.allCases) { kind in Text(kind.title).tag(kind) }
                    }
                    Picker("Sensor", selection: Binding(get: { model.selectedDeviceID }, set: { model.selectSensor($0) })) {
                        ForEach(model.capabilities) { capability in Text("\(capability.name) · \(capability.position.rawValue)").tag(capability.id) }
                    }
                    if model.providerKind == .avFoundation {
                        Picker("Resolution", selection: Binding(get: { model.selectedResolutionID }, set: { model.selectResolution($0) })) {
                            ForEach(model.availableResolutions, id: \.self) { resolution in
                                Text(resolution.replacingOccurrences(of: "x", with: "×")).tag(resolution)
                            }
                        }
                        .pickerStyle(.menu)
                        Picker("Format", selection: Binding(get: { model.selectedPixelFormatID }, set: { model.selectPixelFormat($0) })) {
                            ForEach(model.availablePixelFormats) { format in
                                Text(format.pixelFormatName).tag(format.pixelFormatID)
                            }
                        }
                        .pickerStyle(.menu)
                    }
                    Picker("Frame rate", selection: Binding(get: { model.targetFPS }, set: { model.selectFrameRate($0) })) {
                        Text("5 FPS").tag(5.0)
                        Text("10 FPS").tag(10.0)
                        Text("15 FPS").tag(15.0)
                    }
                    .pickerStyle(.menu)
                    if model.providerKind == .arKit {
                        Text("ARKit scene depth uses rear LiDAR. Choose AVFoundation for front TrueDepth.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("Start") { model.startCapture() }.disabled(model.capturing)
                        Button("Stop") { model.stopCapture() }.disabled(!model.capturing)
                    }
                    LabeledContent("Dropped frames", value: String(model.droppedFrames))
                }
                Section("Live depth") {
                    Button {
                        isDepthPreviewPresented = true
                    } label: {
                        DepthPreviewView(preview: model.depthPreview, palette: previewPalette)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open live depth preview")
                    Picker("Preview colors", selection: $previewPalette) {
                        ForEach(DepthPreviewPalette.allCases) { palette in
                            Text(palette.title).tag(palette)
                        }
                    }
                    .pickerStyle(.segmented)
                    LabeledContent("Device timecode", value: model.latestTimecode)
                }
                Section("Status") {
                    Text(model.status)
                        .font(.caption)
                        .accessibilityLabel("Capture status: \(model.status)")
                }
                if model.selectedCapability?.position == .front {
                    Section {
                        Label("TrueDepth faces the screen. Hold the device behind the object only if the screen-facing ergonomics are acceptable.", systemImage: "info.circle")
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("Depth Bridge")
            .alert(item: $model.connectionNotice) { notice in
                Alert(title: Text(notice.title), message: Text(notice.message), dismissButton: .default(Text("OK")))
            }
            .fullScreenCover(isPresented: $isDepthPreviewPresented) {
                VStack(spacing: 0) {
                    HStack {
                        Button("Back") {
                            isDepthPreviewPresented = false
                        }
                        .accessibilityLabel("Back to capture controls")
                        Spacer()
                    }
                    .padding()
                    DepthPreviewView(preview: model.depthPreview, palette: previewPalette)
                        .frame(maxHeight: .infinity)
                        .padding()
                }
                .background(.black)
            }
            .task { model.refreshCapabilities() }
        }
    }
}

private enum DepthPreviewPalette: String, CaseIterable, Identifiable {
    case blueOrange
    case spectrum

    var id: String { rawValue }
    var title: String { self == .blueOrange ? "Blue–orange" : "Spectrum" }
}

private struct DepthPreviewView: View {
    let preview: DepthPreview?
    let palette: DepthPreviewPalette

    var body: some View {
        Canvas { context, size in
            guard let preview else { return }
            let range = depthDisplayRange(preview.values)
            let span = max(range.far - range.near, .leastNonzeroMagnitude)
            let cellWidth = size.width / CGFloat(preview.width)
            let cellHeight = size.height / CGFloat(preview.height)
            for index in preview.values.indices {
                let distance = preview.values[index]
                let color: Color
                if distance.isFinite && distance > 0 {
                    let value = max(0, min(1, 1 - (distance - range.near) / span))
                    color = palette.color(for: value)
                } else {
                    color = .black
                }
                let x = CGFloat(index % preview.width) * cellWidth
                let y = CGFloat(index / preview.width) * cellHeight
                context.fill(Path(CGRect(x: x, y: y, width: cellWidth + 0.5, height: cellHeight + 0.5)), with: .color(color))
            }
        }
        .frame(maxWidth: .infinity, minHeight: 180)
        .background(.black)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .topLeading) {
            Text(preview == nil ? "Waiting for depth" : "Live Float32 depth")
                .font(.caption2.monospaced())
                .padding(8)
                .foregroundStyle(.white)
        }
    }
}

private func depthDisplayRange(_ values: [Float]) -> (near: Float, far: Float) {
    var near = Float.greatestFiniteMagnitude
    var far: Float = 0
    for value in values where value.isFinite && value > 0 {
        near = min(near, value)
        far = max(far, value)
    }
    guard near.isFinite else { return (0.2, 5) }
    let padding = max((far - near) * 0.08, 0.025)
    return (max(0.05, near - padding), far + padding)
}

private extension DepthPreviewPalette {
    func color(for value: Float) -> Color {
        switch self {
        case .blueOrange:
            return Color(
                red: Double(0.15 + value * 0.85),
                green: Double(0.32 + value * 0.48),
                blue: Double(0.92 - value * 0.80)
            )
        case .spectrum:
            return Color(hue: Double((1 - value) * 0.67), saturation: 0.9, brightness: 0.95)
        }
    }
}
