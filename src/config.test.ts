import assert from "node:assert/strict";
import test from "node:test";
import {validateNetwork} from "./config.js";

test("validateNetwork accepts a valid persisted coordinator identity", () => {
  const network = {panID: 1234, extendedPanID: Array(8).fill(1), networkKey: Array(16).fill(2), channelList: [20]};
  assert.deepEqual(validateNetwork(network), network);
});

test("validateNetwork rejects invalid key and channel lengths", () => {
  assert.throws(() => validateNetwork({panID: 1, extendedPanID: [], networkKey: [], channelList: [20]}), /extendedPanID/);
  assert.throws(
    () => validateNetwork({panID: 1, extendedPanID: Array(8).fill(1), networkKey: Array(16).fill(2), channelList: [27]}),
    /channel/,
  );
});
