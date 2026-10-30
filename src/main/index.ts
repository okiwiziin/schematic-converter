import { randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { cpus, release } from "node:os";
import { dirname, extname, join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeTheme,
  shell,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import { listBlocks18 } from "../engine/mapping/resolver";
import type { EngineRequest, EngineResponse } from "../engine/worker";
import {
  type AppEvent,
  DEFAULT_SETTINGS,
  type JobState,
  type Settings,
  SUPPORTED_EXTENSIONS,
} from "../shared/ipc";
import { DEFAULT_OPTIONS } from "../shared/types";
import { Updater } from "./updater";

const THREADS = cpus().length;
const SETTINGS_PATH = (): string =>
  join(app.getPath("userData"), "settings.json");
const WORKER_PATH = (): string => join(import.meta.dirname, "engine.js");

let window: BrowserWindow | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
const jobs = new Map<string, JobState>();
let updater: Updater;

function send(event: AppEvent): void {
  window?.webContents.send("app-event", event);
}

async function loadSettings(): Promise<void> {
  try {
    const saved = JSON.parse(
      await readFile(SETTINGS_PATH(), "utf8")
    ) as Partial<Settings>;
    settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      options: { ...DEFAULT_OPTIONS, ...saved.options },
    };
  } catch {
    settings = { ...DEFAULT_SETTINGS, outputDir: app.getPath("documents") };
  }
  if (!settings.outputDir) {
    settings.outputDir = join(app.getPath("documents"), "Schematic Converter");
  }
}

async function saveSettings(): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH()), { recursive: true });
  await writeFile(SETTINGS_PATH(), JSON.stringify(settings, null, 2));
}

// ---- Engine processes

function spawnEngine(): UtilityProcess {
  return utilityProcess.fork(WORKER_PATH(), [], {
    // The compressor runs on libuv's pool, which has to be sized before the process starts.
    env: {
      ...process.env,
      UV_THREADPOOL_SIZE: String(Math.max(4, THREADS + 2)),
    },
    serviceName: "Schematic Converter Engine",
    stdio: "ignore",
  });
}

// A single long-lived process reads file headers, one at a time.
let inspector: UtilityProcess | null = null;
const inspectQueue: string[] = [];
let inspecting: string | null = null;

function pumpInspector(): void {
  if (inspecting !== null) {
    return;
  }
  const next = inspectQueue.shift();
  if (next === undefined) {
    return;
  }
  const job = jobs.get(next);
  if (!job) {
    pumpInspector();
    return;
  }
  inspecting = next;
  if (!inspector) {
    inspector = spawnEngine();
    inspector.on("message", (message: EngineResponse) => {
      const id = inspecting;
      inspecting = null;
      if (id && jobs.has(id)) {
        const current = jobs.get(id)!;
        if (message.kind === "inspected") {
          updateJob(id, {
            info: message.info,
            status: current.status === "inspecting" ? "ready" : current.status,
          });
        } else if (message.kind === "failed") {
          updateJob(id, { error: message.message, status: "failed" });
        }
      }
      pumpInspector();
      pumpQueue();
    });
    inspector.on("exit", () => {
      inspector = null;
      if (inspecting) {
        const id = inspecting;
        inspecting = null;
        if (jobs.has(id)) {
          updateJob(id, { error: "Couldn't read this file", status: "failed" });
        }
        pumpInspector();
      }
    });
  }
  const request: EngineRequest = { id: next, kind: "inspect", path: job.path };
  inspector.postMessage(request);
}

function updateJob(id: string, patch: Partial<JobState>): void {
  const job = jobs.get(id);
  if (!job) {
    return;
  }
  const updated = { ...job, ...patch };
  jobs.set(id, updated);
  send({ job: updated, type: "job" });
}

// ---- Conversion queue

const running = new Map<string, { process: UtilityProcess; tempDir: string }>();

function concurrency(): number {
  return Math.max(1, settings.parallelJobs);
}

function pumpQueue(): void {
  if (running.size >= concurrency()) {
    return;
  }
  for (const job of jobs.values()) {
    if (running.size >= concurrency()) {
      return;
    }
    if (job.status !== "queued") {
      continue;
    }
    startJob(job);
  }
}

