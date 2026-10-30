// The contract between the main process and the UI.
import { DEFAULT_OPTIONS, type ConvertOptions, type ConvertReport, type FileInfo, type Progress } from "./types";

export const SUPPORTED_EXTENSIONS = [".schem", ".litematic", ".nbt", ".schematic"];

export type JobStatus = "inspecting" | "ready" | "queued" | "converting" | "done" | "failed" | "cancelled";

export interface JobState {
  id: string;
  path: string;
  name: string;
  size: number;
  status: JobStatus;
  info?: FileInfo;
  progress?: Progress;
  report?: ConvertReport;
  error?: string;
  startedAt?: number;
}

export type UpdateState =
  | { status: "unavailable" } // Not a packaged build.
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "available"; version: string } // The portable build, which can't update itself.
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

export type ThemePreference = "system" | "light" | "dark";

export interface Settings {
  outputDir: string;
  options: ConvertOptions;
  theme: ThemePreference;
  parallelJobs: number;
  autoUpdate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  outputDir: "",
  options: DEFAULT_OPTIONS,
  theme: "system",
  parallelJobs: 1,
  autoUpdate: true,
};

export type AppEvent =
  | { type: "job"; job: JobState }
  | { type: "removed"; id: string }
  | { type: "select"; id: string }
  | { type: "settings"; settings: Settings }
  | { type: "update"; update: UpdateState };

export interface AppState {
  jobs: JobState[];
  settings: Settings;
  threads: number;
  version: string;
  update: UpdateState;
}

export interface Block18 {
  id: number;
  data: number;
  label: string;
}

export interface Api {
  getState(): Promise<AppState>;
  blocks18(): Promise<Block18[]>;
  pickFiles(): Promise<void>;
  pickFolder(): Promise<void>;
  addFiles(files: File[]): Promise<void>;
  pickOutput(): Promise<string | null>;
  setSettings(patch: Partial<Settings>): Promise<void>;
  convert(ids: string[]): Promise<void>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  clearFinished(): Promise<void>;
  reveal(path: string): Promise<void>;
  openOutputFolder(): Promise<void>;
  checkForUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  platform: string;
  glass: boolean;
}
