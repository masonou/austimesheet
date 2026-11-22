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
  const kioskOrigin = "http://127.0.0.1:" + port;
  const kioskUrl = kioskOrigin + "/test-cafe";
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
      env: {
        ...process.env,
        ...fixture.env,
        SHIFTBOOK_APP_ORIGIN: base,
        SHIFTBOOK_KIOSK_ORIGIN: kioskOrigin,
        NEXT_TELEMETRY_DISABLED: "1",
      },
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
  async function login(page, email, password = fixture.password) {
    await page.goto(base);
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/workspace/**");
  }
  let tablet = await browser.newContext();
  let admin = await tablet.newPage();
  const employee = await browser.newPage();
  let kiosk;
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
  await admin.getByRole("link", { name: "Kiosks", exact: true }).click();
  const link = admin.getByRole("link", { name: /Open Kiosk/ });
  assert.equal(await link.getAttribute("href"), kioskUrl);
  const opened = tablet.waitForEvent("page");
  await link.click();
  kiosk = await opened;
  await kiosk.getByText("Test café", { exact: true }).waitFor();
  async function credentials(
    page,
    email = fixture.adminEmail,
    password = fixture.password,
  ) {
    await page.getByLabel("Admin email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
  }
  await kiosk.goto(kioskOrigin + "/harbour-pub");
  await credentials(kiosk);
  await kiosk.getByRole("button", { name: "Activate Kiosk" }).click();
  await kiosk
    .getByRole("alert")
    .filter({ hasText: "administrator account" })
    .waitFor();
  await kiosk.goto(kioskUrl);
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
  assert(
    !(await tablet.cookies(kioskUrl)).some((c) =>
      c.name.includes("auth-token"),
    ),
  );
  assert(
    !(await tablet.cookies(base)).some((c) =>
      c.name.includes("shiftbook-kiosk"),
    ),
  );
  const adminUrl = admin.url();
  await admin.reload();
  await admin.getByRole("button", { name: "Revoke access" }).waitFor();
  await admin.getByRole("button", { name: "Rename", exact: true }).click();
  await admin.getByLabel("Device name").fill("Front desk");
  await admin.getByRole("button", { name: "Save name" }).click();
  await admin.getByText("Front desk", { exact: true }).waitFor();
  const blocked = await employee.goto(kioskOrigin + new URL(adminUrl).pathname);
  assert.equal(blocked.status(), 404);
  await employee.goto(base + "/workspace");
  await kiosk.goto(kioskOrigin + "/harbour-pub");
  await kiosk
    .getByRole("alert")
    .filter({ hasText: "another workplace" })
    .waitFor();
  assert.equal(await kiosk.getByLabel("Enter your PIN").count(), 0);
  await kiosk.goto(kioskUrl);
  await kiosk.getByLabel("Enter your PIN").waitFor();
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
  admin = await tablet.newPage();
  await admin.goto(adminUrl);
  await kiosk.goto(kioskUrl);
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
  await credentials(kiosk);
  await kiosk.getByRole("button", { name: "Activate Kiosk" }).click();
  await kiosk.getByRole("button", { name: "Exit Kiosk" }).click();
  await credentials(kiosk, fixture.adminEmail, "wrong");
  await kiosk.getByRole("button", { name: "Deactivate kiosk" }).click();
  await kiosk.getByRole("alert").waitFor();
  await credentials(kiosk);
  await kiosk.getByRole("button", { name: "Deactivate kiosk" }).click();
  await kiosk.getByRole("button", { name: "Activate Kiosk" }).waitFor();
  await admin.reload();
  await admin.getByText(/^Revoked/).waitFor();
  const historical = "?week=2025-11-17";
  await admin.goto(base + "/workspace/" + fixture.org + "/admin" + historical);
  await admin.getByRole("button", { name: "Add session" }).click();
  const modal = admin.getByRole("dialog");
  await modal
    .getByLabel("Employee", { exact: true })
    .selectOption({ label: "Alex Smith" });
  await modal.getByLabel("Clock in", { exact: true }).fill("2025-11-19T17:00");
  await modal.getByLabel("Clock out", { exact: true }).fill("2025-11-19T22:30");
  await modal.getByLabel("Reason for manual entry").fill("Missed clock-in");
  await modal.getByRole("button", { name: "Add session" }).click();
  await admin.getByText("Session added.", { exact: true }).waitFor();
  const row = admin.getByRole("button", { name: /Open session for Alex/ });
  await row.click();
  await modal.getByRole("button", { name: "Mark Reviewed" }).click();
  await admin.getByText("Session marked Reviewed.").waitFor();
  await row.click();
  await modal.getByRole("button", { name: "Reopen for correction" }).click();
  await modal.getByText("Session reopened for correction.").waitFor();
  await modal.getByLabel("Clock out", { exact: true }).fill("2025-11-19T23:00");
  await modal.getByLabel("Reason for correction").fill("Confirmed close time");
  await modal.getByLabel("Note", { exact: true }).fill("Dinner service");
  await modal.getByRole("button", { name: "Save changes" }).click();
  await admin.getByText("Session updated.").waitFor();
  await admin
    .locator(".metric.primary strong")
    .filter({ hasText: /^6h$/ })
    .waitFor();
  await employee.goto(
    base + "/workspace/" + fixture.org + "/employee" + historical,
  );
  await employee
    .locator(".metric.primary strong")
    .filter({ hasText: /^6h$/ })
    .waitFor();
  await employee.getByText("Dinner service").waitFor();
  assert.equal(
    await employee
      .getByRole("button", { name: /Edit session|Add session/ })
      .count(),
    0,
  );
  await row.click();
  await modal.getByText("Change history").click();
  await modal.getByText("Confirmed close time").waitFor();
  await modal.getByRole("button", { name: "Mark Reviewed" }).click();
  await admin.getByText("Session marked Reviewed.").waitFor();
  await employee.reload();
  await employee.getByText("Reviewed", { exact: true }).waitFor();
  await admin.getByRole("link", { name: "Employees", exact: true }).click();
  await admin.getByRole("button", { name: "Add Employee" }).click();
  let form = admin.getByRole("dialog");
  await form.getByLabel("Full name").fill("Jordan Lee");
  await form.getByRole("button", { name: "Save employee" }).click();
  await admin.getByRole("link", { name: "Jordan Lee" }).click();
  await admin.getByText("Kiosk only", { exact: true }).waitFor();
  const address = "jordan@example.test";
  await admin.getByRole("button", { name: "Reveal PIN" }).click();
  await admin.getByRole("button", { name: "Hide PIN" }).waitFor();
  const jordanPin = await admin.locator(".issued-pin").innerText();
  await admin.getByRole("button", { name: "Enable dashboard access" }).click();
  await admin.getByLabel("Dashboard login email").fill(address);
  await admin.getByRole("button", { name: "Save login email" }).click();
  await admin.getByText("Linked", { exact: true }).waitFor();
  const firstPassword = await admin.getByTestId("issued-password").innerText();
  assert(firstPassword.length >= 12 && firstPassword !== jordanPin);
  await admin.getByRole("button", { name: "Done", exact: true }).click();
  await admin.reload();
  assert.equal(await admin.getByTestId("issued-password").count(), 0);
  const recipient = await browser.newPage();
  await login(recipient, address, firstPassword);
  await recipient.getByRole("heading", { name: "My timesheet" }).waitFor();
  await admin.getByRole("button", { name: "Change PIN" }).click();
  await admin.getByRole("combobox", { name: /New PIN/ }).selectOption("manual");
  await admin.getByLabel("New six-digit PIN").fill("009542");
  await admin.getByRole("button", { name: "Save new PIN" }).click();
  await admin.getByText(/PIN saved/).waitFor();
  await login(recipient, address, firstPassword);
  await admin.getByRole("button", { name: "Reset dashboard password" }).click();
  await admin.getByRole("button", { name: "Confirm password reset" }).click();
  const nextPassword = await admin.getByTestId("issued-password").innerText();
  assert(nextPassword.length >= 12 && nextPassword !== firstPassword);
  await admin.getByRole("button", { name: "Done", exact: true }).click();
  await admin.getByRole("button", { name: "Reveal PIN" }).click();
  await admin.getByRole("button", { name: "Hide PIN" }).waitFor();
  assert.equal(await admin.locator(".issued-pin").innerText(), "009542");
  await recipient.goto(base);
  await recipient.getByLabel("Work email").fill(address);
  await recipient.getByLabel("Password", { exact: true }).fill(firstPassword);
  await recipient.getByRole("button", { name: "Sign in", exact: true }).click();
  await recipient
    .getByText("Sign-in failed. Check your details and try again.", {
      exact: true,
    })
    .waitFor();
  await recipient.goto(base);
  await recipient.getByLabel("Work email").fill(address);
  await recipient.getByLabel("Password", { exact: true }).fill("009542");
  await recipient.getByRole("button", { name: "Sign in", exact: true }).click();
  await recipient
    .getByText("Sign-in failed. Check your details and try again.", {
      exact: true,
    })
    .waitFor();
  await login(recipient, address, nextPassword);
  await admin.getByRole("button", { name: "Deactivate employee" }).click();
  await admin.getByRole("button", { name: "Confirm status change" }).click();
  await admin.getByText("Inactive", { exact: true }).waitFor();
  assert.equal((await recipient.reload()).status(), 404);
  await admin.getByRole("button", { name: "Reactivate employee" }).click();
  await admin.getByRole("button", { name: "Confirm status change" }).click();
  await admin.getByText("Active", { exact: true }).waitFor();
  await admin.getByRole("button", { name: "Change login email" }).click();
  await admin
    .getByLabel("Dashboard login email")
    .fill("jordan-new@example.test");
  await admin.getByRole("button", { name: "Save login email" }).click();
  await admin.getByText("jordan-new@example.test", { exact: true }).waitFor();
  await login(recipient, "jordan-new@example.test", nextPassword);
  await admin.getByRole("link", { name: "Back to employees" }).click();
  await admin.getByRole("button", { name: "Add Employee" }).click();
  form = admin.getByRole("dialog");
  await form.getByLabel("Full name").fill("New starter");
  await form.getByLabel("Login email (optional)").fill("starter@example.test");
  await form.getByRole("combobox", { name: /New PIN/ }).selectOption("manual");
  await form.getByLabel("New six-digit PIN").fill("001290");
  await form.getByRole("button", { name: "Save employee" }).click();
  await admin.getByText(/Dashboard access enabled/).waitFor();
  const starterPassword = await admin
    .getByTestId("issued-password")
    .innerText();
  assert(starterPassword.length >= 12 && starterPassword !== "001290");
  await login(await browser.newPage(), "starter@example.test", starterPassword);
  await admin.reload();
  assert.equal(await admin.getByTestId("issued-password").count(), 0);
  assert.equal(fixture.emailRequests(), 0);
  console.log(
    "PASS kiosk and timesheet workflows, immediate generated-password login, one-time display, later activation, independent resets, email change, deactivation, and zero invitation requests.",
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
