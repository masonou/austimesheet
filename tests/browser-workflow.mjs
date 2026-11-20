import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { browserFixture } from "./browser-fixture.mjs";

// Copy only application sources, configuration and installed packages. A
// temporary app keeps both .env.local and the developer's dev server isolated.
const app = await mkdtemp(join(tmpdir(), "shiftbook-browser-"));
const fixture = await browserFixture();
let next, browser;
try {
  for (const name of [
    "src",
    "public",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "next.config.ts",
    "node_modules",
  ])
    await cp(name, join(app, name), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  const socket = createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const base = "http://localhost:" + port;
  next = spawn(
    process.execPath,
    [
      join(app, "node_modules/next/dist/bin/next"),
      "dev",
      "--port",
      String(port),
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: app,
      env: { ...process.env, ...fixture.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "ignore",
    },
  );
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  assert(ready, "Local application did not start");
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
  });
  async function login(page, email) {
    await page.goto(base);
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(fixture.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/workspace/**");
  }
  const admin = await browser.newPage(),
    employee = await browser.newPage();
  let tablet = await browser.newContext(),
    kiosk = await tablet.newPage();
  await login(admin, fixture.adminEmail);
  await login(employee, fixture.email);
  assert.equal(await employee.getByRole("link", { name: /kiosk/i }).count(), 0);
  await admin.getByRole("link", { name: "Employees", exact: true }).click();
  await admin.getByRole("link", { name: "Alex Lee" }).click();
  await admin.getByText(fixture.email).waitFor();
  await admin.getByRole("button", { name: "Edit name" }).click();
  await admin.getByLabel("Employee name").fill("Alex Smith");
  await admin.getByRole("button", { name: "Save name" }).click();
  await admin.getByRole("heading", { name: "Alex Smith" }).waitFor();
  await admin.getByRole("button", { name: "Assign PIN" }).click();
  await admin.getByRole("button", { name: "Save new PIN" }).click();
  const responsePromise = admin.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("/workspace/"),
  );
  await admin.getByRole("button", { name: "Reveal PIN" }).click();
  assert.match(
    (await responsePromise).headers()["cache-control"] || "",
    /no-store/,
  );
  await admin.getByRole("button", { name: "Hide PIN" }).waitFor();
  const pin = await admin.locator(".issued-pin").innerText();
  assert(/^\d{6}$/.test(pin));
  await admin.getByRole("button", { name: "Hide PIN" }).click();
  // Reproduce the old mixed-cookie browser before activating it.
  const stale = {
    name: "__Host-shiftbook-kiosk",
    value: "a".repeat(43),
    domain: "localhost",
    path: "/",
    secure: true,
    httpOnly: true,
  };
  await tablet.addCookies([stale]);
  await login(kiosk, fixture.adminEmail);
  await kiosk.goto(base + "/kiosk");
  async function credentials(
    page,
    email = fixture.adminEmail,
    password = fixture.password,
  ) {
    await page.getByLabel("Admin email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
  }
  await credentials(kiosk, fixture.email);
  await kiosk.getByRole("button", { name: "Activate Kiosk" }).click();
  await kiosk
    .getByRole("alert")
    .filter({ hasText: "administrator account" })
    .waitFor();
  await credentials(kiosk);
  await kiosk.getByLabel("Kiosk name").fill("Front counter");
  await kiosk.getByRole("button", { name: "Activate Kiosk" }).click();
  await kiosk.getByLabel("Enter your PIN").waitFor();
  assert(!(await tablet.cookies()).some((c) => c.name.includes("auth-token")));
  await kiosk.goto(base + "/workspace");
  await kiosk.waitForURL(base + "/");
  await kiosk.goto(base + "/kiosk");
  await admin.getByRole("link", { name: "Kiosks", exact: true }).click();
  await admin.getByRole("button", { name: "Revoke access" }).waitFor();
  const stored = await tablet.storageState();
  const cookie = stored.cookies.find(
    (c) => c.name === "__Host-shiftbook-kiosk",
  );
  assert(
    cookie?.httpOnly &&
      cookie.secure &&
      cookie.expires > Date.now() / 1000 + 89 * 86400,
  );
  await tablet.close();
  tablet = await browser.newContext({ storageState: stored });
  kiosk = await tablet.newPage();
  await kiosk.goto(base + "/kiosk");
  async function clock() {
    await kiosk.getByLabel("Enter your PIN").fill(pin);
    await kiosk
      .getByRole("button", { name: "Clock In / Out", exact: true })
      .click();
  }
  await clock();
  await kiosk.getByRole("heading", { name: "Alex · Clocked IN" }).waitFor();
  await employee.reload();
  await employee.getByText("Open session", { exact: true }).waitFor();
  await kiosk.getByLabel("Enter your PIN").waitFor();
  fixture.dropReply();
  await clock();
  await kiosk.getByRole("button", { name: "Check recorded result" }).click();
  await kiosk.getByRole("heading", { name: "Alex · Clocked OUT" }).waitFor();
  await employee.reload();
  assert.equal(
    await employee.getByText("Open session", { exact: true }).count(),
    0,
  );
  await kiosk.getByLabel("Enter your PIN").waitFor();
  await admin.getByRole("button", { name: "Revoke access" }).click();
  await admin.getByRole("button", { name: "Confirm revocation" }).click();
  await admin.getByText("Kiosk access revoked.").waitFor();
  await clock();
  await kiosk
    .getByRole("alert")
    .filter({ hasText: "access has ended" })
    .waitFor();
  await kiosk.reload();
  await kiosk.getByText(/revoked or expired/).waitFor();
  const revokedBrowser = await browser.newContext({
    storageState: await tablet.storageState(),
  });
  await login(await revokedBrowser.newPage(), fixture.email);
  await revokedBrowser.close();
  await credentials(kiosk);
  await kiosk.getByRole("button", { name: "Activate Kiosk" }).click();
  await kiosk.getByRole("button", { name: "Exit Kiosk" }).click();
  await kiosk.getByRole("button", { name: "Cancel" }).click();
  await kiosk.goto(base);
  await kiosk.getByLabel("Work email").fill(fixture.adminEmail);
  await kiosk.getByLabel("Password", { exact: true }).fill(fixture.password);
  await kiosk.getByRole("button", { name: "Sign in", exact: true }).click();
  await kiosk.waitForURL(base + "/kiosk?exit=1");
  await credentials(kiosk, fixture.adminEmail, "wrong");
  await kiosk.getByRole("button", { name: "Deactivate kiosk" }).click();
  await kiosk.getByRole("alert").waitFor();
  await credentials(kiosk);
  await kiosk.getByRole("button", { name: "Deactivate kiosk" }).click();
  await kiosk.waitForURL(base + "/");
  await login(kiosk, fixture.email);
  await admin.reload();
  await admin.getByText(/^Revoked/).waitFor();
  console.log(
    "PASS separate admin, employee and reopened kiosk profiles; masked reveal, no-store response, name edit, one-tap attendance, lost-response receipt and revocation.",
  );
} finally {
  await browser?.close();
  if (next && next.exitCode === null) {
    const closed = once(next, "exit");
    next.kill("SIGTERM");
    await closed;
  }
  await fixture.close();
  await rm(app, { recursive: true, force: true });
}
