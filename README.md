# Depth Relay

Depth Relay connects an iPad Pro or iPhone Pro capture app to one local web
hub. The hub accepts synchronized RGB and Float32 depth packets, shows a live
depth map and point cloud, stores original packets, and exports a binary PLY.

The native app uses AVFoundation for camera-space depth. It can also use ARKit
scene depth for camera pose and world-space accumulation. The app enumerates
the formats on the device. It does not read photon returns, SPAD data, or raw
time-of-flight samples.

## Run the hub

Install Node.js 22 or newer.

```sh
npm install
npm run build
npm run dev
```

Open `http://<Mac-LAN-address>:4317` in a browser on the same network. The
hub prints a pairing token. The browser also shows it in the Inspector.

The hub listens on `0.0.0.0:4317`. It stores sessions below `data/sessions/`.
The store writes the original packet before it counts the frame as stored. A
write error stops the session and reports the error to the browser.
The Inspector keeps the last 200 device and hub events. The same entries are
available as JSON at `/api/log`.

For web hot reload, use two terminals:

```sh
npm run dev:hub
npm run dev:web
```

Open the Vite URL shown in the second terminal.

## Build the iOS capture app

Open `ios/DepthBridge/DepthBridge.xcodeproj` in Xcode 16 or newer. Select a
physical iPad Pro or iPhone Pro. The simulator cannot provide LiDAR or
TrueDepth depth frames.

1. Allow camera and local-network access.
2. Enter the hub URL, for example `ws://192.168.1.10:4317`.
3. Enter the pairing token from the web hub.
4. Select AVFoundation depth or ARKit scene depth.
5. Select the device and the capture depth format.
6. Connect the device, then start capture.
7. Start recording in the browser, move the device, stop recording, and export
   the PLY.

TrueDepth is a front-facing sensor. The capture screen states this when the
front sensor is selected.

## Checks

```sh
npm test
npm run typecheck
npm run build
swiftc -parse ios/DepthBridge/*.swift
```

The last command checks Swift syntax only. A physical-device build and sensor
run need Xcode, signing, and the user's iPad or iPhone.

## Packet and session layout

The shared wire contract is documented in [docs/frame-protocol.md](docs/frame-protocol.md).
Each session uses this layout:

```text
data/sessions/<sessionID>/manifest.json
data/sessions/<sessionID>/devices/<deviceID>/frames/<frameID>.bin
```

The browser accumulates only frames marked `arkitWorldFromCamera`. AVFoundation
frames stay in camera space and are shown as one live cloud.
