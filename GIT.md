# Git Workflow for zigbee-host

This repository contains the standalone Slidebolt Zigbee coordinator host. It owns the USB adapter, Zigbee network state, device definitions, command execution, recovery, and the HTTP/SSE integration API.

## Build Process

- **Type:** Node.js/TypeScript service and Linux container.
- **Build:** `npm run build`
- **Test:** `npm test`
- **Container:** `docker build -t slidebolt-zigbee-host .`

## Local Data

Zigbee network state, coordinator backups, runtime credentials, logs, and `.env` files must never be committed. Persistent network state belongs in the configured data volume and should be backed up separately.

## Publishing

1. Run `npm ci` and `npm test`.
2. Build and smoke-test the container.
3. Commit and push changes to `main`.
4. Create and push the next semantic version tag (`vX.Y.Z`) when preparing a release.
