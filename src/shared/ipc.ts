// The contract between the main process and the UI.
import {
  type ConvertOptions,
  type ConvertReport,
  DEFAULT_OPTIONS,
  type FileInfo,
  type Progress,
} from "./types";

export const SUPPORTED_EXTENSIONS = [
  ".schem",
  ".litematic",
  ".nbt",
  ".schematic",
];

export type JobStatus =
  | "inspecting"
  | "ready"
  | "queued"
  | "converting"
  | "done"
  | "failed"
  | "cancelled";

export interface JobState {
  error?: string;
  id: string;
  info?: FileInfo;
  name: string;
  path: string;
  progress?: Progress;
  report?: ConvertReport;
  size: number;
  startedAt?: number;
  status: JobStatus;
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
  autoUpdate: boolean;
  options: ConvertOptions;
  outputDir: string;
  parallelJobs: number;
  theme: ThemePreference;
}

export const DEFAULT_SETTINGS: Settings = {
  autoUpdate: true,
  options: DEFAULT_OPTIONS,
  outputDir: "",
  parallelJobs: 1,
  theme: "system",
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
  update: UpdateState;
  version: string;
}

export interface Block18 {
  data: number;
  id: number;
  label: string;
}

export interface Api {
  addFiles(files: File[]): Promise<void>;
  blocks18(): Promise<Block18[]>;
  cancel(id: string): Promise<void>;
  checkForUpdates(): Promise<void>;
  clearFinished(): Promise<void>;
  convert(ids: string[]): Promise<void>;
  getState(): Promise<AppState>;
  glass: boolean;
  installUpdate(): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  openOutputFolder(): Promise<void>;
  pickFiles(): Promise<void>;
  pickFolder(): Promise<void>;
  pickOutput(): Promise<string | null>;
  platform: string;
  remove(id: string): Promise<void>;
  reveal(path: string): Promise<void>;
  setSettings(patch: Partial<Settings>): Promise<void>;
}
