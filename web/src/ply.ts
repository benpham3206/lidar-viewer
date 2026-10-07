import type { PointCloud } from "./pointCloud";

export function buildBinaryPLY(cloud: PointCloud): Uint8Array {
  const header = [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${cloud.count}`,
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "end_header",
    "",
  ].join("\n");
  const headerBytes = new TextEncoder().encode(header);
  const vertexBytes = new Uint8Array(cloud.count * 15);
  const view = new DataView(vertexBytes.buffer);
  for (let index = 0; index < cloud.count; index += 1) {
    const positionOffset = index * 3;
    const colorOffset = index * 3;
    const byteOffset = index * 15;
    view.setFloat32(byteOffset, cloud.positions[positionOffset], true);
    view.setFloat32(byteOffset + 4, cloud.positions[positionOffset + 1], true);
    view.setFloat32(byteOffset + 8, cloud.positions[positionOffset + 2], true);
    vertexBytes[byteOffset + 12] = cloud.colors[colorOffset];
    vertexBytes[byteOffset + 13] = cloud.colors[colorOffset + 1];
    vertexBytes[byteOffset + 14] = cloud.colors[colorOffset + 2];
  }
  const output = new Uint8Array(headerBytes.byteLength + vertexBytes.byteLength);
  output.set(headerBytes, 0);
  output.set(vertexBytes, headerBytes.byteLength);
  return output;
}
