import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";

const outputDirectory = path.resolve("test-results", "resume-e2e");
await fs.rm(outputDirectory, { recursive: true, force: true });
const userDataDirectory = path.join(outputDirectory, "user-data");
const fakeHomeDirectory = path.join(outputDirectory, "fake-home");
const agentDirectory = path.join(outputDirectory, "agent");
const workspaceDirectory = path.join(outputDirectory, "workspace");
const sessionBucket = path.join(agentDirectory, "sessions", "fake-project");
const sessionPath = path.join(sessionBucket, "2026-08-12_fake-session.jsonl");
const logPath = path.join(outputDirectory, "fake-omp.log.jsonl");
const terminalLogPath = path.join(outputDirectory, "fake-terminal.log");
const fakeBinDirectory = path.resolve("tests", "fixtures", "fake-bin");
const fakeTerminalPath = path.join(fakeBinDirectory, "fake-terminal");
await fs.mkdir(userDataDirectory, { recursive: true });
await fs.mkdir(fakeHomeDirectory, { recursive: true });
await fs.mkdir(sessionBucket, { recursive: true });
await fs.mkdir(workspaceDirectory, { recursive: true });
await fs.writeFile(sessionPath, [
  JSON.stringify({ type: "title", title: "Resumable fixture session" }),
  JSON.stringify({
    type: "session",
    id: "fake-session",
    timestamp: "2026-08-12T00:00:00.000Z",
    cwd: workspaceDirectory,
    title: "Resumable fixture session",
  }),
  "",
].join("\n"));

const electronPath = process.env.ELECTRON_EXECUTABLE || path.resolve("node_modules", "electron", "dist", "electron");
const app = await electron.launch({
  executablePath: electronPath,
  args: [path.resolve("out/main/index.js"), `--user-data-dir=${userDataDirectory}`],
  env: {
    ...process.env,
    HOME: fakeHomeDirectory,
    PATH: `${fakeBinDirectory}${path.delimiter}${process.env.PATH || ""}`,
    WSL_DISTRO_NAME: "OMPDesktopE2E",
    ELECTRON_DISABLE_SANDBOX: "1",
    FAKE_OMP_AGENT_DIR: agentDirectory,
    FAKE_OMP_LOG: logPath,
    FAKE_TERMINAL_LOG: terminalLogPath,
    TERMINAL: fakeTerminalPath,
  },
  timeout: 30_000,
});

