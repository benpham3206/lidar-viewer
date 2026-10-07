import type { DepthFrame } from "../../src/protocol";

export interface ProjectOptions {
  confidenceThreshold?: number;
  maxPoints?: number;
  stride?: number;
}

export interface PointCloud {
  positions: Float32Array;
  colors: Uint8Array;
  count: number;
  poseApplied: boolean;
  poseSpace: DepthFrame["metadata"]["poseSpace"];
}

export class VoxelRoomMap {
  private readonly voxels = new Map<string, number>();
  private readonly positions: Float32Array;
  private readonly colors: Uint8Array;
  private order: string[] = [];
  private evictionCursor = 0;
  private size = 0;

  // ponytail: FIFO eviction bounds live memory; add disk-backed fusion when scans exceed the cap.
  public constructor(
    private readonly voxelSize = 0.035,
    private readonly maxVoxels = 750_000,
  ) {
    this.positions = new Float32Array(maxVoxels * 3);
    this.colors = new Uint8Array(maxVoxels * 3);
  }

  public add(cloud: PointCloud): void {
    if (!cloud.poseApplied || cloud.poseSpace !== "arkitWorldFromCamera") return;
    for (let index = 0; index < cloud.count; index += 1) {
      const offset = index * 3;
      const key = this.key(cloud.positions[offset], cloud.positions[offset + 1], cloud.positions[offset + 2]);
      let slot = this.voxels.get(key);
      if (slot === undefined) {
        if (this.size < this.maxVoxels) {
          slot = this.size;
          this.size += 1;
        } else {
          while (this.evictionCursor < this.order.length && !this.voxels.has(this.order[this.evictionCursor])) this.evictionCursor += 1;
          const evictedKey = this.order[this.evictionCursor++] ?? "";
          slot = this.voxels.get(evictedKey) ?? 0;
          this.voxels.delete(evictedKey);
        }
        this.voxels.set(key, slot);
        this.order.push(key);
      }
      const targetOffset = slot * 3;
      this.positions[targetOffset] = cloud.positions[offset];
      this.positions[targetOffset + 1] = cloud.positions[offset + 1];
      this.positions[targetOffset + 2] = cloud.positions[offset + 2];
      this.colors[targetOffset] = cloud.colors[offset];
      this.colors[targetOffset + 1] = cloud.colors[offset + 1];
      this.colors[targetOffset + 2] = cloud.colors[offset + 2];
    }
  }

  public clear(): void {
    this.voxels.clear();
    this.order = [];
    this.evictionCursor = 0;
    this.size = 0;
  }

  public snapshot(): PointCloud | null {
    if (this.size === 0) return null;
    return {
      positions: this.positions.subarray(0, this.size * 3),
      colors: this.colors.subarray(0, this.size * 3),
      count: this.size,
      poseApplied: true,
      poseSpace: "arkitWorldFromCamera",
    };
  }

  private key(x: number, y: number, z: number): string {
    return `${Math.floor(x / this.voxelSize)}:${Math.floor(y / this.voxelSize)}:${Math.floor(z / this.voxelSize)}`;
  }
}

export function appendPointCloud(previous: PointCloud | null, next: PointCloud, maxPoints = 250_000): PointCloud {
  if (!previous || previous.poseSpace !== next.poseSpace) return next;
  const nextCount = Math.min(next.count, maxPoints);
  const previousCount = Math.min(previous.count, maxPoints - nextCount);
  const positions = new Float32Array((previousCount + nextCount) * 3);
  const colors = new Uint8Array((previousCount + nextCount) * 3);
  const previousStart = (previous.count - previousCount) * 3;
  positions.set(previous.positions.subarray(previousStart, previousStart + previousCount * 3));
  colors.set(previous.colors.subarray(previousStart, previousStart + previousCount * 3));
  positions.set(next.positions.subarray(0, nextCount * 3), previousCount * 3);
  colors.set(next.colors.subarray(0, nextCount * 3), previousCount * 3);
  return { positions, colors, count: previousCount + nextCount, poseApplied: next.poseApplied, poseSpace: next.poseSpace };
}

export function projectFrame(frame: DepthFrame, options: ProjectOptions = {}): PointCloud {
  const { metadata, depth } = frame;
  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const confidenceThreshold = options.confidenceThreshold ?? 0;
  const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? 250_000));
  const scaleX = metadata.depthWidth / metadata.intrinsics.referenceWidth;
  const scaleY = metadata.depthHeight / metadata.intrinsics.referenceHeight;
  const fx = metadata.intrinsics.fx * scaleX;
  const fy = metadata.intrinsics.fy * scaleY;
  const cx = metadata.intrinsics.cx * scaleX;
  const cy = metadata.intrinsics.cy * scaleY;
  const positions: number[] = [];
  const colors: number[] = [];
  const poseApplied = metadata.poseSpace === "arkitWorldFromCamera" && metadata.poseMatrix !== null;

  for (let y = 0; y < metadata.depthHeight; y += stride) {
    for (let x = 0; x < metadata.depthWidth; x += stride) {
      const index = y * metadata.depthStride + x;
      const distance = depth[index];
      const confidence = frame.confidence?.[index] ?? 255;
      if (!Number.isFinite(distance) || distance <= 0 || confidence < confidenceThreshold) continue;
      const cameraX = (x - cx) * distance / fx;
      const cameraY = (y - cy) * distance / fy;
      const cameraPoint: [number, number, number] = metadata.poseSpace === "arkitWorldFromCamera"
        ? [cameraX, -cameraY, -distance]
        : [cameraX, -cameraY, distance];
      const point = poseApplied ? transformPoint(cameraPoint, metadata.poseMatrix) : cameraPoint;
      positions.push(point[0], point[1], point[2]);
      const shade = Math.max(0, Math.min(255, Math.round(255 * (1 - Math.min(distance, 5) / 5))));
      colors.push(255, shade, 80);
      if (positions.length / 3 >= maxPoints) break;
    }
    if (positions.length / 3 >= maxPoints) break;
  }

  return {
    positions: new Float32Array(positions),
    colors: new Uint8Array(colors),
    count: positions.length / 3,
    poseApplied,
    poseSpace: metadata.poseSpace,
  };
}

function transformPoint(point: [number, number, number], matrix: number[] | null): [number, number, number] {
  if (!matrix) return point;
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}
