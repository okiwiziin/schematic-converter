// Types shared by the engine, the main process and the renderer.

export type SourceFormat = "sponge" | "litematic" | "structure" | "legacy";

export type Compression = "fast" | "balanced" | "small";

export interface ConvertOptions {
  compression: Compression;
  // Split into square files of this many blocks per side. 0 keeps one file when possible.
  tileSize: number;
  // "id:data" placed for blocks with no known mapping.
  fallback: string;
  // Block name to "id:data", taking priority over the built-in mapping.
  overrides: Record<string, string>;
  keepTileEntities: boolean;
  keepEntities: boolean;
  overwrite: boolean;
}

export interface FileInfo {
  format: SourceFormat;
  formatLabel: string;
  width: number;
  height: number;
  length: number;
  volume: number;
  fileSize: number;
  dataVersion: number | null;
  versionLabel: string | null;
  regionCount: number | null;
}

export type ProgressPhase = "reading" | "converting" | "writing" | "finishing";

export interface Progress {
  phase: ProgressPhase;
  // 0 to 1 within the current phase.
  fraction: number;
  blocksDone: number;
  volume: number;
  blocksPerSecond: number;
}

export interface BlockReportRow {
  name: string;
  count: number;
  id: number;
  data: number;
  target: string;
  kind: "exact" | "substitute" | "unmapped";
  overridden: boolean;
}

export interface OutputFile {
  path: string;
  size: number;
  width: number;
  height: number;
  length: number;
  tileX: number;
  tileZ: number;
}

export interface ConvertReport {
  info: FileInfo;
  outputs: OutputFile[];
  blocks: BlockReportRow[];
  warnings: string[];
  durationMs: number;
  nonAirBlocks: number;
  tileEntitiesWritten: number;
  entitiesWritten: number;
  split: boolean;
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  compression: "balanced",
  tileSize: 0,
  fallback: "0:0",
  overrides: {},
  keepTileEntities: true,
  keepEntities: true,
  overwrite: false,
};
