// Runs conversions in their own process so a huge file can never freeze the window, and so
// cancelling is as simple as killing the process.
import type { ConvertOptions } from "../shared/types";
import { convertFile, inspectFile } from "./convert";

interface ParentPort {
  on(event: "message", listener: (event: { data: EngineRequest }) => void): void;
  postMessage(message: EngineResponse): void;
}

export type EngineRequest =
  | { kind: "inspect"; id: string; path: string }
  | {
      kind: "convert";
      id: string;
      path: string;
      outputDir: string;
      tempDir: string;
      options: ConvertOptions;
      threads: number;
    };

export type EngineResponse =
  | { kind: "inspected"; id: string; info: Awaited<ReturnType<typeof inspectFile>> }
  | { kind: "progress"; id: string; progress: Parameters<NonNullable<Parameters<typeof convertFile>[0]["onProgress"]>>[0] }
  | { kind: "done"; id: string; report: Awaited<ReturnType<typeof convertFile>> }
  | { kind: "failed"; id: string; message: string };

const port = (process as unknown as { parentPort: ParentPort }).parentPort;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

port.on("message", ({ data }) => {
  if (data.kind === "inspect") {
    inspectFile(data.path)
      .then((info) => port.postMessage({ kind: "inspected", id: data.id, info }))
      .catch((error) => port.postMessage({ kind: "failed", id: data.id, message: message(error) }));
    return;
  }
  convertFile({
    input: data.path,
    outputDir: data.outputDir,
    tempDir: data.tempDir,
    options: data.options,
    threads: data.threads,
    onProgress: (progress) => port.postMessage({ kind: "progress", id: data.id, progress }),
  })
    .then((report) => port.postMessage({ kind: "done", id: data.id, report }))
    .catch((error) => port.postMessage({ kind: "failed", id: data.id, message: message(error) }));
});
