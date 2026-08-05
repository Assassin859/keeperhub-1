/**
 * Workflow execution sharing flag helpers.
 *
 * shareExecutionStatus is an explicit owner opt-in (default false). It is
 * cleared on marketplace unlist and soft-delete so sharing never becomes
 * irreversible.
 */

export function shareExecutionStatusUpdate(enabled: boolean): {
  shareExecutionStatus: boolean;
} {
  return { shareExecutionStatus: enabled };
}

export function clearShareExecutionStatus(): { shareExecutionStatus: false } {
  return { shareExecutionStatus: false };
}
