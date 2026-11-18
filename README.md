# Zigbee Host

`zigbee-host` is an independent local Zigbee coordinator service. It owns the
USB adapter, network credentials, herdsman database, device definitions, state,
command lifecycle, reconnection, and backups. Slidebolt connects through the
versioned bearer-authenticated HTTP/SSE API.

The complete network lives under `/data`; back up or move that directory with
the physical coordinator to preserve the network.

```sh
docker build -t slidebolt-zigbee-host .
export ZIGBEE_HOST_TOKEN="$(openssl rand -hex 32)"
docker run --rm \
  --device=/dev/serial/by-id/your-zigbee-adapter:/dev/zigbee \
  -e ZIGBEE_HOST_TOKEN="$ZIGBEE_HOST_TOKEN" \
  -p 127.0.0.1:47831:47831 \
  -v ./zigbee-data:/data \
  slidebolt-zigbee-host
```

Pairing is never opened automatically. Call `POST /v1/pairing/start` only when
a device is ready to join, or use the coordinator entities in Slidebolt.

## Radio dispatch

Command submission is asynchronous: the API returns `202` after validating and
persisting the intent, without waiting for a physical Zigbee transmission. The
host owns radio scheduling with these rules:

- different devices may transmit concurrently;
- one device never has overlapping physical operations;
- commands run before reconciliation reads, which run before background polls;
- a newer unsent value for the same device, property, and endpoint supersedes
  the older queued value;
- a slow or unreachable device does not occupy every radio slot.

The defaults are four total operations and one background operation. Configure
startup with `ZIGBEE_MAX_IN_FLIGHT` (1–16) and
`ZIGBEE_MAX_BACKGROUND_IN_FLIGHT` (0–the total). Inspect or tune a running host
through authenticated `GET /v1/dispatcher` and `PATCH /v1/dispatcher`; the
effective dispatcher status is also included in `GET /v1/health`.

## Network observations

Each device in the snapshot carries provider-neutral reachability and an
optional `network` observation. The observation retains the current and prior
network address, packet LQI (0–255), inbound and outbound timestamps, the last
failure, and parent/depth evidence from neighbor-table scans. Incoming packets
are recorded before converter selection, so even an unsupported OTA frame is
valid evidence that the device can still transmit.

Reachability distinguishes `reachable`, `degraded`, `unreachable`, and
`unknown`. A device that continues sending after an outbound delivery failure
is degraded rather than falsely reported as absent. Observations are persisted
in `/data/network-observations.json`; that file contains no network key or host
token.

The authenticated `POST /v1/network/refresh` operation asks the host to refresh
neighbor-table evidence. It is an internal plugin-host operation; Slidebolt
clients use the generic coordinator button entity instead.