function startJob(job: JobState): void {
  const outputDir = settings.outputDir;
  const tempDir = join(outputDir, `.schematic-converter-${job.id}`);
  const child = spawnEngine();
  running.set(job.id, { process: child, tempDir });
  updateJob(job.id, {
    error: undefined,
    progress: undefined,
    startedAt: Date.now(),
    status: "converting",
  });

  const threads = Math.max(
    2,
    Math.floor(THREADS / Math.min(concurrency(), 1 + running.size))
  );
  let finished = false;
  const finish = (patch: Partial<JobState>): void => {
    if (finished) {
      return;
    }
    finished = true;
    running.delete(job.id);
    updateJob(job.id, patch);
    // Whatever a failed or cancelled job left behind goes too.
    void rm(tempDir, { force: true, recursive: true }).catch(() => {
      // Temporary files that can't be removed yet are harmless.
    });
    pumpQueue();
  };

  child.on("message", (message: EngineResponse) => {
    if (message.kind === "progress") {
      updateJob(job.id, { progress: message.progress });
    } else if (message.kind === "done") {
      finish({ progress: undefined, report: message.report, status: "done" });
      child.kill();
    } else if (message.kind === "failed") {
      finish({ error: message.message, progress: undefined, status: "failed" });
      child.kill();
    }
  });
  child.on("exit", (code) => {
    if (code === 0) {
      finish({
        error: "The conversion stopped without finishing.",
        progress: undefined,
        status: "failed",
      });
    } else {
      finish({
        error:
          "The conversion stopped unexpectedly. If this was a very large map, check there's enough free disk space next to the output folder.",
        progress: undefined,
        status: "failed",
      });
    }
  });

  const request: EngineRequest = {
    id: job.id,
    kind: "convert",
    options: settings.options,
    outputDir,
    path: job.path,
    tempDir,
    threads,
  };
  child.postMessage(request);
}

// ---- File intake

async function expandPaths(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    let info: Stats;
    try {
      info = await stat(path);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      if (depth > 8) {
        return;
      }
      for (const entry of await readdir(path)) {
        await visit(join(path, entry), depth + 1);
      }
    } else if (SUPPORTED_EXTENSIONS.includes(extname(path).toLowerCase())) {
      found.push(path);
    }
  };
  for (const path of paths) {
    await visit(path, 0);
  }
  return found;
}

async function addPaths(paths: string[]): Promise<void> {
  const files = await expandPaths(paths);
  const known = new Set([...jobs.values()].map((job) => job.path));
  let firstId: string | null = null;
  for (const path of files) {
    if (known.has(path)) {
      continue;
    }
    known.add(path);
    const size = (await stat(path)).size;
    const id = randomUUID();
    firstId ??= id;
    const job: JobState = {
      id,
      name: path.split(/[\\/]/u).at(-1) ?? path,
      path,
      size,
      status: "inspecting",
    };
    jobs.set(id, job);
    send({ job, type: "job" });
    inspectQueue.push(id);
  }
  if (firstId) {
    send({ id: firstId, type: "select" });
  }
  pumpInspector();
}

// ---- IPC

const handle = <A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => R | Promise<R>
): void => {
  ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: unknown[]) =>
    fn(...(args as A))
  );
};

