import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { decodeFrame } from "../../src/protocol";
import { SessionStore, type SessionManifest } from "./sessionStore";

export interface HubOptions {
  host?: string;
  port?: number;
  dataRoot?: string;
  webRoot?: string;
  token?: string;
}

export interface HubHandle {
  server: Server;
  token: string;
  store: SessionStore;
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface DeviceState {
  deviceID: string;
  name: string;
  capabilities: unknown[];
  socket: WebSocket;
  connectedAt: string;
  droppedFrames: number;
}

interface ActivityEntry {
  id: number;
  at: string;
  deviceID: string | null;
  deviceName?: string;
  status: string;
  message?: string;
}

type HubTextMessage =
  | { type: "hello"; deviceID: string; name?: string; capabilities?: unknown[] }
  | { type: "event"; status?: string; message?: string; droppedFrames?: number };

export function createHubServer(options: HubOptions = {}): HubHandle {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 4317;
  const token = options.token ?? randomBytes(18).toString("base64url");
  const store = new SessionStore(options.dataRoot ?? resolve("data", "sessions"));
  const webRoot = options.webRoot ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
  const devices = new Map<string, DeviceState>();
  const uiClients = new Set<WebSocket>();
  const activity: ActivityEntry[] = [];
  let activityID = 0;
  let recordingDeviceID: string | null = null;
  const deviceWSS = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const uiWSS = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const server = createServer((request, response) => handleHTTP(request, response));

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const requestToken = url.searchParams.get("token");
    if (requestToken !== token || (url.pathname !== "/ws/device" && url.pathname !== "/ws/ui")) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const target = url.pathname === "/ws/device" ? deviceWSS : uiWSS;
    target.handleUpgrade(request, socket, head, (client) => target.emit("connection", client, request));
  });

  deviceWSS.on("connection", (socket) => {
    let state: DeviceState | null = null;
    socket.on("message", (raw, isBinary) => {
      if (!isBinary) {
        const message = parseTextMessage(raw);
        if (!message) {
          sendDeviceEvent(socket, "Invalid device message");
          return;
        }
        if (message.type === "hello") {
          if (state) {
            sendDeviceEvent(socket, "Device hello was sent twice");
            return;
          }
          const existing = devices.get(message.deviceID);
          if (existing && existing.socket !== socket) existing.socket.close(4000, "Replaced by a new connection");
          state = {
            deviceID: message.deviceID,
            name: message.name ?? message.deviceID,
            capabilities: message.capabilities ?? [],
            socket,
            connectedAt: new Date().toISOString(),
            droppedFrames: 0,
          };
          devices.set(state.deviceID, state);
          recordActivity(state.deviceID, "connected", `${state.name} connected`, state.name);
          broadcastUI({ type: "devices", devices: deviceList() });
          sendDeviceEvent(socket, "registered", "ready");
          return;
        }
        if (!state) {
          sendDeviceEvent(socket, "Send hello before events");
          return;
        }
        if (message.droppedFrames !== undefined) {
          state.droppedFrames = Math.max(state.droppedFrames, message.droppedFrames);
          store.recordDrop(state.deviceID, message.droppedFrames);
          broadcastUI({ type: "devices", devices: deviceList() });
        }
        const status = message.status ?? "ready";
        recordActivity(state.deviceID, status, message.message, state.name);
        broadcastUI({ type: "device-event", deviceID: state.deviceID, status, message: message.message, droppedFrames: state.droppedFrames });
        return;
      }
      if (!state) {
        sendDeviceEvent(socket, "Send hello before frames");
        return;
      }
      const packet = rawToBytes(raw);
      try {
        const frame = decodeFrame(packet);
        if (frame.metadata.deviceID !== state.deviceID) throw new Error("Frame device ID does not match hello");
        const active = store.current();
        if (active && (!recordingDeviceID || recordingDeviceID === state.deviceID)) {
          try {
            const manifest = store.recordFrame({
              sessionID: active.sessionID,
              deviceID: state.deviceID,
              frameID: frame.metadata.frameID,
              packet,
              hostReceivedAt: new Date().toISOString(),
            });
            broadcastUI({ type: "session", session: manifest });
          } catch (error) {
            try {
              const stopped = store.stop(active.sessionID);
              broadcastUI({ type: "session", session: stopped });
            } catch {
              // The original disk error is the useful report when the manifest also cannot be written.
            }
            throw new Error(`Recording stopped after a disk error: ${error instanceof Error ? error.message : "write failed"}`);
          }
        }
        broadcastBinary(packet);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid frame packet";
        sendDeviceEvent(socket, message);
        recordActivity(state.deviceID, "error", message, state.name);
        broadcastUI({ type: "error", deviceID: state.deviceID, message });
      }
    });
    socket.on("close", () => {
      if (state && devices.get(state.deviceID)?.socket === socket) {
        recordActivity(state.deviceID, "disconnected", `${state.name} disconnected`, state.name);
        devices.delete(state.deviceID);
        broadcastUI({ type: "devices", devices: deviceList() });
      }
    });
  });

  uiWSS.on("connection", (socket) => {
    uiClients.add(socket);
    socket.send(JSON.stringify({ type: "devices", devices: deviceList() }));
    socket.send(JSON.stringify({ type: "activity", entries: activity }));
    const session = store.current();
    if (session) socket.send(JSON.stringify({ type: "session", session }));
    socket.on("close", () => uiClients.delete(socket));
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const message = parseUICommand(raw);
      if (!message) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid UI command" }));
        return;
      }
      sendCommands(message, message.deviceID ?? null);
    });
  });

  async function handleHTTP(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJSON(response, { ok: true, devices: devices.size, recording: store.current() !== null });
    }
    if (request.method === "GET" && url.pathname === "/api/pairing") {
      return sendJSON(response, { token });
    }
    if (request.method === "GET" && url.pathname === "/api/devices") {
      return sendJSON(response, { devices: deviceList() });
    }
    if (request.method === "GET" && url.pathname === "/api/log") {
      return sendJSON(response, { entries: activity });
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      recordingDeviceID = url.searchParams.get("deviceID") || null;
      const session = store.start();
      recordActivity(recordingDeviceID, "recording_started", "Recording started");
      broadcastUI({ type: "session", session });
      sendCommands({ type: "command", command: "start" }, recordingDeviceID);
      return sendJSON(response, session, 201);
    }
    const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (request.method === "POST" && stopMatch) {
      try {
        const session = store.stop(stopMatch[1]);
        recordActivity(recordingDeviceID, "recording_stopped", "Recording stopped");
        broadcastUI({ type: "session", session });
        sendCommands({ type: "command", command: "stop" }, recordingDeviceID);
        recordingDeviceID = null;
        return sendJSON(response, session);
      } catch (error) {
        return sendJSON(response, { error: error instanceof Error ? error.message : "Session stop failed" }, 409);
      }
    }
    const manifestMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/manifest\.json$/);
    if (request.method === "GET" && manifestMatch) {
      const manifest = store.getManifest(manifestMatch[1]);
      return manifest ? sendJSON(response, manifest) : sendJSON(response, { error: "Session not found" }, 404);
    }
    return serveWeb(url.pathname, response);
  }

  function listen(): Promise<void> {
    return new Promise((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
  }

  function close(): Promise<void> {
    for (const client of uiClients) client.close();
    for (const device of devices.values()) device.socket.close();
    deviceWSS.close();
    uiWSS.close();
    return new Promise((resolveClose) => server.close(() => resolveClose()));
  }

  function broadcastUI(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const client of uiClients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 8 * 1024 * 1024) client.send(payload);
    }
  }

  function broadcastBinary(packet: Uint8Array): void {
    for (const client of uiClients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 8 * 1024 * 1024) client.send(packet);
    }
  }

  function sendCommands(message: { type: "command"; command: "start" | "stop" | "ping"; deviceID?: string }, targetDeviceID: string | null = null): void {
    const payload = JSON.stringify(message);
    for (const device of devices.values()) {
      if ((!targetDeviceID || device.deviceID === targetDeviceID) && device.socket.readyState === WebSocket.OPEN) device.socket.send(payload);
    }
  }

  function sendDeviceEvent(socket: WebSocket, message: string, status = "error"): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "event", status, message }));
  }

  function recordActivity(deviceID: string | null, status: string, message?: string, deviceName?: string): void {
    const entry: ActivityEntry = { id: ++activityID, at: new Date().toISOString(), deviceID, status };
    if (deviceName) entry.deviceName = deviceName;
    if (message) entry.message = message;
    activity.push(entry);
    if (activity.length > 200) activity.shift();
    broadcastUI({ type: "activity", entry });
  }

  function deviceList(): Array<Omit<DeviceState, "socket"> & { connected: boolean }> {
    return [...devices.values()].map((device) => ({
      deviceID: device.deviceID,
      name: device.name,
      capabilities: device.capabilities,
      connectedAt: device.connectedAt,
      droppedFrames: device.droppedFrames,
      connected: device.socket.readyState === WebSocket.OPEN,
    }));
  }

  function serveWeb(pathname: string, response: ServerResponse): void {
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = resolve(join(webRoot, requested));
    if (!candidate.startsWith(resolve(webRoot)) || !existsSync(candidate) || !statSync(candidate).isFile()) {
      const fallback = join(webRoot, "index.html");
      if (!existsSync(fallback)) return sendJSON(response, { error: "Web build not found. Run npm run build." }, 404);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      createReadStream(fallback).pipe(response);
      return;
    }
    response.writeHead(200, { "content-type": contentType(extname(candidate)) });
    createReadStream(candidate).pipe(response);
  }

  return { server, token, store, listen, close };
}

