import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  type DepthFrame,
  type FrameMetadata,
} from "./protocol";

const metadata: FrameMetadata = {
  frameID: "frame-1",
  deviceID: "phone-1",
  deviceTimestamp: 12.5,
  sourceWidth: 4,
  sourceHeight: 4,
  depthWidth: 2,
  depthHeight: 2,
  depthStride: 2,
  depthFormat: "float32",
  intrinsics: {
    fx: 2,
    fy: 2,
    cx: 1,
    cy: 1,
    referenceWidth: 2,
    referenceHeight: 2,
  },
  poseMatrix: null,
  poseSpace: "camera",
  orientation: "portrait",
  confidenceAvailable: true,
};

const frame: DepthFrame = {
  metadata,
  rgb: new Uint8Array([255, 216, 0]),
  depth: new Float32Array([1, 2, 3, 4]),
  confidence: new Uint8Array([3, 2, 1, 0]),
};

describe("depth frame protocol", () => {
  it("round trips one synthetic 2x2 frame", () => {
    const decoded = decodeFrame(encodeFrame(frame));

    expect(decoded.metadata).toEqual(metadata);
    expect([...decoded.rgb]).toEqual([...frame.rgb]);
    expect([...decoded.depth]).toEqual([...frame.depth]);
    expect([...decoded.confidence ?? []]).toEqual([...frame.confidence ?? []]);
  });

  it("rejects bad magic", () => {
    const packet = encodeFrame(frame);
    packet[0] = 0;
    expect(() => decodeFrame(packet)).toThrow(/magic/i);
  });

  it("rejects truncation", () => {
    const packet = encodeFrame(frame).slice(0, -1);
    expect(() => decodeFrame(packet)).toThrow(/length/i);
  });

  it("rejects impossible lengths", () => {
    const packet = encodeFrame(frame);
    new DataView(packet.buffer, packet.byteOffset, packet.byteLength).setUint32(16, 0xffffffff, true);
    expect(() => decodeFrame(packet)).toThrow(/length/i);
  });

  it("rejects a depth payload that is not Float32 sized", () => {
    const encoded = encodeFrame(frame);
    const packet = encoded.slice(0, -12);
    new DataView(packet.buffer, packet.byteOffset, packet.byteLength).setUint32(16, 4, true);
    expect(() => decodeFrame(packet)).toThrow(/depth/i);
  });
});
