# Apple Depth Sensor Web Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect an iPad Pro and iPhone 17 Pro to one local web hub so both devices expose their available depth sensors, stream synchronized RGB/depth/metadata, and produce a live point cloud plus a local dataset.

**Architecture:** A universal SwiftUI app owns AVFoundation and ARKit capture. It connects outbound over the local network to one Node WebSocket server. The browser controls the devices, previews depth, renders the point cloud, starts/stops recording, and exports PLY. The browser is not the sensor driver.

**Tech Stack:** SwiftUI, AVFoundation, ARKit, CoreMotion, `URLSessionWebSocketTask`; Node.js, TypeScript, `ws`, React, Vite, Three.js, Vitest, XCTest.

**Spec:** This file. The project is empty, so the scope, protocol, and plan live together until the first implementation review.

## Implementation status

The local hub, browser tool, shared protocol, synthetic smoke path, and Swift
capture source are implemented. Xcode 27 beta now compiles and signs the app
for iOS. The connected iPad app is installed; its first launch is waiting for
the developer profile to be trusted on the device. The connected iPhone and
iPad are paired, booted, unlocked, and have Developer Mode enabled. Physical
LiDAR and TrueDepth checks remain open.

## Recommendation and scope

Use local Wi-Fi/LAN first:

```text
iPad Pro ─┐                         ┌─ browser: control, preview, cloud, export
          ├─ ws://host:4317 ────────┤
iPhone ──┘                         └─ disk: session manifest + frame packets
```

The native app is mandatory. Apple exposes per-pixel depth through AVFoundation and ARKit, not through the normal browser camera stream. `AVCaptureDepthDataOutput` also requires choosing from the device’s `supportedDepthDataFormats`; the exact iPhone 17 Pro and iPad Pro formats must be discovered at runtime.

Use two providers behind one frame contract:

1. **ARKit tracking:** rear LiDAR, RGB, `sceneDepth`, confidence, intrinsics, timestamp, and `ARCamera.transform`. This is the world-space accumulation path.
2. **AVFoundation depth:** rear LiDAR or front TrueDepth, every supported depth format, synchronized RGB/depth, calibration, timestamp, and optional IMU. This is the raw-ish inspection path and is camera-space only in v1.

Only one provider runs at a time. This avoids trying to drive one camera through `ARSession` and `AVCaptureSession` simultaneously.

V1 does not include RoomPlan, cloud accounts, USB transport, automatic Bonjour discovery, cross-device SLAM registration, OBJ/USDZ conversion, or private photon/SPAD samples. V1 exports a `DepthSession` folder and a binary PLY cloud.

## Global constraints

- Run capture tests on physical devices. The simulator is for model and protocol tests only.
- Enumerate formats; never assume 256×192, 640×480, or 768×576.
- Prefer Float32. If only Float16 is available, convert the outgoing depth payload to little-endian Float32 and retain the original format in metadata.
- Use `AVCaptureDataOutputSynchronizer` for AVFoundation RGB/depth pairing and ARKit timestamps for tracking mode.
- Default to 5 FPS and depth stride 2 for preview. Recording can request stride 1.
- Require a pairing token and `NSLocalNetworkUsageDescription`. Keep camera/depth bytes on the local network.
- Bound the send queue to one in-flight frame plus one pending frame. Drop late frames and report the count.
- Retain device timestamps and host receive timestamps. Do not claim that two devices share a clock.
- Keep axis conversion in one tested point-projection helper.
- Every native/web control needs a visible label and text status. Color is not the only error or confidence signal.

## Task 1: Define the small cross-platform protocol

**Files:**
- Create: `docs/frame-protocol.md`
- Create: `src/protocol.ts`
- Create: `src/protocol.test.ts`

**Interfaces:**
- `hello` text message: device identity and all enumerated capabilities.
- `command` text message: `start`, `stop`, `ping`.
- `event` text message: status, error, and drop counts.
- `frame` binary message: one complete synchronized frame.

