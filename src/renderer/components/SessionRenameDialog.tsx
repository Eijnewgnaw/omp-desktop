import { PencilLine, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/contracts";
import { SESSION_TITLE_MAX_LENGTH, validateSessionTitle } from "../session-rename";

interface SessionRenameDialogProps {
  session: SessionSummary;
  saving: boolean;
  error?: string;
  onCancel(): void;
  onConfirm(title: string): void;
}

export function SessionRenameDialog(props: SessionRenameDialogProps): React.JSX.Element {
  const [title, setTitle] = useState(props.session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const validation = useMemo(() => validateSessionTitle(title), [title]);
  const dialogError = props.error ?? (validation.valid ? undefined : validation.error);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !props.saving) props.onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onCancel, props.saving]);

  const submit = (): void => {
    if (props.saving || !validation.valid) return;
    props.onConfirm(validation.title);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="trash-dialog rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-dialog-title">
        <header>
          <span><PencilLine size={18} /></span>
          <div>
            <small>会话名称</small>
            <h2 id="rename-dialog-title">重命名会话</h2>
          </div>
          <button className="icon-button" disabled={props.saving} onClick={props.onCancel} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <form
          onSubmit={event => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="trash-dialog__body">
            <span>{props.session.cwd}</span>
            <label className="rename-field">
              <span>新名称</span>
              <input
                ref={inputRef}
                value={title}
                disabled={props.saving}
                maxLength={SESSION_TITLE_MAX_LENGTH}
                autoComplete="off"
                aria-invalid={!validation.valid}
                aria-describedby={dialogError ? "rename-dialog-error" : undefined}
                onChange={event => setTitle(event.target.value)}
              />
            </label>
            {dialogError && (
              <p className="rename-dialog__error" id="rename-dialog-error" role="alert">
                {dialogError}
              </p>
            )}
          </div>
          <footer>
            <button type="button" className="secondary-button" disabled={props.saving} onClick={props.onCancel}>取消</button>
            <button type="submit" className="primary-button" disabled={props.saving || !validation.valid}>
              {props.saving ? "正在保存…" : "保存"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
