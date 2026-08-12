import { CheckCircle2, CircleAlert, X } from "lucide-react";
import type {
  AppSettings,
  EnvironmentInfo,
  OmpInstallation,
  ThemeSnapshot,
} from "../../shared/contracts";
import {
  installationsForLocation,
  RUNTIME_LOCATION_LABELS,
  RUNTIME_LOCATIONS,
  runtimeLocation,
  type RuntimeLocation,
  visibleRuntimeInstallations,
} from "../runtime-location";

function profileValue(installation: Pick<OmpInstallation, "profile">): string {
  return installation.profile ?? "";
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

function preferredInstallation(
  candidates: readonly OmpInstallation[],
  preferredProfile: string,
  preferredDistro?: string,
): OmpInstallation | undefined {
  return candidates.find(item => profileValue(item) === preferredProfile && item.distro === preferredDistro)
    ?? candidates.find(item => profileValue(item) === preferredProfile)
    ?? candidates.find(item => profileValue(item) === "" && item.distro === preferredDistro)
    ?? candidates.find(item => profileValue(item) === "")
    ?? candidates[0];
}

function profileSummary(installations: readonly OmpInstallation[]): string {
  const namedProfiles = sortedUnique(installations.flatMap(item => item.profile ? [item.profile] : []));
  const hasDefault = installations.some(item => !item.profile);
  if (hasDefault && namedProfiles.length === 0) return "Default";
  if (hasDefault) return `Default + ${namedProfiles.length} 个 Profile`;
  return `${namedProfiles.length} 个 Profile`;
}

interface SettingsDialogProps {
  environment: EnvironmentInfo;
  settings: AppSettings;
  theme?: ThemeSnapshot;
  onClose(): void;
  onUpdate(patch: Partial<AppSettings>): void;
}

export function SettingsDialog(props: SettingsDialogProps): React.JSX.Element {
  const installations = visibleRuntimeInstallations(props.environment.installations);
  const selectedInstallation = installations.find(item => item.id === props.settings.selectedInstallationId);
  const availableBackends = RUNTIME_LOCATIONS.filter(kind =>
    installations.some(item => runtimeLocation(item.kind) === kind));
  const backendInstallations = selectedInstallation
    ? installationsForLocation(installations, runtimeLocation(selectedInstallation.kind))
    : [];
  const profileInstallations = selectedInstallation?.kind === "wsl" && selectedInstallation.distro
    ? backendInstallations.filter(item => item.distro === selectedInstallation.distro)
    : backendInstallations;
  const profiles = sortedUnique(profileInstallations.map(profileValue));
  const distros = selectedInstallation?.kind === "wsl"
    ? sortedUnique(backendInstallations.flatMap(item => item.distro ? [item.distro] : []))
    : [];

  const chooseBackend = (kind: RuntimeLocation): void => {
    const candidates = installationsForLocation(installations, kind);
    const target = preferredInstallation(
      candidates,
      selectedInstallation ? profileValue(selectedInstallation) : "",
      selectedInstallation?.distro,
    );
    if (target) props.onUpdate({ selectedInstallationId: target.id });
  };

  const chooseProfile = (profile: string): void => {
    if (!selectedInstallation) return;
    const candidates = profileInstallations.filter(item => profileValue(item) === profile);
    const target = candidates[0];
    if (target) props.onUpdate({ selectedInstallationId: target.id });
  };

  const chooseDistro = (distro: string): void => {
    if (selectedInstallation?.kind !== "wsl") return;
    const candidates = backendInstallations.filter(item => item.distro === distro);
    const target = preferredInstallation(candidates, profileValue(selectedInstallation), distro);
    if (target) props.onUpdate({ selectedInstallationId: target.id });
  };

  return (
    <div className="modal-backdrop">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
        <header>
          <div><small>OMP DESKTOP</small><h2>设置与诊断</h2></div>
          <button className="icon-button" onClick={props.onClose}><X size={17} /></button>
        </header>

        <div className="settings-grid">
          <label>
            <span>默认新会话运行位置</span>
            <select
              aria-label="默认新会话运行位置"
              value={selectedInstallation ? runtimeLocation(selectedInstallation.kind) : ""}
              onChange={event => chooseBackend(event.target.value as RuntimeLocation)}
            >
              {availableBackends.length === 0 && <option value="">未检测到 OMP</option>}
              {!selectedInstallation && availableBackends.length > 0 && <option value="">请选择运行位置</option>}
              {availableBackends.map(kind => (
                <option key={kind} value={kind}>{RUNTIME_LOCATION_LABELS[kind]}</option>
              ))}
            </select>
          </label>

          <label>
            <span>默认 OMP Profile</span>
            <select
              aria-label="默认 OMP Profile"
              value={selectedInstallation ? profileValue(selectedInstallation) : ""}
              disabled={!selectedInstallation}
              onChange={event => chooseProfile(event.target.value)}
            >
              {!selectedInstallation && <option value="">先选择运行位置</option>}
              {selectedInstallation && profiles.length === 0 && <option value="">Default</option>}
              {profiles.map(profile => (
                <option key={profile || "__default__"} value={profile}>{profile || "Default"}</option>
              ))}
            </select>
          </label>

          {distros.length > 1 && (
            <label>
              <span>默认 WSL 发行版</span>
              <select
                aria-label="默认 WSL 发行版"
                value={selectedInstallation?.distro ?? ""}
                onChange={event => chooseDistro(event.target.value)}
              >
                {distros.map(distro => <option key={distro} value={distro}>{distro}</option>)}
              </select>
            </label>
          )}

          <label className="settings-grid__theme">
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

        </div>

        <div className="diagnostic-cards">
          {availableBackends.map(kind => {
            const backendItems = installationsForLocation(installations, kind);
            const versions = sortedUnique(backendItems.map(item => item.version));
            const backendDistros = sortedUnique(backendItems.flatMap(item => item.distro ? [item.distro] : []));
            const executablePaths = sortedUnique(backendItems.map(item => item.executablePath));
            const detail = kind === "wsl" && backendDistros.length > 0
              ? `${backendDistros.join("、")} · ${executablePaths.join(" · ")}`
              : executablePaths.join(" · ");
            return (
            <div className="diagnostic-card" key={kind}>
              <CheckCircle2 size={17} />
              <div>
                <strong>{RUNTIME_LOCATION_LABELS[kind]} · OMP {versions.join(" / ")}</strong>
                <span title={detail}>{detail}</span>
              </div>
              <em>{profileSummary(backendItems)}</em>
            </div>
            );
          })}
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