- [x] **Step 1: Write the protocol document.**

  Use a 24-byte little-endian header followed by UTF-8 metadata JSON, JPEG RGB bytes, Float32 depth bytes, and optional UInt8 confidence bytes:

  ```text
  bytes 0..3    magic "DSF1"
  bytes 4..5    version: u16
  bytes 6..7    flags: u16
  bytes 8..11   metadata length: u32
  bytes 12..15  RGB length: u32
  bytes 16..19  depth length: u32
  bytes 20..23  confidence length: u32
  ```

  Metadata must contain `frameID`, `deviceTimestamp`, `sourceWidth`, `sourceHeight`, `depthWidth`, `depthHeight`, `depthStride`, `depthFormat`, `intrinsics`, `poseMatrix` or `null`, `poseSpace`, `orientation`, and optional IMU values.

- [x] **Step 2: Write tests for one synthetic 2×2 frame.**

  Test a valid round trip and reject bad magic, truncation, impossible lengths, and a non-Float32 depth length.

- [x] **Step 3: Implement one TypeScript encoder/decoder used by the hub and web UI.**

  Expose `decodeFrame(packet)`, `encodeFrame(frame)`, and the `FrameMetadata` type. The Swift encoder mirrors this documented wire format; it does not create a second protocol.

- [x] **Step 4: Run the protocol test.**

  Run: `npm test -- src/protocol.test.ts`.

  Expected: valid packets round-trip and malformed packets fail before any disk write.

## Task 2: Build the native capture app

**Files:**
- Create: `ios/DepthBridge/DepthBridge.xcodeproj`
- Create: `ios/DepthBridge/DepthBridgeApp.swift`
- Create: `ios/DepthBridge/Info.plist`
- Create: `ios/DepthBridge/CaptureModels.swift`
- Create: `ios/DepthBridge/CapabilityScanner.swift`
- Create: `ios/DepthBridge/AVDepthProvider.swift`
- Create: `ios/DepthBridge/ARKitTrackingProvider.swift`
- Create: `ios/DepthBridge/PointProjection.swift`
- Create: `ios/DepthBridge/HubWebSocketClient.swift`
- Create: `ios/DepthBridge/FrameEncoder.swift`
- Create: `ios/DepthBridge/ContentView.swift`
- Test: `ios/DepthBridgeTests/CaptureTests.swift`

**Interfaces:**
- `DepthFormatDescriptor`
- `CaptureFrame`
- `CaptureProvider.start(configuration:) async throws -> AsyncStream<CaptureFrame>`
- `CapabilityScanner.scan() -> [SensorCapability]`
- `FrameEncoder.encode(_:) -> Data`

- [x] **Step 1: Create the universal SwiftUI target and privacy strings.**

  Add camera, local-network, and motion usage descriptions. Add only the narrow local-network ATS setting needed for development `ws://host:4317`; do not add arbitrary-loads or cloud permissions.

- [x] **Step 2: Write XCTest coverage for format choice and point projection.**

  Assert Float32 preference, Float16 fallback, runtime dimensions, scaled intrinsics, invalid-depth rejection, ARKit axis conversion, and one known world translation.

- [x] **Step 3: Enumerate rear LiDAR and front TrueDepth.**

  Discover `.builtInLiDARDepthCamera` at the back and `.builtInTrueDepthCamera` at the front. List every color format with non-empty `supportedDepthDataFormats`, including subtype, dimensions, and frame-rate range. Do not hard-code the device names or resolutions.

- [x] **Step 4: Implement AVFoundation depth mode.**

  Configure `AVCaptureVideoDataOutput`, `AVCaptureDepthDataOutput`, and `AVCaptureDataOutputSynchronizer`. Disable filtering by default, discard late depth data, prefer Float32, convert Float16 to Float32, attach calibration and timestamp, and emit `poseMatrix = null` with `poseSpace = "camera"`.