try {
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".app-shell", { timeout: 30_000 });
  const sessionRow = page.getByText("Resumable fixture session", { exact: true }).first();
  await sessionRow.click();
  await page.getByText("Historical answer", { exact: true }).waitFor({ timeout: 15_000 });

  const composer = page.locator(".composer textarea");
  await composer.fill("Continue from desktop");
  await composer.press("Enter");
  await page.getByText("Resumed reply: Continue from desktop", { exact: true }).waitFor({ timeout: 15_000 });

  const runtimes = await page.evaluate(() => window.ompDesktop.runtime.list());
  if (runtimes.length !== 1) throw new Error(`Expected exactly one runtime, found ${runtimes.length}`);

  const modelSelect = page.getByLabel("选择 OMP 模型");
  await modelSelect.waitFor({ timeout: 15_000 });
  await modelSelect.selectOption(JSON.stringify(["fake-provider", "fake-model-b"]));
  await page.waitForFunction(() => {
    const select = document.querySelector('select[aria-label="选择 OMP 模型"]');
    return select instanceof HTMLSelectElement && select.value.includes("fake-model-b");
  });

  await composer.fill("FAKE_FAIL");
  await composer.press("Enter");
  await page.getByText("Synthetic resumed prompt failure", { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const textarea = document.querySelector(".composer textarea");
    return textarea instanceof HTMLTextAreaElement && textarea.value === "FAKE_FAIL";
  });

  await composer.fill("FAKE_FAIL_WITH_DRAFT");
  await composer.press("Enter");
  await composer.fill("Keep this newer draft");
  await page.getByText("Synthetic delayed prompt failure", { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const textarea = document.querySelector(".composer textarea");
    return textarea instanceof HTMLTextAreaElement && textarea.value === "Keep this newer draft";
  });
  await page.getByText("1 条未发送消息已保留", { exact: true }).waitFor();
  await page.locator(".retry-drafts button").click();
  await page.waitForFunction(() => {
    const textarea = document.querySelector(".composer textarea");
    return textarea instanceof HTMLTextAreaElement && textarea.value === "FAKE_FAIL_WITH_DRAFT";
  });
  await composer.press("Enter");
  await page.getByText("Resumed reply: FAKE_FAIL_WITH_DRAFT", { exact: true }).waitFor({ timeout: 15_000 });
  await page.locator(".retry-drafts button").click();
  await composer.press("Enter");
  await page.getByText("Resumed reply: Keep this newer draft", { exact: true }).waitFor({ timeout: 15_000 });

  const terminalButton = page.getByTitle("在原始 OMP 终端中打开");
  await composer.fill("FAKE_CONTINUATION");
  await composer.press("Enter");
  await page.getByText("Continuation stage one", { exact: true }).waitFor({ timeout: 15_000 });
  if (!(await terminalButton.isDisabled())) throw new Error("Terminal handoff was enabled during a non-terminal continuation");
  await page.getByText("Continuation stage two", { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[title="在原始 OMP 终端中打开"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });

  await composer.fill("FAKE_LOCAL");
  await composer.press("Enter");
  await page.waitForTimeout(100);

  const menuButton = page.locator("[data-session-menu-trigger]").first();
  await menuButton.click();
  await page.getByRole("menuitem", { name: "继续会话" }).waitFor();
  await page.getByRole("menuitem", { name: "在原始终端打开" }).waitFor();
  await page.getByRole("menuitem", { name: "移到回收站…" }).waitFor();
  const screenshot = path.join(outputDirectory, "resume-session-controls.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.getByRole("menuitem", { name: "移到回收站…" }).click();
  await page.getByRole("dialog", { name: "将会话移到回收站？" }).waitFor();
  await page.getByRole("button", { name: "取消" }).click();

  await composer.fill("FAKE_PENDING_ONE");
  await composer.press("Enter");
  await composer.fill("FAKE_EXIT");
  await composer.press("Enter");
  await page.getByRole("alert").getByText("OMP exited with code 9", { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const textarea = document.querySelector(".composer textarea");
    return textarea instanceof HTMLTextAreaElement && textarea.value === "FAKE_PENDING_ONE";
  });
  await page.getByText("1 条未发送消息已保留", { exact: true }).waitFor();
  await composer.fill("Reconnect after exit");
  await composer.press("Enter");
  await page.getByText("Resumed reply: Reconnect after exit", { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(async () => (await window.ompDesktop.runtime.list()).length === 1);

  await terminalButton.click();
  await page.waitForFunction(async () => (await window.ompDesktop.runtime.list()).length === 0);
  const terminalDeadline = Date.now() + 15_000;
  let terminalLog = "";
  while (Date.now() < terminalDeadline) {
    try {
      terminalLog = await fs.readFile(terminalLogPath, "utf8");
      if (terminalLog.includes(`--resume\n${sessionPath}\n`)) break;
    } catch {
      // The detached launcher may not have created its log yet.
    }
    await page.waitForTimeout(50);
  }
  const terminalArgs = terminalLog.trim().split("\n");
  const resumeIndex = terminalArgs.indexOf("--resume");
  if (resumeIndex < 0 || terminalArgs[resumeIndex + 1] !== sessionPath) {
    throw new Error(`Original terminal did not receive the selected resume path: ${JSON.stringify(terminalArgs)}`);
  }
  await page.getByText("新会话", { exact: true }).waitFor();
  await composer.fill("After terminal handoff");
  await composer.press("Enter");
  await page.getByText("Resumed reply: After terminal handoff", { exact: true }).waitFor({ timeout: 15_000 });

  await page.getByText("Fresh fixture session", { exact: true }).waitFor({ timeout: 15_000 });
  let ownershipLogEntries = (await fs.readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const trashOwnedStart = ownershipLogEntries.filter(entry => entry.event === "start").at(-1);
  const trashOwnedPath = trashOwnedStart?.effectiveSessionPath;
  if (trashOwnedStart?.sessionPath !== undefined || typeof trashOwnedPath !== "string") {
    throw new Error("Fresh desktop runtime did not publish its owned session path");
  }
  let freshRow = page.locator(".session-row").filter({ hasText: "Fresh fixture session" }).first();
  await freshRow.locator("[data-session-menu-trigger]").click();
  await page.getByRole("menuitem", { name: "移到回收站…" }).click();
  await page.getByRole("button", { name: "移到回收站", exact: true }).click();
  await page.waitForFunction(async () => (await window.ompDesktop.runtime.list()).length === 0);
  await page.getByText("会话已移到可恢复回收站", { exact: true }).waitFor({ timeout: 15_000 });
  try {
    await fs.access(trashOwnedPath);
    throw new Error("Fresh session file was not moved after its runtime stopped");
  } catch (error) {
    if (error instanceof Error && error.message === "Fresh session file was not moved after its runtime stopped") throw error;
  }

  await composer.fill("Fresh session terminal ownership");
  await composer.press("Enter");
  await page.getByText("Resumed reply: Fresh session terminal ownership", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("Fresh fixture session", { exact: true }).waitFor({ timeout: 15_000 });
  ownershipLogEntries = (await fs.readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const terminalOwnedStart = ownershipLogEntries.filter(entry => entry.event === "start").at(-1);
  const terminalOwnedPath = terminalOwnedStart?.effectiveSessionPath;
  if (terminalOwnedStart?.sessionPath !== undefined || typeof terminalOwnedPath !== "string") {
    throw new Error("Second fresh desktop runtime did not publish its owned session path");
  }
  freshRow = page.locator(".session-row").filter({ hasText: "Fresh fixture session" }).first();
  await freshRow.locator("[data-session-menu-trigger]").click();
  await page.getByRole("menuitem", { name: "在原始终端打开" }).click();
  await page.waitForFunction(async () => (await window.ompDesktop.runtime.list()).length === 0);
  const freshTerminalDeadline = Date.now() + 15_000;
  let freshTerminalLog = "";
  while (Date.now() < freshTerminalDeadline) {
    try {
      freshTerminalLog = await fs.readFile(terminalLogPath, "utf8");
      if (freshTerminalLog.includes(`--resume\n${terminalOwnedPath}\n`)) break;
    } catch {
      // The detached launcher may still be replacing its previous log.
    }
    await page.waitForTimeout(50);
  }
  if (!freshTerminalLog.includes(`--resume\n${terminalOwnedPath}\n`)) {
    throw new Error("Fresh runtime ownership was not handed to the original terminal");
  }

  const logEntries = (await fs.readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const starts = logEntries.filter(entry => entry.event === "start");
  if (starts[0]?.sessionPath !== sessionPath) throw new Error("Fake OMP did not receive the selected resume path");
  if (starts.at(-1)?.sessionPath !== undefined) {
    throw new Error("Desktop implicitly reclaimed the handed-off session instead of starting fresh");
  }
  const commands = logEntries.filter(entry => entry.event === "command").map(entry => entry.command);
  if (!commands.some(command => command.type === "prompt" && command.message === "Continue from desktop")) {
    throw new Error("Resumed prompt did not reach OMP RPC");
  }
  if (!commands.some(command => command.type === "set_model" && command.modelId === "fake-model-b")) {
    throw new Error("Model selection did not reach OMP RPC");
  }
  process.stdout.write(`${JSON.stringify({
    resumed: true,
    modelSelection: true,
    promptErrorRestored: true,
    newerDraftPreserved: true,
    multiplePendingRecovered: true,
    nonTerminalContinuation: true,
    promptResultHandled: true,
    reconnectAfterExit: true,
    terminalHandoff: true,
    handoffStartsFresh: true,
    newSessionTrashOwnership: true,
    newSessionTerminalOwnership: true,
    screenshot,
  })}\n`);
} finally {
  await app.close();
}
