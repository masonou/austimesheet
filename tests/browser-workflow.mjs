import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import readExcelFile from "read-excel-file/node";
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
  await admin.goto(base);
  await admin.getByLabel("Work email").fill(fixture.adminEmail);
  await admin
    .getByLabel("Password", { exact: true })
    .fill("incorrect password");
  await admin.getByRole("button", { name: "Sign in", exact: true }).click();
  await admin
    .getByRole("alert")
    .getByText("Sign-in failed. Check your details and try again.")
    .waitFor();
  assert.equal(
    await admin.getByLabel("Work email").inputValue(),
    fixture.adminEmail,
  );
  assert.equal(
    await admin.getByLabel("Password", { exact: true }).inputValue(),
    "incorrect password",
  );
  await admin.getByLabel("Password", { exact: true }).fill(fixture.password);
  await admin.getByRole("button", { name: "Sign in", exact: true }).click();
  await admin.waitForURL("**/workspace/**");
  await login(employee, fixture.email);
  assert.equal(await employee.getByRole("link", { name: /kiosk/i }).count(), 0);
  await admin.getByRole("link", { name: "Employees", exact: true }).click();
  const directorySearch = admin.getByRole("searchbox", {
    name: "Search employees",
  });
  const archive = admin.locator("summary").filter({ hasText: "Archived employees" });
  const archivedProfile = admin.getByRole("link", { name: "Sam Wilson" });
  await archive.waitFor();
  assert.equal(await archivedProfile.count(), 0);
  await directorySearch.fill("wils");
  await archive.click();
  await archivedProfile.click();
  await admin.getByRole("heading", { name: "Sam Wilson" }).waitFor();
  await admin.getByRole("link", { name: "Employees", exact: true }).click();
  await directorySearch.fill("missing name");
  await admin.getByText("No active employees match your search.").waitFor();
  await directorySearch.fill("lEe");
  assert.equal(await admin.getByRole("link", { name: "Sam Wilson" }).count(), 0);
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
  const openSessionPage = await tablet.newPage();
  await openSessionPage.goto(base + "/workspace/" + fixture.org + "/admin");
  await openSessionPage.getByRole("button", { name: /Open session for Alex/ }).click();
  const openSessionModal = openSessionPage.getByRole("dialog");
  await openSessionModal.getByRole("button", { name: "Edit session", exact: true }).click();
  await openSessionModal.getByRole("button", { name: "Clock in date" }).waitFor();
  assert.equal(await openSessionModal.getByLabel("Clock out time").inputValue(), "");
  await openSessionModal.getByRole("button", { name: "Clock out date" }).click();
  await openSessionModal.getByRole("grid").waitFor();
  await openSessionPage.keyboard.press("Escape");
  await openSessionModal.getByLabel("Clock out time").fill("23:00");
  await openSessionModal.getByLabel("Clock out time").fill("");
  await openSessionModal.getByRole("button", { name: "Clock out date" }).getByText("Choose date").waitFor();
  await openSessionModal.getByLabel("Note", { exact: true }).fill("Open session correction");
  await openSessionModal.getByRole("button", { name: "Save changes" }).click();
  await openSessionPage.getByText("Session updated.").waitFor();
  await openSessionPage.close();
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
  const timesheetsUrl = base + "/workspace/" + fixture.org + "/admin";
  const employeeFilter = admin.getByRole("combobox", { name: "Filter by employee" });
  await admin.goto(timesheetsUrl + "?week=2025-11-24&employee=" + fixture.formerEmployee);
  await admin.getByText(/Showing historical sessions for Sam Wilson/).waitFor();
  await admin.getByRole("button", { name: /Open session for Sam Wilson/ }).waitFor();
  assert.equal(await employeeFilter.inputValue(), "All employees");
  await admin.getByRole("button", { name: "Filter", exact: true }).click();
  await admin.waitForURL((url) => !url.searchParams.get("employee"));
  await admin.getByRole("button", { name: /Open session for Sam Wilson/ }).waitFor();

  await admin.goto(timesheetsUrl + historical);
  await employeeFilter.click();
  assert.equal(await admin.getByRole("option", { name: /Sam Wilson/ }).count(), 0);
  await employeeFilter.pressSequentially("wils");
  await admin.getByText("No employees match your search.").waitFor();
  await employeeFilter.fill("smi");
  await admin.getByRole("option", { name: "Alex Smith" }).click();
  await admin.getByRole("button", { name: "Filter", exact: true }).click();
  await admin.waitForURL((url) => !!url.searchParams.get("employee"));
  assert.equal(new URL(admin.url()).searchParams.get("week"), "2025-11-17");
  assert.equal(await employeeFilter.inputValue(), "Alex Smith");
  await admin.getByRole("button", { name: "Add session" }).click();
  const modal = admin.getByRole("dialog");
  const employeeField = modal.getByRole("combobox", { name: "Employee" });
  assert.equal(await employeeField.inputValue(), "Alex Smith");
  await modal.getByRole("button", { name: "Close" }).click();
  await employeeFilter.click();
  await admin.getByRole("option", { name: "All employees" }).click();
  await admin.getByRole("button", { name: "Filter", exact: true }).click();
  await admin.waitForURL((url) => !url.searchParams.get("employee"));
  await admin.getByRole("button", { name: "Add session" }).click();
  await employeeField.click();
  await modal.getByRole("option", { name: "Alex Smith" }).waitFor();
  assert.equal(await modal.getByRole("option", { name: /Sam Wilson/ }).count(), 0);
  await employeeField.fill("wilson");
  await modal.getByText("No employees match your search.").waitFor();
  await employeeField.press("Escape");
  assert.equal(await modal.getByRole("listbox").count(), 0);
  assert(await modal.isVisible());
  await employeeField.fill("SMI AL");
  await employeeField.press("ArrowDown");
  await employeeField.press("Enter");
  assert.equal(await employeeField.inputValue(), "Alex Smith");
  for (const label of ["Clock in", "Clock out"]) {
    await modal.getByRole("button", { name: label + " date" }).click();
    await admin.keyboard.press("Escape");
    assert.equal(await modal.getByRole("grid").count(), 0);
    await modal.getByRole("button", { name: label + " date" }).click();
    await modal
      .getByRole("gridcell", { name: /19/ })
      .getByRole("button")
      .click();
  }
  await modal.getByLabel("Clock in time").fill("17:00");
  await modal.getByLabel("Clock out time").fill("22:30");
  await modal.getByRole("button", { name: "Add session" }).click();
  await admin.getByText("Session added.", { exact: true }).waitFor();
  const row = admin.getByRole("button", { name: /Open session for Alex/ });
  await row.click();
  await modal.getByRole("button", { name: "Edit session", exact: true }).click();
  assert.equal(await modal.getByLabel("Clock in time").inputValue(), "17:00");
  assert.equal(await modal.getByLabel("Clock out time").inputValue(), "22:30");
  for (const label of ["Clock in", "Clock out"]) {
    await modal.getByRole("button", { name: label + " date" }).click();
    await modal.locator('[data-day="2025-11-20"]').getByRole("button").click();
    await modal.getByRole("button", { name: label + " date" }).click();
    await modal.getByRole("gridcell", { name: /19/ }).getByRole("button").click();
  }
  await modal.getByLabel("Clock out time").fill("22:45");
  await modal.getByRole("button", { name: "Save changes" }).click();
  await admin.getByText("Session updated.").waitFor();
  await row.click();
  await modal.getByRole("button", { name: "Mark Reviewed" }).click();
  await admin.getByText("Session marked Reviewed.").waitFor();
  await row.click();
  await modal.getByRole("button", { name: "Reopen for correction" }).click();
  await modal.getByText("Session reopened for correction.").waitFor();
  await modal.getByRole("button", { name: "Clock in date" }).waitFor();
  await modal.getByRole("button", { name: "Clock out date" }).waitFor();
  await modal.getByLabel("Clock out time").fill("23:00");
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
  await modal.getByText("Session edited", { exact: true }).first().waitFor();
  await modal.getByRole("button", { name: "Mark Reviewed" }).click();
  await admin.getByText("Session marked Reviewed.").waitFor();
  await employee.reload();
  await employee.getByText("Reviewed", { exact: true }).waitFor();
  await admin.getByRole("link", { name: "Reports", exact: true }).click();
  await admin.getByLabel("Reporting period").selectOption("fortnight");
  await admin.getByLabel("Start date").fill("2025-11-17");
  await admin.getByLabel("Employees", { exact: true }).selectOption("some");
  const reportEmployeeSearch = admin.getByRole("searchbox", { name: "Search employees" });
  await reportEmployeeSearch.fill("smi");
  assert.equal(await admin.getByRole("checkbox", { name: /Sam Wilson/ }).count(), 0);
  await admin
    .getByRole("checkbox", { name: "Alex Smith", exact: true })
    .check();
  await admin.getByRole("button", { name: "Apply filters" }).click();
  await admin
    .getByRole("heading", { name: "2025-11-17 – 2025-11-30" })
    .waitFor();
  await admin
    .locator(".metric.primary strong")
    .filter({ hasText: /^6\.00$/ })
    .waitFor();
  await admin.locator(".report-person summary").click();
  await admin.getByText("Dinner service", { exact: true }).waitFor();
  const reportUrl = admin.url();
  const fileUrl = new URL(
    await admin
      .getByRole("link", { name: "Work sessions CSV", exact: true })
      .getAttribute("href"),
    base,
  );
  const detail = await admin.request.get(fileUrl.href);
  assert.equal(detail.status(), 200);
  assert.match(detail.headers()["cache-control"], /no-store/);
  assert.match(
    detail.headers()["content-disposition"],
    /2025-11-17-to-2025-11-30\.csv/,
  );
  assert.match(await detail.text(), /"6.00","Reviewed","Dinner service"/);
  const summaryUrl = new URL(
    await admin
      .getByRole("link", { name: "Employee summary CSV" })
      .getAttribute("href"),
    base,
  );
  assert.match(
    await (await admin.request.get(summaryUrl.href)).text(),
    /"6.00","0.00","1","0"/,
  );
  const excelLink = admin.getByRole("link", {
    name: "Export Excel",
    exact: true,
  });
  const excelUrl = new URL(await excelLink.getAttribute("href"), base);
  const excel = await admin.request.get(excelUrl.href);
  assert.equal(excel.status(), 200);
  assert.match(excel.headers()["cache-control"], /no-store/);
  assert.match(excel.headers()["content-type"], /spreadsheetml.sheet/);
  assert.match(
    excel.headers()["content-disposition"],
    /alex-smith-2025-11-17-to-2025-11-30\.xlsx/,
  );
  const individual = await readExcelFile(await excel.body());
  assert.deepEqual(
    individual.map((sheet) => sheet.sheet),
    ["Alex Smith"],
  );
  assert(
    individual[0].data.some(
      (row) =>
        row[6] === 6 && row[7] === "Reviewed" && row[8] === "Dinner service",
    ),
  );
  for (const url of [reportUrl, fileUrl.href, summaryUrl.href, excelUrl.href]) {
    assert.equal((await employee.request.get(url)).status(), 404);
    assert.equal(
      (
        await admin.request.get(url.replace(fixture.org, fixture.harbour))
      ).status(),
      404,
    );
  }
  excelUrl.searchParams.append("employee", fixture.harbourEmployee);
  assert.equal((await admin.request.get(excelUrl.href)).status(), 400);
  fileUrl.searchParams.set("employee", fixture.harbourEmployee);
  assert.equal((await admin.request.get(fileUrl.href)).status(), 400);
  assert.equal(
    await employee.getByRole("link", { name: "Reports" }).count(),
    0,
  );
  await admin.getByLabel("Employees", { exact: true }).selectOption("all");
  await admin.getByRole("button", { name: "Apply filters" }).click();
  await admin
    .locator(".metric.primary strong")
    .filter({ hasText: /^10\.00$/ })
    .waitFor();
  await admin
    .getByText(
      "1 completed session is pending review and included in these totals.",
    )
    .waitFor();
  const former = admin
    .locator(".report-person summary")
    .filter({ hasText: "Sam Wilson (inactive)" });
  assert.match(await former.innerText(), /Saturday\s+2\.00/);
  assert.equal(await admin.getByText("Harbour employee").count(), 0);
  const team = await admin.request.get(
    new URL(await excelLink.getAttribute("href"), base).href,
  );
  assert.equal(team.status(), 200);
  const [overview, ...teamSheets] = await readExcelFile(await team.body());
  assert.equal(overview.sheet, "Overview");
  assert.deepEqual(teamSheets.map((s) => s.sheet).sort(), [
    "Alex Smith",
    "Sam Wilson",
  ]);
  assert.deepEqual(overview.data.at(-1), ["Overall total", 8, 2, 0, 10]);
  assert(
    teamSheets
      .find((s) => s.sheet === "Sam Wilson")
      .data.some(
        (row) =>
          row[3] === 2 && row[4] === 2 && row[6] === 4 && row[7] === "Pending",
      ),
  );
  const savedReport = new URL(reportUrl);
  savedReport.searchParams.append("employee", fixture.formerEmployee);
  await admin.goto(savedReport.href);
  await admin.getByText(/This saved report includes archived employees/).waitFor();
  await admin.locator(".metric.primary strong").filter({ hasText: /^10\.00$/ }).waitFor();
  assert.equal(await admin.getByRole("checkbox", { name: /Sam Wilson/ }).count(), 0);
  await reportEmployeeSearch.fill("wilson");
  await admin.getByText("No employees match your search.").waitFor();
  await admin.getByRole("button", { name: "Apply filters" }).click();
  await admin.waitForURL(reportUrl);
  await admin.locator(".metric.primary strong").filter({ hasText: /^6\.00$/ }).waitFor();
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto(
    base + "/workspace/" + fixture.org + "/admin?week=2025-11-17",
  );
  await admin.getByRole("button", { name: "Add session" }).click();
  await employeeField.fill("alex");
  await modal.getByRole("option", { name: "Alex Smith" }).click();
  await modal.getByLabel("Clock in", { exact: true }).fill("2025-11-19T10:00");
  await modal.getByLabel("Clock out", { exact: true }).fill("2025-11-19T11:00");
  await modal.getByRole("button", { name: "Add session" }).click();
  await admin.getByText("Session added.").waitFor();
  await admin.getByText("Wed, 19 Nov").first().waitFor();
  await admin.getByRole("button", { name: /Open session for Alex.*at 10:00/ }).click();
  await modal.getByRole("button", { name: "Edit session", exact: true }).click();
  assert.equal(
    await modal.getByLabel("Clock in", { exact: true }).inputValue(),
    "2025-11-19T10:00",
  );
  await modal.getByLabel("Clock out", { exact: true }).fill("2025-11-19T11:30");
  await modal.getByRole("button", { name: "Save changes" }).click();
  await admin.getByText("Session updated.").waitFor();
  await admin.setViewportSize({ width: 1280, height: 720 });
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
    "PASS kiosk, timesheet corrections, individual and team Excel workbooks, CSV downloads and report permissions, employee dashboard provisioning, password and email changes, and deactivation.",
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
