// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpInstallation } from "../src/shared/contracts";
import { NewSessionDialog } from "../src/renderer/components/NewSessionDialog";

const installations: OmpInstallation[] = [
  {
    id: "windows:default",
    kind: "windows-native",
    label: "Windows (native)",
    executablePath: "C:\\Tools\\omp.exe",
    version: "17.2.15",
    agentDir: "C:\\Users\\me\\.omp\\agent",
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
    id: "wsl:default",
    kind: "wsl",
    label: "Ubuntu (WSL)",
    distro: "Ubuntu",
    executablePath: "/usr/bin/omp",
    version: "17.2.15",
    agentDir: "/home/me/.omp/agent",
  },
  {
    id: "wsl:research",
    kind: "wsl",
    label: "Ubuntu (WSL) · Profile · research",
    profile: "research",
    distro: "Ubuntu",
    executablePath: "/usr/bin/omp",
    version: "17.2.15",
    agentDir: "/home/me/.omp/profiles/research/agent",
  },
  {
    id: "wsl:debian-default",
    kind: "wsl",
    label: "Debian (WSL)",
    distro: "Debian",
    executablePath: "/opt/omp/bin/omp",
    version: "17.2.15",
    agentDir: "/home/me/.omp/agent",
  },
  {
    id: "wsl:debian-team",
    kind: "wsl",
    label: "Debian (WSL) · Profile · team",
    profile: "team",
    distro: "Debian",
    executablePath: "/opt/omp/bin/omp",
    version: "17.2.15",
    agentDir: "/home/me/.omp/profiles/team/agent",
  },
  {
    id: "linux:ignored",
    kind: "linux-direct",
    label: "Linux (direct) · Profile · must-not-be-a-top-level-choice",
    profile: "must-not-be-a-top-level-choice",
    executablePath: "/usr/local/bin/omp",
    version: "17.2.15",
    agentDir: "/home/me/.omp/profiles/must-not-be-a-top-level-choice/agent",
  },
];

function dialogProps(patch: Partial<Parameters<typeof NewSessionDialog>[0]> = {}) {
  return {
    installations,
    selectedInstallationId: "windows:default",
    onSelectInstallation: vi.fn(),
    onChooseWorkspace: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...patch,
  };
}

afterEach(cleanup);

