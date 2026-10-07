import { describe, expect, it } from "vitest";
import { buildBinaryPLY } from "./ply";
import type { PointCloud } from "./pointCloud";

describe("buildBinaryPLY", () => {
  it("writes a binary PLY header and RGB vertex", () => {
    const cloud: PointCloud = {
      positions: new Float32Array([1, 2, 3]),
      colors: new Uint8Array([255, 128, 0]),
      count: 1,
      poseApplied: false,
      poseSpace: "camera",
    };
    const output = buildBinaryPLY(cloud);
    const text = new TextDecoder().decode(output.subarray(0, 160));
    expect(text).toContain("format binary_little_endian 1.0");
    expect(text).toContain("element vertex 1");
    expect(output.byteLength).toBeGreaterThan(15);
    expect([...output.slice(-3)]).toEqual([255, 128, 0]);
  });
});
