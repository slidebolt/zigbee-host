import assert from "node:assert/strict";
import test from "node:test";
import {firmwareAtLeast, parseValue} from "./device-utils.js";

test("parseValue recognizes CLI scalar and structured values", () => {
  assert.equal(parseValue("42"), 42);
  assert.equal(parseValue("-3.5"), -3.5);
  assert.equal(parseValue("true"), true);
  assert.equal(parseValue("OFF"), "OFF");
  assert.deepEqual(parseValue('{"x":1}'), {x: 1});
  assert.deepEqual(parseValue("[1,2]"), [1, 2]);
});

test("firmwareAtLeast compares semantic firmware components", () => {
  assert.equal(firmwareAtLeast({major: 7, minor: 4, patch: 4}, [7, 4, 4]), true);
  assert.equal(firmwareAtLeast({major: 7, minor: 4, patch: 3}, [7, 4, 4]), false);
  assert.equal(firmwareAtLeast({major: 8, minor: 0, patch: 0}, [7, 4, 4]), true);
  assert.equal(firmwareAtLeast({major: "bad", minor: 4, patch: 4}, [7, 4, 4]), false);
});
