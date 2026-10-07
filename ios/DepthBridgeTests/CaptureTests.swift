import XCTest
@testable import DepthBridge

final class CaptureTests: XCTestCase {
    func testFloat32ProjectionWithWorldTranslation() {
        let intrinsics = CameraIntrinsics(fx: 1, fy: 1, cx: 0, cy: 0, referenceWidth: 2, referenceHeight: 2)
        let points = PointProjection.project(depth: [1], width: 1, height: 1, stride: 1, intrinsics: intrinsics, poseMatrix: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            2, 3, 4, 1,
        ], poseSpace: "arkitWorldFromCamera")
        XCTAssertEqual(points.first, SIMD3<Float>(2, 3, 3))
    }

    func testEncoderStartsWithDSF1Header() throws {
        let metadata = FrameMetadata(frameID: "frame", deviceID: "device", deviceTimestamp: 1, sourceWidth: 1, sourceHeight: 1, depthWidth: 1, depthHeight: 1, depthStride: 1, depthFormat: "float32", sourceDepthFormat: nil, intrinsics: CameraIntrinsics(fx: 1, fy: 1, cx: 0, cy: 0, referenceWidth: 1, referenceHeight: 1), poseMatrix: nil, poseSpace: "camera", orientation: "portrait", confidenceAvailable: false, imu: nil)
        let data = try FrameEncoder.encode(CaptureFrame(metadata: metadata, rgbJPEG: Data(), depth: [1], confidence: nil))
        XCTAssertEqual(Array(data.prefix(4)), [0x44, 0x53, 0x46, 0x31])
    }
}
