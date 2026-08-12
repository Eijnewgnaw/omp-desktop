import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";

const outputDirectory = path.resolve("test-results", "profile-e2e");
await fs.rm(outputDirectory, { recursive: true, force: true });
const userDataDirectory = path.join(outputDirectory, "user-data");
const fakeHomeDirectory = path.join(outputDirectory, "fake-home");
const defaultAgentDirectory = path.join(outputDirectory, "agent-default");
const workAgentDirectory = path.join(outputDirectory, "agent-work");
const workspaceDirectory = path.join(outputDirectory, "workspace");
const defaultSessionPath = path.join(defaultAgentDirectory, "sessions", "shared", "session.jsonl");
const workSessionPath = path.join(workAgentDirectory, "sessions", "shared", "session.jsonl");
const logPath = path.join(outputDirectory, "fake-omp.log.jsonl");
const fakeBinDirectory = path.resolve("tests", "fixtures", "fake-bin");

await Promise.all([
  fs.mkdir(userDataDirectory, { recursive: true }),
  fs.mkdir(path.join(fakeHomeDirectory, ".omp", "profiles", "work"), { recursive: true }),
  fs.mkdir(path.dirname(defaultSessionPath), { recursive: true }),
  fs.mkdir(path.dirname(workSessionPath), { recursive: true }),
  fs.mkdir(workspaceDirectory, { recursive: true }),
]);

async function writeSession(file, id, title) {
  await fs.writeFile(file, [
    JSON.stringify({ type: "title", title }),
    JSON.stringify({
      type: "session",
      id,
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: workspaceDirectory,
      title,
    }),
    "",
  ].join("\n"));
}

await Promise.all([
  writeSession(defaultSessionPath, "default-session", "Default profile session"),
  writeSession(workSessionPath, "work-session", "Work profile session"),
]);

