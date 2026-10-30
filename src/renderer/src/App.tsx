import { ArrowRight, FileDown, FolderPlus, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JobState } from "../../shared/ipc";
import iconUrl from "../../../assets/icon.svg";
import { DetailPane, hasDetail, isTallDetail } from "./components/DetailPane";
import { FileTable } from "./components/FileTable";
import { OptionsPanel } from "./components/OptionsPanel";
import { Button, cn } from "./components/ui";
import { api, canStart, useStore } from "./store";

function useFileDrop(): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") ?? false;
    const onEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent): void => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (): void => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void api.addFiles(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  return dragging;
}

function useShortcuts(jobs: JobState[], selected: JobState | null, select: (id: string | null) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = (event.target as HTMLElement).tagName === "INPUT";
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void api.pickFiles();
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void api.convert(jobs.filter(canStart).map((job) => job.id));
      } else if (typing) {
        return;
      } else if (event.key === "Delete" && selected) {
        const index = jobs.indexOf(selected);
        void api.remove(selected.id);
        const next = jobs[index + 1] ?? jobs[index - 1];
        select(next?.id ?? null);
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && jobs.length > 0) {
        event.preventDefault();
        const index = selected ? jobs.indexOf(selected) : -1;
        const next = event.key === "ArrowDown" ? Math.min(jobs.length - 1, index + 1) : Math.max(0, index - 1);
        select(jobs[next]!.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [jobs, selected, select]);
}

export function App() {
  const { jobs, settings, threads, selected, selectedId, select } = useStore();
  const dragging = useFileDrop();
  useShortcuts(jobs, selected, select);

  useEffect(() => {
    if (!selectedId && jobs.length > 0) select(jobs[0]!.id);
  }, [jobs, selectedId, select]);

  if (!settings) return <div className="drag h-full" />;

  const startable = jobs.filter(canStart);
  const active = jobs.filter((job) => job.status === "converting" || job.status === "queued");
  const showDetail = selected !== null && hasDetail(selected);
  const tall = isTallDetail(selected);

  return (
    <div className="canvas flex h-full flex-col">
      <header
        className="drag flex h-10 shrink-0 items-center gap-1.5 pl-2.5"
        style={{ paddingRight: "calc(var(--titlebar-inset) + 0.5rem)" }}
      >
        <img src={iconUrl} alt="" className="size-4.5 rounded-[4px]" />
        <span className="mr-2 truncate text-xs font-medium">Schematic Converter</span>
        <Button variant="bar" className="no-drag" title="Add files (Ctrl+O)" onClick={() => void api.pickFiles()}>
          <FileDown />
          Add files
        </Button>
        <Button variant="bar" className="no-drag" title="Add a folder of schematics" onClick={() => void api.pickFolder()}>
          <FolderPlus />
          Add folder
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          {active.length > 0 && (
            <Button
              variant="bar-danger"
              className="no-drag"
              onClick={() => {
                for (const job of active) void api.cancel(job.id);
              }}
            >
              <Square className="fill-current" />
              Stop
            </Button>
          )}
          {(active.length === 0 || startable.length > 0) && (
            <Button
              variant="bar-primary"
              className="no-drag"
              title="Convert (Ctrl+Enter)"
              disabled={startable.length === 0}
              onClick={() => void api.convert(startable.map((job) => job.id))}
            >
              Convert{startable.length > 1 ? ` ${startable.length}` : ""}
              <ArrowRight />
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-1.5 px-1.5 pb-1.5">
        <main className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className={cn("panel min-h-0 overflow-hidden", tall ? "h-[46%] shrink-0" : "flex-1")}>
            <FileTable jobs={jobs} selectedId={selectedId} onSelect={select} />
          </div>
          {showDetail && (
            <div className={cn("panel min-h-0 overflow-hidden", tall ? "flex-1" : "shrink-0")}>
              <DetailPane job={selected} settings={settings} />
            </div>
          )}
        </main>
        <OptionsPanel settings={settings} jobs={jobs} threads={threads} />
      </div>

      <div
        aria-hidden={!dragging}
        className={cn(
          "surface-glass pointer-events-none fixed inset-0 z-40 flex items-center justify-center transition-opacity duration-150",
          dragging ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="rounded-2xl border border-dashed border-foreground/40 px-10 py-7 text-center">
          <FileDown className="mx-auto size-5" />
          <p className="mt-1.5 text-[13px] font-medium">Drop to add</p>
          <p className="text-xs text-muted-foreground">Files or whole folders</p>
        </div>
      </div>
    </div>
  );
}
