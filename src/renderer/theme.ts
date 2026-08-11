import type { ThemeSnapshot } from "../shared/contracts";

const tokenNames = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
  "pythonMode",
  "statusLineBg",
  "statusLineModel",
  "statusLinePath",
  "statusLineGitClean",
  "statusLineGitDirty",
] as const;

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
}

export function applyTheme(snapshot: ThemeSnapshot): void {
  const root = document.documentElement;
  root.dataset.theme = snapshot.mode;
  root.dataset.ompTheme = snapshot.name;
  root.style.setProperty("--app-bg", snapshot.export.pageBg);
  root.style.setProperty("--app-card", snapshot.export.cardBg);
  root.style.setProperty("--app-info", snapshot.export.infoBg);
  for (const token of tokenNames) {
    const value = snapshot.colors[token];
    if (value) root.style.setProperty(`--omp-${kebabCase(token)}`, value);
  }
}
