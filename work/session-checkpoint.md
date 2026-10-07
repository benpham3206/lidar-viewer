# Engineering checkpoint and generalized postmortem

Review scope: the full implementation session, generalized so it does not
depend on project names, device models, paths, identifiers, or credentials.

## Checkpoint status

| Area | Status | Evidence |
| --- | --- | --- |
| Native app compilation | Verified | Swift parsing and the signed device build passed after the latest orientation changes. |
| Web client build and tests | Verified | Existing web tests and the production build passed. |
| Code signing | Verified | The app passed code-signing verification. |
| Device installation and launch | Verified at process level | Installation and launch commands succeeded on both target devices. |
| Local hub health | Verified on the host | The local health endpoint returned a healthy response. |
| Remote pairing reliability | Not verified | The device connection alternated between working, timing out, and being cancelled. |
| Rear/front orientation behavior | Partially verified | User observations confirmed several fixes, but later changes caused regressions on another device or provider. |
| Scene-depth orientation after the final patch | Not verified | No live sensor frame was captured after the final device-specific change. |
| Front-camera mirroring | Not verified on live hardware | The code path was added, but no final physical-frame confirmation was recorded. |
| Point-cloud accumulation/export | Not the checkpoint focus | The capture and orientation path was not stable enough for reliable end-to-end validation. |

The key checkpoint rule is: a successful build, installation, and process launch
do not prove that a live sensor frame has the correct orientation.

## What worked

- The work reached a real vertical slice: native capture, live visualization,
  local networking, logging, signing, and deployment.
- The local hub was testable independently from the native app. This separated
  host health from device connectivity.
- Device logs exposed useful facts about first-frame dimensions, rotation
  angles, and whether RGB and depth connections supported the same transform.
- Debugging improved when RGB, depth, confidence, and intrinsics were treated
  as related data instead of changing only the visible image.
- A known-good device/provider combination became a reference for detecting
  regressions.
- A bounded subagent review reduced context pressure and produced a separate
  analysis of the remaining issue.
- The implementation moved toward provider-level normalization instead of
  scattering orientation fixes through the UI.

## What did not work

- Connection feedback was initially too weak. A failed request could appear as
  a timeout, cancellation, or no visible state change.
- The local network path was not stable. The host could reach its own health
  endpoint while the mobile device could not reliably reach the host.
- Orientation fixes were not stable across every combination of device, lens,
  provider, and buffer type.
- RGB rotation sometimes succeeded while depth rotation was unsupported. This
  created mismatched RGB/depth frames.
- Front-camera mirroring was handled later than rotation and was not proven with
  a final live frame.
- A global orientation assumption fixed one path and regressed another.
- The scene-depth path was changed after the rear-camera path was already
  considered correct, causing a device-specific regression.
- A start-time crash was reported early. Later build and launch checks passed,
  but the session did not contain a conclusive crash diagnosis or a regression
  test for it.
- The final hardware result was inferred from code and deployment status
  instead of confirmed with a captured frame and log.

## Avoidable mistakes and root causes

1. **No explicit orientation contract.**

   The implementation did not define, in one place, the orientation required
   for every emitted raster. It also did not define whether a reported angle
   referred to the sensor buffer, display, connection transform, or software
   row-major transform.

   Root cause: several coordinate systems were treated as interchangeable.

2. **RGB and depth were assumed to support identical transforms.**

   The RGB connection accepted a rotation that the depth connection did not.
   Applying the same operation to both streams produced different results.

   Root cause: capability checks were added after the first implementation
   instead of being part of the provider contract.

3. **Clockwise and counter-clockwise conventions were mixed.**

   Hardware connection rotation and software raster rotation used different
   conventions. A fallback initially corrected the depth buffer in the wrong
   direction.

   Root cause: there was no tiny reference raster or unit test that made the
   transform direction unambiguous.

4. **Transforms were changed without a full metadata audit.**

   Rotating depth also requires matching changes to confidence-map dimensions,
   RGB dimensions, principal point, focal-length interpretation, and sometimes
   the camera-coordinate basis. Mirroring requires changing the principal
   point as well.

   Root cause: the visible image was treated as the primary output while
   geometric metadata was treated as secondary.

5. **A single device matrix was used too broadly.**

   Empirical per-device behavior was useful, but the matrix was first applied as
   if it described every provider and every stream on that device.

   Root cause: device, lens position, provider, and connection capability were
   not modeled as separate axes.

6. **Validation stopped at build and launch.**

   Build and install success were reported as progress toward a hardware fix.
   They are necessary gates, but they do not validate sensor orientation.

   Root cause: the acceptance sequence did not require starting capture,
   receiving one frame, inspecting dimensions and orientation, and saving
   evidence.

7. **Network diagnosis started too late.**

   The same Wi-Fi name was treated as strong evidence of reachability. It is
   not. VPN profiles, client isolation, local-network permissions, firewall
   rules, host binding, and different subnets can all break the path.

   Root cause: there was no device-to-host route preflight.

8. **Features were added before the capture contract was stable.**

   Higher-resolution visualization, full-screen viewing, mirroring, and
   reconstruction enhancements were mixed into the same period as connection
   and orientation debugging.

   Root cause: the work lacked a frozen baseline milestone for one correctly
   oriented live frame.

## General lessons

- Normalize sensor output at the provider boundary. The UI should consume one
  documented orientation and mirror convention.
- Treat every frame as one tuple:

  RGB + depth + confidence + intrinsics + pose + timestamp

  A transform is incomplete if it changes only one member of the tuple.
- Keep a capability matrix for:

  device x lens position x provider x stream x hardware transform support

- Use a small synthetic raster with an arrow, labels, and known dimensions to
  test every rotation and mirror operation. A 3x2 matrix is enough to catch
  most direction mistakes.
- Keep separate concepts for sensor-native buffer orientation,
  emitted-dataset orientation, screen/display orientation, and
  camera-coordinate orientation.
- Prefer a hardware transform when supported. Use a tested software fallback
  when it is not. Do not assume both paths use the same sign convention.
- When mirroring, mirror RGB and depth consistently and update the principal
  point in the intrinsics. Confidence maps must use the same raster transform.
- Preserve the known-good path as a locked reference. Test every new transform
  against it before applying it to other combinations.
- Use separate acceptance gates:
  1. build,
  2. sign,
  3. install,
  4. launch,
  5. start sensor,
  6. receive frame,
  7. confirm dimensions and orientation,
  8. confirm geometry.
- Use explicit connection states such as checking, connecting, connected,
  timed out, cancelled, and failed, with a request identifier and last error.
- For local networking, verify the actual device-to-host route. Check host
  binding, IP address, subnet, firewall, VPN state, local-network permission,
  and token expiry.
- Keep an evidence ledger with three labels: observed, inferred, and unknown.
- Parallel agents are useful for bounded reviews, but they need clear
  ownership. Only one agent should mutate a given orientation path at a time,
  and the main agent should inspect the resulting diff before building.
- Keep diagnostic output small and deliberate. Remove large reports after the
  development checkpoint while retaining compact logs that explain the failure.

## Recommended next process

1. Freeze the current code as a checkpoint.
2. Write the orientation contract before making another transform change.
3. Add one synthetic raster test for rotation and mirroring.
4. Capture one live frame per device/provider combination.
5. Record frame dimensions, transform capability, mirror state, intrinsics, and
   timestamp.
6. Only then continue with point-cloud or reconstruction work.

## Checkpoint verdict

The current state is **buildable and deployable, with several fixes observed
during testing**. It is not yet **fully hardware-verified**.
