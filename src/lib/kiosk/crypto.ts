import {
  createHash,
  createCipheriv,
  createDecipheriv,
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

export function nextToken(token: string, secret: string) {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update("renew:" + token)
    .digest("base64url");
}
function pinCipherKey(key: string) {
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new Error("Invalid PIN encryption configuration.");
  return Buffer.from(key, "hex");
}
export function sealPin(
  org: string,
  employee: string,
  pin: string,
  key: string,
) {
  if (!validPin(pin)) throw new Error("Invalid PIN.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", pinCipherKey(key), iv);
  cipher.setAAD(Buffer.from("shiftbook.pin.v1:" + org + ":" + employee));
  const ciphertext = Buffer.concat([
    cipher.update(pin, "ascii"),
    cipher.final(),
  ]);
  return (
    "v1." + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("hex")
  );
}
export function openPin(
  org: string,
  employee: string,
  envelope: string,
  key: string,
) {
  if (!/^v1\.[0-9a-f]{68}$/.test(envelope))
    throw new Error("Invalid envelope.");
  const bytes = Buffer.from(envelope.slice(3), "hex");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    pinCipherKey(key),
    bytes.subarray(0, 12),
    { authTagLength: 16 },
  );
  cipher.setAAD(Buffer.from("shiftbook.pin.v1:" + org + ":" + employee));
  cipher.setAuthTag(bytes.subarray(18));
  const pin = Buffer.concat([
    cipher.update(bytes.subarray(12, 18)),
    cipher.final(),
  ]).toString("ascii");
  if (!validPin(pin)) throw new Error("Invalid PIN envelope.");
  return pin;
}

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