- [x] **Step 5: Implement ARKit tracking mode.**

  Check `ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)` before enabling it. Emit RGB, Float32 `sceneDepth.depthMap`, optional confidence, `camera.intrinsics`, image resolution, `camera.transform`, timestamp, orientation, and optional IMU. Keep smoothed scene depth as a visible toggle, not the default raw stream.

- [x] **Step 6: Implement one tested projection helper.**

  Apply the requested pinhole formula, scale intrinsics to the depth dimensions, convert to ARKit’s camera basis in one place, and multiply by the world-from-camera matrix only when `poseSpace` is `arkitWorldFromCamera`.

- [x] **Step 7: Add pairing, command handling, and bounded sending.**

  Use `URLSessionWebSocketTask`. Send `hello` after connect, handle `start`/`stop`/`ping`, allow one in-flight plus one pending frame, and increment `droppedFrames` instead of growing memory.

- [x] **Step 8: Add the smallest native control screen.**

  Include hub URL, pairing token, connect state, device/provider/sensor picker, exact format list, start/stop, record toggle, frame rate, and drop/error text. A thumbnail is optional; the web hub is the main visualization.

- [ ] **Step 9: Run model tests, then a physical-device smoke test.** The generic and signed iOS builds pass, and the iPad app is installed. Trust the developer profile on the iPad, then verify camera permission, capability enumeration, hub connection, and one Float32 frame.

  Verify that both devices connect, report their actual capabilities, stream Float32 depth, and recover from one disconnected hub.

## Task 3: Build the LAN hub and local session store

**Files:**
- Create: `package.json`
- Create: `hub/src/server.ts`
- Create: `hub/src/sessionStore.ts`
- Create: `hub/test/server.test.ts`
- Create: `hub/test/session-store.test.ts`

**Interfaces:**
- `GET /api/health`
- `GET /api/pairing`
- `GET /api/devices`
- `POST /api/sessions`
- `POST /api/sessions/:id/stop`
- `GET /api/sessions/:id/manifest.json`
- WebSocket `/ws/device?token=...`
- WebSocket `/ws/ui`

- [x] **Step 1: Create one package with the minimum dependencies and scripts.**

  Use `react`, `vite`, `three`, `ws`, `tsx`, `typescript`, and `vitest`. Scripts are `dev`, `build`, `test`, and `typecheck`. Do not add a database, auth service, or cloud SDK.

- [x] **Step 2: Write server tests with a fake WebSocket device.**

  Cover token rejection, hello registration, start/stop delivery, malformed-frame rejection, one stored packet, and a session that survives a device disconnect.

- [x] **Step 3: Implement the local-only HTTP/WebSocket server.**

  Bind to `0.0.0.0:4317`. Generate a random startup pairing token. Keep the device registry in the server module; do not create a registry abstraction until there is a second implementation.

- [x] **Step 4: Implement bounded session storage.**

  Store original packets at:

  ```text
  data/sessions/<sessionID>/manifest.json
  data/sessions/<sessionID>/devices/<deviceID>/frames/<frameID>.bin
  ```

  Write the manifest at start and stop. Add host receive time and drop counts. If disk writing fails, stop recording and report the error instead of silently losing data.

- [x] **Step 5: Broadcast status and frames to the browser.**

  Forward the latest frame to `/ws/ui`, notify the UI of device status and drops, and send `start`/`stop` commands to the selected native device.

- [ ] **Step 6: Run the server tests and a two-device LAN smoke test.** The fake-device LAN path is green; two physical devices remain open.

  Expected: both devices stay visible, one device can disconnect without corrupting the session, and stored packet counts are explainable from received and dropped counts.

## Task 4: Build the web control surface and point cloud

