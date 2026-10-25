import { hostname } from "node:os";
import { ApiRequestError, Doc2VideoClient } from "./client.js";
import type { PendingLogin } from "./config.js";

/**
 * One-click login (OAuth 2.0 device authorization): ask doc2video for a code,
 * the user approves it in the browser, then poll until an API key is issued.
 */

interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface LoginResult {
  apiKey: string;
  email: string;
  keyName: string;
}

/** The name shown on the approval page and given to the API key. */
export function clientName(via: string): string {
  return `${via} on ${hostname()}`.slice(0, 100);
}

export async function startDeviceLogin(baseUrl: string, name: string): Promise<PendingLogin> {
  const res = await new Doc2VideoClient(baseUrl, null).publicRequest<DeviceStartResponse>("POST", "/auth/device", {
    client_name: name,
  });
  return {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUrl: res.verification_uri_complete,
    expiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
    interval: res.interval,
    baseUrl,
  };
}

/**
 * Poll until the user approves (resolves), denies or the code expires (throws),
 * or `timeoutSeconds` passes (throws `login_timeout`; polling again later is fine).
 */
export async function waitForDeviceLogin(pending: PendingLogin, timeoutSeconds: number): Promise<LoginResult> {
  const client = new Doc2VideoClient(pending.baseUrl, null);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let interval = pending.interval;

  for (;;) {
    if (Date.now() > Date.parse(pending.expiresAt)) {
      throw new ApiRequestError(400, "expired_token", "The login code expired. Run `d2v login` again.");
    }
    try {
      const res = await client.publicRequest<{ api_key: string; email: string; key_name: string }>(
        "POST",
        "/auth/device/token",
        { device_code: pending.deviceCode },
      );
      return { apiKey: res.api_key, email: res.email, keyName: res.key_name };
    } catch (err) {
      if (!(err instanceof ApiRequestError)) throw err;
      if (err.code === "slow_down") interval += 2;
      else if (err.code !== "authorization_pending") throw err;
    }
    if (Date.now() + interval * 1000 > deadline) {
      throw new ApiRequestError(408, "login_timeout", "Still waiting for approval in the browser.");
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}
