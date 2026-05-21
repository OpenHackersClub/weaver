import { useCallback, useSyncExternalStore } from "react";
import { Effect, Fiber, Ref, Stream, SubscriptionRef } from "effect";

/**
 * Bridge an Effect-TS `SubscriptionRef<T>` into a React component. See ADR 0006.
 *
 * The `select`/`eq` pair narrows the cell so React only re-renders when the
 * selected slice actually changes.
 */
export function useSubscriptionRef<T, S>(
  ref: SubscriptionRef.SubscriptionRef<T>,
  select: (t: T) => S,
  eq: (a: S, b: S) => boolean = Object.is,
): S {
  return useSyncExternalStore(
    useCallback(
      (onChange) => {
        const fiber = Effect.runFork(
          ref.changes.pipe(
            Stream.map(select),
            Stream.changesWith(eq),
            Stream.runForEach(() => Effect.sync(onChange)),
          ),
        );
        return () => {
          Effect.runFork(Fiber.interrupt(fiber));
        };
      },
      [ref, select, eq],
    ),
    () => select(Effect.runSync(Ref.get(ref))),
    () => select(Effect.runSync(Ref.get(ref))),
  );
}
