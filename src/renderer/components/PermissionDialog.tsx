import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";
import type { RpcFrame } from "../../shared/contracts";

interface PermissionDialogProps {
  request: RpcFrame;
  onRespond(frame: RpcFrame): void;
}

export function PermissionDialog({ request, onRespond }: PermissionDialogProps): React.JSX.Element {
  const [value, setValue] = useState(typeof request.prefill === "string" ? request.prefill : "");
  const method = String(request.method ?? "confirm");
  const title = typeof request.title === "string" ? request.title : "OMP 需要你的确认";
  const cancel = (): void => onRespond({ type: "extension_ui_response", id: String(request.id), cancelled: true });

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="permission-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <span><AlertTriangle size={19} /></span>
          <div>
            <small>OMP 请求</small>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={cancel}><X size={17} /></button>
        </header>

        {typeof request.message === "string" && <p className="permission-message">{request.message}</p>}

        {method === "select" && Array.isArray(request.options) && (
          <div className="permission-options">
            {request.options.map(option => (
              <button
                key={String(option)}
                onClick={() => onRespond({ type: "extension_ui_response", id: String(request.id), value: String(option) })}
              >
                {String(option)}
              </button>
            ))}
          </div>
        )}

        {(method === "input" || method === "editor") && (
          <textarea
            autoFocus
            rows={method === "editor" ? 10 : 3}
            value={value}
            placeholder={typeof request.placeholder === "string" ? request.placeholder : "输入内容"}
            onChange={event => setValue(event.target.value)}
          />
        )}

        {method !== "select" && (
          <footer>
            <button className="secondary-button" onClick={cancel}>取消</button>
            {method === "confirm" ? (
              <>
                <button
                  className="secondary-button"
                  onClick={() => onRespond({ type: "extension_ui_response", id: String(request.id), confirmed: false })}
                >
                  拒绝
                </button>
                <button
                  className="primary-button"
                  onClick={() => onRespond({ type: "extension_ui_response", id: String(request.id), confirmed: true })}
                >
                  允许
                </button>
              </>
            ) : (
              <button
                className="primary-button"
                onClick={() => onRespond({ type: "extension_ui_response", id: String(request.id), value })}
              >
                提交
              </button>
            )}
          </footer>
        )}
      </section>
    </div>
  );
}
