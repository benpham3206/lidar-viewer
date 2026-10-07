import AVFoundation
import CoreImage
import Foundation
import simd
import UIKit

final class AVDepthProvider: NSObject, CaptureProvider, AVCaptureDataOutputSynchronizerDelegate {
    private let scanner: CapabilityScanner
    private let context = CIContext()
    private let queue = DispatchQueue(label: "depth.bridge.avcapture")
    private var session: AVCaptureSession?
    private var videoOutput: AVCaptureVideoDataOutput?
    private var depthOutput: AVCaptureDepthDataOutput?
    private var synchronizer: AVCaptureDataOutputSynchronizer?
    private var continuation: AsyncStream<CaptureFrame>.Continuation?
    private var configuration: CaptureConfiguration?
    private var depthSoftwareRotation: CGFloat = 0
    private var rgbSoftwareRotation: CGFloat = 0
    private var depthSoftwareMirror = false
    private var rgbSoftwareMirror = false
    private var mirroredCapture = false
    private var captureAngle: CGFloat = 0
    private var frameCounter = 0

    init(scanner: CapabilityScanner) {
        self.scanner = scanner
    }

    func start(configuration: CaptureConfiguration) async throws -> AsyncStream<CaptureFrame> {
        stop()
        guard let device = scanner.device(withID: configuration.deviceID) else {
            throw CaptureError.deviceUnavailable
        }
        let selectedCaptureFormat = selectCaptureFormat(device: device, requested: configuration.depthFormat)
        let captureSession = AVCaptureSession()
        captureSession.beginConfiguration()
        let input = try AVCaptureDeviceInput(device: device)
        guard captureSession.canAddInput(input) else { throw CaptureError.configurationFailed }
        captureSession.addInput(input)
        let video = AVCaptureVideoDataOutput()
        video.alwaysDiscardsLateVideoFrames = true
        video.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        guard captureSession.canAddOutput(video) else { throw CaptureError.configurationFailed }
        captureSession.addOutput(video)
        let depth = AVCaptureDepthDataOutput()
        depth.isFilteringEnabled = false
        depth.alwaysDiscardsLateDepthData = true
        guard captureSession.canAddOutput(depth) else { throw CaptureError.configurationFailed }
        captureSession.addOutput(depth)
        if let selectedCaptureFormat {
            try device.lockForConfiguration()
            device.activeFormat = selectedCaptureFormat.video
            device.activeDepthDataFormat = selectedCaptureFormat.depth
            let supportedRanges = selectedCaptureFormat.video.videoSupportedFrameRateRanges
            if let range = supportedRanges.first {
                let fps = min(max(configuration.targetFPS, range.minFrameRate), range.maxFrameRate)
                let duration = CMTime(value: 1, timescale: Int32(max(1, fps.rounded())))
                device.activeVideoMinFrameDuration = duration
                device.activeVideoMaxFrameDuration = duration
            }
            device.unlockForConfiguration()
        }
        let captureAngle = portraitCaptureAngle(for: device)
        let videoConnection = video.connection(with: .video)
        let depthConnection = depth.connection(with: .video)
        let depthRotationSupported = depthConnection?.isVideoRotationAngleSupported(captureAngle) ?? false
        depthSoftwareRotation = depthRotationSupported ? 0 : softwareDepthRotation(for: captureAngle)
        rgbSoftwareRotation = (videoConnection?.isVideoRotationAngleSupported(captureAngle) ?? false) ? 0 : softwareDepthRotation(for: captureAngle)
        let mirrorFront = device.position == .front
        let depthMirrorSupported = depthConnection?.isVideoMirroringSupported ?? false
        let rgbMirrorSupported = videoConnection?.isVideoMirroringSupported ?? false
        depthSoftwareMirror = mirrorFront && !depthMirrorSupported
        rgbSoftwareMirror = mirrorFront && !rgbMirrorSupported
        mirroredCapture = mirrorFront
        self.captureAngle = captureAngle
        print("[AVDepthProvider] position=\(device.position.rawValue) angle=\(captureAngle) videoSupported=\(videoConnection?.isVideoRotationAngleSupported(captureAngle) ?? false) depthSupported=\(depthRotationSupported) depthSoftwareAngle=\(depthSoftwareRotation) mirror=\(mirrorFront) videoMirrorSupported=\(rgbMirrorSupported) depthMirrorSupported=\(depthMirrorSupported)")
        configureOutputOrientation(videoConnection, angle: captureAngle, mirrored: mirrorFront)
        configureOutputOrientation(depthConnection, angle: captureAngle, mirrored: mirrorFront)
        captureSession.commitConfiguration()
        let dataSynchronizer = AVCaptureDataOutputSynchronizer(dataOutputs: [video, depth])
        self.session = captureSession
        self.videoOutput = video
        self.depthOutput = depth
        self.synchronizer = dataSynchronizer
        self.configuration = configuration
        frameCounter = 0
        let stream = AsyncStream<CaptureFrame> { continuation in
            self.continuation = continuation
        }
        dataSynchronizer.setDelegate(self, queue: queue)
        captureSession.startRunning()
        return stream
    }

