let isShuttingDown = false;

export function setShuttingDown(): void {
  isShuttingDown = true;
}

export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

export function resetShutdownState(): void {
  isShuttingDown = false;
}
