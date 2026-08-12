import { ShieldAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/contracts";

interface SessionDeleteDialogProps {
  session: SessionSummary;
  deleting: boolean;
  onCancel(): void;
  onConfirm(): void;
}

const CONFIRMATION = "永久删除";

export function SessionDeleteDialog(props: SessionDeleteDialogProps): React.JSX.Element {
  const [confirmation, setConfirmation] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="trash-dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
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
          <span>{props.session.cwd}</span>
          <p>这会永久删除 OMP JSONL 会话文件及其附件目录，无法从回收站恢复。</p>
          <label className="delete-confirmation">
            <span>请输入“{CONFIRMATION}”确认</span>
            <input
              ref={inputRef}
              value={confirmation}
              disabled={props.deleting}
              autoComplete="off"
              onChange={event => setConfirmation(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && confirmation === CONFIRMATION && !props.deleting) props.onConfirm();
              }}
            />
          </label>
        </div>
        <footer>
          <button className="secondary-button" disabled={props.deleting} onClick={props.onCancel}>取消</button>
          <button
            className="danger-button danger-button--permanent"
            disabled={props.deleting || confirmation !== CONFIRMATION}
            onClick={props.onConfirm}
          >
            {props.deleting ? "正在彻底删除…" : "彻底删除"}
          </button>
        </footer>
      </section>
    </div>
  );
}
