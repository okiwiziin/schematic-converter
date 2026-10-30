// Types shared by the engine, the main process and the renderer.

export type SourceFormat = "sponge" | "litematic" | "structure" | "legacy";

export type Compression = "fast" | "balanced" | "small";

export interface ConvertOptions {
  compression: Compression;
  // "id:data" placed for blocks with no known mapping.
  fallback: string;
  keepEntities: boolean;
  keepTileEntities: boolean;
  // Block name to "id:data", taking priority over the built-in mapping.
  overrides: Record<string, string>;
  overwrite: boolean;
  // Split into square files of this many blocks per side. 0 keeps one file when possible.
  tileSize: number;
}

export interface FileInfo {
  dataVersion: number | null;
  fileSize: number;
  format: SourceFormat;
  formatLabel: string;
  height: number;
  length: number;
  regionCount: number | null;
  versionLabel: string | null;
  volume: number;
  width: number;
}

export type ProgressPhase = "reading" | "converting" | "writing" | "finishing";

export interface Progress {
  blocksDone: number;
  blocksPerSecond: number;
  // 0 to 1 within the current phase.
  fraction: number;
  phase: ProgressPhase;
  volume: number;
}

export interface BlockReportRow {
  count: number;
  data: number;
  id: number;
  kind: "exact" | "substitute" | "unmapped";
  name: string;
  overridden: boolean;
  target: string;
}

export interface OutputFile {
  height: number;
  length: number;
  path: string;
  size: number;
  tileX: number;
  tileZ: number;
  width: number;
}

export interface ConvertReport {
  blocks: BlockReportRow[];
  durationMs: number;
  entitiesWritten: number;
  info: FileInfo;
  nonAirBlocks: number;
  outputs: OutputFile[];
  split: boolean;
  tileEntitiesWritten: number;
  warnings: string[];
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  compression: "balanced",
  fallback: "0:0",
  keepEntities: true,
  keepTileEntities: true,
  overrides: {},
  overwrite: false,
  tileSize: 0,
};
