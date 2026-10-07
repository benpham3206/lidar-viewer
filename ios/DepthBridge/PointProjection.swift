import Foundation
import simd

enum PointProjection {
    static func project(depth: [Float], width: Int, height: Int, stride: Int, intrinsics: CameraIntrinsics, poseMatrix: [Float]?, poseSpace: String, confidence: [UInt8]? = nil, minimumConfidence: UInt8 = 0) -> [SIMD3<Float>] {
        guard width > 0, height > 0, stride >= width, depth.count >= stride * height else { return [] }
        let scaleX = Float(width) / Float(intrinsics.referenceWidth)
        let scaleY = Float(height) / Float(intrinsics.referenceHeight)
        let fx = intrinsics.fx * scaleX
        let fy = intrinsics.fy * scaleY
        let cx = intrinsics.cx * scaleX
        let cy = intrinsics.cy * scaleY
        var points: [SIMD3<Float>] = []
        points.reserveCapacity(width * height)
        for y in 0..<height {
            for x in 0..<width {
                let index = y * stride + x
                let distance = depth[index]
                guard distance.isFinite, distance > 0, (confidence?[index] ?? 255) >= minimumConfidence else { continue }
                let cameraX = (Float(x) - cx) * distance / fx
                let cameraY = (Float(y) - cy) * distance / fy
                let point = poseSpace == "arkitWorldFromCamera" ? SIMD4(cameraX, -cameraY, -distance, 1) : SIMD4(cameraX, -cameraY, distance, 1)
                points.append(transform(point, by: poseMatrix))
            }
        }
        return points
    }

    private static func transform(_ point: SIMD4<Float>, by matrix: [Float]?) -> SIMD3<Float> {
        guard let matrix, matrix.count == 16 else { return SIMD3(point.x, point.y, point.z) }
        return SIMD3(
            matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12],
            matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z + matrix[13],
            matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14]
        )
    }
}
