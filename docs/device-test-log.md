# Device test log

Record one row for each physical-device run. Keep the runtime format names as
the device reports them. Do not replace them with an assumed resolution.

| Date | Device | Provider | Format | Frames | Stored | Dropped | Result | Notes |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| 2026-09-19 | not run | not run | not run | — | — | — | pending | This workspace has no Xcode build or connected iOS device. |

Required checks:

- rear LiDAR on the iPhone Pro;
- rear LiDAR on the iPad Pro;
- front TrueDepth when available;
- local-network denial and recovery;
- one device disconnect during a recording;
- malformed packet and disk-write error reporting;
- world-cloud stability while the camera moves.
