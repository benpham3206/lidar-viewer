import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface DeviceSessionStats {
  framesReceived: number;
  framesStored: number;
  droppedFrames: number;
  lastHostReceiveTime: string | null;
}

export interface SessionManifest {
  sessionID: string;
  startedAt: string;
  stoppedAt: string | null;
  framesReceived: number;
  framesStored: number;
  devices: Record<string, DeviceSessionStats>;
}

export class SessionStore {
  private active: SessionManifest | null = null;

  public constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  public start(): SessionManifest {
    if (this.active) return cloneManifest(this.active);
    const sessionID = `session-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const manifest: SessionManifest = {
      sessionID,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      framesReceived: 0,
      framesStored: 0,
      devices: {},
    };
    this.active = manifest;
    this.writeManifest(manifest);
    return cloneManifest(manifest);
  }

  public stop(sessionID: string): SessionManifest {
    const active = this.requireActive(sessionID);
    active.stoppedAt = new Date().toISOString();
    try {
      this.writeManifest(active);
    } finally {
      this.active = null;
    }
    return cloneManifest(active);
  }

  public current(): SessionManifest | null {
    return this.active ? cloneManifest(this.active) : null;
  }

  public recordFrame(input: {
    sessionID: string;
    deviceID: string;
    frameID: string;
    packet: Uint8Array;
    hostReceivedAt: string;
  }): SessionManifest {
    const active = this.requireActive(input.sessionID);
    const device = this.device(active, input.deviceID);
    device.framesReceived += 1;
    active.framesReceived += 1;
    device.lastHostReceiveTime = input.hostReceivedAt;
    const framesRoot = join(this.root, active.sessionID, "devices", input.deviceID, "frames");
    mkdirSync(framesRoot, { recursive: true });
    writeFileSync(join(framesRoot, `${safeName(input.frameID)}.bin`), input.packet);
    device.framesStored += 1;
    active.framesStored += 1;
    this.writeManifest(active);
    return cloneManifest(active);
  }

  public recordDrop(deviceID: string, count: number): SessionManifest | null {
    if (!this.active) return null;
    const device = this.device(this.active, deviceID);
    device.droppedFrames = Math.max(device.droppedFrames, Math.floor(count));
    this.writeManifest(this.active);
    return cloneManifest(this.active);
  }

  public getManifest(sessionID: string): SessionManifest | null {
    const path = join(this.root, sessionID, "manifest.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      return isManifest(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private requireActive(sessionID: string): SessionManifest {
    if (!this.active || this.active.sessionID !== sessionID) throw new Error("Session is not active");
    return this.active;
  }

  private device(manifest: SessionManifest, deviceID: string): DeviceSessionStats {
    const existing = manifest.devices[deviceID];
    if (existing) return existing;
    const created: DeviceSessionStats = {
      framesReceived: 0,
      framesStored: 0,
      droppedFrames: 0,
      lastHostReceiveTime: null,
    };
    manifest.devices[deviceID] = created;
    return created;
  }

  private writeManifest(manifest: SessionManifest): void {
    const sessionRoot = join(this.root, manifest.sessionID);
    mkdirSync(sessionRoot, { recursive: true });
    writeFileSync(join(sessionRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function safeName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (safe.length === 0 || safe === "." || safe === "..") throw new Error("Invalid frame ID");
  return safe.slice(0, 160);
}

function cloneManifest(manifest: SessionManifest): SessionManifest {
  const devices: Record<string, DeviceSessionStats> = {};
  for (const [deviceID, stats] of Object.entries(manifest.devices)) devices[deviceID] = { ...stats };
  return { ...manifest, devices };
}

function isManifest(value: unknown): value is SessionManifest {
  if (!isRecord(value)) return false;
  return typeof value.sessionID === "string" && typeof value.startedAt === "string" && (typeof value.stoppedAt === "string" || value.stoppedAt === null) && typeof value.framesReceived === "number" && typeof value.framesStored === "number" && isRecord(value.devices);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
