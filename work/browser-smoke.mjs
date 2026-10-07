import { WebSocket } from "ws";

const token = process.argv[2];
if (!token) throw new Error("Pass the hub pairing token as the first argument");
const holdMs = Number(process.argv[3] ?? 140);

const metadata = {
  frameID: "smoke-frame-1",
  deviceID: "smoke-ipad",
  deviceTimestamp: 42,
  sourceWidth: 2,
  sourceHeight: 2,
  depthWidth: 2,
  depthHeight: 2,
  depthStride: 2,
  depthFormat: "float32",
  intrinsics: { fx: 1, fy: 1, cx: 0, cy: 0, referenceWidth: 2, referenceHeight: 2 },
  poseMatrix: null,
  poseSpace: "camera",
  orientation: "portrait",
  confidenceAvailable: false,
};
const metadataBytes = Buffer.from(JSON.stringify(metadata));
const depth = Buffer.alloc(16);
[1, 2, 3, 4].forEach((value, index) => depth.writeFloatLE(value, index * 4));
const header = Buffer.alloc(24);
header.write("DSF1", 0, "ascii");
header.writeUInt16LE(1, 4);
header.writeUInt32LE(metadataBytes.length, 8);
header.writeUInt32LE(0, 12);
header.writeUInt32LE(depth.length, 16);
header.writeUInt32LE(0, 20);
const packet = Buffer.concat([header, metadataBytes, depth]);
const socket = new WebSocket(`ws://127.0.0.1:4317/ws/device?token=${encodeURIComponent(token)}`);

socket.on("open", async () => {
  socket.send(JSON.stringify({ type: "hello", deviceID: "smoke-ipad", name: "Synthetic iPad", capabilities: [] }));
  const session = await fetch("http://127.0.0.1:4317/api/sessions", { method: "POST" }).then((response) => response.json());
  setTimeout(() => socket.send(packet), 40);
  setTimeout(async () => {
    const stopped = await fetch(`http://127.0.0.1:4317/api/sessions/${session.sessionID}/stop`, { method: "POST" }).then((response) => response.json());
    process.stdout.write(JSON.stringify(stopped));
    socket.close();
  }, holdMs);
});

socket.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
