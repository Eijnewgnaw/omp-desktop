import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";

const outputDirectory = path.resolve("test-results");
await fs.mkdir(outputDirectory, { recursive: true });
const packagedExecutable = process.env.OMP_DESKTOP_EXECUTABLE;
const electronPath = packagedExecutable || (await import("electron")).default;
const userDataDirectory = path.join(outputDirectory, "user-data");
const fakeHomeDirectory = path.join(outputDirectory, "fake-home");
await fs.mkdir(fakeHomeDirectory, { recursive: true });

const app = await electron.launch({
  executablePath: packagedExecutable || electronPath,
  args: [
    ...(packagedExecutable ? [] : [path.resolve("out/main/index.js")]),
    `--user-data-dir=${userDataDirectory}`,
  ],
  env: {
    ...process.env,
    HOME: fakeHomeDirectory,
    ELECTRON_DISABLE_SANDBOX: "1",
    OMP_DESKTOP_E2E: "1",
  },
  timeout: 30_000,
});

try {
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".app-shell", { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  const title = await page.locator(".sidebar-brand strong").textContent();
  if (title !== "OMP Desktop") throw new Error(`Unexpected app title: ${title}`);
  const themeName = await page.evaluate(() => document.documentElement.dataset.ompTheme);
  if (!themeName) throw new Error("OMP theme was not applied");
  const screenshot = path.join(outputDirectory, "omp-desktop-home.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ screenshot, themeName, title }));
} finally {
  await app.close();
}
