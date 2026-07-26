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
