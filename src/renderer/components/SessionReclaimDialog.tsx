import { CircleAlert, X } from "lucide-react";
import type { SessionSummary } from "../../shared/contracts";

interface SessionReclaimDialogProps {
  session: SessionSummary;
  reclaiming: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function SessionReclaimDialog(props: SessionReclaimDialogProps): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="trash-dialog" role="dialog" aria-modal="true" aria-labelledby="reclaim-dialog-title">
        <header>
          <span><CircleAlert size={18} /></span>
          <div>
            <small>会话所有权确认</small>
            <h2 id="reclaim-dialog-title">重新接管这个会话？</h2>
          </div>
          <button className="icon-button" disabled={props.reclaiming} onClick={props.onCancel} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="trash-dialog__body">
          <strong>{props.session.title}</strong>
          <span>{props.session.cwd}</span>
          <p>该会话已交给原始 OMP 终端。请先关闭终端中的 OMP，再重新接管，避免两个进程同时写入同一会话。</p>
        </div>
        <footer>
          <button className="secondary-button" disabled={props.reclaiming} onClick={props.onCancel}>取消</button>
          <button className="primary-button" disabled={props.reclaiming} onClick={props.onConfirm}>
            {props.reclaiming ? "正在接管…" : "我已关闭终端，重新接管"}
          </button>
        </footer>
      </section>
    </div>
  );
}
