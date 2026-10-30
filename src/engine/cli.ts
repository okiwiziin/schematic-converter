// Headless entry point: `node out/main/cli.js <input> <output dir> [--tile=512] [--level=fast]`.
import { cpus } from "node:os";
import { join } from "node:path";
import { DEFAULT_OPTIONS, type Compression } from "../shared/types";
import { convertFile } from "./convert";

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const flag = (name: string): string | undefined =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const [input, outputDir] = positional;
  if (!input || !outputDir) {
    console.error("Usage: cli <input> <output dir> [--tile=512] [--level=fast|balanced|small]");
    process.exit(2);
  }
  const startedAt = Date.now();
  const report = await convertFile({
    input,
    outputDir,
    tempDir: join(outputDir, `.schematic-converter-${process.pid}`),
    threads: cpus().length,
    options: {
      ...DEFAULT_OPTIONS,
      overwrite: true,
      compression: (flag("level") as Compression | undefined) ?? "balanced",
      tileSize: Number(flag("tile") ?? 0),
    },
  });
  const seconds = (Date.now() - startedAt) / 1000;
  console.log(
    JSON.stringify(
      {
        format: report.info.format,
        size: `${report.info.width}x${report.info.height}x${report.info.length}`,
        volume: report.info.volume,
        seconds,
        millionBlocksPerSecond: Math.round(report.info.volume / seconds / 1e6),
        peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
        files: report.outputs.map((file) => ({ path: file.path, mb: +(file.size / 1048576).toFixed(2) })),
        nonAir: report.nonAirBlocks,
        tiles: report.tileEntitiesWritten,
        entities: report.entitiesWritten,
        warnings: report.warnings,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