**Files:**
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/pointCloud.ts`
- Create: `web/src/ply.ts`
- Create: `web/src/pointCloud.worker.ts`
- Create: `web/src/styles.css`
- Test: `web/src/pointCloud.test.ts`
- Test: `web/src/ply.test.ts`

**Interfaces:**
- `HubClient.connect()` and `sendCommand(deviceID, command)`
- `decodeFrame(packet)` from shared `src/protocol.ts`
- `projectFrame(frame, options)`
- `buildBinaryPLY(points)`

- [x] **Step 1: Write tests against a synthetic frame.**

  Cover intrinsics scaled from RGB reference dimensions, invalid/low-confidence samples, pose translation, a 250,000-point cap, and a valid binary PLY header with RGB properties.

- [x] **Step 2: Implement one labeled tool screen.**

  Show devices, exact format list, connection/session controls, depth heatmap, confidence state, point-cloud viewport, timestamp, and drop status. Keep it as one working tool surface, not a dashboard of placeholder cards.

- [x] **Step 3: Implement depth preview and projection.** The first slice keeps projection on the main thread; a worker is a later throughput step.

  Draw Float32 depth to a canvas with a fixed near/far range and invalid-depth color. Transfer typed arrays to the worker, project points, apply pose only for ARKit tracking, and return typed arrays to Three.js.

- [x] **Step 4: Implement accumulation and export.**

  Keep one current cloud and one capped accumulated cloud. Accumulate only world-space ARKit frames. Render AVFoundation frames as camera-space and display that state in text. Export binary little-endian PLY and link the `DepthSession` manifest.

- [x] **Step 5: Run web tests and browser checks.** Synthetic WebSocket frames were rendered in the live browser tab.

  Verify desktop and narrow layouts, keyboard-accessible controls, device selection, start/stop, live depth, confidence filtering, point-cloud rotation, and PLY download.

## Task 5: Prove the physical vertical slice

**Files:**
- Create: `README.md`
- Create: `docs/device-test-log.md`

- [x] **Step 1: Document the operator path.**

  Start the hub, open the browser URL, copy the pairing token, enter it on both devices, grant permissions, select a provider/sensor/format, start recording, stop, and export.

- [ ] **Step 2: Test rear LiDAR on the iPhone 17 Pro and iPad Pro.**

  Record the exact runtime format list, one room scan, frame count, dropped frames, thermal state, and whether the world cloud stays stable while the camera moves.

- [ ] **Step 3: Test front TrueDepth when available.**

  Verify close-range camera-space depth and confirm that the UI explains the front-camera ergonomics.

- [ ] **Step 4: Test recovery.**

  Deny local-network permission, disconnect one device, restart the hub, send a malformed packet, and simulate a disk error. Each case must produce visible recovery text and no silent data loss.

- [ ] **Step 5: Stop at the vertical slice.**

  Add Bonjour, clock-offset estimation, AV lens-distortion rectification, compression, RoomPlan comparison, or OBJ/USDZ only after this path works on both devices.

## Self-review

- The plan still covers detection, runtime format enumeration, Float32 depth, live visualization, synchronized RGB/depth/metadata, pose, IMU, point-cloud accumulation, PLY export, and a custom raw dataset.
- The plan now has one protocol implementation, one server-side registry, one native app target, and one web tool surface. It removes speculative databases, cloud services, automatic discovery, duplicate fixtures, and separate UI component scaffolding.
- Trust-boundary validation, pairing, bounded queues, disk-error handling, permission recovery, and accessibility checks remain.
- AVFoundation raw mode is deliberately camera-space only. ARKit tracking mode is the world-space path.

## Reference documentation

- [AVCaptureDepthDataOutput](https://developer.apple.com/documentation/avfoundation/avcapturedepthdataoutput)
- [Capturing depth using the LiDAR camera](https://developer.apple.com/documentation/AVFoundation/capturing-depth-using-the-lidar-camera)
- [Streaming depth data from the TrueDepth camera](https://developer.apple.com/documentation/avfoundation/streaming-depth-data-from-the-truedepth-camera)
- [ARFrame sceneDepth](https://developer.apple.com/documentation/arkit/arframe/scenedepth)
- [ARDepthData](https://developer.apple.com/documentation/arkit/ardepthdata)
- [Local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
- [URLSessionWebSocketTask](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask)
