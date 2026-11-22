import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseConfig } from "@/lib/supabase/config";

import { origins, restaurantPath } from "@/lib/hosts";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const { app, kiosk } = origins();
  const host = request.headers.get("host")?.toLowerCase();
  const origin = host === app.host ? app : host === kiosk.host ? kiosk : null;
  const deny = () =>
    new NextResponse("Page not found.", {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  if (!origin) return deny();
  const write = !["GET", "HEAD"].includes(request.method);
  if (write && request.headers.get("origin") !== origin.origin) return deny();

  // Next also uses forwarding headers when handling redirects from Server Actions.
  request.headers.set("x-forwarded-host", origin.host);
  request.headers.set("x-forwarded-proto", origin.protocol.slice(0, -1));
  request.headers.delete("x-shiftbook-restaurant");
  if (origin === kiosk) {
    const slug = restaurantPath(path);
    if (!slug) {
      if (
        !write &&
        (path.startsWith("/_next/static/") ||
          path === "/_next/image" ||
          path.startsWith("/_next/webpack-hmr") ||
          path === "/favicon.ico" ||
          path === "/shiftbook.svg")
      )
        return NextResponse.next({ request });
      return deny();
    }
    request.headers.set("x-shiftbook-restaurant", slug);
    const response = NextResponse.next({ request });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  if (restaurantPath(path) || path === "/kiosk") return deny();
  if (path !== "/workspace" && !path.startsWith("/workspace/"))
    return NextResponse.next({ request });
  const { url, key } = supabaseConfig();
  let response = NextResponse.next({ request });
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(updates, headers) {
        for (const { name, value } of updates) request.cookies.set(name, value);
        const previous = response;
        response = NextResponse.next({ request });
        for (const cookie of previous.cookies.getAll())
          response.cookies.set(cookie);
        for (const { name, value, options } of updates)
          response.cookies.set(name, value, options);
        for (const [name, value] of Object.entries(headers))
          response.headers.set(name, value);
      },
    },
  });
  await client.auth.getClaims();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
