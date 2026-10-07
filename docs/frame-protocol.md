# Depth frame protocol

The hub accepts one binary frame format from a native device. The format is
little-endian and has no compression in the first vertical slice.

## Packet layout

The first 24 bytes are the header:

| Bytes | Type | Meaning |
| --- | --- | --- |
| 0..3 | ASCII | `DSF1` |
| 4..5 | `u16` | Version, `1` |
| 6..7 | `u16` | Flags, bit 0 means confidence bytes exist |
| 8..11 | `u32` | UTF-8 metadata length |
| 12..15 | `u32` | JPEG RGB length |
| 16..19 | `u32` | Float32 depth length |
| 20..23 | `u32` | UInt8 confidence length, or `0` |

The payload follows the header in this order:

```text
UTF-8 metadata JSON
JPEG RGB bytes
little-endian Float32 depth bytes
optional UInt8 confidence bytes
```

The depth array contains `depthWidth * depthHeight` samples. The sender must
convert Float16 source data to Float32 before sending. `sourceDepthFormat`
keeps the source format when that conversion occurred.

## Metadata

The JSON object contains:

```json
{
  "frameID": "frame-42",
  "deviceID": "ipad-pro",
  "deviceTimestamp": 123.45,
  "sourceWidth": 1920,
  "sourceHeight": 1440,
  "depthWidth": 256,
  "depthHeight": 192,
  "depthStride": 256,
  "depthFormat": "float32",
  "sourceDepthFormat": "float16",
  "intrinsics": {
    "fx": 300,
    "fy": 300,
    "cx": 128,
    "cy": 96,
    "referenceWidth": 256,
    "referenceHeight": 192
  },
  "poseMatrix": null,
  "poseSpace": "camera",
  "orientation": "portrait",
  "confidenceAvailable": true,
  "imu": {
    "acceleration": [0, 0, 0],
    "rotationRate": [0, 0, 0]
  }
}
```

`poseSpace` is `camera` for AVFoundation depth and
`arkitWorldFromCamera` for ARKit tracking. A world pose is a 4x4 column-major
matrix. Device timestamps are not synchronized between devices. The hub adds
its own receive timestamp when it stores a frame.

## Text messages

The device sends `hello` after it connects:

```json
{
  "type": "hello",
  "deviceID": "ipad-pro",
  "name": "Ben's iPad",
  "capabilities": []
}
```

The hub sends `command` messages with `start`, `stop`, or `ping`. The device
sends `event` messages for status, errors, and dropped frames. The browser
uses the same event shape on `/ws/ui`.
