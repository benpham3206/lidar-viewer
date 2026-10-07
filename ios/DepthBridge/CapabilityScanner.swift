import AVFoundation
import CoreMedia
import Foundation

final class CapabilityScanner {
    func scan() -> [SensorCapability] {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInLiDARDepthCamera, .builtInTrueDepthCamera],
            mediaType: .video,
            position: .unspecified
        )
        return discovery.devices.map { device in
            let formats = device.formats.flatMap { colorFormat in
                colorFormat.supportedDepthDataFormats.map { depthFormat in
                    descriptor(device: device, colorFormat: colorFormat, depthFormat: depthFormat)
                }
            }
            return SensorCapability(
                id: device.uniqueID,
                name: device.localizedName,
                deviceType: device.deviceType.rawValue,
                position: SensorPosition(device.position),
                formats: formats
            )
        }
    }

    func device(withID id: String) -> AVCaptureDevice? {
        scanDeviceList().first { $0.uniqueID == id }
    }

    private func scanDeviceList() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInLiDARDepthCamera, .builtInTrueDepthCamera],
            mediaType: .video,
            position: .unspecified
        ).devices
    }

    private func descriptor(device: AVCaptureDevice, colorFormat: AVCaptureDevice.Format, depthFormat: AVCaptureDevice.Format) -> DepthFormatDescriptor {
        let dimensions = CMVideoFormatDescriptionGetDimensions(depthFormat.formatDescription)
        let mediaSubType = CMFormatDescriptionGetMediaSubType(depthFormat.formatDescription)
        let formatName: String
        switch mediaSubType {
        case kCVPixelFormatType_DepthFloat32: formatName = "Float32"
        case kCVPixelFormatType_DepthFloat16: formatName = "Float16"
        default: formatName = fourCC(mediaSubType)
        }
        let range = colorFormat.videoSupportedFrameRateRanges.first
        return DepthFormatDescriptor(
            id: "\(device.uniqueID)-\(dimensions.width)x\(dimensions.height)-\(mediaSubType)",
            dimensions: SIMD2(dimensions.width, dimensions.height),
            pixelFormat: mediaSubType,
            pixelFormatName: formatName,
            minFrameRate: range?.minFrameRate ?? 0,
            maxFrameRate: range?.maxFrameRate ?? 0,
            isFloat32: mediaSubType == kCVPixelFormatType_DepthFloat32
        )
    }
}

private extension SensorPosition {
    init(_ position: AVCaptureDevice.Position) {
        switch position {
        case .front: self = .front
        case .back: self = .back
        default: self = .unspecified
        }
    }
}

private func fourCC(_ code: FourCharCode) -> String {
    let bytes: [UInt8] = [
        UInt8((code >> 24) & 0xff),
        UInt8((code >> 16) & 0xff),
        UInt8((code >> 8) & 0xff),
        UInt8(code & 0xff),
    ]
    return String(bytes: bytes, encoding: .ascii) ?? "unknown"
}
