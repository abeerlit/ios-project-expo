import * as Sentry from "@sentry/react-native";
import { Platform } from "react-native";

/**
 * Filter macOS Console.app / device logs with: VOXO_IOS_CALLFLOW
 * (Process: VOXOConnect / React Native — warnings are forwarded to system log.)
 */
export const IOS_CALLFLOW_SUBSYSTEM = "VOXO_IOS_CALLFLOW";

function safePayload(data?: Record<string, unknown>): string {
  if (data == null) return "";
  try {
    return ` | ${JSON.stringify(data)}`;
  } catch {
    return " | [payload stringify failed]";
  }
}

function toSerializable(
  data?: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  if (!data) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(data)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v == null
    ) {
      out[k] = v as string | number | boolean | null;
    } else {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = "[unserializable]";
      }
    }
  }
  return out;
}

/**
 * High-signal iOS-only call flow tracing. Logs to console and Sentry.
 */
export function iosCallFlowLog(
  area: string,
  message: string,
  data?: Record<string, unknown>
): void {
  if (Platform.OS !== "ios") {
    return;
  }
  const ts = new Date().toISOString();
  const serialized = toSerializable(data);

  console.warn(
    `${IOS_CALLFLOW_SUBSYSTEM} ${ts} [${area}] ${message}${safePayload(data)}`
  );

  Sentry.addBreadcrumb({
    category: "voxo.callflow.ios",
    level: "info",
    message: `[${area}] ${message}`,
    data: serialized
  });

  Sentry.captureMessage(`VOXO_IOS_CALLFLOW [${area}] ${message}`, "info");
}

export function iosCallFlowError(
  area: string,
  message: string,
  error: unknown,
  data?: Record<string, unknown>
): void {
  if (Platform.OS !== "ios") {
    return;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  const merged = {
    ...(data || {}),
    errorMessage: err.message,
    errorName: err.name
  };

  iosCallFlowLog(area, `${message} (error)`, merged);

  Sentry.withScope((scope) => {
    scope.setTag("callflow", "ios");
    scope.setTag("callflow_area", area);
    scope.setContext("callflow", toSerializable(merged));
    Sentry.captureException(err);
  });
}
