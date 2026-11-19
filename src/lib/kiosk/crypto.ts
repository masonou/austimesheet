import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt,
} from "node:crypto";

export const validPin = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{6}$/.test(value);
export const newPin = () => randomInt(1_000_000).toString().padStart(6, "0");
export const newToken = () => randomBytes(32).toString("base64url");
export const tokenDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

// Deterministic only within one organisation, allowing an indexed unique lookup.
// The key is supplied by the server-only caller and never travels to Postgres.
export async function pinVerifier(org: string, pin: string, pepper: string) {
  if (!validPin(pin) || !/^[0-9a-f]{64}$/i.test(pepper))
    throw new Error("Invalid PIN configuration.");
  const secret = createHmac("sha256", Buffer.from(pepper, "hex"))
    .update("shiftbook.pin.v1:" + org + ":" + pin)
    .digest();
  return new Promise<string>((resolve, reject) => {
    scrypt(
      secret,
      org,
      32,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        secret.fill(0);
        if (error) reject(new Error("PIN verification unavailable."));
        else resolve(key.toString("hex"));
      },
    );
  });
}
