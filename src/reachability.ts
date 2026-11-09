import type {DeviceReachability} from "./types.js";

export type ReachabilityFailure = NonNullable<DeviceReachability["lastFailure"]>;

/**
 * Tracks per-device reachability. Every observation updates the record
 * (lastSeen / lastFailure), but the returned `changed` flag is true only when
 * the status itself changes, so callers emit one event per transition instead
 * of one per read.
 */
export class ReachabilityTracker {
  readonly #records = new Map<string, DeviceReachability>();

  get(ieeeAddress: string): DeviceReachability | undefined {
    return this.#records.get(ieeeAddress);
  }

  ensure(ieeeAddress: string): void {
    if (!this.#records.has(ieeeAddress)) this.#records.set(ieeeAddress, {status: "unknown"});
  }

  markReachable(ieeeAddress: string, now = new Date().toISOString()): {record: DeviceReachability; changed: boolean} {
    const changed = this.#records.get(ieeeAddress)?.status !== "reachable";
    const record: DeviceReachability = {status: "reachable", lastSeen: now, lastSuccess: now};
    this.#records.set(ieeeAddress, record);
    return {record, changed};
  }

  markUnreachable(ieeeAddress: string, reason: string, failure: ReachabilityFailure): {record: DeviceReachability; changed: boolean} {
    const previous = this.#records.get(ieeeAddress);
    const changed = previous?.status !== "unreachable";
    const record: DeviceReachability = {
      status: "unreachable",
      reason,
      lastFailure: failure,
      ...(previous?.lastSeen ? {lastSeen: previous.lastSeen} : {}),
      ...(previous?.lastSuccess ? {lastSuccess: previous.lastSuccess} : {}),
    };
    this.#records.set(ieeeAddress, record);
    return {record, changed};
  }

  markAllUnknown(reason: string): void {
    for (const [ieeeAddress, current] of this.#records) {
      this.#records.set(ieeeAddress, {...current, status: "unknown", reason});
    }
  }
}
