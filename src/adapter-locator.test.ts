import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {AdapterLocator, fingerprintMatches} from "./adapter-locator.js";
import type {AdapterIdentity, ProbeResult} from "./types.js";

const identity: AdapterIdentity = {eui64: "0x00124b00000000aa", lastPort: "COM7", serialNumber: "TEST-ADAPTER", vendorId: "10c4", productId: "ea60"};
const probe = (port: string, eui64 = identity.eui64): ProbeResult => ({port, protocolVersion: 13, stackType: 2, stackVersion: 1, firmware: "8.0.2", firmwareMeta: {}, eui64, meetsRecommendedFirmware: true, supportedByHost: true});

test("adapter fingerprint prefers serial number and falls back to VID/PID", () => {
  assert.equal(fingerprintMatches({path: "COM8", serialNumber: "TEST-ADAPTER"}, identity), true);
  assert.equal(fingerprintMatches({path: "COM8", vendorId: "10C4", productId: "EA60"}, {...identity, serialNumber: undefined}), true);
  assert.equal(fingerprintMatches({path: "COM8", vendorId: "1234", productId: "EA60"}, {...identity, serialNumber: undefined}), false);
});

test("locator follows a reassigned matching port and verifies coordinator EUI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-locator-"));
  try {
    const identityFile = path.join(root, "adapter.json");
    const first = new AdapterLocator({preferredPort: "COM7", identityFile, listPorts: async () => [{path: "COM7", serialNumber: "TEST-ADAPTER", vendorId: "10c4", productId: "ea60"}], probe: async (port) => probe(port)});
    assert.equal((await first.locate()).port, "COM7");
    const reassigned = new AdapterLocator({preferredPort: "COM7", identityFile, listPorts: async () => [{path: "COM11", serialNumber: "TEST-ADAPTER", vendorId: "10c4", productId: "ea60"}], probe: async (port) => probe(port)});
    assert.equal((await reassigned.locate()).port, "COM11");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("locator rejects a fingerprint match with the wrong EUI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-locator-wrong-"));
  try {
    const identityFile = path.join(root, "adapter.json");
    const first = new AdapterLocator({preferredPort: "COM7", identityFile, listPorts: async () => [{path: "COM7", serialNumber: "TEST-ADAPTER"}], probe: async (port) => probe(port)});
    await first.locate();
    const wrong = new AdapterLocator({preferredPort: "COM7", identityFile, listPorts: async () => [{path: "COM9", serialNumber: "TEST-ADAPTER"}], probe: async (port) => probe(port, "0x0000000000000001")});
    await assert.rejects(wrong.locate(), /expected 0x00124b00000000aa/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("locator can probe an explicitly mapped device that serial enumeration omits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-locator-direct-"));
  try {
    const attempts: string[] = [];
    const locator = new AdapterLocator({
      preferredPort: "/dev/zigbee",
      probePreferredDirectly: true,
      identityFile: path.join(root, "adapter.json"),
      listPorts: async () => [],
      probe: async (port) => {
        attempts.push(port);
        return probe(port);
      },
    });
    assert.equal((await locator.locate()).port, "/dev/zigbee");
    assert.deepEqual(attempts, ["/dev/zigbee"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("direct probing does not depend on serial enumeration support", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zigbee-locator-no-udev-"));
  try {
    const locator = new AdapterLocator({
      preferredPort: "/dev/zigbee",
      probePreferredDirectly: true,
      identityFile: path.join(root, "adapter.json"),
      listPorts: async () => { throw new Error("spawn udevadm ENOENT"); },
      probe: async (port) => probe(port),
    });
    assert.equal((await locator.locate()).port, "/dev/zigbee");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