    private func configureOutputOrientation(_ connection: AVCaptureConnection?, angle: CGFloat, mirrored: Bool) {
        guard let connection, connection.isVideoRotationAngleSupported(angle) else { return }
        connection.videoRotationAngle = angle
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = mirrored
        }
    }

    func stop() {
        session?.stopRunning()
        continuation?.finish()
        continuation = nil
        synchronizer = nil
        videoOutput = nil
        depthOutput = nil
        session = nil
        depthSoftwareRotation = 0
        rgbSoftwareRotation = 0
        depthSoftwareMirror = false
        rgbSoftwareMirror = false
        mirroredCapture = false
        captureAngle = 0
    }

    func dataOutputSynchronizer(_ synchronizer: AVCaptureDataOutputSynchronizer, didOutput synchronizedDataCollection: AVCaptureSynchronizedDataCollection) {
        guard let videoOutput, let depthOutput, let configuration,
              let synchronizedVideo = synchronizedDataCollection.synchronizedData(for: videoOutput) as? AVCaptureSynchronizedSampleBufferData,
              let synchronizedDepth = synchronizedDataCollection.synchronizedData(for: depthOutput) as? AVCaptureSynchronizedDepthData,
              !synchronizedVideo.sampleBufferWasDropped, !synchronizedDepth.depthDataWasDropped else { return }
        do {
            let depthData = synchronizedDepth.depthData.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
            let depthBuffer = depthData.depthDataMap
            let rawWidth = CVPixelBufferGetWidth(depthBuffer)
            let rawHeight = CVPixelBufferGetHeight(depthBuffer)
            let rawValues = try copyFloat32(depthBuffer)
            let rotatedDepth = rotateDepth(rawValues, width: rawWidth, height: rawHeight, angle: depthSoftwareRotation)
            let width = rotatedDepth.width
            let height = rotatedDepth.height
            let values = depthSoftwareMirror ? mirrorRaster(rotatedDepth.values, width: width, height: height) : rotatedDepth.values
            let sampleBuffer = synchronizedVideo.sampleBuffer
            guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            var sourceImage = CIImage(cvPixelBuffer: imageBuffer)
            if rgbSoftwareRotation != 0 { sourceImage = rotateImage(sourceImage, angle: rgbSoftwareRotation) }
            if rgbSoftwareMirror { sourceImage = sourceImage.oriented(.upMirrored) }
            let rgb = context.jpegRepresentation(
                of: sourceImage,
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                options: [:]
            ) ?? Data()
            let calibration = depthData.cameraCalibrationData
            let reference = calibration?.intrinsicMatrixReferenceDimensions ?? CGSize(width: width, height: height)
            let matrix = calibration?.intrinsicMatrix ?? matrix_identity_float3x3
            let hardwareDepthRotation = depthSoftwareRotation == 0
                && Int(reference.width) == height
                && Int(reference.height) == width
            let intrinsicsAngle = hardwareDepthRotation ? captureAngle : depthSoftwareRotation
            var intrinsics = rotatedIntrinsics(matrix, reference: reference, angle: intrinsicsAngle)
            if mirroredCapture { intrinsics = mirroredIntrinsics(intrinsics) }
            let rawSourceWidth = CVPixelBufferGetWidth(imageBuffer)
            let rawSourceHeight = CVPixelBufferGetHeight(imageBuffer)
            let sourceWidth = rgbSoftwareRotation == 0 ? rawSourceWidth : rawSourceHeight
            let sourceHeight = rgbSoftwareRotation == 0 ? rawSourceHeight : rawSourceWidth
            if frameCounter == 0 {
                print("[AVDepthProvider] firstFrame source=\(sourceWidth)x\(sourceHeight) depth=\(width)x\(height)")
            }
            let metadata = FrameMetadata(
                frameID: "\(configuration.deviceID)-\(frameCounter)",
                deviceID: configuration.deviceID,
                deviceTimestamp: CMTimeGetSeconds(synchronizedDepth.timestamp),
                sourceWidth: sourceWidth,
                sourceHeight: sourceHeight,
                depthWidth: width,
                depthHeight: height,
                depthStride: width,
                depthFormat: "float32",
                sourceDepthFormat: sourceFormatName(depthData.depthDataType),
                intrinsics: intrinsics,
                poseMatrix: nil,
                poseSpace: "camera",
                orientation: deviceOrientation(),
                confidenceAvailable: false,
                imu: nil
            )
            frameCounter += 1
            continuation?.yield(CaptureFrame(metadata: metadata, rgbJPEG: rgb, depth: values, confidence: nil))
        } catch {
            continuation?.finish()
        }
    }

    private func selectCaptureFormat(device: AVCaptureDevice, requested: DepthFormatDescriptor?) -> (video: AVCaptureDevice.Format, depth: AVCaptureDevice.Format)? {
        let candidates = device.formats.flatMap { videoFormat in
            videoFormat.supportedDepthDataFormats.compactMap { depthFormat -> (video: AVCaptureDevice.Format, depth: AVCaptureDevice.Format)? in
                let dimensions = CMVideoFormatDescriptionGetDimensions(depthFormat.formatDescription)
                let pixelFormat = CMFormatDescriptionGetMediaSubType(depthFormat.formatDescription)
                if let requested {
                    guard dimensions.width == requested.dimensions.x,
                          dimensions.height == requested.dimensions.y,
                          pixelFormat == requested.pixelFormat else { return nil }
                }
                return (video: videoFormat, depth: depthFormat)
            }
        }
        return candidates.first(where: { $0.video === device.activeFormat })
            ?? candidates.first(where: { CMFormatDescriptionGetMediaSubType($0.depth.formatDescription) == kCVPixelFormatType_DepthFloat32 })
            ?? candidates.first
    }
}

