import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const agentDirectory = process.env.FAKE_OMP_AGENT_DIR;
const logPath = process.env.FAKE_OMP_LOG;

const appendLog = async entry => {
  if (!logPath) return;
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`);
};

if (args.includes("--version")) {
  process.stdout.write("omp/17.2.12-fake\n");
  process.exit(0);
}

if (args[0] === "config" && args[1] === "path") {
  if (!agentDirectory) throw new Error("FAKE_OMP_AGENT_DIR is required");
  process.stdout.write(`${agentDirectory}\n`);
  process.exit(0);
}

if (!args.includes("--mode") || args[args.indexOf("--mode") + 1] !== "rpc-ui") {
  process.stderr.write(`Unsupported fake OMP arguments: ${args.join(" ")}\n`);
  process.exit(2);
}

const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const resumePath = option("--resume");
const cwd = option("--cwd") || process.cwd();
const sessionPath = resumePath ?? path.join(
  agentDirectory || process.cwd(),
  "sessions",
  "fake-new-project",
  `2026-08-12_fresh-${process.pid}.jsonl`,
);
let selectedModel = { provider: "fake-provider", id: "fake-model-a", name: "Fake Model A", reasoning: true };
let delayedFailureSent = false;
const models = [
  selectedModel,
  { provider: "fake-provider", id: "fake-model-b", name: "Fake Model B", reasoning: false },
];
const historicalMessages = process.env.FAKE_OMP_LONG_HISTORY === "1"
  ? [
      { role: "user", timestamp: 1, content: "Historical question" },
      ...Array.from({ length: 48 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        timestamp: index + 2,
        content: index % 2 === 0
          ? [{
              type: "text",
              text: `Long history response ${index + 1}. This fixture deliberately occupies several lines so the conversation pane must scroll without pushing the composer outside the window.`,
            }]
          : `Long history question ${index + 1}. Keep the selected workspace and the input composer visible while this history is rendered.`,
      })),
      { role: "assistant", timestamp: 1000, content: [{ type: "text", text: "Historical answer" }] },
    ]
  : [
      { role: "user", timestamp: 1, content: "Historical question" },
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Historical answer" }] },
    ];
const continuationDelayMs = Number(process.env.FAKE_OMP_CONTINUATION_DELAY_MS ?? 500);

if (!resumePath) {
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, [
    JSON.stringify({ type: "title", title: "Fresh fixture session" }),
    JSON.stringify({
      type: "session",
      id: `fresh-${process.pid}`,
      timestamp: new Date().toISOString(),
      cwd,
      title: "Fresh fixture session",
    }),
    "",
  ].join("\n"));
}

await appendLog({ event: "start", sessionPath: resumePath, effectiveSessionPath: sessionPath, cwd, pid: process.pid });
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
send({ type: "ready", supportedProtocolVersions: [1, 2] });
if (!resumePath) send({ type: "session_info_update", sessionFile: sessionPath });

const lineReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lineReader) {
  if (!line.trim()) continue;
  const command = JSON.parse(line);
  await appendLog({ event: "command", command });
  switch (command.type) {
    case "negotiate_protocol":
      send({ id: command.id, type: "response", command: command.type, success: true, data: { protocolVersion: 2 } });
      break;
    case "get_state":
      send({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: {
          model: selectedModel,
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          sessionFile: sessionPath,
          sessionId: "fake-resumed-session",
          steeringMode: "all",
          followUpMode: "all",
          interruptMode: "immediate",
          autoCompactionEnabled: true,
        },
      });
      break;
    case "get_messages_page":
      send({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: {
          messages: historicalMessages,
        },
      });
      break;
    case "get_available_models":
      send({ id: command.id, type: "response", command: command.type, success: true, data: { models } });
      break;
    case "set_model": {
      const next = models.find(model => model.provider === command.provider && model.id === command.modelId);
      if (!next) {
        send({ id: command.id, type: "response", command: command.type, success: false, error: "Model not found" });
      } else {
        selectedModel = next;
        send({ id: command.id, type: "response", command: command.type, success: true, data: selectedModel });
        send({ type: "model_changed" });
      }
      break;
    }
    case "prompt":
      send({ id: command.id, type: "response", command: command.type, success: true, data: { agentInvoked: true } });
      if (command.message === "FAKE_EXIT") {
        setTimeout(() => process.exit(9), 20);
        break;
      }
      if (command.message === "FAKE_LOCAL") {
        setTimeout(() => send({ type: "prompt_result", id: command.id, agentInvoked: false }), 20);
        break;
      }
      if (command.message === "FAKE_CONTINUATION") {
        send({ type: "agent_start" });
        send({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Continuation stage one" }] },
        });
        send({ type: "agent_end", isTerminal: false });
        setTimeout(() => {
          send({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "Continuation stage two" }] },
          });
          send({ type: "agent_end", isTerminal: true });
        }, Number.isFinite(continuationDelayMs) ? continuationDelayMs : 500);
        break;
      }
      if (command.message === "FAKE_PENDING_ONE") break;
      if (command.message === "FAKE_FAIL_WITH_DRAFT" && !delayedFailureSent) {
        delayedFailureSent = true;
        setTimeout(() => send({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: "Synthetic delayed prompt failure",
        }), 500);
        break;
      }
      if (command.message === "FAKE_FAIL") {
        setTimeout(() => send({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: "Synthetic resumed prompt failure",
        }), 20);
        break;
      }
      send({ type: "agent_start" });
      send({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Resumed" }] } });
      send({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: `Resumed reply: ${command.message}` }] },
      });
      send({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `Resumed reply: ${command.message}` }] },
      });
      send({ type: "agent_end" });
      break;
    case "abort":
      send({ id: command.id, type: "response", command: command.type, success: true });
      break;
    default:
      send({ id: command.id, type: "response", command: command.type, success: false, error: "Unsupported fake command" });
  }
}

await appendLog({ event: "exit", pid: process.pid });