async function readLogEntries() {
  try {
    const contents = (await fs.readFile(logPath, "utf8")).trim();
    return contents ? contents.split("\n").map(line => JSON.parse(line)) : [];
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForLog(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readLogEntries();
    if (predicate(entries)) return entries;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

const electronPath = process.env.ELECTRON_EXECUTABLE || (await import("electron")).default;
const app = await electron.launch({
  executablePath: electronPath,
  args: [path.resolve("out/main/index.js"), `--user-data-dir=${userDataDirectory}`],
  env: {
    ...process.env,
    HOME: fakeHomeDirectory,
    PATH: `${fakeBinDirectory}${path.delimiter}${process.env.PATH || ""}`,
    OMP_EXECUTABLE: path.join(fakeBinDirectory, "omp"),
    ELECTRON_DISABLE_SANDBOX: "1",
    FAKE_OMP_AGENT_DIR: defaultAgentDirectory,
    FAKE_OMP_PROFILE_AGENT_DIRS: JSON.stringify({ work: workAgentDirectory }),
    FAKE_OMP_LOG: logPath,
  },
  timeout: 30_000,
});

try {
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".app-shell", { timeout: 30_000 });

  const detected = await page.evaluate(() => window.ompDesktop.environment.detect());
  const defaultInstallation = detected.installations.find(installation => installation.profile === undefined);
  const workInstallation = detected.installations.find(installation => installation.profile === "work");
  const expectedRuntimeKind = process.platform === "darwin" ? "macos-native" : "linux-direct";
  if (!defaultInstallation || !workInstallation
    || detected.installations.length !== 2
    || detected.installations.some(installation => installation.kind !== expectedRuntimeKind)) {
    throw new Error(`Work Profile was not detected: ${JSON.stringify({
      installations: detected.installations,
      diagnostics: detected.diagnostics,
    })}`);
  }
  const initialSettings = await page.evaluate(() => window.ompDesktop.settings.get());
  if (initialSettings.selectedInstallationId !== defaultInstallation.id) {
    throw new Error("The default Profile was not persisted as the default installation");
  }

  const defaultRow = page.locator(".session-row").filter({ hasText: "Default profile session" }).first();
  const workRow = page.locator(".session-row").filter({ hasText: "Work profile session" }).first();
  await Promise.all([defaultRow.waitFor(), workRow.waitFor()]);
  const expectedRuntimeLabel = process.platform === "darwin" ? "macOS" : "WSL";
  await defaultRow.getByText(expectedRuntimeLabel, { exact: true }).waitFor();
  await defaultRow.getByText("Default", { exact: true }).waitFor();
  await workRow.getByText(expectedRuntimeLabel, { exact: true }).waitFor();
  await workRow.getByText("Profile · work", { exact: true }).waitFor();

  await page.getByTitle("设置", { exact: true }).click();
  await page.locator(".settings-grid__theme select").selectOption("dark");
  await page.waitForFunction(() => document.documentElement.dataset.ompTheme === "anthracite");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await workRow.locator(".session-row__main").click();
  await page.getByText("Work profile session", { exact: true }).first().waitFor();
  await page.waitForFunction(async () => (await window.ompDesktop.runtime.list())[0]?.profile === "work");
  await page.waitForFunction(() => document.documentElement.dataset.ompTheme === "dark-aurora");
  await waitForLog(
    entries => entries.some(entry => entry.event === "start"
      && entry.profile === "work"
      && entry.sessionPath === workSessionPath),
    "Saved work-profile session did not start in the work profile",
  );

  const settingsAfterWorkSession = await page.evaluate(() => window.ompDesktop.settings.get());
  if (settingsAfterWorkSession.selectedInstallationId !== defaultInstallation.id) {
    throw new Error("Opening a saved work-profile session overwrote the global default for new sessions");
  }

  await defaultRow.locator(".session-row__main").click();
  await page.waitForFunction(async () => {
    const [runtime] = await window.ompDesktop.runtime.list();
    return runtime && runtime.profile === undefined;
  });
  await page.waitForFunction(() => document.documentElement.dataset.ompTheme === "anthracite");
  await waitForLog(
    entries => entries.some(entry => entry.event === "start"
      && entry.profile === "default"
      && entry.sessionPath === defaultSessionPath),
    "Saved default-profile session did not start in the default profile",
  );

  const [runtimeBeforeNewDialog] = await page.evaluate(() => window.ompDesktop.runtime.list());
  await page.locator(".new-session-button").click();
  const newSessionDialog = page.getByRole("dialog", { name: "新建会话" });
  await newSessionDialog.waitFor();
  if (await newSessionDialog.getByRole("radio").count() !== 1) {
    throw new Error("The native development runtime did not collapse into one top-level location");
  }
  await newSessionDialog.getByRole("radio", { name: new RegExp(`^${expectedRuntimeLabel}`, "u") }).waitFor();
  const profileOptions = await newSessionDialog.getByRole("combobox", { name: "OMP Profile" })
    .locator("option").allTextContents();
  if (JSON.stringify(profileOptions) !== JSON.stringify(["Default", "work"])) {
    throw new Error(`Profiles were not nested under ${expectedRuntimeLabel}: ${JSON.stringify(profileOptions)}`);
  }
  const [runtimeWhileNewDialogOpen] = await page.evaluate(() => window.ompDesktop.runtime.list());
  if (!runtimeBeforeNewDialog
    || runtimeWhileNewDialogOpen?.runtimeId !== runtimeBeforeNewDialog.runtimeId) {
    throw new Error("Opening New Session disrupted the saved default-Profile runtime");
  }
  await newSessionDialog.getByRole("button", { name: "取消", exact: true }).click();
  await newSessionDialog.waitFor({ state: "detached" });
  const [runtimeAfterNewDialogCancel] = await page.evaluate(() => window.ompDesktop.runtime.list());
  if (runtimeAfterNewDialogCancel?.runtimeId !== runtimeBeforeNewDialog.runtimeId) {
    throw new Error("Canceling New Session disrupted the saved default-Profile runtime");
  }

  process.stdout.write(`${JSON.stringify({
    profileDiscovery: true,
    profilesNestedUnderRuntime: true,
    sessionBadges: true,
    savedRuntimeIsolation: true,
    themeIsolation: true,
    settingsDefaultPreserved: true,
    newSessionCancelPreservesProfileRuntime: true,
  })}\n`);
} finally {
  await app.close();
}
