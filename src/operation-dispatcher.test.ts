import assert from "node:assert/strict";
import test from "node:test";
import {OperationDispatcher, OperationSupersededError, parseDispatcherOptions} from "./operation-dispatcher.js";

const deferred = (): {promise: Promise<void>; resolve: () => void} => {
  let resolve!: () => void;
  return {promise: new Promise<void>((done) => { resolve = done; }), resolve};
};

test("runs four devices concurrently but never overlaps one device", async () => {
  const dispatcher = new OperationDispatcher({maxInFlight: 4});
  const gates = Array.from({length: 5}, deferred);
  let active = 0;
  let peak = 0;
  const run = (deviceId: string, index: number) => dispatcher.run({deviceId, priority: "command"}, async () => {
    active++;
    peak = Math.max(peak, active);
    await gates[index]!.promise;
    active--;
  });
  const operations = [run("a", 0), run("b", 1), run("c", 2), run("d", 3), run("a", 4)];
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dispatcher.status().active, 4);
  assert.equal(peak, 4);
  gates[0]!.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dispatcher.status().active, 4);
  gates.slice(1).forEach((gate) => gate.resolve());
  await Promise.all(operations);
});

test("newest unsent property operation supersedes the old operation", async () => {
  const dispatcher = new OperationDispatcher({maxInFlight: 1});
  const blocker = deferred();
  const active = dispatcher.run({deviceId: "other", priority: "command"}, () => blocker.promise);
  const old = dispatcher.run({deviceId: "bulb", priority: "command", operationId: "old", replaceKey: "brightness"}, async () => "old");
  const latest = dispatcher.run({deviceId: "bulb", priority: "command", operationId: "latest", replaceKey: "brightness"}, async () => "latest");
  await assert.rejects(old, (error: unknown) => error instanceof OperationSupersededError && error.supersededBy === "latest");
  blocker.resolve();
  await active;
  assert.equal(await latest, "latest");
  assert.equal(dispatcher.status().superseded, 1);
});

test("foreground work overtakes queued background polling", async () => {
  const dispatcher = new OperationDispatcher({maxInFlight: 1, maxBackgroundInFlight: 1});
  const blocker = deferred();
  const order: string[] = [];
  const active = dispatcher.run({deviceId: "active", priority: "background"}, () => blocker.promise);
  const poll = dispatcher.run({deviceId: "poll", priority: "background"}, async () => { order.push("poll"); });
  const command = dispatcher.run({deviceId: "command", priority: "command"}, async () => { order.push("command"); });
  blocker.resolve();
  await Promise.all([active, poll, command]);
  assert.deepEqual(order, ["command", "poll"]);
});

test("dispatcher concurrency can be increased at runtime", async () => {
  const dispatcher = new OperationDispatcher({maxInFlight: 1});
  const gates = [deferred(), deferred()];
  const operations = gates.map((gate, index) => dispatcher.run({deviceId: String(index), priority: "command"}, () => gate.promise));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(dispatcher.status().active, 1);
  assert.equal(dispatcher.configure(2, 1).active, 2);
  gates.forEach((gate) => gate.resolve());
  await Promise.all(operations);
});

test("one failed bulb does not block healthy bulbs or exceed the configured fanout", async () => {
  const dispatcher = new OperationDispatcher({maxInFlight: 4});
  let active = 0;
  let peak = 0;
  const completed: number[] = [];
  const operations = Array.from({length: 8}, (_, index) => dispatcher.run({deviceId: `bulb-${index}`, priority: "command"}, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, index === 1 || index === 5 ? 25 : 5));
    active--;
    if (index === 1 || index === 5) throw new Error(`bulb-${index} unavailable`);
    completed.push(index);
  }));
  const results = await Promise.allSettled(operations);
  assert.equal(peak, 4);
  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
  assert.deepEqual(completed.sort((left, right) => left - right), [0, 2, 3, 4, 6, 7]);
});

test("reducing concurrency clamps the background allowance when it is omitted", () => {
  const dispatcher = new OperationDispatcher({maxInFlight: 4, maxBackgroundInFlight: 3});
  assert.deepEqual(dispatcher.configure(2), {...dispatcher.status(), maxInFlight: 2, maxBackgroundInFlight: 2});
});

test("dispatcher environment defaults and bounds are explicit", () => {
  assert.deepEqual(parseDispatcherOptions({}), {maxInFlight: 4, maxBackgroundInFlight: 1});
  assert.deepEqual(parseDispatcherOptions({ZIGBEE_MAX_IN_FLIGHT: "99", ZIGBEE_MAX_BACKGROUND_IN_FLIGHT: "0"}), {maxInFlight: 16, maxBackgroundInFlight: 0});
  assert.deepEqual(parseDispatcherOptions({ZIGBEE_MAX_IN_FLIGHT: "2", ZIGBEE_MAX_BACKGROUND_IN_FLIGHT: "8"}), {maxInFlight: 2, maxBackgroundInFlight: 2});
});
