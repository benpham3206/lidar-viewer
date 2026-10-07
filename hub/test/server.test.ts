import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createHubServer, type HubHandle } from "../src/server";
import { encodeFrame, type DepthFrame } from "../../src/protocol";

const frame: DepthFrame = {
  metadata: {
    frameID: "frame-1",
    deviceID: "ipad",
    deviceTimestamp: 1,
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
  },
  rgb: new Uint8Array([1, 2]),
  depth: new Float32Array([1, 2, 3, 4]),
};

let hub: HubHandle | null = null;

afterEach(async () => {
  if (hub) await hub.close();
  hub = null;
});

async function startHub(): Promise<{ hub: HubHandle; port: number }> {
  hub = createHubServer({ host: "127.0.0.1", port: 0, dataRoot: mkdtempSync(join(tmpdir(), "depth-hub-")) });
  await hub.listen();
  const address = hub.server.address();
  if (!address || typeof address === "string") throw new Error("Hub did not bind to a port");
  return { hub, port: address.port };
}

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/device?token=${encodeURIComponent(token)}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("hub server", () => {
  it("rejects a device with the wrong token", async () => {
    const { port } = await startHub();
    await expect(connect(port, "wrong-token")).rejects.toBeTruthy();
  });

  it("registers a device, delivers commands, rejects bad frames, and stores one valid frame", async () => {
    const started = await startHub();
    const device = await connect(started.port, started.hub.token);
    const messages: string[] = [];
    device.on("message", (data, binary) => {
      if (!binary) messages.push(data.toString());
    });
    device.send(JSON.stringify({ type: "hello", deviceID: "ipad", name: "Test iPad", capabilities: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const devices = await fetch(`http://127.0.0.1:${started.port}/api/devices`).then((response) => response.json()) as { devices: Array<{ deviceID: string }> };
    expect(devices.devices[0].deviceID).toBe("ipad");
    const initialLog = await fetch(`http://127.0.0.1:${started.port}/api/log`).then((response) => response.json()) as { entries: Array<{ status: string }> };
    expect(initialLog.entries.some((entry) => entry.status === "connected")).toBe(true);
    device.send(JSON.stringify({ type: "event", status: "capture_started", message: "LiDAR" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const activityLog = await fetch(`http://127.0.0.1:${started.port}/api/log`).then((response) => response.json()) as { entries: Array<{ message?: string }> };
    expect(activityLog.entries.some((entry) => entry.message === "LiDAR")).toBe(true);

    const session = await fetch(`http://127.0.0.1:${started.port}/api/sessions`, { method: "POST" }).then((response) => response.json()) as { sessionID: string };
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages.some((message) => message.includes('"command":"start"'))).toBe(true);
    device.send(Buffer.from("bad"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages.some((message) => message.includes("truncated"))).toBe(true);
    device.send(encodeFrame(frame));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopped = await fetch(`http://127.0.0.1:${started.port}/api/sessions/${session.sessionID}/stop`, { method: "POST" }).then((response) => response.json()) as { framesStored: number };
    expect(stopped.framesStored).toBe(1);
    expect(messages.some((message) => message.includes('"command":"stop"'))).toBe(true);
    device.close();
  });
});
