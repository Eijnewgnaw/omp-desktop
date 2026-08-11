import type { OmpDesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    ompDesktop: OmpDesktopApi;
  }
}

export {};
