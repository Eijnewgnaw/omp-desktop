import { CheckCircle2, CircleAlert, X } from "lucide-react";
import type { AppSettings, EnvironmentInfo, ThemeSnapshot } from "../../shared/contracts";

interface SettingsDialogProps {
  environment: EnvironmentInfo;
  settings: AppSettings;
  theme?: ThemeSnapshot;
  onClose(): void;
  onUpdate(patch: Partial<AppSettings>): void;
}

export function SettingsDialog(props: SettingsDialogProps): React.JSX.Element {
  return (
    <div className="modal-backdrop">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
        <header>
          <div><small>OMP DESKTOP</small><h2>设置与诊断</h2></div>
          <button className="icon-button" onClick={props.onClose}><X size={17} /></button>
        </header>

        <div className="settings-grid">
          <label>
            <span>WSL 发行版</span>
            <select
              value={props.settings.selectedDistro ?? ""}
              onChange={event => {
                const installation = props.environment.installations.find(item => item.distro === event.target.value);
                props.onUpdate({
                  selectedDistro: event.target.value,
                  selectedInstallationPath: installation?.executablePath,
                });
              }}
            >
              {props.environment.installations.map(installation => (
                <option key={installation.distro} value={installation.distro}>{installation.distro}</option>
              ))}
            </select>
          </label>

          <label>
            <span>界面主题</span>
            <select
              value={props.settings.themeMode}
              onChange={event => props.onUpdate({ themeMode: event.target.value as AppSettings["themeMode"] })}
            >
              <option value="system">跟随系统和 OMP</option>
              <option value="dark">固定 OMP 深色主题</option>
              <option value="light">固定 OMP 浅色主题</option>
            </select>
          </label>

          <label>
            <span>OMP Profile（可选）</span>
            <input
              value={props.settings.profile ?? ""}
              placeholder="默认 Profile"
              onChange={event => props.onUpdate({ profile: event.target.value || undefined })}
            />
          </label>
        </div>

        <div className="diagnostic-cards">
          {props.environment.installations.map(installation => (
            <div className="diagnostic-card" key={`${installation.distro}-${installation.executablePath}`}>
              <CheckCircle2 size={17} />
              <div><strong>OMP {installation.version}</strong><span>{installation.executablePath}</span></div>
              <em>{installation.distro}</em>
            </div>
          ))}
          {props.environment.diagnostics.map(message => (
            <div className="diagnostic-card diagnostic-card--warning" key={message}>
              <CircleAlert size={17} /><div><strong>诊断信息</strong><span>{message}</span></div>
            </div>
          ))}
        </div>

        {props.theme && (
          <div className="theme-summary">
            <span className="theme-swatch" />
            <div><strong>{props.theme.name}</strong><small>深色 {props.theme.darkTheme} · 浅色 {props.theme.lightTheme}</small></div>
            <em>{props.theme.source === "custom" ? "自定义主题" : "OMP 内置主题"}</em>
          </div>
        )}

        <footer><button className="primary-button" onClick={props.onClose}>完成</button></footer>
      </section>
    </div>
  );
}
