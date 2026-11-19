"use server";

import {
  currentKiosk,
  deviceDigest,
  kioskClient,
  pinKey,
  sameOrigin,
  validToken,
  validUuid,
} from "@/lib/kiosk/server";
import {
  newToken,
  pinVerifier,
  tokenDigest,
  validPin,
} from "@/lib/kiosk/crypto";

type Failure = { status: "error"; message: string; challenge?: string };
type Ready = {
  status: "ready";
  firstName: string;
  action: "in" | "out";
  ticket: string;
};
type Recorded = { status: "recorded"; at: string; action: "in" | "out" };
const failure = (message: string, challenge?: string): Failure => ({
  status: "error",
  message,
  challenge,
});
function refusal(status: string, challenge?: string) {
  if (status === "invalid")
    return failure("PIN not recognised. Try again.", challenge);
  if (status === "locked")
    return failure("Too many incorrect PINs. Try again in 10 minutes.");
  if (status === "unauthorised")
    return failure(
      "This kiosk is no longer authorised. Contact an administrator.",
    );
  return failure(
    "This request has expired or attendance has changed. Start again to check your status.",
  );
}

export async function verifyPin(
  pin: string,
  challenge: string,
): Promise<Ready | Failure> {
  if (!(await sameOrigin()) || !validPin(pin) || !validUuid(challenge))
    return failure("Enter a six-digit PIN and try again.");
  const digest = await deviceDigest();
  if (!digest) return refusal("unauthorised");
  try {
    const context = await currentKiosk(digest);
    if (!context) return refusal("unauthorised");
    if (context.locked) return refusal("locked");
    if (context.challenge !== challenge) return refusal("stale");
    const ticket = newToken();
    const { data, error } = await kioskClient().rpc("verify_kiosk_pin", {
      credential_digest: digest,
      attempt: challenge,
      pin_verifier: await pinVerifier(context.org, pin, pinKey()),
      ticket_hash: tokenDigest(ticket),
    });
    if (error) throw new Error();
    if (data.status !== "ready") return refusal(data.status, data.challenge);
    return {
      status: "ready",
      firstName: data.firstName,
      action: data.action,
      ticket,
    };
  } catch {
    return failure(
      "Cannot reach the kiosk service. Check the connection and start again.",
    );
  }
}

export async function recordAttendance(
  ticket: string,
): Promise<Recorded | Failure> {
  if (!(await sameOrigin()) || !validToken(ticket)) return refusal("stale");
  const digest = await deviceDigest();
  if (!digest) return refusal("unauthorised");
  try {
    const { data, error } = await kioskClient().rpc("record_kiosk_attendance", {
      credential_digest: digest,
      ticket_hash: tokenDigest(ticket),
    });
    if (!error && data.status === "recorded")
      return { status: "recorded", at: data.at, action: data.action };
    if (!error) return refusal(data.status);
  } catch {
    /* A disconnected response may have committed. Never auto-toggle. */
  }
  return failure(
    "Recording could not be confirmed. Start again and check your current status.",
  );
}
