const HEADER_BYTES = 24;
const MAGIC = "DSF1";
const VERSION = 1;
const MAX_PACKET_BYTES = 64 * 1024 * 1024;

export type DepthFormat = "float32" | "float16";
export type PoseSpace = "camera" | "arkitWorldFromCamera";
export type DeviceOrientation =
  | "portrait"
  | "portraitUpsideDown"
  | "landscapeLeft"
  | "landscapeRight"
  | "unknown";

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  referenceWidth: number;
  referenceHeight: number;
}

export interface FrameMetadata {
  frameID: string;
  deviceID: string;
  deviceTimestamp: number;
  sourceWidth: number;
  sourceHeight: number;
  depthWidth: number;
  depthHeight: number;
  depthStride: number;
  depthFormat: "float32";
  sourceDepthFormat?: DepthFormat;
  intrinsics: Intrinsics;
  poseMatrix: number[] | null;
  poseSpace: PoseSpace;
  orientation: DeviceOrientation;
  confidenceAvailable: boolean;
  imu?: {
    acceleration: [number, number, number];
    rotationRate: [number, number, number];
  };
}

export interface DepthFrame {
  metadata: FrameMetadata;
  rgb: Uint8Array;
  depth: Float32Array;
  confidence?: Uint8Array;
}

export function encodeFrame(frame: DepthFrame): Uint8Array {
  validateFrame(frame);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(frame.metadata));
  const header = new ArrayBuffer(HEADER_BYTES);
  const headerBytes = new Uint8Array(header);
  headerBytes.set(new TextEncoder().encode(MAGIC), 0);
  const view = new DataView(header);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, frame.confidence ? 1 : 0, true);
  view.setUint32(8, metadataBytes.byteLength, true);
  view.setUint32(12, frame.rgb.byteLength, true);
  view.setUint32(16, frame.depth.byteLength, true);
  view.setUint32(20, frame.confidence?.byteLength ?? 0, true);

  const output = new Uint8Array(
    HEADER_BYTES + metadataBytes.byteLength + frame.rgb.byteLength + frame.depth.byteLength + (frame.confidence?.byteLength ?? 0),
  );
  let offset = 0;
  for (const part of [
    headerBytes,
    metadataBytes,
    frame.rgb,
    new Uint8Array(frame.depth.buffer, frame.depth.byteOffset, frame.depth.byteLength),
    frame.confidence ?? new Uint8Array(),
  ]) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function decodeFrame(packet: ArrayBuffer | Uint8Array): DepthFrame {
  const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error("Frame packet is truncated before the header");
  }
  if (bytes.byteLength > MAX_PACKET_BYTES) {
    throw new Error("Frame packet exceeds the maximum length");
  }
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) {
    throw new Error(`Invalid frame magic: ${magic}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== VERSION) {
    throw new Error("Unsupported frame version");
  }
  const flags = view.getUint16(6, true);
  const metadataLength = view.getUint32(8, true);
  const rgbLength = view.getUint32(12, true);
  const depthLength = view.getUint32(16, true);
  const confidenceLength = view.getUint32(20, true);
  const payloadLength = HEADER_BYTES + metadataLength + rgbLength + depthLength + confidenceLength;
  if (payloadLength !== bytes.byteLength) {
    throw new Error("Frame packet contains an impossible payload length");
  }
  const metadataStart = HEADER_BYTES;
  const rgbStart = metadataStart + metadataLength;
  const depthStart = rgbStart + rgbLength;
  const confidenceStart = depthStart + depthLength;
  const metadata = parseMetadata(new TextDecoder().decode(bytes.subarray(metadataStart, rgbStart)));
  const expectedDepthLength = metadata.depthWidth * metadata.depthHeight * Float32Array.BYTES_PER_ELEMENT;
  if (depthLength !== expectedDepthLength) {
    throw new Error(`Depth payload length ${depthLength} does not match Float32 dimensions ${expectedDepthLength}`);
  }
  const depthBytes = bytes.slice(depthStart, confidenceStart);
  const depth = new Float32Array(depthLength / Float32Array.BYTES_PER_ELEMENT);
  new Uint8Array(depth.buffer).set(depthBytes);
  const confidence = confidenceLength > 0 ? bytes.slice(confidenceStart) : undefined;
  if (metadata.confidenceAvailable !== (confidenceLength > 0) && (flags & 1) !== 0) {
    throw new Error("Confidence flag does not match metadata");
  }
  return {
    metadata,
    rgb: bytes.slice(rgbStart, depthStart),
    depth,
    confidence,
  };
}

function validateFrame(frame: DepthFrame): void {
  const { metadata } = frame;
  if (frame.depth.length !== metadata.depthWidth * metadata.depthHeight) {
    throw new Error("Depth dimensions do not match the Float32 array");
  }
  if (frame.confidence && frame.confidence.length !== frame.depth.length) {
    throw new Error("Confidence dimensions do not match the depth array");
  }
  parseMetadata(JSON.stringify(metadata));
}

function parseMetadata(json: string): FrameMetadata {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("Frame metadata must be an object");
  const sourceDepthFormat = value.sourceDepthFormat;
  if (sourceDepthFormat !== undefined && sourceDepthFormat !== "float32" && sourceDepthFormat !== "float16") {
    throw new Error("Invalid source depth format");
  }
  const result: FrameMetadata = {
    frameID: requiredString(value, "frameID"),
    deviceID: requiredString(value, "deviceID"),
    deviceTimestamp: requiredFiniteNumber(value, "deviceTimestamp"),
    sourceWidth: requiredPositiveInt(value, "sourceWidth"),
    sourceHeight: requiredPositiveInt(value, "sourceHeight"),
    depthWidth: requiredPositiveInt(value, "depthWidth"),
    depthHeight: requiredPositiveInt(value, "depthHeight"),
    depthStride: requiredPositiveInt(value, "depthStride"),
    depthFormat: "float32",
    intrinsics: parseIntrinsics(value.intrinsics),
    poseMatrix: parsePose(value.poseMatrix),
    poseSpace: parsePoseSpace(value.poseSpace),
    orientation: parseOrientation(value.orientation),
    confidenceAvailable: requiredBoolean(value, "confidenceAvailable"),
  };
  if (sourceDepthFormat !== undefined) result.sourceDepthFormat = sourceDepthFormat;
  if (value.imu !== undefined) {
    const imu = isRecord(value.imu) ? value.imu : undefined;
    if (!imu) throw new Error("Invalid IMU metadata");
    result.imu = {
      acceleration: parseTuple3(imu.acceleration),
      rotationRate: parseTuple3(imu.rotationRate),
    };
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid metadata field: ${key}`);
  return value;
}

function requiredFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid metadata field: ${key}`);
  return value;
}

function requiredPositiveInt(record: Record<string, unknown>, key: string): number {
  const value = requiredFiniteNumber(record, key);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid metadata field: ${key}`);
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Invalid metadata field: ${key}`);
  return value;
}

function parseIntrinsics(value: unknown): Intrinsics {
  if (!isRecord(value)) throw new Error("Invalid intrinsics metadata");
  return {
    fx: requiredFiniteNumber(value, "fx"),
    fy: requiredFiniteNumber(value, "fy"),
    cx: requiredFiniteNumber(value, "cx"),
    cy: requiredFiniteNumber(value, "cy"),
    referenceWidth: requiredPositiveInt(value, "referenceWidth"),
    referenceHeight: requiredPositiveInt(value, "referenceHeight"),
  };
}

function parsePose(value: unknown): number[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 16) throw new Error("Invalid pose matrix");
  const matrix: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) throw new Error("Invalid pose matrix");
    matrix.push(item);
  }
  return matrix;
}

function parsePoseSpace(value: unknown): PoseSpace {
  if (value === "camera" || value === "arkitWorldFromCamera") return value;
  throw new Error("Invalid pose space");
}

function parseOrientation(value: unknown): DeviceOrientation {
  if (value === "portrait" || value === "portraitUpsideDown" || value === "landscapeLeft" || value === "landscapeRight" || value === "unknown") return value;
  throw new Error("Invalid device orientation");
}

function parseTuple3(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("Invalid IMU tuple");
  const tuple: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) throw new Error("Invalid IMU tuple");
    tuple.push(item);
  }
  return [tuple[0], tuple[1], tuple[2]];
}