describe("NewSessionDialog", () => {
  it("shows only Windows and WSL as top-level locations and filters Profiles by the selected backend", () => {
    const props = dialogProps();
    const { rerender } = render(createElement(NewSessionDialog, props));
    const backendGroup = screen.getByRole("radiogroup", { name: "运行位置" });

    expect(within(backendGroup).getAllByRole("radio")).toHaveLength(2);
    expect(within(backendGroup).getByRole("radio", { name: /^Windows/u }).getAttribute("aria-checked")).toBe("true");
    expect(within(backendGroup).getByRole("radio", { name: /^WSL/u }).getAttribute("aria-checked")).toBe("false");
    expect(within(backendGroup).queryByText(/Linux/u)).toBeNull();

    const profile = screen.getByRole("combobox", { name: "OMP Profile" });
    expect(within(profile).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Default",
      "studio",
    ]);
    expect(within(profile).queryByRole("option", { name: "research" })).toBeNull();
    expect(within(profile).queryByRole("option", { name: "must-not-be-a-top-level-choice" })).toBeNull();

    fireEvent.click(within(backendGroup).getByRole("radio", { name: /^WSL/u }));
    expect(props.onSelectInstallation).toHaveBeenLastCalledWith("wsl:default");

    rerender(createElement(NewSessionDialog, {
      ...props,
      selectedInstallationId: "wsl:default",
    }));
    const wslProfile = screen.getByRole("combobox", { name: "OMP Profile" });
    expect(within(wslProfile).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Default",
      "research",
    ]);
    expect(within(wslProfile).queryByRole("option", { name: "studio" })).toBeNull();
    expect(within(wslProfile).queryByRole("option", { name: "team" })).toBeNull();
  });

  it("keeps Profiles scoped to the current WSL distribution and selects an exact installation", () => {
    const props = dialogProps({ selectedInstallationId: "wsl:research" });
    const { rerender } = render(createElement(NewSessionDialog, props));
    const distro = screen.getByRole("combobox", { name: "WSL 发行版" });
    const ubuntuProfile = screen.getByRole("combobox", { name: "OMP Profile" });

    expect(within(distro).getAllByRole("option").map(option => option.textContent)).toEqual(["Debian", "Ubuntu"]);
    expect(within(ubuntuProfile).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Default",
      "research",
    ]);
    expect(within(ubuntuProfile).queryByRole("option", { name: "team" })).toBeNull();

    fireEvent.change(distro, { target: { value: "Debian" } });
    expect(props.onSelectInstallation).toHaveBeenLastCalledWith("wsl:debian-default");

    rerender(createElement(NewSessionDialog, {
      ...props,
      selectedInstallationId: "wsl:debian-default",
    }));
    const debianProfile = screen.getByRole("combobox", { name: "OMP Profile" });
    expect(within(debianProfile).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Default",
      "team",
    ]);
    expect(within(debianProfile).queryByRole("option", { name: "research" })).toBeNull();

    fireEvent.change(debianProfile, { target: { value: "team" } });
    expect(props.onSelectInstallation).toHaveBeenLastCalledWith("wsl:debian-team");
  });

  it("lets the parent clear a selected project whenever backend or Profile changes", () => {
    const onSelectInstallation = vi.fn();

    function Harness(): ReturnType<typeof createElement> {
      const [selectedInstallationId, setSelectedInstallationId] = useState("windows:default");
      const [workspace, setWorkspace] = useState<string | undefined>("C:\\Work\\old-project");
      return createElement(NewSessionDialog, {
        installations,
        selectedInstallationId,
        workspace,
        onSelectInstallation: installationId => {
          onSelectInstallation(installationId);
          setSelectedInstallationId(installationId);
          setWorkspace(undefined);
        },
        onChooseWorkspace: vi.fn(),
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      });
    }

    render(createElement(Harness));
    expect(screen.getByLabelText("项目目录").textContent).toBe("C:\\Work\\old-project");

    fireEvent.click(screen.getByRole("radio", { name: /^WSL/u }));
    expect(onSelectInstallation).toHaveBeenLastCalledWith("wsl:default");
    expect(screen.getByLabelText("项目目录").textContent).toBe("尚未选择项目文件夹");

    fireEvent.change(screen.getByRole("combobox", { name: "OMP Profile" }), {
      target: { value: "research" },
    });
    expect(onSelectInstallation).toHaveBeenLastCalledWith("wsl:research");
    expect(screen.getByLabelText("项目目录").textContent).toBe("尚未选择项目文件夹");
  });

  it("does not confirm until a project has been selected", () => {
    const onChooseWorkspace = vi.fn();
    const onConfirm = vi.fn();
    const props = dialogProps({ onChooseWorkspace, onConfirm });
    const { rerender } = render(createElement(NewSessionDialog, props));
    const createButton = screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement;

    expect(createButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "选择项目文件夹" }));
    expect(onChooseWorkspace).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(createElement(NewSessionDialog, { ...props, workspace: "C:\\Work\\selected" }));
    const enabledCreateButton = screen.getByRole("button", { name: "创建会话" }) as HTMLButtonElement;
    expect(enabledCreateButton.disabled).toBe(false);
    fireEvent.click(enabledCreateButton);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("cancels with Escape and traps keyboard focus inside the modal", () => {
    const onCancel = vi.fn();
    render(createElement(NewSessionDialog, dialogProps({
      workspace: "C:\\Work\\selected",
      onCancel,
    })));
    const dialog = screen.getByRole("dialog", { name: "新建会话" });
    const closeButton = within(dialog).getByRole("button", { name: "关闭" });
    const createButton = within(dialog).getByRole("button", { name: "创建会话" });

    createButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);

    closeButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(createButton);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
