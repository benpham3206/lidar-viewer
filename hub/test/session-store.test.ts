import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessionStore";

describe("SessionStore", () => {
  it("writes one packet and a readable manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "depth-hub-"));
    const store = new SessionStore(root);
    const started = store.start();
    store.recordFrame({
      sessionID: started.sessionID,
      deviceID: "ipad",
      frameID: "frame/1",
      packet: new Uint8Array([1, 2, 3]),
      hostReceivedAt: "2026-09-19T00:00:00.000Z",
    });
    const stopped = store.stop(started.sessionID);
    expect(stopped.framesStored).toBe(1);
    const manifest = JSON.parse(readFileSync(join(root, started.sessionID, "manifest.json"), "utf8")) as { framesStored: number };
    expect(manifest.framesStored).toBe(1);
  });

  it("keeps the highest cumulative drop count", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "depth-hub-")));
    store.start();
    store.recordDrop("ipad", 1);
    store.recordDrop("ipad", 3);
    store.recordDrop("ipad", 2);
    expect(store.current()?.devices.ipad.droppedFrames).toBe(3);
  });
});
