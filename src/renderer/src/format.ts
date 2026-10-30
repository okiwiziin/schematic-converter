export function formatCount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 1e10 ? 1 : 2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e8 ? 0 : 1)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

export function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${Math.max(1, Math.round(ms))} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export const shortBlockName = (name: string): string => name.replace(/^minecraft:/, "");

export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