enum CaptureError: LocalizedError {
    case deviceUnavailable
    case configurationFailed

    var errorDescription: String? {
        switch self {
        case .deviceUnavailable: return "The selected depth camera is not available."
        case .configurationFailed: return "The selected depth format cannot be configured."
        }
    }
}

private func copyFloat32(_ buffer: CVPixelBuffer) throws -> [Float] {
    guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_DepthFloat32 else { throw CaptureError.configurationFailed }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw CaptureError.configurationFailed }
    let stride = CVPixelBufferGetBytesPerRow(buffer) / MemoryLayout<Float>.stride
    let pointer = base.assumingMemoryBound(to: Float.self)
    var values = [Float](repeating: 0, count: width * height)
    for row in 0..<height {
        for column in 0..<width {
            values[row * width + column] = pointer[row * stride + column]
        }
    }
    return values
}

private func sourceFormatName(_ format: OSType) -> String {
    format == kCVPixelFormatType_DepthFloat16 ? "float16" : "float32"
}

private func portraitCaptureAngle(for device: AVCaptureDevice) -> CGFloat {
    // The app's rendered frame is portrait-normalized. These are the measured
    // sensor conventions for the connected iPhone/iPad families; the iPad rear
    // LiDAR path is the known-good reference. Revisit if landscape capture is added.
    if UIDevice.current.userInterfaceIdiom == .phone { return 270 }
    return device.position == .front ? 180 : 0
}

