import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";

const outputDirectory = path.resolve("test-results", "resume-e2e");
await fs.rm(outputDirectory, { recursive: true, force: true });
const userDataDirectory = path.join(outputDirectory, "user-data");
const fakeHomeDirectory = path.join(outputDirectory, "fake-home");
const agentDirectory = path.join(outputDirectory, "agent");
const workspaceDirectory = path.join(outputDirectory, "workspace-resumed");
const newWorkspaceDirectory = path.join(outputDirectory, "workspace-new");
const sessionBucket = path.join(agentDirectory, "sessions", "fake-project");
const sessionPath = path.join(sessionBucket, "2026-08-12_fake-session.jsonl");
const logPath = path.join(outputDirectory, "fake-omp.log.jsonl");
const terminalLogPath = path.join(outputDirectory, "fake-terminal.log");
const fakeBinDirectory = path.resolve("tests", "fixtures", "fake-bin");
const fakeTerminalPath = path.join(fakeBinDirectory, "fake-terminal");

await Promise.all([
  fs.mkdir(userDataDirectory, { recursive: true }),
  fs.mkdir(fakeHomeDirectory, { recursive: true }),
  fs.mkdir(sessionBucket, { recursive: true }),
  fs.mkdir(workspaceDirectory, { recursive: true }),
  fs.mkdir(newWorkspaceDirectory, { recursive: true }),
]);
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

async function assertMissing(filePath, message) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
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
    WSL_DISTRO_NAME: "OMPDesktopE2E",
    ELECTRON_DISABLE_SANDBOX: "1",
    FAKE_OMP_AGENT_DIR: agentDirectory,
    FAKE_OMP_LOG: logPath,
    FAKE_OMP_LONG_HISTORY: "1",
    FAKE_OMP_CONTINUATION_DELAY_MS: "2000",
    FAKE_TERMINAL_LOG: terminalLogPath,
    TERMINAL: fakeTerminalPath,
  },
  timeout: 30_000,
});

