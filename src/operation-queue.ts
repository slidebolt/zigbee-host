/**
 * A small FIFO gate for physical coordinator operations. Zigbee devices share
 * one radio, so allowing every entity command to transmit at once turns a
 * harmless group command into a burst that the coordinator cannot deliver.
 */
export class OperationQueue {
  readonly #concurrency: number;
  readonly #waiting: Array<() => void> = [];
  #active = 0;

  constructor(concurrency = 1) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("operation concurrency must be a positive integer");
    this.#concurrency = concurrency;
  }

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#concurrency) {
      this.#active++;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
  }

  #release(): void {
    this.#active--;
    this.#waiting.shift()?.();
  }
}
