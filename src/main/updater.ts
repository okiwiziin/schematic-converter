// Keeps installed copies up to date from GitHub Releases. Updates download in the background and
// apply when the user restarts, or on the next quit. The portable build can't replace itself, so
// it only says a new version is out and points to the release page.
import { app, shell } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateState } from "../shared/ipc";

const RELEASE_PAGE =
  "https://github.com/okiwiziin/schematic-converter/releases/latest";
const FIRST_CHECK_DELAY = 10 * 1000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export class Updater {
  state: UpdateState = app.isPackaged
    ? { status: "idle" }
    : { status: "unavailable" };
  private readonly portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  private firstCheck: NodeJS.Timeout | null = null;
  private recheck: NodeJS.Timeout | null = null;
  // Failing quietly is right for a background check, but not for one the user asked for.
  private manual = false;

  constructor(private readonly onChange: (state: UpdateState) => void) {
    if (!app.isPackaged) {
      return;
    }
    autoUpdater.logger = null;
    autoUpdater.autoDownload = !this.portable;
    autoUpdater.autoInstallOnAppQuit = !this.portable;
    autoUpdater.on("checking-for-update", () =>
      this.set({ status: "checking" })
    );
    autoUpdater.on("update-not-available", () =>
      this.set({ status: "current" })
    );
    autoUpdater.on("update-available", ({ version }) => {
      this.set(
        this.portable
          ? { status: "available", version }
          : { percent: 0, status: "downloading", version }
      );
    });
    autoUpdater.on("download-progress", ({ percent }) => {
      if (this.state.status !== "downloading") {
        return;
      }
      const rounded = Math.floor(percent);
      if (rounded !== this.state.percent) {
        this.set({ ...this.state, percent: rounded });
      }
    });
    autoUpdater.on("update-downloaded", ({ version }) =>
      this.set({ status: "ready", version })
    );
    autoUpdater.on("error", () => {
      if (this.state.status === "ready") {
        return;
      }
      this.set(
        this.manual
          ? {
              message: "Couldn't check for updates. Are you online?",
              status: "error",
            }
          : { status: "idle" }
      );
    });
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.onChange(state);
  }

  setAutomatic(automatic: boolean): void {
    if (!app.isPackaged) {
      return;
    }
    if (this.firstCheck) {
      clearTimeout(this.firstCheck);
    }
    if (this.recheck) {
      clearInterval(this.recheck);
    }
    this.firstCheck = null;
    this.recheck = null;
    if (!automatic) {
      return;
    }
    this.firstCheck = setTimeout(() => this.check(false), FIRST_CHECK_DELAY);
    this.recheck = setInterval(() => this.check(false), CHECK_INTERVAL);
  }

  check(manual: boolean): void {
    if (!app.isPackaged) {
      return;
    }
    // Nothing to gain from checking again while one is on its way or waiting for a restart.
    if (["checking", "downloading", "ready"].includes(this.state.status)) {
      return;
    }
    this.manual = manual;
    autoUpdater.checkForUpdates().catch(() => {
      // Reported through the "error" event as well, so there's nothing more to do here.
    });
  }

  install(): void {
    if (this.state.status === "ready") {
      autoUpdater.quitAndInstall(true, true);
    } else if (this.state.status === "available") {
      void shell.openExternal(RELEASE_PAGE);
    }
  }
}