function parseTextMessage(raw: RawData): HubTextMessage | null {
  try {
    const value: unknown = JSON.parse(rawToBytes(raw).toString("utf8"));
    if (!isRecord(value) || (value.type !== "hello" && value.type !== "event")) return null;
    if (value.type === "hello") {
      if (typeof value.deviceID !== "string" || value.deviceID.length === 0) return null;
      return { type: "hello", deviceID: value.deviceID, name: typeof value.name === "string" ? value.name : undefined, capabilities: Array.isArray(value.capabilities) ? value.capabilities : [] };
    }
    if (value.status !== undefined && (typeof value.status !== "string" || value.status.length > 120)) return null;
    if (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 512)) return null;
    if (value.droppedFrames !== undefined && (typeof value.droppedFrames !== "number" || !Number.isFinite(value.droppedFrames))) return null;
    return { type: "event", status: value.status, message: value.message, droppedFrames: value.droppedFrames };
  } catch {
    return null;
  }
}

function parseUICommand(raw: RawData): { type: "command"; command: "start" | "stop" | "ping"; deviceID?: string } | null {
  try {
    const value: unknown = JSON.parse(rawToBytes(raw).toString("utf8"));
    if (!isRecord(value) || value.type !== "command") return null;
    if (value.command !== "start" && value.command !== "stop" && value.command !== "ping") return null;
    if (value.deviceID !== undefined && (typeof value.deviceID !== "string" || value.deviceID.length === 0)) return null;
    return { type: "command", command: value.command, deviceID: value.deviceID };
  } catch {
    return null;
  }
}

function rawToBytes(raw: RawData): Buffer {
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJSON(response: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(payload);
}

function contentType(extension: string): string {
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "text/html; charset=utf-8";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hub = createHubServer();
  hub.listen().then(() => {
    process.stderr.write(`Depth hub listening on ws://0.0.0.0:4317 with pairing token ${hub.token}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
