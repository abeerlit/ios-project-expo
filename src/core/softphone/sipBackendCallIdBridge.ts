/**
 * Bridges SipSession "backendCallIdUpdate" events into SoftphoneProvider state
 * without circular imports (NotificationManager + storeSipSession can use this).
 */
let sipBackendCallIdHandler:
  | ((sessionId: string, callId: string) => void)
  | null = null;

export function setSipBackendCallIdHandler(
  fn: typeof sipBackendCallIdHandler
): void {
  sipBackendCallIdHandler = fn;
}

export function notifySipBackendCallDiscovered(
  sessionId: string,
  callId: string
): void {
  const trimmed = callId?.trim();
  if (trimmed) {
    sipBackendCallIdHandler?.(sessionId, trimmed);
  }
}
