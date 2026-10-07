import Foundation

enum FrameEncodingError: LocalizedError {
    case invalidDepthDimensions
    case invalidConfidenceDimensions

    var errorDescription: String? {
        switch self {
        case .invalidDepthDimensions: return "Depth dimensions do not match the Float32 sample count."
        case .invalidConfidenceDimensions: return "Confidence dimensions do not match the depth sample count."
        }
    }
}

struct FrameEncoder {
    static func encode(_ frame: CaptureFrame) throws -> Data {
        let sampleCount = frame.metadata.depthWidth * frame.metadata.depthHeight
        guard frame.depth.count == sampleCount else { throw FrameEncodingError.invalidDepthDimensions }
        if let confidence = frame.confidence, confidence.count != sampleCount {
            throw FrameEncodingError.invalidConfidenceDimensions
        }
        let metadata = try JSONEncoder().encode(frame.metadata)
        var depth = Data(capacity: frame.depth.count * MemoryLayout<Float32>.size)
        for sample in frame.depth {
            var bits = sample.bitPattern.littleEndian
            depth.append(contentsOf: withUnsafeBytes(of: &bits) { Data($0) })
        }
        let confidence = Data(frame.confidence ?? [])
        let header = Header(
            flags: confidence.isEmpty ? 0 : 1,
            metadataLength: UInt32(metadata.count),
            rgbLength: UInt32(frame.rgbJPEG.count),
            depthLength: UInt32(depth.count),
            confidenceLength: UInt32(confidence.count)
        )
        var output = Data(capacity: Header.byteCount + metadata.count + frame.rgbJPEG.count + depth.count + confidence.count)
        output.append(contentsOf: Header.magic)
        output.appendLE(UInt16(1))
        output.appendLE(header.flags)
        output.appendLE(header.metadataLength)
        output.appendLE(header.rgbLength)
        output.appendLE(header.depthLength)
        output.appendLE(header.confidenceLength)
        output.append(metadata)
        output.append(frame.rgbJPEG)
        output.append(depth)
        output.append(confidence)
        return output
    }
}

private struct Header {
    static let magic: [UInt8] = [0x44, 0x53, 0x46, 0x31]
    static let byteCount = 24
    let flags: UInt16
    let metadataLength: UInt32
    let rgbLength: UInt32
    let depthLength: UInt32
    let confidenceLength: UInt32
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        append(contentsOf: Swift.withUnsafeBytes(of: &littleEndian) { Data($0) })
    }
}
