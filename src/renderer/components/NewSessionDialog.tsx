import { Bot, FolderOpen, LoaderCircle, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { OmpInstallation } from "../../shared/contracts";
import {
  installationsForLocation,
  RUNTIME_LOCATION_LABELS,
  RUNTIME_LOCATIONS,
  runtimeLocation,
  type RuntimeLocation,
  visibleRuntimeInstallations,
} from "../runtime-location";

export interface NewSessionDialogProps {
  installations: readonly OmpInstallation[];
  selectedInstallationId?: string;
  workspace?: string;
  selectingWorkspace?: boolean;
  creating?: boolean;
  error?: string;
  onSelectInstallation(installationId: string): void;
  onChooseWorkspace(): void;
  onCancel(): void;
  onConfirm(): void;
}

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

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>([
    "button:not(:disabled)",
    "select:not(:disabled)",
    "input:not(:disabled)",
    "[href]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(","))).filter(element => element.getAttribute("aria-hidden") !== "true");
}

export function NewSessionDialog(props: NewSessionDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const chooseWorkspaceRef = useRef<HTMLButtonElement>(null);

  const installations = useMemo(
    () => visibleRuntimeInstallations(props.installations),
    [props.installations],
  );
  const selectedInstallation = installations.find(item => item.id === props.selectedInstallationId);
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
  const controlsBusy = Boolean(props.creating || props.selectingWorkspace);
  const canCreate = Boolean(selectedInstallation && props.workspace && !controlsBusy);

  useEffect(() => {
    const preferred = chooseWorkspaceRef.current;
    const first = dialogRef.current ? focusableElements(dialogRef.current)[0] : undefined;
    (preferred && !preferred.disabled ? preferred : first)?.focus();
  }, []);

  const chooseBackend = (kind: RuntimeLocation): void => {
    if (controlsBusy || (selectedInstallation && runtimeLocation(selectedInstallation.kind) === kind)) return;
    const candidates = installationsForLocation(installations, kind);
    const target = preferredInstallation(
      candidates,
      selectedInstallation ? profileValue(selectedInstallation) : "",
      selectedInstallation?.distro,
    );
    if (target) props.onSelectInstallation(target.id);
  };

  const moveBackendSelection = (offset: -1 | 1): void => {
    if (controlsBusy || availableBackends.length < 2) return;
    const currentLocation = selectedInstallation
      ? runtimeLocation(selectedInstallation.kind)
      : availableBackends[0];
    if (!currentLocation) return;
    const currentIndex = Math.max(0, availableBackends.indexOf(currentLocation));
    const nextIndex = (currentIndex + offset + availableBackends.length) % availableBackends.length;
    const next = availableBackends[nextIndex];
    if (next) chooseBackend(next);
  };

  const chooseProfile = (profile: string): void => {
    if (!selectedInstallation || controlsBusy) return;
    const candidates = profileInstallations.filter(item => profileValue(item) === profile);
    const target = candidates[0];
    if (target) props.onSelectInstallation(target.id);
  };

  const chooseDistro = (distro: string): void => {
    if (selectedInstallation?.kind !== "wsl" || controlsBusy) return;
    const candidates = backendInstallations.filter(item => item.distro === distro);
    const target = preferredInstallation(candidates, profileValue(selectedInstallation), distro);
    if (target) props.onSelectInstallation(target.id);
  };

  const cancel = (): void => {
    if (!props.creating) props.onCancel();
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <section
        ref={dialogRef}
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-dialog-title"
        aria-describedby="new-session-dialog-description"
        aria-busy={props.creating || undefined}
        onKeyDown={event => {
          if (event.key === "Escape") {
            if (!props.creating) {
              event.preventDefault();
              event.stopPropagation();
              props.onCancel();
            }
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = dialogRef.current ? focusableElements(dialogRef.current) : [];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) {
            event.preventDefault();
            return;
          }
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
          <span><Bot size={18} /></span>
          <div>
            <small>OMP DESKTOP</small>
            <h2 id="new-session-dialog-title">新建会话</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={props.creating}
            onClick={cancel}
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </header>

        <form
          onSubmit={event => {
            event.preventDefault();
            if (canCreate) props.onConfirm();
          }}
        >
          <div className="new-session-dialog__body">
            <p id="new-session-dialog-description">
              选择本次会话使用的位置、OMP Profile 和项目目录。它们只会绑定到这个会话。
              只有确认创建后才会切换；取消不会中断当前会话。
            </p>

            <div className="new-session-field">
              <span id="new-session-backend-label">运行位置</span>
              {availableBackends.length > 0 ? (
                <div
                  className="new-session-backends"
                  role="radiogroup"
                  aria-labelledby="new-session-backend-label"
                >
                  {availableBackends.map(kind => (
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={selectedInstallation ? runtimeLocation(selectedInstallation.kind) === kind : false}
                      className={selectedInstallation && runtimeLocation(selectedInstallation.kind) === kind ? "is-selected" : undefined}
                      tabIndex={selectedInstallation
                        ? runtimeLocation(selectedInstallation.kind) === kind ? 0 : -1
                        : kind === availableBackends[0] ? 0 : -1}
                      disabled={controlsBusy}
                      onClick={() => chooseBackend(kind)}
                      onKeyDown={event => {
                        if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
                          event.preventDefault();
                          const offset = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
                          moveBackendSelection(offset);
                          const nextIndex = (availableBackends.indexOf(kind) + offset + availableBackends.length)
                            % availableBackends.length;
                          const nextKind = availableBackends[nextIndex];
                          window.requestAnimationFrame(() => {
                            dialogRef.current?.querySelector<HTMLButtonElement>(`[role="radio"][data-runtime-location="${nextKind}"]`)?.focus();
                          });
                        }
                      }}
                      data-runtime-location={kind}
                    >
                      <span>{RUNTIME_LOCATION_LABELS[kind]}</span>
                      <small>{kind === "macos-native"
                        ? "使用 macOS 中安装的 OMP"
                        : kind === "windows-native"
                          ? "使用 Windows 中安装的 OMP"
                          : "使用 WSL 中安装的 OMP"}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="new-session-empty" role="status">
                  未检测到可用的 OMP
                </div>
              )}
            </div>

            <label className="new-session-field">
              <span>OMP Profile</span>
              <select
                aria-label="OMP Profile"
                value={selectedInstallation ? profileValue(selectedInstallation) : ""}
                disabled={!selectedInstallation || controlsBusy}
                onChange={event => chooseProfile(event.target.value)}
              >
                {profiles.length === 0 && <option value="">Default</option>}
                {profiles.map(profile => (
                  <option key={profile || "__default__"} value={profile}>
                    {profile || "Default"}
                  </option>
                ))}
              </select>
            </label>

            {selectedInstallation?.kind === "wsl" && distros.length > 1 && (
              <label className="new-session-field">
                <span>WSL 发行版</span>
                <select
                  aria-label="WSL 发行版"
                  value={selectedInstallation.distro ?? ""}
                  disabled={controlsBusy}
                  onChange={event => chooseDistro(event.target.value)}
                >
                  {distros.map(distro => <option key={distro} value={distro}>{distro}</option>)}
                </select>
              </label>
            )}

            <div className="new-session-field">
              <span>项目目录</span>
              <div className="new-session-workspace">
                <FolderOpen size={17} />
                <output aria-label="项目目录" title={props.workspace}>
                  {props.workspace || "尚未选择项目文件夹"}
                </output>
                <button
                  ref={chooseWorkspaceRef}
                  type="button"
                  className="secondary-button"
                  aria-label="选择项目文件夹"
                  disabled={!selectedInstallation || controlsBusy}
                  onClick={props.onChooseWorkspace}
                >
                  {props.selectingWorkspace
                    ? <><LoaderCircle className="spin" size={15} />正在选择…</>
                    : <><FolderOpen size={15} />选择项目文件夹</>}
                </button>
              </div>
            </div>

            {props.error && <p className="new-session-dialog__error" role="alert">{props.error}</p>}
          </div>

          <footer>
            <button
              type="button"
              className="secondary-button"
              disabled={props.creating}
              onClick={cancel}
            >
              取消
            </button>
            <button type="submit" className="primary-button" disabled={!canCreate}>
              {props.creating
                ? <><LoaderCircle className="spin" size={15} />正在创建…</>
                : <><Plus size={15} />创建会话</>}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
