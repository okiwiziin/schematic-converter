// Headless entry point: `node out/main/cli.js <input> <output dir> [--tile=512] [--level=fast]`.
import { cpus } from "node:os";
import { join } from "node:path";
import { type Compression, DEFAULT_OPTIONS } from "../shared/types";
import { convertFile } from "./convert";

async function main(): Promise<void> {
  const positional = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--"));
  const flag = (name: string): string | undefined =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const [input, outputDir] = positional;
  if (!(input && outputDir)) {
    console.error(
      "Usage: cli <input> <output dir> [--tile=512] [--level=fast|balanced|small]"
    );
    process.exit(2);
  }
  const startedAt = Date.now();
  const report = await convertFile({
    input,
    options: {
      ...DEFAULT_OPTIONS,
      compression: (flag("level") as Compression | undefined) ?? "balanced",
      overwrite: true,
      tileSize: Number(flag("tile") ?? 0),
    },
    outputDir,
    tempDir: join(outputDir, `.schematic-converter-${process.pid}`),
    threads: cpus().length,
  });
  const seconds = (Date.now() - startedAt) / 1000;
  console.log(
    JSON.stringify(
      {
        entities: report.entitiesWritten,
        files: report.outputs.map((file) => ({
          mb: +(file.size / 1_048_576).toFixed(2),
          path: file.path,
        })),
        format: report.info.format,
        millionBlocksPerSecond: Math.round(report.info.volume / seconds / 1e6),
        nonAir: report.nonAirBlocks,
        peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
        seconds,
        size: `${report.info.width}x${report.info.height}x${report.info.length}`,
        tiles: report.tileEntitiesWritten,
        volume: report.info.volume,
        warnings: report.warnings,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
