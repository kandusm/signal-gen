/**
 * Injectable clock.
 *
 * Several services here are defined by their behaviour over time — a 6h TTL, a
 * token bucket, a 24h window, a retry schedule measured in hours. Testing
 * those against the real clock would mean either sleeping or not testing them.
 *
 * Declared with `@Optional() @Inject(CLOCK)` at the injection site so Nest
 * falls back to the default parameter instead of trying to resolve `Function`
 * from the container.
 */
export type Clock = () => Date;

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = () => new Date();

/** A clock that returns a fixed time, advanced explicitly. For tests. */
export function fixedClock(start: Date): Clock & { advance(ms: number): void; set(at: Date): void } {
  let current = start.getTime();
  const clock = (() => new Date(current)) as Clock & {
    advance(ms: number): void;
    set(at: Date): void;
  };
  clock.advance = (ms: number) => {
    current += ms;
  };
  clock.set = (at: Date) => {
    current = at.getTime();
  };
  return clock;
}
