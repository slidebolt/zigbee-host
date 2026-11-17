import assert from "node:assert/strict";
import test from "node:test";
import {OperationQueue} from "./operation-queue.js";

test("physical operations are FIFO and never overlap by default", async () => {
  const queue = new OperationQueue();
  const order: string[] = [];
  let active = 0;
  let peak = 0;
  let releaseFirst!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const operation = (name: string, wait?: Promise<void>) => queue.run(async () => {
    active++;
    peak = Math.max(peak, active);
    order.push(`${name}:start`);
    await wait;
    order.push(`${name}:end`);
    active--;
  });

  const first = operation("first", blocked);
  const second = operation("second");
  const third = operation("third");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second, third]);

  assert.equal(peak, 1);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end", "third:start", "third:end"]);
});

test("a failed operation releases the next radio slot", async () => {
  const queue = new OperationQueue();
  await assert.rejects(queue.run(async () => { throw new Error("delivery failed"); }), /delivery failed/);
  assert.equal(await queue.run(async () => "recovered"), "recovered");
});
