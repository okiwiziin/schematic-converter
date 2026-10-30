import {
  ArrowRight,
  Download,
  FileDown,
  FolderPlus,
  RefreshCw,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import iconUrl from "../../../assets/icon.svg";
import type { JobState, UpdateState } from "../../shared/ipc";
import { DetailPane, hasDetail, isTallDetail } from "./components/DetailPane";
import { FileTable } from "./components/FileTable";
import { OptionsPanel } from "./components/OptionsPanel";
import { Button, cn } from "./components/ui";
import { api, canStart, useStore } from "./store";

function useFileDrop(): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean =>
      event.dataTransfer?.types.includes("Files") ?? false;
    const onEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent): void => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };
    const onLeave = (): void => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) {
        setDragging(false);
      }
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) {
        void api.addFiles(files);
      }
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

function useShortcuts(
  jobs: JobState[],
  selected: JobState | null,
  select: (id: string | null) => void
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void api.pickFiles();
        return;
      }
      if (command && event.key === "Enter") {
        event.preventDefault();
        void api.convert(jobs.filter(canStart).map((job) => job.id));
        return;
      }
      // The rest of these keys belong to a text box while someone's typing in it.
      if ((event.target as HTMLElement).tagName === "INPUT") {
        return;
      }
      if (event.key === "Delete" && selected) {
        const index = jobs.indexOf(selected);
        void api.remove(selected.id);
        const next = jobs[index + 1] ?? jobs[index - 1];
        select(next?.id ?? null);
      } else if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        jobs.length > 0
      ) {
        event.preventDefault();
        const index = selected ? jobs.indexOf(selected) : -1;
        const next =
          event.key === "ArrowDown"
            ? Math.min(jobs.length - 1, index + 1)
            : Math.max(0, index - 1);
        select(jobs[next]!.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [jobs, selected, select]);
}

function UpdateButton({
  update,
  busy,
}: {
  update: UpdateState;
  busy: boolean;
}) {
  if (update.status === "downloading") {
    return (
      <span className="text-2xs text-muted-foreground px-1 font-mono tabular-nums">
        Updating {update.percent}%
      </span>
    );
  }
  if (update.status === "ready") {
    return (
      <Button
        className="no-drag"
        disabled={busy}
        onClick={() => void api.installUpdate()}
        title={
          busy
            ? "Finish converting first"
            : `Restart to install version ${update.version}`
        }
        variant="bar"
      >
        <RefreshCw className="text-info-foreground" />
        Restart to update
      </Button>
    );
  }
  if (update.status === "available") {
    return (
      <Button
        className="no-drag"
        onClick={() => void api.installUpdate()}
        title="Open the download page"
        variant="bar"
      >
        <Download className="text-info-foreground" />
        Version {update.version} is out
      </Button>
    );
  }
  return null;
}

export function App() {
  const {
    jobs,
    settings,
    threads,
    version,
    update,
    selected,
    selectedId,
    select,
  } = useStore();
  const dragging = useFileDrop();
  useShortcuts(jobs, selected, select);

  useEffect(() => {
    if (!selectedId && jobs.length > 0) {
      select(jobs[0]!.id);
    }
  }, [jobs, selectedId, select]);

  if (!settings) {
    return <div className="drag h-full" />;
  }

  const startable = jobs.filter(canStart);
  const active = jobs.filter(
    (job) => job.status === "converting" || job.status === "queued"
  );
  const showDetail = selected !== null && hasDetail(selected);
  const tall = isTallDetail(selected);

  return (
    <div className="canvas flex h-full flex-col">
      <header
        className="drag flex h-10 shrink-0 items-center gap-1.5 pl-2.5"
        style={{ paddingRight: "calc(var(--titlebar-inset) + 0.5rem)" }}
      >
        <img
          alt=""
          className="size-4.5 rounded-[4px]"
          height={18}
          src={iconUrl}
          width={18}
        />
        <span className="mr-2 truncate text-xs font-medium">
          Schematic Converter
        </span>
        <Button
          className="no-drag"
          onClick={() => void api.pickFiles()}
          title="Add files (Ctrl+O)"
          variant="bar"
        >
          <FileDown />
          Add files
        </Button>
        <Button
          className="no-drag"
          onClick={() => void api.pickFolder()}
          title="Add a folder of schematics"
          variant="bar"
        >
          <FolderPlus />
          Add folder
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <UpdateButton busy={active.length > 0} update={update} />
          {active.length > 0 && (
            <Button
              className="no-drag"
              onClick={() => {
                for (const job of active) {
                  void api.cancel(job.id);
                }
              }}
              variant="bar-danger"
            >
              <Square className="fill-current" />
              Stop
            </Button>
          )}
          {(active.length === 0 || startable.length > 0) && (
            <Button
              className="no-drag"
              disabled={startable.length === 0}
              onClick={() => void api.convert(startable.map((job) => job.id))}
              title="Convert (Ctrl+Enter)"
              variant="bar-primary"
            >
              Convert{startable.length > 1 ? ` ${startable.length}` : ""}
              <ArrowRight />
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-1.5 px-1.5 pb-1.5">
        <main className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div
            className={cn(
              "panel min-h-0 overflow-hidden",
              tall ? "h-[46%] shrink-0" : "flex-1"
            )}
          >
            <FileTable jobs={jobs} onSelect={select} selectedId={selectedId} />
          </div>
          {showDetail && (
            <div
              className={cn(
                "panel min-h-0 overflow-hidden",
                tall ? "flex-1" : "shrink-0"
              )}
            >
              <DetailPane job={selected} settings={settings} />
            </div>
          )}
        </main>
        <OptionsPanel
          jobs={jobs}
          settings={settings}
          threads={threads}
          updateState={update}
          version={version}
        />
      </div>

      <div
        aria-hidden={!dragging}
        className={cn(
          "surface-glass pointer-events-none fixed inset-0 z-40 flex items-center justify-center transition-opacity duration-150",
          dragging ? "opacity-100" : "opacity-0"
        )}
      >
        <div className="border-foreground/40 rounded-2xl border border-dashed px-10 py-7 text-center">
          <FileDown className="mx-auto size-5" />
          <p className="mt-1.5 text-[13px] font-medium">Drop to add</p>
          <p className="text-muted-foreground text-xs">
            Files or whole folders
          </p>
        </div>
      </div>
    </div>
  );
}