function registerIpc(): void {
  handle("get-state", () => ({
    jobs: [...jobs.values()],
    settings,
    threads: THREADS,
    update: updater.state,
    version: app.getVersion(),
  }));
  handle("blocks-18", () => listBlocks18());
  handle("pick-files", async () => {
    if (!window) {
      return;
    }
    const result = await dialog.showOpenDialog(window, {
      filters: [
        {
          extensions: SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1)),
          name: "Schematics",
        },
        { extensions: ["*"], name: "All files" },
      ],
      properties: ["openFile", "multiSelections"],
      title: "Add schematics",
    });
    if (!result.canceled) {
      await addPaths(result.filePaths);
    }
  });
  handle("pick-folder", async () => {
    if (!window) {
      return;
    }
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
      title: "Add a folder of schematics",
    });
    if (!result.canceled) {
      await addPaths(result.filePaths);
    }
  });
  handle("add-paths", (paths: string[]) =>
    addPaths(paths.filter((path) => typeof path === "string"))
  );
  handle("pick-output", async () => {
    if (!window) {
      return null;
    }
    const result = await dialog.showOpenDialog(window, {
      defaultPath: settings.outputDir,
      properties: ["openDirectory", "createDirectory"],
      title: "Save converted files to",
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    settings = { ...settings, outputDir: result.filePaths[0] };
    await saveSettings();
    send({ settings, type: "settings" });
    return settings.outputDir;
  });
  handle("set-settings", async (patch: Partial<Settings>) => {
    settings = {
      ...settings,
      ...patch,
      options: { ...settings.options, ...patch.options },
      outputDir: settings.outputDir,
    };
    if (patch.theme) {
      applyTheme();
    }
    if (patch.autoUpdate !== undefined) {
      updater.setAutomatic(patch.autoUpdate);
    }
    await saveSettings();
    send({ settings, type: "settings" });
    pumpQueue();
  });
  handle("convert", (ids: string[]) => {
    for (const id of ids) {
      const job = jobs.get(id);
      if (
        job &&
        (job.status === "ready" ||
          job.status === "done" ||
          job.status === "failed" ||
          job.status === "cancelled") &&
        job.info
      ) {
        updateJob(id, {
          error: undefined,
          report: undefined,
          status: "queued",
        });
      }
    }
    pumpQueue();
  });
  handle("cancel", (id: string) => {
    const active = running.get(id);
    if (active) {
      // Marked first so the exit handler doesn't report it as a crash.
      running.delete(id);
      updateJob(id, { progress: undefined, status: "cancelled" });
      active.process.removeAllListeners("exit");
      active.process.removeAllListeners("message");
      active.process.kill();
      void removeWhenFree(active.tempDir);
      pumpQueue();
    } else if (jobs.get(id)?.status === "queued") {
      updateJob(id, { status: "ready" });
    }
  });
  handle("remove", (id: string) => {
    const job = jobs.get(id);
    if (!job || running.has(id)) {
      return;
    }
    jobs.delete(id);
    send({ id, type: "removed" });
  });
  handle("clear-finished", () => {
    for (const job of [...jobs.values()]) {
      if (
        job.status === "done" ||
        job.status === "failed" ||
        job.status === "cancelled"
      ) {
        jobs.delete(job.id);
        send({ id: job.id, type: "removed" });
      }
    }
  });
  handle("reveal", (path: string) => {
    // Only ever opens files this app wrote or was given.
    const allowed = [...jobs.values()].some(
      (job) =>
        job.path === path ||
        job.report?.outputs.some((output) => output.path === path)
    );
    if (allowed && existsSync(path)) {
      shell.showItemInFolder(path);
    }
  });
  handle("check-updates", () => updater.check(true));
  handle("install-update", () => {
    // Installing restarts the app, which would throw away a conversion in progress.
    if (running.size === 0) {
      updater.install();
    }
  });
  handle("open-output-folder", async () => {
    await mkdir(settings.outputDir, { recursive: true });
    await shell.openPath(settings.outputDir);
  });
}

// A killed process's files can stay locked for a moment on Windows.
async function removeWhenFree(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(path, { force: true, recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

// ---- Window

// Windows 11 22H2 and up can draw real glass behind the window.
const SUPPORTS_GLASS =
  process.platform === "win32" &&
  Number(release().split(".")[2] ?? 0) >= 22_621;

// The overlay itself is see-through, so the window controls sit on the glass toolbar. Fully
// transparent (#00000000) doesn't work everywhere, hence the 01.
const CHROME = {
  dark: { background: "#0a0a0a", color: "#01000000", symbolColor: "#f8fafc" },
  light: { background: "#fdfdfd", color: "#01000000", symbolColor: "#1f2937" },
};

function applyTheme(): void {
  nativeTheme.themeSource = settings.theme;
  syncChrome();
}

function syncChrome(): void {
  if (!window || process.platform === "darwin") {
    return;
  }
  const colors = nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light;
  window.setTitleBarOverlay({
    color: colors.color,
    height: 40,
    symbolColor: colors.symbolColor,
  });
  if (!SUPPORTS_GLASS) {
    window.setBackgroundColor(colors.background);
  }
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors;
  const colors = dark ? CHROME.dark : CHROME.light;
  window = new BrowserWindow({
    backgroundColor: SUPPORTS_GLASS ? "#00000000" : colors.background,
    height: 640,
    minHeight: 440,
    minWidth: 720,
    title: "Schematic Converter",
    width: 1040,
    ...(SUPPORTS_GLASS ? { backgroundMaterial: "acrylic" as const } : {}),
    show: false,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 12 },
        }
      : {
          titleBarOverlay: {
            color: colors.color,
            height: 40,
            symbolColor: colors.symbolColor,
          },
          titleBarStyle: "hidden" as const,
        }),
    autoHideMenuBar: true,
    webPreferences: {
      additionalArguments: SUPPORTS_GLASS ? ["--window-glass"] : [],
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, "../preload/index.js"),
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });

  // The window only ever shows the bundled UI.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

// Files dropped on the app's icon arrive as arguments. Unpackaged, the arguments are Electron's
// own, and one of them is the project folder, so there's nothing to open.
function filesFromArguments(argv: string[]): string[] {
  if (!app.isPackaged) {
    return [];
  }
  return argv.slice(1).filter((arg) => !arg.startsWith("-") && existsSync(arg));
}

const hasLock = app.requestSingleInstanceLock();
if (hasLock) {
  // A second launch, such as dropping files on the app icon, adds to this window.
  app.on("second-instance", (_event, argv) => {
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
    void addPaths(filesFromArguments(argv));
  });

  void app.whenReady().then(async () => {
    await loadSettings();
    applyTheme();
    nativeTheme.on("updated", syncChrome);
    updater = new Updater((update) => send({ type: "update", update }));
    registerIpc();
    createWindow();
    updater.setAutomatic(settings.autoUpdate);
    const launchFiles = filesFromArguments(process.argv);
    if (launchFiles.length > 0) {
      window?.webContents.once(
        "did-finish-load",
        () => void addPaths(launchFiles)
      );
    }
  });

  app.on("window-all-closed", () => {
    for (const { process: child } of running.values()) {
      child.kill();
    }
    inspector?.kill();
    app.quit();
  });

  app.on("will-quit", () => {
    for (const { tempDir } of running.values()) {
      void rm(tempDir, { force: true, recursive: true }).catch(() => {
        // Temporary files that can't be removed yet are harmless.
      });
    }
  });
} else {
  app.quit();
}
