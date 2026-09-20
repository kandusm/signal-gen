/**
 * Injectable delay.
 *
 * Only used for the 429 path, where dm-contract.md hands us a Retry-After and
 * the brief says to honour it. Injected so tests can assert that we waited the
 * right amount without actually waiting it.
 */
export type Sleep = (ms: number) => Promise<void>;

export const SLEEP = Symbol('SLEEP');

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
