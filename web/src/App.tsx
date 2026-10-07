import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import * as THREE from "three";
import { decodeFrame, type DepthFrame } from "../../src/protocol";
import { buildBinaryPLY } from "./ply";
import { projectFrame, VoxelRoomMap, type PointCloud } from "./pointCloud";

interface DeviceSummary {
  deviceID: string;
  name: string;
  capabilities: unknown[];
  connectedAt: string;
  droppedFrames: number;
  connected: boolean;
}

interface SessionSummary {
  sessionID: string;
  startedAt: string;
  stoppedAt: string | null;
  framesReceived: number;
  framesStored: number;
  devices: Record<string, { framesReceived: number; framesStored: number; droppedFrames: number; lastHostReceiveTime: string | null }>;
}

interface ActivityEntry {
  id: number;
  at: string;
  deviceID: string | null;
  deviceName?: string;
  status: string;
  message?: string;
}

type UIMessage =
  | { type: "devices"; devices: DeviceSummary[] }
  | { type: "session"; session: SessionSummary }
  | { type: "activity"; entries?: ActivityEntry[]; entry?: ActivityEntry }
  | { type: "device-event"; deviceID: string; status: string; message?: string; droppedFrames: number }
  | { type: "error"; message: string; deviceID?: string };

export default function App() {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [token, setToken] = useState("");
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [frame, setFrame] = useState<DepthFrame | null>(null);
  const [roomCloud, setRoomCloud] = useState<PointCloud | null>(null);
  const [liveCloud, setLiveCloud] = useState<PointCloud | null>(null);
  const [livePoseMatrix, setLivePoseMatrix] = useState<number[] | null>(null);
  const [connection, setConnection] = useState("Connecting to hub");
  const [notice, setNotice] = useState("Waiting for a device");
  const [threshold, setThreshold] = useState(1);
  const [adaptiveDepth, setAdaptiveDepth] = useState(true);
  const [selectedDeviceID, setSelectedDeviceID] = useState("");
  const thresholdRef = useRef(threshold);
  const selectedDeviceRef = useRef(selectedDeviceID);
  const roomMapRef = useRef(new VoxelRoomMap());
  const lastMapSnapshotRef = useRef(0);
  thresholdRef.current = threshold;
  selectedDeviceRef.current = selectedDeviceID;

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    fetch("/api/pairing")
      .then((response) => response.json())
      .then((value: unknown) => {
        if (disposed || !isRecord(value) || typeof value.token !== "string") return;
        setToken(value.token);
        const scheme = window.location.protocol === "https:" ? "wss" : "ws";
        socket = new WebSocket(`${scheme}://${window.location.host}/ws/ui?token=${encodeURIComponent(value.token)}`);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => setConnection("Hub connected");
        socket.onclose = () => setConnection("Hub disconnected");
        socket.onerror = () => setConnection("Hub connection error");
        socket.onmessage = (event) => receiveMessage(event.data);
      })
      .catch(() => setConnection("Hub unavailable"));
    return () => {
      disposed = true;
      socket?.close();
    };

    function receiveMessage(data: unknown): void {
      if (typeof data === "string") {
        try {
          const message: unknown = JSON.parse(data);
          if (isUIMessage(message)) handleUIMessage(message);
        } catch {
          setNotice("Hub sent invalid status data");
        }
        return;
      }
      if (data instanceof ArrayBuffer) {
        handleFrame(new Uint8Array(data));
        return;
      }
      if (data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => handleFrame(new Uint8Array(buffer)));
      }
    }

    function handleUIMessage(message: UIMessage): void {
      if (message.type === "devices") {
        setDevices(message.devices);
        const nextDeviceID = preferredDeviceID(message.devices, selectedDeviceRef.current);
        if (nextDeviceID !== selectedDeviceRef.current) {
          resetVisualization();
          selectedDeviceRef.current = nextDeviceID;
          setSelectedDeviceID(nextDeviceID);
        }
      } else if (message.type === "session") {
        setSession(message.session);
      } else if (message.type === "activity") {
        if (message.entries) setActivity(message.entries.slice(-200));
        if (message.entry) setActivity((previous) => [...previous, message.entry!].slice(-200));
      } else if (message.type === "device-event") {
        setNotice(`${message.deviceID}: ${message.message ?? message.status}`);
      } else {
        setNotice(message.message);
      }
    }

    function handleFrame(packet: Uint8Array): void {
      try {
        const nextFrame = decodeFrame(packet);
        if (selectedDeviceRef.current && nextFrame.metadata.deviceID !== selectedDeviceRef.current) return;
        const nextCloud = projectFrame(nextFrame, { confidenceThreshold: thresholdRef.current, stride: 2, maxPoints: 250_000 });
        setFrame(nextFrame);
        setLiveCloud(nextCloud);
        setLivePoseMatrix(nextCloud.poseApplied ? nextFrame.metadata.poseMatrix : null);
        if (nextCloud.poseApplied) {
          roomMapRef.current.add(nextCloud);
          const now = performance.now();
          if (now - lastMapSnapshotRef.current >= 120) {
            setRoomCloud(roomMapRef.current.snapshot());
            lastMapSnapshotRef.current = now;
          }
        } else {
          roomMapRef.current.clear();
          lastMapSnapshotRef.current = 0;
          setRoomCloud(null);
        }
        setNotice(`${nextFrame.metadata.deviceID} · ${nextFrame.metadata.poseSpace}`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Frame decode failed");
      }
    }
  }, []);

  const recording = session?.stoppedAt === null;
  const selectedDevice = useMemo(() => devices.find((device) => device.deviceID === selectedDeviceID) ?? devices[0], [devices, selectedDeviceID]);
  const canRecord = Boolean(selectedDevice?.connected && selectedDevice.capabilities.length > 0);
  const displayedCloud = roomCloud ?? liveCloud;
  const roomMapActive = Boolean(roomCloud);

  function resetVisualization(): void {
    roomMapRef.current.clear();
    lastMapSnapshotRef.current = 0;
    setRoomCloud(null);
    setLiveCloud(null);
    setLivePoseMatrix(null);
    setFrame(null);
  }

  function clearRoomMap(): void {
    roomMapRef.current.clear();
    lastMapSnapshotRef.current = 0;
    setRoomCloud(null);
  }

  function selectDevice(deviceID: string): void {
    if (deviceID !== selectedDeviceRef.current) resetVisualization();
    selectedDeviceRef.current = deviceID;
    setSelectedDeviceID(deviceID);
  }

  async function startRecording(): Promise<void> {
    if (!canRecord || !selectedDevice) {
      setNotice("Select a connected capture device first");
      return;
    }
    clearRoomMap();
    const query = `?deviceID=${encodeURIComponent(selectedDevice.deviceID)}`;
    const response = await fetch(`/api/sessions${query}`, { method: "POST" });
    setNotice(response.ok ? "Recording started" : "Could not start recording");
  }

  async function stopRecording(): Promise<void> {
    if (!session) return;
    const response = await fetch(`/api/sessions/${encodeURIComponent(session.sessionID)}/stop`, { method: "POST" });
    setNotice(response.ok ? "Recording stopped" : "Could not stop recording");
  }

  function exportPLY(): void {
    const exportCloud = roomCloud ?? liveCloud;
    if (!exportCloud || exportCloud.count === 0) return;
    const bytes = buildBinaryPLY(exportCloud);
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);
    const blob = new Blob([payload], { type: "application/octet-stream" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${session?.sessionID ?? "depth-frame"}.ply`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand-mark" aria-hidden="true">◌</div>
        <div className="brand-copy">
          <p className="eyebrow">Depth Relay</p>
          <h1>Raw-ish depth<br />at a glance.</h1>
        </div>
        <section className="rail-section">
          <div className="section-label"><span>Devices</span><span className="count-badge">{devices.length}</span></div>
          <div className="device-list">
            {devices.length === 0 && <p className="muted">No device has sent hello yet.</p>}
            {devices.map((device) => (
              <button className={`device-row ${device.deviceID === selectedDeviceID ? "selected" : ""}`} key={device.deviceID} onClick={() => selectDevice(device.deviceID)}>
                <span className={`status-dot ${device.connected ? "online" : "offline"}`} aria-hidden="true" />
                <span className="device-row-copy"><strong>{device.name}</strong><small>{device.deviceID}</small></span>
                <span className="device-chevron" aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        </section>
        <section className="rail-footer">
          <span className={`status-dot ${connection === "Hub connected" ? "online" : "offline"}`} />
          <span>{connection}</span>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><span className="live-kicker"><span className="pulse-dot" /> Live workspace</span><span className="topbar-separator">/</span><span>{selectedDevice?.name ?? "No selected device"}</span></div>
          <div className="topbar-actions"><span className="timestamp">{frame ? `${frame.metadata.deviceTimestamp.toFixed(3)} s device time` : "No frame"}</span><button className="quiet-button" onClick={clearRoomMap}>Clear map</button></div>
        </header>

        <div className="work-grid">
          <section className="viewport-panel panel">
            <div className="panel-heading"><div><p className="eyebrow">Point cloud</p><h2>{displayedCloud ? `${displayedCloud.count.toLocaleString()} ${roomMapActive ? "map" : "POV"} points` : "Waiting for depth"}</h2></div><span className={`mode-chip ${roomMapActive ? "world" : "camera"}`}>{roomMapActive ? "Room map + live POV" : liveCloud?.poseApplied ? "Live sensor POV" : "Camera space"}</span></div>
            <PointCloudViewport roomCloud={roomCloud} liveCloud={liveCloud} poseMatrix={livePoseMatrix} />
            <div className="viewport-footer"><span>Drag orbit · wheel zoom · WASD move</span><span>{roomMapActive ? "Persistent voxel map · live points highlighted" : liveCloud?.poseApplied ? "World-aligned live frame" : "Live frame only"}</span></div>
          </section>

          <section className="depth-panel panel">
            <div className="panel-heading"><div><p className="eyebrow">Live capture</p><h2>{recording ? "Recording scan" : "Camera reference"}</h2></div><span className={`mode-chip ${recording ? "world" : ""}`}>{recording ? "REC" : "Preview"}</span></div>
            <div className="capture-stack">
              <div className="capture-view">
                <div className="capture-view-heading"><span>RGB reference</span><span>{frame ? "live" : "waiting"}</span></div>
                <LiveRGBPreview frame={frame} />
              </div>
              <div className="capture-view depth-view">
                <div className="capture-view-heading"><span>Float32 depth</span><span>{adaptiveDepth ? "adaptive range" : "0.2 — 5.0 m"}</span></div>
                <DepthHeatmap frame={frame} adaptive={adaptiveDepth} />
              </div>
            </div>
            <div className="depth-legend"><span><i className="legend-swatch near" /> Near</span><span><i className="legend-swatch far" /> Far</span><span><i className="legend-swatch invalid" /> Invalid</span></div>
            <div className="depth-readout"><span>Confidence filter</span><input aria-label="Minimum confidence" type="range" min="0" max="3" step="1" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /><output>{threshold}</output><label className="display-toggle"><input type="checkbox" checked={adaptiveDepth} onChange={(event) => setAdaptiveDepth(event.target.checked)} /> Adaptive</label></div>
          </section>
        </div>

        <footer className="bottom-strip">
          <div className="strip-message"><span className="strip-icon">↳</span><span>{notice}</span></div>
          <div className="strip-actions"><button className="secondary-button" onClick={exportPLY} disabled={!displayedCloud?.count}>Export PLY</button><button className="primary-button" onClick={recording ? stopRecording : startRecording} disabled={!recording && !canRecord}>{recording ? "Stop recording" : "Start recording"}</button></div>
        </footer>
      </section>

      <aside className="inspector">
        <div className="inspector-heading"><p className="eyebrow">Inspector</p><span className="live-badge">{recording ? "REC" : "IDLE"}</span></div>
        <section className="inspector-section"><div className="section-label"><span>Pairing token</span><button className="copy-button" onClick={() => navigator.clipboard?.writeText(token)}>Copy</button></div><code className="token-value">{token || "Waiting for hub"}</code><p className="help-text">Enter this token in each native capture app on the same Wi-Fi network.</p></section>
        <section className="inspector-section"><div className="section-label"><span>Sensor</span><span className="tiny-status">{selectedDevice?.connected ? "connected" : "offline"}</span></div>{selectedDevice ? <><h3>{selectedDevice.name}</h3><p className="mono-text">{selectedDevice.deviceID}</p><details className="capabilities"><summary>Capabilities ({selectedDevice.capabilities.length})</summary><pre>{JSON.stringify(selectedDevice.capabilities, null, 2)}</pre></details></> : <p className="muted">Connect a device to see its runtime formats.</p>}</section>
        <section className="inspector-section metrics"><div className="section-label"><span>Session</span><span className="tiny-status">{recording ? "writing" : "ready"}</span></div><Metric label="Frames received" value={String(session?.framesReceived ?? 0)} /><Metric label="Frames stored" value={String(session?.framesStored ?? 0)} /><Metric label="Map points" value={String(roomCloud?.count ?? 0)} /><Metric label="Dropped frames" value={String(selectedDevice?.droppedFrames ?? 0)} /><Metric label="Pose" value={frame?.metadata.poseSpace ?? "—"} /></section>
        <section className="inspector-section"><div className="section-label"><span>Activity log</span><span className="tiny-status">{activity.length}</span></div><div className="activity-log" role="log" aria-live="polite">{activity.length === 0 ? <p className="muted">No device activity yet.</p> : activity.slice().reverse().map((entry) => <div className="activity-entry" key={entry.id}><time>{formatActivityTime(entry.at)}</time><div><strong>{entry.deviceName ?? entry.deviceID ?? "Hub"}</strong><span>{entry.message ?? entry.status}</span></div></div>)}</div></section>
        <section className="inspector-note"><span className="note-mark">i</span><p>ARKit frames fuse into the room map. The bright live layer and frustum show the current sensor POV. AVFoundation stays camera-space only.</p></section>
      </aside>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function PointCloudViewport({ roomCloud, liveCloud, poseMatrix }: { roomCloud: PointCloud | null; liveCloud: PointCloud | null; poseMatrix: number[] | null }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const roomPointsRef = useRef<THREE.Points | null>(null);
  const livePointsRef = useRef<THREE.Points | null>(null);
  const sensorRigRef = useRef<THREE.Group | null>(null);
  const invalidateRef = useRef<() => void>(() => undefined);
  const viewRef = useRef({ yaw: 0.4, pitch: 0.2, distance: 4.2, target: new THREE.Vector3() });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const keys = useRef(new Set<string>());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 50);
    const sensorRig = new THREE.Group();
    sensorRig.matrixAutoUpdate = false;
    sensorRig.visible = false;
    sensorRig.add(new THREE.AxesHelper(0.22));
    const near = 0.12;
    const far = 0.7;
    const aspect = 4 / 3;
    const fov = 54 * Math.PI / 180;
    const nearHeight = 2 * Math.tan(fov / 2) * near;
    const nearWidth = nearHeight * aspect;
    const farHeight = 2 * Math.tan(fov / 2) * far;
    const farWidth = farHeight * aspect;
    const corners = [
      new THREE.Vector3(-nearWidth / 2, nearHeight / 2, -near),
      new THREE.Vector3(nearWidth / 2, nearHeight / 2, -near),
      new THREE.Vector3(nearWidth / 2, -nearHeight / 2, -near),
      new THREE.Vector3(-nearWidth / 2, -nearHeight / 2, -near),
      new THREE.Vector3(-farWidth / 2, farHeight / 2, -far),
      new THREE.Vector3(farWidth / 2, farHeight / 2, -far),
      new THREE.Vector3(farWidth / 2, -farHeight / 2, -far),
      new THREE.Vector3(-farWidth / 2, -farHeight / 2, -far),
    ];
    const edges: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const frustumPoints = edges.flatMap(([start, end]) => [corners[start], corners[end]]);
    const frustum = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(frustumPoints),
      new THREE.LineBasicMaterial({ color: 0xffb25c, transparent: true, opacity: 0.85 }),
    );
    const pointTexture = createPointTexture();
    const roomPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: pointTexture, size: 0.014, alphaTest: 0.35, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.42, depthWrite: false }));
    const livePoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: pointTexture, size: 0.024, alphaTest: 0.35, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.98, depthWrite: false }));
    roomPoints.frustumCulled = false;
    livePoints.frustumCulled = false;
    sensorRig.add(frustum);
    scene.add(roomPoints, livePoints, sensorRig);
    roomPointsRef.current = roomPoints;
    livePointsRef.current = livePoints;
    sensorRigRef.current = sensorRig;

    const updateCamera = () => {
      const view = viewRef.current;
      const offset = new THREE.Vector3(0, 0, view.distance).applyEuler(new THREE.Euler(view.pitch, view.yaw, 0, "YXZ"));
      camera.position.copy(view.target).add(offset);
      camera.lookAt(view.target);
    };
    const render = () => {
      invalidateRef.current = () => {
        if (renderFrame === 0) renderFrame = requestAnimationFrame(render);
      };
      renderFrame = 0;
      updateCamera();
      renderer.render(scene, camera);
    };
    let renderFrame = 0;
    invalidateRef.current = () => {
      if (renderFrame === 0) renderFrame = requestAnimationFrame(render);
    };
    const resize = () => {
      const width = canvas.clientWidth;
      const height = Math.max(canvas.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      invalidateRef.current();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const move = () => {
      if (keys.current.size === 0) {
        movementFrame = 0;
        return;
      }
      const view = viewRef.current;
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() > 0) forward.normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      right.y = 0;
      if (right.lengthSq() > 0) right.normalize();
      const delta = new THREE.Vector3();
      if (keys.current.has("w")) delta.addScaledVector(forward, 0.07);
      if (keys.current.has("s")) delta.addScaledVector(forward, -0.07);
      if (keys.current.has("d")) delta.addScaledVector(right, 0.07);
      if (keys.current.has("a")) delta.addScaledVector(right, -0.07);
      if (keys.current.has("e")) delta.y += 0.07;
      if (keys.current.has("q")) delta.y -= 0.07;
      view.target.add(delta);
      invalidateRef.current();
      movementFrame = requestAnimationFrame(move);
    };
    let movementFrame = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!["w", "a", "s", "d", "q", "e"].includes(key)) return;
      event.preventDefault();
      keys.current.add(key);
      if (movementFrame === 0) movementFrame = requestAnimationFrame(move);
    };
    const onKeyUp = (event: KeyboardEvent) => keys.current.delete(event.key.toLowerCase());
    canvas.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      cancelAnimationFrame(renderFrame);
      cancelAnimationFrame(movementFrame);
      observer.disconnect();
      canvas.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      invalidateRef.current = () => undefined;
      roomPoints.geometry.dispose();
      livePoints.geometry.dispose();
      if (roomPoints.material instanceof THREE.Material) roomPoints.material.dispose();
      if (livePoints.material instanceof THREE.Material) livePoints.material.dispose();
      pointTexture.dispose();
      frustum.geometry.dispose();
      if (frustum.material instanceof THREE.Material) frustum.material.dispose();
      renderer.dispose();
      roomPointsRef.current = null;
      livePointsRef.current = null;
      sensorRigRef.current = null;
    };
  }, []);

  useEffect(() => {
    updatePointLayer(roomPointsRef.current, roomCloud);
    invalidateRef.current();
  }, [roomCloud]);

  useEffect(() => {
    updatePointLayer(livePointsRef.current, liveCloud);
    const sensorRig = sensorRigRef.current;
    if (sensorRig && poseMatrix?.length === 16 && liveCloud?.poseApplied) {
      sensorRig.matrix.fromArray(poseMatrix);
      sensorRig.matrixWorldNeedsUpdate = true;
      sensorRig.visible = true;
    } else if (sensorRig) {
      sensorRig.visible = false;
    }
    invalidateRef.current();
  }, [liveCloud, poseMatrix]);

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    drag.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!drag.current) return;
    const view = viewRef.current;
    view.yaw += (event.clientX - drag.current.x) * 0.01;
    view.pitch = Math.max(-1.4, Math.min(1.4, view.pitch + (event.clientY - drag.current.y) * 0.01));
    drag.current = { x: event.clientX, y: event.clientY };
    invalidateRef.current();
  }

  function onWheel(event: React.WheelEvent<HTMLCanvasElement>): void {
    event.preventDefault();
    viewRef.current.distance = Math.max(0.35, Math.min(30, viewRef.current.distance * Math.exp(event.deltaY * 0.001)));
    invalidateRef.current();
  }

  return <div className="point-cloud-stage"><canvas ref={canvasRef} tabIndex={0} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} onWheel={onWheel} aria-label="Live 3D room map and sensor POV" /><div className="axis-glyph" aria-hidden="true"><span className="axis-x">X</span><span className="axis-y">Y</span><span className="axis-z">Z</span></div>{liveCloud && <div className="sensor-pov-label">LIVE SENSOR POV</div>}{!roomCloud && !liveCloud && <div className="empty-stage">Connect a sensor to see points.</div>}</div>;
}

function createPointTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "white";
    context.beginPath();
    context.arc(16, 16, 14, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function updatePointLayer(points: THREE.Points | null, cloud: PointCloud | null): void {
  if (!points) return;
  if (!cloud) {
    points.visible = false;
    points.geometry.setDrawRange(0, 0);
    return;
  }
  const updateAttribute = (name: string, values: Float32Array | Uint8Array, itemSize: number, normalized = false) => {
    const current = points.geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!current || current.array.length < values.length || current.array.constructor !== values.constructor) {
      points.geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize, normalized));
      return;
    }
    (current.array as Float32Array | Uint8Array).set(values);
    current.needsUpdate = true;
  };
  updateAttribute("position", cloud.positions, 3);
  updateAttribute("color", cloud.colors, 3, true);
  points.geometry.setDrawRange(0, cloud.count);
  points.visible = true;
}

function LiveRGBPreview({ frame }: { frame: DepthFrame | null }): ReactElement {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!frame || frame.rgb.byteLength === 0) {
      setSrc(null);
      return;
    }
    const bytes = new Uint8Array(frame.rgb.byteLength);
    bytes.set(frame.rgb);
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: "image/jpeg" }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [frame]);

  return <div className="rgb-preview">{src ? <img src={src} alt="Live RGB camera reference" /> : <div className="empty-stage">No RGB frame.</div>}</div>;
}

function DepthHeatmap({ frame, adaptive }: { frame: DepthFrame | null; adaptive: boolean }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    canvas.width = frame.metadata.depthWidth;
    canvas.height = frame.metadata.depthHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    const range = depthDisplayRange(frame.depth, adaptive);
    const image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = y * frame.metadata.depthStride + x;
        const distance = frame.depth[index];
        const pixel = (y * canvas.width + x) * 4;
        if (!Number.isFinite(distance) || distance <= 0) {
          image.data[pixel + 3] = 255;
          continue;
        }
        const value = Math.max(0, Math.min(1, 1 - (distance - range.near) / (range.far - range.near)));
        image.data[pixel] = Math.round(255 * value);
        image.data[pixel + 1] = Math.round(120 * value + 24);
        image.data[pixel + 2] = Math.round(255 * (1 - value));
        image.data[pixel + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [adaptive, frame]);
  return <div className="heatmap-frame">{frame ? <canvas ref={canvasRef} aria-label="Live depth heatmap" /> : <div className="empty-stage">No depth frame.</div>}</div>;
}

function depthDisplayRange(values: Float32Array, adaptive: boolean): { near: number; far: number } {
  if (!adaptive) return { near: 0.2, far: 5 };
  let near = Number.POSITIVE_INFINITY;
  let far = 0;
  for (const distance of values) {
    if (!Number.isFinite(distance) || distance <= 0) continue;
    near = Math.min(near, distance);
    far = Math.max(far, distance);
  }
  if (!Number.isFinite(near)) return { near: 0.2, far: 5 };
  const padding = Math.max((far - near) * 0.08, 0.025);
  return { near: Math.max(0.05, near - padding), far: far + padding };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUIMessage(value: unknown): value is UIMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "devices") return Array.isArray(value.devices);
  if (value.type === "session") return isRecord(value.session);
  if (value.type === "activity") return (value.entries === undefined || Array.isArray(value.entries)) && (value.entry === undefined || isRecord(value.entry));
  if (value.type === "device-event") return typeof value.deviceID === "string" && typeof value.status === "string" && (value.message === undefined || typeof value.message === "string") && typeof value.droppedFrames === "number";
  return value.type === "error" && typeof value.message === "string";
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "--:--:--" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function preferredDeviceID(devices: DeviceSummary[], selectedID: string): string {
  const selected = devices.find((device) => device.deviceID === selectedID);
  if (selected?.connected && selected.capabilities.length > 0) return selected.deviceID;
  return devices.find((device) => device.connected && device.capabilities.length > 0)?.deviceID
    ?? devices.find((device) => device.connected)?.deviceID
    ?? devices[0]?.deviceID
    ?? "";
}
