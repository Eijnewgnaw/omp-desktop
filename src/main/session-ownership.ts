import type {
  AppSettings,
  OmpInstallation,
  RuntimeDescriptor,
  SessionHandoff,
  StartRuntimeInput,
} from "../shared/contracts";
import { assertLogicalPath, installationDataDir } from "./security";
import type { OwnedRuntime } from "./runtime-manager";

interface RuntimeOwnershipSource {
  list(): RuntimeDescriptor[];
  listOwned?(): OwnedRuntime[];
  start(installation: OmpInstallation, input: StartRuntimeInput): Promise<RuntimeDescriptor>;
  stop(runtimeId: string): Promise<void>;
}

interface SettingsOwnershipSource {
  getSettings(): AppSettings;
  updateSettings(patch: Partial<AppSettings>): AppSettings;
  writeSettings(patch: Partial<AppSettings>): void;
}

type Operation<T> = () => T | Promise<T>;

function logicalPathIdentity(installation: Pick<OmpInstallation, "kind">, value: string): string {
  const normalized = assertLogicalPath(installation, value, "session path");
  return installation.kind === "windows-native" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function sameLogicalPath(installation: Pick<OmpInstallation, "kind">, left: string, right: string): boolean {
  try {
    return logicalPathIdentity(installation, left) === logicalPathIdentity(installation, right);
  } catch {
    return false;
  }
}

function handoffMatchesInstallation(installation: OmpInstallation, handoff: SessionHandoff): boolean {
  if (handoff.installationId) return handoff.installationId === installation.id;
  if (installation.kind !== "wsl") return false;
  if (handoff.distro && handoff.distro !== installation.distro) return false;
  if (handoff.installationPath && handoff.installationPath !== installation.executablePath) return false;
  return Boolean(handoff.distro || handoff.installationPath);
}

function samePhysicalInstallation(left: OmpInstallation, right: OmpInstallation): boolean {
  if (left.kind !== right.kind || left.distro !== right.distro) return false;
  return logicalPathIdentity(left, installationDataDir(left))
    === logicalPathIdentity(right, installationDataDir(right));
}

/** Main-process authority for every operation that can create or destroy a session writer. */
export class SessionOwnershipCoordinator {
  readonly #runtimes: RuntimeOwnershipSource;
  readonly #settings: SettingsOwnershipSource;
  #transition: Promise<void> = Promise.resolve();

  constructor(runtimes: RuntimeOwnershipSource, settings: SettingsOwnershipSource) {
    this.#runtimes = runtimes;
    this.#settings = settings;
  }

  updateSettings<T>(operation: Operation<T>): Promise<T> {
    return this.#exclusive(operation);
  }

  startRuntime(
    installation: OmpInstallation,
    input: StartRuntimeInput,
  ): Promise<RuntimeDescriptor> {
    return this.#exclusive(async () => {
      if (input.sessionPath && this.#findHandoff(installation, input.sessionPath)) {
        throw new Error("Session is handed off to an OMP terminal; reclaim it before resuming in OMP Desktop");
      }
      return this.#runtimes.start(installation, input);
    });
  }

  reclaimSession(
    installation: OmpInstallation,
    input: StartRuntimeInput & { sessionPath: string },
  ): Promise<{ descriptor: RuntimeDescriptor; settings: AppSettings }> {
    return this.#exclusive(async () => {
      const current = this.#settings.getSettings();
      const lease = this.#findHandoff(installation, input.sessionPath, current);
      if (!lease) throw new Error("Session is not handed off to an OMP terminal");
      const descriptor = await this.#runtimes.start(installation, input);
      try {
        const remaining = (current.handedOffSessions ?? []).filter(item => item !== lease);
        this.#settings.writeSettings({ handedOffSessions: remaining });
        return { descriptor, settings: { ...current, handedOffSessions: remaining } };
      } catch (error) {
        try {
          await this.#runtimes.stop(descriptor.runtimeId);
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            "OMP Desktop started reclaiming the session but could not persist ownership or safely stop its runtime",
          );
        }
        throw error;
      }
    });
  }

  trashSession<T>(installation: OmpInstallation, sessionPath: string, operation: Operation<T>): Promise<T> {
    return this.#destructive(installation, sessionPath, operation);
  }

  deleteSession<T>(installation: OmpInstallation, sessionPath: string, operation: Operation<T>): Promise<T> {
    return this.#destructive(installation, sessionPath, operation);
  }

  handoffToTerminal(
    installation: OmpInstallation,
    input: StartRuntimeInput & { sessionPath: string },
    launch: Operation<void>,
    handedOffAt = new Date().toISOString(),
  ): Promise<AppSettings> {
    return this.#exclusive(async () => {
      if (this.#hasRuntime(installation, input.sessionPath)) {
        throw new Error("Session is still active in OMP Desktop; stop it before opening an OMP terminal");
      }
      if (this.#findHandoff(installation, input.sessionPath)) {
        throw new Error("Session is already handed off to an OMP terminal");
      }

      const lease: SessionHandoff = {
        installationId: installation.id,
        sessionPath: input.sessionPath,
        cwd: input.path,
        handedOffAt,
        ...(installation.kind === "wsl" ? { distro: installation.distro } : {}),
      };
      const before = this.#settings.getSettings();
      const existingLeases = before.handedOffSessions ?? [];
      if (existingLeases.length >= 256) {
        throw new Error("Too many active terminal ownership leases; reclaim one before opening another terminal");
      }
      const leases = [...existingLeases, lease];
      this.#settings.writeSettings({ handedOffSessions: leases });
      const persisted = { ...before, handedOffSessions: leases };
      try {
        await launch();
        return persisted;
      } catch (error) {
        try {
          this.#settings.writeSettings({ handedOffSessions: before.handedOffSessions ?? [] });
        } catch (rollbackError) {
          // Keeping the persisted lease is conservative: the terminal may have
          // started even though launch verification failed.
          throw new AggregateError(
            [error, rollbackError],
            "OMP terminal launch failed and its conservative ownership lock could not be rolled back",
          );
        }
        throw error;
      }
    });
  }

  async #destructive<T>(installation: OmpInstallation, sessionPath: string, operation: Operation<T>): Promise<T> {
    return this.#exclusive(async () => {
      if (this.#hasRuntime(installation, sessionPath)) {
        throw new Error("Session is still active in OMP Desktop; stop it before deleting or moving it");
      }
      if (this.#findHandoff(installation, sessionPath)) {
        throw new Error("Session is handed off to an OMP terminal; reclaim it before deleting or moving it");
      }
      return operation();
    });
  }

  #hasRuntime(installation: OmpInstallation, sessionPath: string): boolean {
    const owned = this.#runtimes.listOwned?.();
    if (owned) {
      return owned.some(runtime => samePhysicalInstallation(runtime.installation, installation)
        && (!runtime.descriptor.sessionPath
          || sameLogicalPath(installation, runtime.descriptor.sessionPath, sessionPath)));
    }
    return this.#runtimes.list().some(runtime => runtime.installationId === installation.id
      && (!runtime.sessionPath || sameLogicalPath(installation, runtime.sessionPath, sessionPath)));
  }

  #findHandoff(
    installation: OmpInstallation,
    sessionPath: string,
    settings = this.#settings.getSettings(),
  ): SessionHandoff | undefined {
    return settings.handedOffSessions?.find(handoff => {
      const exact = handoffMatchesInstallation(installation, handoff);
      const physicalFallback = !exact && sameLogicalPath(installation, handoff.sessionPath, sessionPath)
        && (installation.kind !== "wsl" || !handoff.distro || handoff.distro === installation.distro);
      return (exact || physicalFallback) && sameLogicalPath(installation, handoff.sessionPath, sessionPath);
    });
  }

  async #exclusive<T>(operation: Operation<T>): Promise<T> {
    const previous = this.#transition;
    let release!: () => void;
    this.#transition = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
