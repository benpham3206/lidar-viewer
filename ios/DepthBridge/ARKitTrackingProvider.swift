import ARKit
import CoreImage
import Foundation

final class ARKitTrackingProvider: NSObject, CaptureProvider, ARSessionDelegate {
    private let session = ARSession()
    private let context = CIContext()
    private var continuation: AsyncStream<CaptureFrame>.Continuation?
    private var configuration: CaptureConfiguration?
    private var frameCounter = 0
    private var lastEmittedTimestamp: TimeInterval = 0

    func start(configuration: CaptureConfiguration) async throws -> AsyncStream<CaptureFrame> {
        stop()
        guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else { throw CaptureError.configurationFailed }
        let stream = AsyncStream<CaptureFrame> { continuation in
            self.continuation = continuation
        }
        let arConfiguration = ARWorldTrackingConfiguration()
        arConfiguration.frameSemantics = [.sceneDepth]
        arConfiguration.worldAlignment = .gravity
        self.configuration = configuration
        frameCounter = 0
        lastEmittedTimestamp = 0
        session.delegate = self
        session.run(arConfiguration, options: [.resetTracking, .removeExistingAnchors])
        return stream
    }

    func stop() {
        session.pause()
        continuation?.finish()
        continuation = nil
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard let configuration else { return }
        guard configuration.targetFPS > 0, frame.timestamp - lastEmittedTimestamp >= 1 / configuration.targetFPS else { return }
        lastEmittedTimestamp = frame.timestamp
        let depthData = configuration.useSmoothedDepth ? frame.smoothedSceneDepth : frame.sceneDepth
        guard let depthData else { return }
        let correctionAngle: CGFloat = UIDevice.current.userInterfaceIdiom == .phone ? 90 : 0
        let depthMap = depthData.depthMap
        let rawDepthWidth = CVPixelBufferGetWidth(depthMap)
        let rawDepthHeight = CVPixelBufferGetHeight(depthMap)
        guard let rawDepth = copyFloat32(depthMap) else { return }
        let rotatedDepth = rotateRaster(rawDepth, width: rawDepthWidth, height: rawDepthHeight, angle: correctionAngle)
        let depth = rotatedDepth.values
        let confidence = depthData.confidenceMap.flatMap(copyUInt8).map {
            rotateRaster($0, width: rawDepthWidth, height: rawDepthHeight, angle: correctionAngle).values
        }
        let sourceImage = frame.capturedImage
        let rawSourceWidth = CVPixelBufferGetWidth(sourceImage)
        let rawSourceHeight = CVPixelBufferGetHeight(sourceImage)
        let sourceWidth = correctionAngle == 0 ? rawSourceWidth : rawSourceHeight
        let sourceHeight = correctionAngle == 0 ? rawSourceHeight : rawSourceWidth
        guard let poseMatrix = matrixArray(frame.camera.transform) else { return }
        let rgb = context.jpegRepresentation(
            of: rotateImage(CIImage(cvPixelBuffer: sourceImage), angle: correctionAngle),
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            options: [:]
        ) ?? Data()
        let intrinsics = frame.camera.intrinsics
        let resolution = frame.camera.imageResolution
        let normalizedIntrinsics = rotatedIntrinsics(intrinsics, reference: resolution, angle: correctionAngle)
        if frameCounter == 0 {
            print("[ARKitTrackingProvider] angle=\(correctionAngle) source=\(sourceHeight)x\(sourceWidth) depth=\(rotatedDepth.width)x\(rotatedDepth.height)")
        }
        let metadata = FrameMetadata(
            frameID: "\(configuration.deviceID)-\(frameCounter)",
            deviceID: configuration.deviceID,
            deviceTimestamp: frame.timestamp,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            depthWidth: rotatedDepth.width,
            depthHeight: rotatedDepth.height,
            depthStride: rotatedDepth.width,
            depthFormat: "float32",
            sourceDepthFormat: nil,
            intrinsics: normalizedIntrinsics,
            poseMatrix: poseMatrix,
            poseSpace: "arkitWorldFromCamera",
            orientation: "portrait",
            confidenceAvailable: confidence != nil,
            imu: nil
        )
        frameCounter += 1
        continuation?.yield(CaptureFrame(metadata: metadata, rgbJPEG: rgb, depth: depth, confidence: confidence))
    }
}

private func copyFloat32(_ buffer: CVPixelBuffer) -> [Float]? {
    guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_DepthFloat32 else { return nil }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
    let rowStride = CVPixelBufferGetBytesPerRow(buffer) / MemoryLayout<Float>.stride
    let pointer = base.assumingMemoryBound(to: Float.self)
    var values = [Float](repeating: 0, count: width * height)
    for row in 0..<height {
        for column in 0..<width { values[row * width + column] = pointer[row * rowStride + column] }
    }
    return values
}

private func copyUInt8(_ buffer: CVPixelBuffer) -> [UInt8]? {
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
    let rowStride = CVPixelBufferGetBytesPerRow(buffer)
    let pointer = base.assumingMemoryBound(to: UInt8.self)
    var values = [UInt8](repeating: 0, count: width * height)
    for row in 0..<height {
        for column in 0..<width { values[row * width + column] = pointer[row * rowStride + column] }
    }
    return values
}

private func matrixArray(_ matrix: simd_float4x4) -> [Float]? {
    let values: [Float] = [
        matrix[0, 0], matrix[0, 1], matrix[0, 2], matrix[0, 3],
        matrix[1, 0], matrix[1, 1], matrix[1, 2], matrix[1, 3],
        matrix[2, 0], matrix[2, 1], matrix[2, 2], matrix[2, 3],
        matrix[3, 0], matrix[3, 1], matrix[3, 2], matrix[3, 3],
    ]
    return values.allSatisfy { $0.isFinite } ? values : nil
}