private func softwareDepthRotation(for nativeAngle: CGFloat) -> CGFloat {
    let normalized = ((Int((nativeAngle / 90).rounded()) % 4) + 4) % 4
    return normalized == 0 ? 0 : CGFloat((4 - normalized) * 90)
}

func rotateRaster<T>(_ values: [T], width: Int, height: Int, angle: CGFloat) -> (values: [T], width: Int, height: Int) {
    let turns = ((Int((angle / 90).rounded()) % 4) + 4) % 4
    guard turns != 0 else { return (values, width, height) }
    let outputWidth = turns.isMultiple(of: 2) ? width : height
    let outputHeight = turns.isMultiple(of: 2) ? height : width
    var output = values
    for y in 0..<outputHeight {
        for x in 0..<outputWidth {
            let source: (x: Int, y: Int)
            switch turns {
            case 1: source = (y, height - 1 - x)
            case 2: source = (width - 1 - x, height - 1 - y)
            default: source = (width - 1 - y, x)
            }
            output[y * outputWidth + x] = values[source.y * width + source.x]
        }
    }
    return (output, outputWidth, outputHeight)
}

func mirrorRaster<T>(_ values: [T], width: Int, height: Int) -> [T] {
    var output = values
    for row in 0..<height {
        for column in 0..<width {
            output[row * width + column] = values[row * width + (width - 1 - column)]
        }
    }
    return output
}

private func rotateDepth(_ values: [Float], width: Int, height: Int, angle: CGFloat) -> (values: [Float], width: Int, height: Int) {
    rotateRaster(values, width: width, height: height, angle: angle)
}

func rotatedIntrinsics(_ matrix: simd_float3x3, reference: CGSize, angle: CGFloat) -> CameraIntrinsics {
    let width = Float(reference.width)
    let height = Float(reference.height)
    let turns = ((Int((angle / 90).rounded()) % 4) + 4) % 4
    let fx = matrix[0, 0]
    let fy = matrix[1, 1]
    let cx = matrix[2, 0]
    let cy = matrix[2, 1]
    switch turns {
    case 1:
        return CameraIntrinsics(fx: fy, fy: fx, cx: height - 1 - cy, cy: cx, referenceWidth: Int(height), referenceHeight: Int(width))
    case 2:
        return CameraIntrinsics(fx: fx, fy: fy, cx: width - 1 - cx, cy: height - 1 - cy, referenceWidth: Int(width), referenceHeight: Int(height))
    case 3:
        return CameraIntrinsics(fx: fy, fy: fx, cx: cy, cy: width - 1 - cx, referenceWidth: Int(height), referenceHeight: Int(width))
    default:
        return CameraIntrinsics(fx: fx, fy: fy, cx: cx, cy: cy, referenceWidth: Int(width), referenceHeight: Int(height))
    }
}

func mirroredIntrinsics(_ intrinsics: CameraIntrinsics) -> CameraIntrinsics {
    CameraIntrinsics(
        fx: intrinsics.fx,
        fy: intrinsics.fy,
        cx: Float(intrinsics.referenceWidth - 1) - intrinsics.cx,
        cy: intrinsics.cy,
        referenceWidth: intrinsics.referenceWidth,
        referenceHeight: intrinsics.referenceHeight
    )
}

func rotateImage(_ image: CIImage, angle: CGFloat) -> CIImage {
    switch ((Int((angle / 90).rounded()) % 4) + 4) % 4 {
    case 1: return image.oriented(.right)
    case 2: return image.oriented(.down)
    case 3: return image.oriented(.left)
    default: return image
    }
}

private func deviceOrientation() -> String {
    switch UIDevice.current.orientation {
    case .portrait: return "portrait"
    case .portraitUpsideDown: return "portraitUpsideDown"
    case .landscapeLeft: return "landscapeRight"
    case .landscapeRight: return "landscapeLeft"
    default: return "unknown"
    }
}
