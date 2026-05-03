/**
 * KEEP-395 (Bug 2): Drain-loop tracker for pending workflow tasks.
 *
 * Under "use workflow" durability, the SDK can checkpoint and resume
 * `executeWorkflow` partway through. The recursive `executeReadyDownstream`
 * call chain runs in the workflow layer (NOT inside a "use step"), so when
 * the SDK truncates the call-stack-await chain at a checkpoint resume the
 * scheduling of a downstream node is sometimes lost -- finalisation occurs
 * before that downstream node has even been queued.
 *
 * Wrap every `Promise.allSettled(...)` whose elements call `executeNode`
 * with `trackPending` so the executor holds a strong reference to every
 * in-flight branch. After the trigger settle, drain until the set is empty.
 * This catches any orphaned promise that was scheduled but not awaited via
 * the call-stack chain.
 *
 * Behavioural-equivalent: when no checkpoint resume happens, every awaited
 * `Promise.allSettled` resolves naturally and the drain loop sees an empty
 * set immediately. The new behaviour only kicks in when an orphaned promise
 * exists -- previously they were silently dropped, now they are awaited.
 */

export type PendingTracker = {
  /**
   * Wrap a promise so it is held in the pending set until it settles.
   * Returns the same promise (settled or rejected) so callers can `await`
   * it normally.
   */
  track<T>(p: Promise<T>): Promise<T>;
  /**
   * Drain the pending set: await every currently-tracked promise. New
   * promises added by the awaited promises are also drained. Returns once
   * the set is empty.
   */
  drain(): Promise<void>;
  /** Current count of in-flight promises (used in tests / diagnostics). */
  size(): number;
};

export function createPendingTracker(): PendingTracker {
  const pending = new Set<Promise<unknown>>();

  function track<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    // `.finally` returns a NEW promise that rejects with the same reason if
    // `p` rejects. Attach a noop `.catch` so an internal rejection here is
    // never reported as unhandled. Callers that care about rejection should
    // await the original promise (returned below) where their own handlers
    // apply.
    p.finally(() => {
      pending.delete(p);
    }).catch(() => undefined);
    return p;
  }

  async function drain(): Promise<void> {
    // New promises may be added while we await existing ones (e.g. an
    // awaited branch schedules another downstream node). Loop until the
    // set is fully drained.
    while (pending.size > 0) {
      const snapshot = [...pending];
      await Promise.allSettled(snapshot);
    }
  }

  function size(): number {
    return pending.size;
  }

  return { track, drain, size };
}
