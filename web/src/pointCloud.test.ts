import { describe, expect, it } from "vitest";
import { appendPointCloud, projectFrame, VoxelRoomMap, type PointCloud } from "./pointCloud";
import type { DepthFrame } from "../../src/protocol";

function frame(overrides: Partial<DepthFrame["metadata"]> = {}): DepthFrame {
  return {
    metadata: {
      frameID: "frame",
      deviceID: "ipad",
      deviceTimestamp: 1,
      sourceWidth: 4,
      sourceHeight: 4,
      depthWidth: 2,
      depthHeight: 2,
      depthStride: 2,
      depthFormat: "float32",
      intrinsics: { fx: 2, fy: 2, cx: 2, cy: 2, referenceWidth: 4, referenceHeight: 4 },
      poseMatrix: null,
      poseSpace: "camera",
      orientation: "portrait",
      confidenceAvailable: true,
      ...overrides,
    },
    rgb: new Uint8Array(),
    depth: new Float32Array([1, 2, NaN, 4]),
    confidence: new Uint8Array([3, 1, 0, 3]),
  };
}

describe("projectFrame", () => {
  it("scales reference intrinsics and skips invalid or low-confidence samples", () => {
    const cloud = projectFrame(frame(), { confidenceThreshold: 2 });
    expect(cloud.count).toBe(2);
    expect([...cloud.positions.slice(0, 3)]).toEqual([-1, 1, 1]);
  });

  it("applies an ARKit world translation", () => {
    const cloud = projectFrame(frame({ poseSpace: "arkitWorldFromCamera", poseMatrix: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      2, 3, 4, 1,
    ] }), { confidenceThreshold: 3 });
    expect(cloud.poseApplied).toBe(true);
    expect([...cloud.positions.slice(0, 3)]).toEqual([1, 4, 3]);
  });

  it("caps the output point count", () => {
    const cloud = projectFrame(frame(), { maxPoints: 1 });
    expect(cloud.count).toBe(1);
  });
});

describe("appendPointCloud", () => {
  it("keeps the newest points when the live cloud reaches its cap", () => {
    const previous: PointCloud = {
      positions: new Float32Array([1, 1, 1, 2, 2, 2]),
      colors: new Uint8Array([1, 1, 1, 2, 2, 2]),
      count: 2,
      poseApplied: true,
      poseSpace: "arkitWorldFromCamera",
    };
    const next: PointCloud = {
      positions: new Float32Array([3, 3, 3]),
      colors: new Uint8Array([3, 3, 3]),
      count: 1,
      poseApplied: true,
      poseSpace: "arkitWorldFromCamera",
    };
    const cloud = appendPointCloud(previous, next, 2);
    expect([...cloud.positions]).toEqual([2, 2, 2, 3, 3, 3]);
  });
});

describe("VoxelRoomMap", () => {
  it("merges nearby world points and keeps the newest voxel sample", () => {
    const map = new VoxelRoomMap(0.1, 10);
    map.add({
      positions: new Float32Array([0.01, 0, 0, 0.25, 0, 0]),
      colors: new Uint8Array([1, 2, 3, 4, 5, 6]),
      count: 2,
      poseApplied: true,
      poseSpace: "arkitWorldFromCamera",
    });
    map.add({
      positions: new Float32Array([0.02, 0, 0]),
      colors: new Uint8Array([7, 8, 9]),
      count: 1,
      poseApplied: true,
      poseSpace: "arkitWorldFromCamera",
    });
    const cloud = map.snapshot();
    expect(cloud?.count).toBe(2);
    const samples = Array.from({ length: cloud!.count }, (_, index) => [...cloud!.colors.slice(index * 3, index * 3 + 3)]);
    expect(samples).toContainEqual([7, 8, 9]);
  });
});
