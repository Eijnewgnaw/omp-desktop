// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../src/shared/contracts";
import { SessionRenameDialog } from "../src/renderer/components/SessionRenameDialog";

const session: SessionSummary = {
  id: "rename-session",
  path: "/sessions/rename.jsonl",
  cwd: "/work/rename",
  title: "原会话名称",
  createdAt: "2026-08-12T00:00:00.000Z",
  modifiedAt: "2026-08-12T00:00:00.000Z",
  size: 1,
  projectName: "rename",
  pinned: false,
  archived: false,
  tags: [],
};

afterEach(cleanup);

describe("SessionRenameDialog", () => {
  it("prefills the current title and submits its trimmed replacement", () => {
    const onConfirm = vi.fn();
    render(createElement(SessionRenameDialog, {
      session,
      saving: false,
      onCancel: vi.fn(),
      onConfirm,
    }));

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("原会话名称");
    fireEvent.change(input, { target: { value: "  新会话名称  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onConfirm).toHaveBeenCalledWith("新会话名称");
  });

  it("keeps save disabled and explains an empty title", () => {
    render(createElement(SessionRenameDialog, {
      session,
      saving: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });

    expect(screen.getByRole("alert").textContent).toContain("会话名称不能为空");
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a metadata update error without closing the dialog", () => {
    render(createElement(SessionRenameDialog, {
      session,
      saving: false,
      error: "元数据写入失败",
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));

    expect(document.body.contains(screen.getByRole("dialog"))).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("元数据写入失败");
  });
});
