type Surface = "app" | "kiosk";

function configuredOrigin(value: string | undefined, fallback: string) {
  const url = new URL(value ?? fallback);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.href !== url.origin + "/" ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new Error("Configure an HTTPS origin or a local loopback origin.");
  }
  return url;
}

export function origins() {
  const app = configuredOrigin(
    process.env.SHIFTBOOK_APP_ORIGIN,
    "http://localhost:3000",
  );
  const kiosk = configuredOrigin(
    process.env.SHIFTBOOK_KIOSK_ORIGIN,
    "http://127.0.0.1:3000",
  );
  if (app.hostname === kiosk.hostname)
    throw new Error("The app and kiosk require different hostnames.");
  return { app, kiosk };
}

export function expectedHost(
  headers: Headers,
  surface: Surface,
  action = false,
) {
  const expected = origins()[surface];
  return (
    headers.get("host")?.toLowerCase() === expected.host &&
    (!action || headers.get("origin") === expected.origin)
  );
}

export function restaurantPath(path: string) {
  const slug = path.slice(1);
  return path.startsWith("/") &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) &&
    slug.length <= 63 &&
    !["workspace", "preview", "api", "kiosk"].includes(slug)
    ? slug
    : null;
}
