import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commissionValueMatches,
  redactSecrets,
  validateCommissionDevice,
  writeCommissionReport,
  type CommissionReport,
} from "./commission.js";
import type {DeviceInfo} from "./types.js";

function validDevice(): DeviceInfo {
  return {
    ieeeAddress: "0x00124b0000000001",
    networkAddress: 1,
    type: "EndDevice",
    interviewState: "SUCCESSFUL",
    manufacturerName: "sengled",
    modelID: "E11-N1EA",
    definition: {vendor: "Sengled", model: "E11-N1EA", description: "Element plus color (A19)", generated: false},
    exposes: ["state", "brightness", "color_temp", "color", "x", "y", "power", "energy"].map((property) => ({
      property,
      type: "numeric",
      access: 7,
    })),
  };
}

test("commission device validation rejects generated and incomplete definitions", () => {
  assert.deepEqual(validateCommissionDevice(validDevice()), []);
  const invalid = validDevice();
  invalid.definition = {...invalid.definition!, generated: true};
  invalid.exposes = invalid.exposes.filter((item) => item.property !== "color");
  assert.deepEqual(validateCommissionDevice(invalid), ["definition must not be generated", "missing capabilities: color"]);
});

test("commission comparisons allow Zigbee numeric quantization", () => {
  assert.equal(commissionValueMatches(199, 200, 2), true);
  assert.equal(commissionValueMatches(196, 200, 2), false);
  assert.equal(commissionValueMatches({x: 0.699, y: 0.301}, {x: 0.7006, y: 0.2993}, 0.02), true);
});

test("commission reports redact network secrets", async () => {
  const redacted = redactSecrets({networkKey: [1, 2], nested: {install_code: "secret", safe: 42}});
  assert.deepEqual(redacted, {networkKey: "[REDACTED]", nested: {install_code: "[REDACTED]", safe: 42}});

  const root = await mkdtemp(path.join(os.tmpdir(), "local-zigbee-report-"));
  try {
    const report: CommissionReport = {
      schemaVersion: 1,
      startedAt: "2026-07-25T12:00:00.000Z",
      finishedAt: "2026-07-25T12:01:00.000Z",
      status: "passed",
      steps: [{name: "safe", status: "passed", timestamp: "2026-07-25T12:00:01.000Z", details: {network_key: [1, 2]}}],
    };
    const destination = await writeCommissionReport(root, report);
    const contents = await readFile(destination, "utf8");
    assert.doesNotMatch(contents, /\[\s*1,\s*2\s*\]/);
    assert.match(contents, /\[REDACTED\]/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