try {
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".app-shell", { timeout: 30_000 });

  const composer = page.locator(".composer textarea");
  const sendButton = page.locator(".send-button");
  await page.waitForFunction(() => {
    const textarea = document.querySelector(".composer textarea");
    return textarea instanceof HTMLTextAreaElement
      && textarea.disabled
      && textarea.placeholder === "请先选择工作区";
  });
  if (!(await sendButton.isDisabled())) throw new Error("A new session could send before selecting its workspace");
  if ((await page.locator(".conversation-title small").textContent()) !== "选择运行环境和工作区后开始") {
    throw new Error("The initial new session inherited a previous workspace");
  }

  let sessionRow = page.locator(".session-row").filter({ hasText: "Resumable fixture session" }).first();
  await sessionRow.locator(".session-row__main").click();
  await page.getByText("Historical answer", { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll(".message").length >= 50);

  const layout = await page.evaluate(() => {
    const pane = document.querySelector(".conversation-pane")?.getBoundingClientRect();
    const scroll = document.querySelector(".conversation-scroll");
    const scrollBounds = scroll?.getBoundingClientRect();
    const composerBounds = document.querySelector(".composer-area")?.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      paneBottom: pane?.bottom,
      scrollBottom: scrollBounds?.bottom,
      composerTop: composerBounds?.top,
      composerBottom: composerBounds?.bottom,
      scrollHeight: scroll?.scrollHeight,
      clientHeight: scroll?.clientHeight,
    };
  });
  if (layout.paneBottom === undefined || layout.paneBottom > layout.innerHeight + 1) {
    throw new Error(`Conversation pane escaped the viewport: ${JSON.stringify(layout)}`);
  }
  if (layout.composerBottom === undefined || layout.composerBottom > layout.innerHeight + 1) {
    throw new Error(`Composer was pushed below the viewport: ${JSON.stringify(layout)}`);
  }
  if (layout.scrollBottom === undefined || layout.composerTop === undefined || layout.scrollBottom > layout.composerTop + 1) {
    throw new Error(`Conversation scroll area overlapped the composer: ${JSON.stringify(layout)}`);
  }
  if ((layout.scrollHeight ?? 0) <= (layout.clientHeight ?? 0)) {
    throw new Error(`Long history did not create a bounded scroll area: ${JSON.stringify(layout)}`);
  }
  const conversationScroll = page.locator(".conversation-scroll");
  await conversationScroll.evaluate(element => element.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForFunction(() => (document.querySelector(".conversation-scroll")?.scrollTop ?? -1) === 0);
  await conversationScroll.hover();
  await page.mouse.wheel(0, 700);
  await page.waitForFunction(() => (document.querySelector(".conversation-scroll")?.scrollTop ?? 0) > 100);
  await conversationScroll.evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));

  const refreshButton = page.getByTitle("重新载入当前会话");
  const logBeforeRefresh = await readLogEntries();
  const commandCountBeforeRefresh = logBeforeRefresh.filter(entry => entry.event === "command").length;
  await refreshButton.click();
  const refreshEntries = await waitForLog(
    entries => {
      const commands = entries.slice(logBeforeRefresh.length)
        .filter(entry => entry.event === "command")
        .map(entry => entry.command);
      return ["get_state", "get_messages_page", "get_available_models"]
        .every(type => commands.some(command => command.type === type && String(command.id).startsWith("refresh-")));
    },
    "Refresh did not request state, history, and models",
  );
  if (refreshEntries.filter(entry => entry.event === "command").length < commandCountBeforeRefresh + 3) {
    throw new Error("Refresh did not send all three RPC commands");
  }
  await page.getByText("当前会话已请求重新载入", { exact: true }).waitFor({ timeout: 15_000 });

  const originalSessionContents = await fs.readFile(sessionPath, "utf8");
  const renamedSessionTitle = "E2E renamed session";
  await sessionRow.locator("[data-session-menu-trigger]").click();
  await page.getByRole("menuitem", { name: "重命名…" }).click();
  const renameDialog = page.getByRole("dialog", { name: "重命名会话" });
  await renameDialog.waitFor();
  const renameInput = renameDialog.getByRole("textbox", { name: "新名称" });
  if (await renameInput.inputValue() !== "Resumable fixture session") {
    throw new Error("Rename dialog was not prefilled with the selected session title");
  }
  await renameInput.fill(`  ${renamedSessionTitle}  `);
  await renameDialog.getByRole("button", { name: "保存", exact: true }).click();
  await renameDialog.waitFor({ state: "detached" });
  sessionRow = page.locator(".session-row").filter({ hasText: renamedSessionTitle }).first();
  await sessionRow.waitFor({ timeout: 15_000 });
  await page.locator(".conversation-title strong").getByText(renamedSessionTitle, { exact: true }).waitFor();
  if (await fs.readFile(sessionPath, "utf8") !== originalSessionContents) {
    throw new Error("Renaming a session modified the OMP JSONL source of truth");
  }
  await refreshButton.click();
  await page.getByText("当前会话已请求重新载入", { exact: true }).waitFor({ timeout: 15_000 });
  await sessionRow.getByText(renamedSessionTitle, { exact: true }).waitFor();
  await page.locator(".conversation-title strong").getByText(renamedSessionTitle, { exact: true }).waitFor();

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

  const terminalButton = page.getByTitle("在原始 OMP 终端中打开", { exact: true });
  await composer.fill("FAKE_CONTINUATION");
  await composer.press("Enter");
  await page.getByText("Continuation stage one", { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(async () => (await window.ompDesktop.runtime.list())[0]?.state === "running");
  if (await terminalButton.isDisabled()) throw new Error("Header terminal handoff was disabled while OMP was running");
  if (await page.locator(".new-session-button").isDisabled()) {
    throw new Error("New Session was disabled while OMP was running");
  }
  const [runtimeBeforeNewDialog] = await page.evaluate(() => window.ompDesktop.runtime.list());
  if (!runtimeBeforeNewDialog) throw new Error("Running OMP disappeared before opening the New Session dialog");
  const activeTitleBeforeNewDialog = await page.locator(".conversation-title strong").textContent();
  await page.locator(".new-session-button").click();
  const newSessionDialog = page.getByRole("dialog", { name: "新建会话" });
  await newSessionDialog.waitFor();
  const runtimesWhileNewDialogOpen = await page.evaluate(() => window.ompDesktop.runtime.list());
  if (runtimesWhileNewDialogOpen.length !== 1
    || runtimesWhileNewDialogOpen[0]?.runtimeId !== runtimeBeforeNewDialog.runtimeId) {
    throw new Error("Opening New Session stopped or replaced the current OMP runtime before confirmation");
  }
  if (await page.locator(".conversation-title strong").textContent() !== activeTitleBeforeNewDialog) {
    throw new Error("Opening New Session switched the active conversation before confirmation");
  }
  await newSessionDialog.getByRole("button", { name: "取消", exact: true }).click();
  await newSessionDialog.waitFor({ state: "detached" });
  const runtimesAfterNewDialogCancel = await page.evaluate(() => window.ompDesktop.runtime.list());
  if (runtimesAfterNewDialogCancel.length !== 1
    || runtimesAfterNewDialogCancel[0]?.runtimeId !== runtimeBeforeNewDialog.runtimeId) {
    throw new Error("Canceling New Session stopped or replaced the current OMP runtime");
  }
  if (await page.locator(".conversation-title strong").textContent() !== activeTitleBeforeNewDialog) {
    throw new Error("Canceling New Session changed the active conversation");
  }

  await page.keyboard.press("Control+N");
  await newSessionDialog.waitFor();
  const runtimesWhileShortcutDialogOpen = await page.evaluate(() => window.ompDesktop.runtime.list());
  if (runtimesWhileShortcutDialogOpen.length !== 1
    || runtimesWhileShortcutDialogOpen[0]?.runtimeId !== runtimeBeforeNewDialog.runtimeId) {
    throw new Error("Ctrl+N did not use the same non-destructive New Session path");
  }
  await newSessionDialog.getByRole("button", { name: "取消", exact: true }).click();
  await newSessionDialog.waitFor({ state: "detached" });
  sessionRow = page.locator(".session-row").filter({ hasText: renamedSessionTitle }).first();
  if (await sessionRow.locator(".session-row__main").isDisabled()) {
    throw new Error("The active sidebar session was disabled while OMP was running");
  }
  const runningMenuButton = sessionRow.locator("[data-session-menu-trigger]");
  if (await runningMenuButton.isDisabled()) throw new Error("Sidebar session actions were disabled while OMP was running");
  await runningMenuButton.click();
  const runningTerminalMenuItem = page.getByRole("menuitem", { name: "在原始终端打开" });
  await runningTerminalMenuItem.waitFor();
  if (await runningTerminalMenuItem.isDisabled()) {
    throw new Error("Sidebar terminal handoff was disabled while OMP was running");
  }
  await page.keyboard.press("Escape");
  await page.getByText("Continuation stage two", { exact: true }).waitFor({ timeout: 15_000 });

  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths });
  }, [newWorkspaceDirectory]);
  const [runtimeBeforeConfirmedNewSession] = await page.evaluate(() => window.ompDesktop.runtime.list());
  if (!runtimeBeforeConfirmedNewSession) throw new Error("Active runtime disappeared before confirming New Session");
  await page.locator(".new-session-button").click();
  await newSessionDialog.waitFor();
  await newSessionDialog.getByRole("button", { name: "选择项目文件夹" }).click();
  await newSessionDialog.getByText(newWorkspaceDirectory, { exact: true }).waitFor();
  const [runtimeBeforeNewSessionConfirmation] = await page.evaluate(() => window.ompDesktop.runtime.list());
  if (runtimeBeforeNewSessionConfirmation?.runtimeId !== runtimeBeforeConfirmedNewSession.runtimeId) {
    throw new Error("Selecting a project stopped the active runtime before New Session confirmation");
  }
  await newSessionDialog.getByRole("button", { name: "创建会话" }).click();
  await newSessionDialog.waitFor({ state: "detached" });
  if ((await page.evaluate(() => window.ompDesktop.runtime.list())).length !== 0) {
    throw new Error("Confirming New Session did not stop the previously active runtime");
  }
  await page.waitForFunction(expected => {
    const title = document.querySelector(".conversation-title strong");
    const cwd = document.querySelector(".conversation-title small");
    return title?.textContent === "新会话" && cwd?.textContent === expected;
  }, newWorkspaceDirectory);
  await sessionRow.locator(".session-row__main").click();
  await page.waitForFunction(async expectedTitle => {
    const [activeRuntime] = await window.ompDesktop.runtime.list();
    const title = document.querySelector(".conversation-title strong");
    return Boolean(activeRuntime) && title?.textContent === expectedTitle;
  }, renamedSessionTitle);

  await composer.fill("FAKE_LOCAL");
  await composer.press("Enter");
  await page.waitForTimeout(100);

  const menuButton = sessionRow.locator("[data-session-menu-trigger]");
  await menuButton.click();
  await page.getByRole("menuitem", { name: "继续会话" }).waitFor();
  await page.getByRole("menuitem", { name: "在原始终端打开" }).waitFor();
  await page.getByRole("menuitem", { name: "移到回收站…" }).waitFor();
  await page.getByRole("menuitem", { name: "彻底删除…" }).waitFor();
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
  await page.getByText("会话已交给原始 OMP 终端；桌面端已切换到新会话", { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const title = document.querySelector(".conversation-title strong");
    const cwd = document.querySelector(".conversation-title small");
    const textarea = document.querySelector(".composer textarea");
    return title?.textContent === "OMP Desktop"
      && cwd?.textContent === "选择运行环境和工作区后开始"
      && textarea instanceof HTMLTextAreaElement
      && textarea.disabled
      && textarea.placeholder === "请先选择工作区";
  });
  if (!(await sendButton.isDisabled())) throw new Error("Terminal handoff left the new-session composer sendable");

  sessionRow = page.locator(".session-row").filter({ hasText: renamedSessionTitle }).first();
  await sessionRow.getByText("原始终端中", { exact: false }).waitFor({ timeout: 15_000 });
  await sessionRow.locator(".session-row__main").click();
  const reclaimDialog = page.getByRole("dialog", { name: "重新接管这个会话？" });
  await reclaimDialog.waitFor({ timeout: 15_000 });
  await reclaimDialog.getByRole("button", { name: "取消" }).click();
  await reclaimDialog.waitFor({ state: "hidden" });
  if ((await page.evaluate(() => window.ompDesktop.runtime.list())).length !== 0) {
    throw new Error("Canceling session reclaim unexpectedly started a desktop runtime");
  }

  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths });
  }, [newWorkspaceDirectory]);
  const startCountBeforeWorkspaceSelection = (await readLogEntries()).filter(entry => entry.event === "start").length;
  const workspacePicker = page.locator(".workspace-picker");
  if (await workspacePicker.isDisabled()) throw new Error("Fresh session setup entry was disabled");
  await workspacePicker.click();
  await newSessionDialog.waitFor();
  await newSessionDialog.getByRole("button", { name: "选择项目文件夹" }).click();
  await newSessionDialog.getByText(newWorkspaceDirectory, { exact: true }).waitFor();
  if ((await readLogEntries()).filter(entry => entry.event === "start").length !== startCountBeforeWorkspaceSelection) {
    throw new Error("Choosing a project in the New Session dialog started OMP before confirmation");
  }
  await newSessionDialog.getByRole("button", { name: "创建会话" }).click();
  await newSessionDialog.waitFor({ state: "detached" });
  await page.waitForFunction(expected => {
    const title = document.querySelector(".conversation-title strong");
    const cwd = document.querySelector(".conversation-title small");
    const textarea = document.querySelector(".composer textarea");
    return title?.textContent === "新会话"
      && cwd?.textContent === expected
      && textarea instanceof HTMLTextAreaElement
      && !textarea.disabled;
  }, newWorkspaceDirectory);
  if ((await readLogEntries()).filter(entry => entry.event === "start").length !== startCountBeforeWorkspaceSelection) {
    throw new Error("Creating a configured session started OMP before the first prompt");
  }

  await composer.fill("Create session in selected workspace");
  await composer.press("Enter");
  await page.getByText("Resumed reply: Create session in selected workspace", { exact: true }).waitFor({ timeout: 15_000 });
  const entriesAfterFreshStart = await waitForLog(
    entries => entries.filter(entry => entry.event === "start").length > startCountBeforeWorkspaceSelection,
    "Selecting a workspace and sending the first prompt did not start OMP",
  );
  const freshStart = entriesAfterFreshStart.filter(entry => entry.event === "start").at(-1);
  const freshSessionPath = freshStart?.effectiveSessionPath;
  if (freshStart?.cwd !== newWorkspaceDirectory) {
    throw new Error(`Fresh session started in the wrong workspace: ${JSON.stringify(freshStart)}`);
  }
  if (freshStart?.sessionPath !== undefined) {
    throw new Error(`Fresh session unexpectedly resumed an older JSONL: ${JSON.stringify(freshStart)}`);
  }
  if (typeof freshSessionPath !== "string") throw new Error("Fresh runtime did not publish its session path");

  let freshRow = page.locator(".session-row").filter({ hasText: "Fresh fixture session" }).first();
  await freshRow.waitFor({ timeout: 15_000 });
  await freshRow.locator("[data-session-menu-trigger]").click();
  await page.getByRole("menuitem", { name: "移到回收站…" }).waitFor();
  await page.getByRole("menuitem", { name: "彻底删除…" }).waitFor();
  await page.getByRole("menuitem", { name: "移到回收站…" }).click();
  await page.getByRole("dialog", { name: "将会话移到回收站？" }).waitFor();
  await page.getByRole("button", { name: "取消" }).click();

  freshRow = page.locator(".session-row").filter({ hasText: "Fresh fixture session" }).first();
  await freshRow.locator("[data-session-menu-trigger]").click();
  await page.getByRole("menuitem", { name: "彻底删除…" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "彻底删除这个会话？" });
  await deleteDialog.waitFor();
  const permanentDeleteButton = deleteDialog.getByRole("button", { name: "彻底删除", exact: true });
  const deleteSessionPath = deleteDialog.getByText(`会话文件：${freshSessionPath}`, { exact: true });
  if (!(await deleteSessionPath.isVisible()) || await deleteSessionPath.getAttribute("title") !== freshSessionPath) {
    throw new Error("Permanent delete dialog did not identify the exact session file");
  }
  if (await permanentDeleteButton.isDisabled()) {
    throw new Error("Permanent delete remained disabled in the confirmation dialog");
  }
  const cancelDeleteButton = deleteDialog.getByRole("button", { name: "取消", exact: true });
  if (!(await cancelDeleteButton.evaluate(element => element === document.activeElement))) {
    throw new Error("Permanent delete dialog did not focus its safe cancel action");
  }
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press(index % 2 === 0 ? "Tab" : "Shift+Tab");
    if (!(await deleteDialog.evaluate(dialog => dialog.contains(document.activeElement)))) {
      throw new Error("Permanent delete dialog allowed keyboard focus to escape to the background");
    }
  }
  await cancelDeleteButton.focus();
  await cancelDeleteButton.press("Enter");
  await deleteDialog.waitFor({ state: "detached" });
  await fs.access(freshSessionPath);

  freshRow = page.locator(".session-row").filter({ hasText: "Fresh fixture session" }).first();
  await freshRow.locator("[data-session-menu-trigger]").click();
  await page.getByRole("menuitem", { name: "彻底删除…" }).click();
  await deleteDialog.waitFor();
  await permanentDeleteButton.click();
  await page.getByText("会话及其附件已彻底删除", { exact: true }).waitFor({ timeout: 15_000 });
  await freshRow.waitFor({ state: "detached", timeout: 15_000 });
  await assertMissing(freshSessionPath, "Permanent delete left the temporary fake session on disk");
  await fs.access(sessionPath);
  await page.waitForFunction(() => {
    const cwd = document.querySelector(".conversation-title small");
    const textarea = document.querySelector(".composer textarea");
    return cwd?.textContent === "选择运行环境和工作区后开始"
      && textarea instanceof HTMLTextAreaElement
      && textarea.disabled;
  });
  const horizontalLayout = await page.evaluate(() => {
    const pane = document.querySelector(".conversation-pane");
    const welcome = document.querySelector(".welcome-panel")?.getBoundingClientRect();
    const paneBounds = pane?.getBoundingClientRect();
    return {
      paneLeft: paneBounds?.left,
      paneRight: paneBounds?.right,
      paneScrollLeft: pane?.scrollLeft,
      paneScrollWidth: pane?.scrollWidth,
      paneClientWidth: pane?.clientWidth,
      welcomeLeft: welcome?.left,
      welcomeRight: welcome?.right,
    };
  });
  if ((horizontalLayout.paneScrollLeft ?? -1) !== 0
    || (horizontalLayout.paneScrollWidth ?? 0) > (horizontalLayout.paneClientWidth ?? 0) + 1
    || (horizontalLayout.welcomeLeft ?? -1) < (horizontalLayout.paneLeft ?? 0)
    || (horizontalLayout.welcomeRight ?? Number.POSITIVE_INFINITY) > (horizontalLayout.paneRight ?? 0)) {
    throw new Error(`Welcome layout escaped or horizontally scrolled after handoff: ${JSON.stringify(horizontalLayout)}`);
  }

  const logEntries = await readLogEntries();
  const starts = logEntries.filter(entry => entry.event === "start");
  if (starts[0]?.sessionPath !== sessionPath) throw new Error("Fake OMP did not receive the selected resume path");
  const commands = logEntries.filter(entry => entry.event === "command").map(entry => entry.command);
  if (!commands.some(command => command.type === "prompt" && command.message === "Continue from desktop")) {
    throw new Error("Resumed prompt did not reach OMP RPC");
  }
  if (!commands.some(command => command.type === "set_model" && command.modelId === "fake-model-b")) {
    throw new Error("Model selection did not reach OMP RPC");
  }

  process.stdout.write(`${JSON.stringify({
    resumed: true,
    boundedLongHistoryScroll: true,
    refreshReloadsRuntime: true,
    sessionRenamePersists: true,
    runningControlsAvailable: true,
    newSessionModalNonDestructive: true,
    newSessionShortcut: true,
    newSessionConfirmationStopsRuntime: true,
    modelSelection: true,
    promptErrorRestored: true,
    newerDraftPreserved: true,
    multiplePendingRecovered: true,
    nonTerminalContinuation: true,
    promptResultHandled: true,
    reconnectAfterExit: true,
    terminalHandoff: true,
    handoffStartsWorkspaceLess: true,
    handoffLeaseRequiresReclaim: true,
    perSessionWorkspace: true,
    trashAndPermanentDeleteVisible: true,
    permanentDeleteConfirmed: true,
    boundedHorizontalWelcome: true,
    screenshot,
  })}\n`);
} finally {
  await app.close();
}
