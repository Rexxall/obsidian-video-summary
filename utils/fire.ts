/**
 * Event callbacks expect a void return. Pass async handlers through this: the promise still runs,
 * and a rejection is logged instead of becoming an unhandled rejection.
 */
export function fire<A extends unknown[]>(handler: (...args: A) => unknown): (...args: A) => void {
  return (...args: A) => {
    void Promise.resolve(handler(...args)).catch((error: unknown) =>
      console.error('[Video Summary]', error),
    );
  };
}
