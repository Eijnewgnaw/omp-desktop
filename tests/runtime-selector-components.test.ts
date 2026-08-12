// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  EnvironmentInfo,
  OmpInstallation,
  SessionSummary,
} from "../src/shared/contracts";
import { SettingsDialog } from "../src/renderer/components/SettingsDialog";
import { Sidebar } from "../src/renderer/components/Sidebar";

const productInstallations: OmpInstallation[] = [
  {
    id: "windows:default",
    kind: "windows-native",
    label: "Windows (native)",
    executablePath: "C:\\Tools\\omp.exe",
    version: "17.2.15",
    agentDir: "C:\\Users\\me\\.omp\\agent",
  },
  {
    id: "windows:research",
    kind: "windows-native",
    label: "Windows (native) · Profile · research",
    profile: "research",
    executablePath: "C:\\Tools\\omp.exe",
    version: "17.2.15",
    agentDir: "C:\\Users\\me\\.omp\\profiles\\research\\agent",
  },
  {
    id: "windows:studio",
    kind: "windows-native",
    label: "Windows (native) · Profile · studio",
    profile: "studio",
    executablePath: "C:\\Tools\\omp.exe",
    version: "17.2.15",
    agentDir: "C:\\Users\\me\\.omp\\profiles\\studio\\agent",
  },
  {
    id: "wsl:ubuntu:default",
    kind: "wsl",
    label: "Ubuntu (WSL)",
    distro: "Ubuntu",
    executablePath: "/usr/bin/omp",
    version: "17.2.15",
    agentDir: "/home/me/.omp/agent",
  },
  {
    id: "wsl:ubuntu:research",
    kind: "wsl",
    label: "Ubuntu (WSL) · Profile · research",
    profile: "research",
    distro: "Ubuntu",
    executablePath: "/usr/bin/omp",
    version: "17.2.15",
    agentDir: "/home/me/.omp/profiles/research/agent",
  },
  {
    id: "wsl:ubuntu:work",
    kind: "wsl",
    label: "Ubuntu (WSL) · Profile · work",
    profile: "work",
    distro: "Ubuntu",
    executablePath: "/usr/bin/omp",
    version: "17.2.15",
    agentDir: "/home/me/.omp/profiles/work/agent",
  },
  {
    id: "wsl:debian:default",
    kind: "wsl",
    label: "Debian (WSL)",
    distro: "Debian",
    executablePath: "/opt/omp/bin/omp",
    version: "17.2.14",
    agentDir: "/home/me/.omp/agent",
  },
  {
    id: "wsl:debian:team",
    kind: "wsl",
    label: "Debian (WSL) · Profile · team",
    profile: "team",
    distro: "Debian",
    executablePath: "/opt/omp/bin/omp",
    version: "17.2.14",
    agentDir: "/home/me/.omp/profiles/team/agent",
  },
  {
    id: "linux:dev-only",
    kind: "linux-direct",
    label: "Linux direct development adapter",
    profile: "dev-only",
    executablePath: "/usr/local/bin/omp",
    version: "17.2.99",
    agentDir: "/home/me/.omp/profiles/dev-only/agent",
  },
];

const settings: AppSettings = {
  selectedInstallationId: "wsl:ubuntu:research",
  themeMode: "system",
};

function environment(
  installations: OmpInstallation[] = productInstallations,
  mode: EnvironmentInfo["mode"] = "windows-dual",
): EnvironmentInfo {
  return {
    platform: mode === "windows-dual" ? "win32" : mode === "macos-native" ? "darwin" : "linux",
    mode,
    installations,
    diagnostics: [],
  };
}

function settingsProps(patch: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  return {
    environment: environment(),
    settings,
    onClose: vi.fn(),
    onUpdate: vi.fn(),
    ...patch,
  };
}

function savedSession(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    installationId: "wsl:ubuntu:research",
    runtimeKind: "wsl",
    runtimeLabel: "Ubuntu (WSL) · Profile · research",
    profile: "research",
    path: "/home/me/.omp/profiles/research/sessions/session-1.jsonl",
    cwd: "/home/me/project",
    title: "Saved research session",
    createdAt: "2026-08-12T00:00:00.000Z",
    modifiedAt: "2026-08-12T00:00:00.000Z",
    size: 128,
    projectName: "project",
    pinned: false,
    archived: false,
    tags: [],
    ...patch,
  };
}

