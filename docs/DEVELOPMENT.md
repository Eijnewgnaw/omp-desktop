# Development guide

This document covers source setup, validation, packaging, and release conventions for OMP Desktop. The project README intentionally focuses on the product.

## Prerequisites

- Node.js 22.20 or newer
- npm
- macOS for native OMP and DMG/ZIP validation, or Windows 11 with native Windows OMP and WSL2 OMP
- A working OMP installation for the opt-in real RPC integration test

WSLg can run the Linux development shell. Release targets are one Apple Silicon macOS package set and one Windows x64 package; the Windows package supports both native Windows OMP and WSL2 OMP, while each runtime adapter and Profile remains isolated.

## Setup

```bash
git clone git@github.com:Eijnewgnaw/omp-desktop.git
cd omp-desktop
npm ci
npm run dev
```

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run test:integration
npm run test:e2e:resume
npm run test:e2e:profile
```

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type-check main, preload, shared, and renderer code. |
| `npm test` | Run unit, boundary, lifecycle, session-index, deletion, metadata, and terminal-launch tests. |
| `npm run build` | Produce the production Electron bundles. |
| `npm run test:integration` | Negotiate RPC with the installed OMP, read state, and list models without sending a model prompt. |
| `npm run test:e2e` | Run the visual Electron smoke test. |
| `npm run test:e2e:resume` | Exercise resume/send, model switching, continuation frames, error recovery, reconnects, session controls, workspace ownership, and terminal handoff with a fake OMP runtime. |
| `npm run test:e2e:profile` | Exercise Default/named Profile discovery, selectors, saved-session routing, theme isolation, and new-session agent-directory isolation. |

The real OMP integration test is opt-in and intentionally does not call a model. Packaged changes should also be verified against an installed build and the real macOS Terminal or Windows Terminal handoff path.

## Build macOS packages

On Apple Silicon:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist -- --mac --arm64 --publish never
```

DMG and ZIP artifacts are written to `release/`. Current macOS packages are unsigned and not notarized; do not describe them as signed or notarized.

## Build a Windows installer

```bash
npm run dist -- --win --x64 --publish never
```

Artifacts are written to `release/`. The current installer is unsigned; do not describe it as signed or bypass SmartScreen warnings in automation.

## Repository structure

```text
src/
  main/       Environment discovery, OMP lifecycle, session indexing, themes, and IPC
  preload/    Minimal typed bridge exposed to the renderer
  renderer/   React conversation and session-management interface
  shared/     Cross-process contracts and generated OMP theme data
tests/        Unit, integration, security, and Electron end-to-end tests
docs/         Architecture, development notes, and product images
scripts/      Theme synchronization utilities
build/        Application icons
```

## Project conventions

- OMP is the only agent runtime and source of truth for model, tool, rule, extension, permission, and session semantics.
- Do not rewrite OMP JSONL conversations. Desktop-only names, pins, archive state, tags, and preferences belong in the app metadata database.
- A saved session is bound to the OMP installation, Profile, agent directory, and working directory that produced it. Do not implicitly translate between Windows, WSL, or Profile identities.
- Validate all IPC input in the main process and keep Node.js unavailable to the renderer.
- Unknown RPC frames must remain forward-compatible and must not crash the app.
- Runtime replacement and destructive session operations must preserve single-writer ownership.
- UI colors should come from OMP semantic theme tokens instead of a parallel theme system.
- When synchronizing bundled OMP themes, update the recorded source version and preserve the upstream MIT notice in `THIRD_PARTY_NOTICES.md`.
- Every deletion path must resolve an exact indexed target, enforce containment, reject symlinks or unexpected artifact types, and have regression coverage.

## Release checklist

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
2. Run type-checking, unit tests, production build, real OMP handshake, and Electron E2E.
3. Build and install the platform artifacts, then test Default and named Profiles on native macOS, native Windows and WSL, including each visible terminal-handoff path.
4. Open a pull request and wait for CI.
5. Merge before creating the release tag.
6. Wait for the macOS and Windows Release jobs and verify every public asset.
7. Treat release or tag deletion as destructive and perform it only after the replacement release is healthy.

See [Architecture](ARCHITECTURE.md), [Security](../SECURITY.md), and [Contributing](../CONTRIBUTING.md) for the remaining project policies.
