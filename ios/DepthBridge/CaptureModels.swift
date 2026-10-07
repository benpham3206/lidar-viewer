import Foundation
import simd

enum CaptureProviderKind: String, CaseIterable, Identifiable {
    case avFoundation
    case arKit

    var id: String { rawValue }
    var title: String { self == .avFoundation ? "AVFoundation depth" : "ARKit scene depth" }
}

enum SensorPosition: String, Codable {
    case back
    case front
    case unspecified
}

struct DepthFormatDescriptor: Codable, Hashable, Identifiable {
    let id: String
    let dimensions: SIMD2<Int32>
    let pixelFormat: UInt32
    let pixelFormatName: String
    let minFrameRate: Double
    let maxFrameRate: Double
    let isFloat32: Bool

    var resolutionID: String {
        "\(dimensions.x)x\(dimensions.y)"
    }

    var resolutionLabel: String {
        "\(dimensions.x)×\(dimensions.y)"
    }

    var pixelFormatID: String {
        String(pixelFormat)
    }

    var label: String {
        "\(dimensions.x)×\(dimensions.y) · \(pixelFormatName) · \(Int(maxFrameRate)) fps"
    }
}

struct SensorCapability: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let deviceType: String
    let position: SensorPosition
    let formats: [DepthFormatDescriptor]
}

struct CameraIntrinsics: Codable, Hashable {
    let fx: Float
    let fy: Float
    let cx: Float
    let cy: Float
    let referenceWidth: Int
    let referenceHeight: Int
}

struct FrameMetadata: Codable, Hashable {
    let frameID: String
    let deviceID: String
    let deviceTimestamp: Double
    let sourceWidth: Int
    let sourceHeight: Int
    let depthWidth: Int
    let depthHeight: Int
    let depthStride: Int
    let depthFormat: String
    let sourceDepthFormat: String?
    let intrinsics: CameraIntrinsics
    let poseMatrix: [Float]?
    let poseSpace: String
    let orientation: String
    let confidenceAvailable: Bool
    let imu: IMUMetadata?
}

struct IMUMetadata: Codable, Hashable {
    let acceleration: [Float]
    let rotationRate: [Float]
}

struct CaptureFrame {
    let metadata: FrameMetadata
    let rgbJPEG: Data
    let depth: [Float]
    let confidence: [UInt8]?
}

struct DepthPreview: Equatable {
    let width: Int
    let height: Int
    let values: [Float]
}

struct CaptureConfiguration {
    let deviceID: String
    let kind: CaptureProviderKind
    let depthFormat: DepthFormatDescriptor?
    let useSmoothedDepth: Bool
    let targetFPS: Double
}

protocol CaptureProvider: AnyObject {
    func start(configuration: CaptureConfiguration) async throws -> AsyncStream<CaptureFrame>
    func stop()
}