function sidebarProps(patch: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return {
    collapsed: false,
    sessions: [savedSession()],
    installations: productInstallations,
    activeInstallationId: "wsl:ubuntu:research",
    activeSessionKey: undefined,
    query: "",
    showArchived: false,
    workspace: "/home/me/project",
    workspaceSelectable: false,
    terminalAvailable: true,
    handedOffSessionKeys: [],
    switching: false,
    onCollapse: vi.fn(),
    onQuery: vi.fn(),
    onToggleArchived: vi.fn(),
    onNew: vi.fn(),
    onChooseWorkspace: vi.fn(),
    onOpen: vi.fn(),
    onRename: vi.fn(),
    onPin: vi.fn(),
    onArchive: vi.fn(),
    onTrash: vi.fn(),
    onDelete: vi.fn(),
    onOpenTerminal: vi.fn(),
    onSettings: vi.fn(),
    ...patch,
  };
}

afterEach(cleanup);

describe("layered runtime selectors", () => {
  it("exposes only Windows and WSL at the product level instead of flattening Profiles", () => {
    const { container } = render(createElement(SettingsDialog, settingsProps()));
    const location = screen.getByRole("combobox", { name: "默认新会话运行位置" });

    expect(within(location).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Windows",
      "WSL",
    ]);
    expect(within(location).queryByRole("option", { name: /Profile/u })).toBeNull();
    expect(within(location).queryByRole("option", { name: /Linux/u })).toBeNull();

    const profile = screen.getByRole("combobox", { name: "默认 OMP Profile" });
    expect(within(profile).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Default",
      "research",
      "work",
    ]);
    expect(within(profile).queryByRole("option", { name: "team" })).toBeNull();

    const distro = screen.getByRole("combobox", { name: "默认 WSL 发行版" });
    expect(within(distro).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Debian",
      "Ubuntu",
    ]);

    const detectedRuntimeCards = container.querySelectorAll(
      ".diagnostic-card:not(.diagnostic-card--warning)",
    );
    expect(detectedRuntimeCards).toHaveLength(2);
    expect([...detectedRuntimeCards].map(card => card.textContent)).toEqual([
      expect.stringContaining("Windows"),
      expect.stringContaining("WSL"),
    ]);
    expect([...detectedRuntimeCards].some(card => card.textContent?.includes("dev-only"))).toBe(false);
  });

  it("maps location, Profile, and WSL distribution changes to exact installation IDs", () => {
    const onUpdate = vi.fn();
    const props = settingsProps({ onUpdate });
    const { rerender } = render(createElement(SettingsDialog, props));

    fireEvent.change(screen.getByRole("combobox", { name: "默认新会话运行位置" }), {
      target: { value: "windows-native" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ selectedInstallationId: "windows:research" });

    rerender(createElement(SettingsDialog, {
      ...props,
      settings: { ...settings, selectedInstallationId: "windows:default" },
    }));
    fireEvent.change(screen.getByRole("combobox", { name: "默认 OMP Profile" }), {
      target: { value: "studio" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ selectedInstallationId: "windows:studio" });

    rerender(createElement(SettingsDialog, {
      ...props,
      settings: { ...settings, selectedInstallationId: "wsl:ubuntu:research" },
    }));
    fireEvent.change(screen.getByRole("combobox", { name: "默认 WSL 发行版" }), {
      target: { value: "Debian" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ selectedInstallationId: "wsl:debian:default" });

    rerender(createElement(SettingsDialog, {
      ...props,
      settings: { ...settings, selectedInstallationId: "wsl:debian:default" },
    }));
    fireEvent.change(screen.getByRole("combobox", { name: "默认 OMP Profile" }), {
      target: { value: "team" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ selectedInstallationId: "wsl:debian:team" });
  });

  it("renders a saved session's backend and Profile as read-only context", () => {
    const onChooseWorkspace = vi.fn();
    const { container } = render(createElement(Sidebar, sidebarProps({ onChooseWorkspace })));
    const runtimeSummary = container.querySelector(".runtime-picker--readonly");
    const sessionRow = screen.getByText("Saved research session").closest(".session-row");
    const workspaceButton = screen.getByRole("button", { name: /会话工作区/u }) as HTMLButtonElement;

    expect(runtimeSummary?.textContent).toContain("WSL");
    expect(runtimeSummary?.textContent).toContain("Profile · research");
    expect(runtimeSummary?.querySelector("select, [role='radio']")).toBeNull();
    expect(sessionRow?.textContent).toContain("WSL");
    expect(sessionRow?.textContent).toContain("Profile · research");
    expect(workspaceButton.disabled).toBe(true);

    fireEvent.click(workspaceButton);
    expect(onChooseWorkspace).not.toHaveBeenCalled();
  });

  it("presents a linux-direct-only development environment as WSL without rewriting its ID", () => {
    const linuxInstallations: OmpInstallation[] = [
      {
        id: "linux:default-real-id",
        kind: "linux-direct",
        label: "Linux direct",
        executablePath: "/usr/bin/omp",
        version: "17.2.15",
        agentDir: "/home/me/.omp/agent",
      },
      {
        id: "linux:lab-real-id",
        kind: "linux-direct",
        label: "Linux direct · Profile · lab",
        profile: "lab",
        executablePath: "/usr/bin/omp",
        version: "17.2.15",
        agentDir: "/home/me/.omp/profiles/lab/agent",
      },
    ];
    const linuxSettings: AppSettings = {
      selectedInstallationId: "linux:lab-real-id",
      themeMode: "system",
    };
    const onUpdate = vi.fn();
    const { container } = render(createElement(SettingsDialog, settingsProps({
      environment: environment(linuxInstallations, "linux-direct"),
      settings: linuxSettings,
      onUpdate,
    })));

    const location = screen.getByRole("combobox", { name: "默认新会话运行位置" });
    expect(within(location).getAllByRole("option").map(option => option.textContent)).toEqual(["WSL"]);
    expect((location as HTMLSelectElement).value).toBe("wsl");
    expect(container.querySelectorAll(".diagnostic-card:not(.diagnostic-card--warning)")).toHaveLength(1);
    expect(container.querySelector(".diagnostic-card")?.textContent).toContain("WSL");

    fireEvent.change(screen.getByRole("combobox", { name: "默认 OMP Profile" }), {
      target: { value: "" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ selectedInstallationId: "linux:default-real-id" });

    cleanup();
    const linuxSession = savedSession({
      installationId: "linux:lab-real-id",
      runtimeKind: "linux-direct",
      runtimeLabel: "Linux direct · Profile · lab",
      profile: "lab",
    });
    const { container: sidebarContainer } = render(createElement(Sidebar, sidebarProps({
      sessions: [linuxSession],
      installations: linuxInstallations,
      activeInstallationId: "linux:lab-real-id",
    })));
    expect(sidebarContainer.querySelector(".runtime-picker--readonly")?.textContent).toContain("WSL");
    expect(sidebarContainer.querySelector(".runtime-picker--readonly")?.textContent).toContain("Profile · lab");
    expect(screen.getByText("Saved research session").closest(".session-row")?.textContent).toContain("WSL");
  });

  it("presents native macOS Profiles under one macOS location without rewriting IDs", () => {
    const macosInstallations: OmpInstallation[] = [
      {
        id: "macos:default-real-id",
        kind: "macos-native",
        label: "macOS (native)",
        executablePath: "/opt/homebrew/bin/omp",
        version: "17.2.15",
        agentDir: "/Users/me/.omp/agent",
      },
      {
        id: "macos:work-real-id",
        kind: "macos-native",
        label: "macOS (native) · Profile · work",
        profile: "work",
        executablePath: "/opt/homebrew/bin/omp",
        version: "17.2.15",
        agentDir: "/Users/me/.omp/profiles/work/agent",
      },
    ];
    const { container } = render(createElement(SettingsDialog, settingsProps({
      environment: environment(macosInstallations, "macos-native"),
      settings: { selectedInstallationId: "macos:work-real-id", themeMode: "system" },
    })));

    const location = screen.getByRole("combobox", { name: "默认新会话运行位置" });
    expect(within(location).getAllByRole("option").map(option => option.textContent)).toEqual(["macOS"]);
    expect((location as HTMLSelectElement).value).toBe("macos-native");
    expect(within(screen.getByRole("combobox", { name: "默认 OMP Profile" }))
      .getAllByRole("option").map(option => option.textContent)).toEqual(["Default", "work"]);
    expect(container.querySelector(".diagnostic-card")?.textContent).toContain("macOS");

    cleanup();
    const macosSession = savedSession({
      installationId: "macos:work-real-id",
      runtimeKind: "macos-native",
      runtimeLabel: "macOS (native) · Profile · work",
      profile: "work",
      path: "/Users/me/.omp/profiles/work/sessions/session-1.jsonl",
      cwd: "/Users/me/project",
    });
    const { container: sidebarContainer } = render(createElement(Sidebar, sidebarProps({
      sessions: [macosSession],
      installations: macosInstallations,
      activeInstallationId: "macos:work-real-id",
    })));
    expect(sidebarContainer.querySelector(".runtime-picker--readonly")?.textContent).toContain("macOS");
    expect(screen.getByText("Saved research session").closest(".session-row")?.textContent).toContain("macOS");
  });
});
