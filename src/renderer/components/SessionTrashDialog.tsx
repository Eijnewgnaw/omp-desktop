import { Trash2, X } from "lucide-react";
import type { SessionSummary } from "../../shared/contracts";

interface SessionTrashDialogProps {
  session: SessionSummary;
  deleting: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function SessionTrashDialog(props: SessionTrashDialogProps): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="trash-dialog" role="dialog" aria-modal="true" aria-labelledby="trash-dialog-title">
        <header>
          <span><Trash2 size={18} /></span>
          <div>
            <small>可恢复操作</small>
            <h2 id="trash-dialog-title">将会话移到回收站？</h2>
          </div>
          <button className="icon-button" disabled={props.deleting} onClick={props.onCancel} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="trash-dialog__body">
          <strong>{props.session.title}</strong>
          <span>{props.session.cwd}</span>
          <p>会话文件及其附件会移到 OMP agent 目录下的 OMP Desktop 回收站，不会永久删除。</p>
        </div>
        <footer>
          <button className="secondary-button" disabled={props.deleting} onClick={props.onCancel}>取消</button>
          <button className="danger-button" disabled={props.deleting} onClick={props.onConfirm}>
            {props.deleting ? "正在移动…" : "移到回收站"}
          </button>
        </footer>
      </section>
    </div>
  );
}
