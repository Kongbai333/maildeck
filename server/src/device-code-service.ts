import type {
  DeviceCodeSessionView,
  DeviceCodeStateEvent
} from "../../shared/mail-contracts.js";
import {
  DeviceCodeAuthError,
  pollDeviceCode,
  readAccountEmail,
  startDeviceCode,
  type DeviceCodeSession
} from "../mail/device-code-auth.js";

interface ActiveDeviceCode {
  session: DeviceCodeSession;
  controller: AbortController;
  state: DeviceCodeStateEvent;
}

let active: ActiveDeviceCode | null = null;

function failureEvent(error: unknown): DeviceCodeStateEvent {
  if (error instanceof DeviceCodeAuthError) {
    const code =
      error.code === "auth_expired"
        ? "DEVICE_CODE_EXPIRED"
        : error.code === "auth_declined"
          ? "DEVICE_CODE_DECLINED"
          : error.code === "auth_request_failed"
            ? "NETWORK_ERROR"
            : "UNKNOWN";
    return { phase: "failed", code, message: error.message };
  }
  return {
    phase: "failed",
    code: "UNKNOWN",
    message: error instanceof Error ? error.message : String(error)
  };
}

export async function beginDeviceCode(): Promise<DeviceCodeSessionView> {
  cancelDeviceCode();

  const session = await startDeviceCode({
    clientId: process.env.MAILDECK_DEVICE_CODE_CLIENT_ID?.trim() || undefined,
    baseUrl: process.env.MAILDECK_DEVICE_CODE_BASE?.trim() || undefined
  });
  const controller = new AbortController();
  const view: DeviceCodeSessionView = {
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    expiresInSec: session.expiresInSec,
    clientId: session.clientId
  };

  const entry: ActiveDeviceCode = {
    session,
    controller,
    state: { phase: "waiting", ...view }
  };
  active = entry;

  void (async () => {
    try {
      const tokens = await pollDeviceCode({ session, signal: controller.signal });
      const email = await readAccountEmail({ accessToken: tokens.accessToken });
      if (active === entry) {
        entry.state = {
          phase: "authorized",
          clientId: session.clientId,
          refreshToken: tokens.refreshToken,
          email,
          scope: tokens.scope
        };
      }
    } catch (error) {
      if (active === entry && !controller.signal.aborted) {
        entry.state = failureEvent(error);
      }
    }
  })();

  return view;
}

export function getDeviceCodeState(): DeviceCodeStateEvent {
  return active?.state ?? { phase: "canceled" };
}

export function cancelDeviceCode(): { canceled: boolean } {
  if (active) {
    active.controller.abort();
    active = null;
  }
  return { canceled: true };
}
