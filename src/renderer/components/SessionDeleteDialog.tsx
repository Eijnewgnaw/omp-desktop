import { ShieldAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { SessionSummary } from "../../shared/contracts";

interface SessionDeleteDialogProps {
  session: SessionSummary;
  deleting: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function SessionDeleteDialog(props: SessionDeleteDialogProps): React.JSX.Element {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="trash-dialog delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-warning"
        onKeyDown={event => {
          if (event.key === "Escape" && !props.deleting) {
            event.preventDefault();
            event.stopPropagation();
            props.onCancel();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
          );
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <span><ShieldAlert size={18} /></span>
          <div>
            <small>不可恢复操作</small>
            <h2 id="delete-dialog-title">彻底删除这个会话？</h2>
          </div>
          <button className="icon-button" disabled={props.deleting} onClick={props.onCancel} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="trash-dialog__body">
          <strong>{props.session.title}</strong>
          <span title={props.session.cwd}>工作区：{props.session.cwd}</span>
          <span title={props.session.path}>会话文件：{props.session.path}</span>
          <p id="delete-dialog-warning">
            此操作会永久删除 OMP JSONL 会话文件及其附件目录，无法撤销，也无法从回收站恢复。
          </p>
        </div>
        <footer>
          <button
            ref={cancelButtonRef}
            className="secondary-button"
            disabled={props.deleting}
            onClick={props.onCancel}
          >
            取消
          </button>
          <button
            className="danger-button danger-button--permanent"
            disabled={props.deleting}
            onClick={props.onConfirm}
          >
            {props.deleting ? "正在彻底删除…" : "彻底删除"}
          </button>
        </footer>
      </section>
    </div>
  );
}
