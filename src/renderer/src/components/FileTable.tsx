import {
  Box,
  FileDown,
  FolderPlus,
  FolderSearch,
  RotateCw,
  X,
} from "lucide-react";
import { useMemo } from "react";
import type { JobState } from "../../../shared/ipc";
import type { Progress, SourceFormat } from "../../../shared/types";
import { formatBytes, formatCount, formatDuration } from "../format";
import { api, canStart } from "../store";
import { Button, cn, ProgressBar } from "./ui";

const FORMAT_NAMES: Record<SourceFormat, string> = {
  legacy: "Schematic",
  litematic: "Litematica",
  sponge: "Sponge",
  structure: "Structure",
};

export const PHASES: Record<Progress["phase"], string> = {
  converting: "Converting",
  finishing: "Finishing",
  reading: "Reading",
  writing: "Writing",
};

const DOT_COLORS = {
  active: "bg-info animate-status-pulse",
  error: "bg-error",
  idle: "bg-muted-foreground/50",
  success: "bg-success",
  warning: "bg-warning",
} as const;

function dotFor(job: JobState): keyof typeof DOT_COLORS {
  switch (job.status) {
    case "converting":
    case "inspecting":
    case "queued":
      return "active";
    case "done":
      return job.report?.warnings.length ? "warning" : "success";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

function JobIcon({ job }: { job: JobState }) {
  return (
    <span className="text-muted-foreground relative flex size-7 shrink-0 items-center justify-center">
      <Box className="size-4.5" strokeWidth={1.5} />
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 right-0.5 size-1.75 rounded-full",
          DOT_COLORS[dotFor(job)]
        )}
      />
    </span>
  );
}

// At a glance, how faithfully the file's blocks came across: five squares, green for exact,
// amber for replaced and red for unknown.
function QualityPips({ job }: { job: JobState }) {
  const pips = useMemo(() => {
    let exact = 0;
    let replaced = 0;
    let unknown = 0;
    for (const row of job.report?.blocks ?? []) {
      if (row.id === 0 && row.kind === "exact") {
        continue;
      }
      if (row.kind === "unmapped") {
        unknown += row.count;
      } else if (row.kind === "substitute") {
        replaced += row.count;
      } else {
        exact += row.count;
      }
    }
    const total = exact + replaced + unknown;
    if (total === 0) {
      return null;
    }
    const red =
      unknown > 0 ? Math.max(1, Math.round((unknown / total) * 5)) : 0;
    const amber =
      replaced > 0 ? Math.max(1, Math.round((replaced / total) * 5)) : 0;
    const colors = [
      ...new Array<string>(Math.max(0, 5 - red - amber)).fill("bg-success"),
      ...new Array<string>(amber).fill("bg-warning"),
      ...new Array<string>(red).fill("bg-error"),
    ].slice(-5);
    const percent = Math.floor((exact / total) * 100);
    return { colors, title: `${percent}% of blocks are an exact match` };
  }, [job.report]);
  if (!pips) {
    return null;
  }
  return (
    <span
      aria-label={pips.title}
      className="flex shrink-0 gap-0.5"
      role="img"
      title={pips.title}
    >
      {pips.colors.map((color, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: A fixed row of five that never reorders.
        <span className={cn("size-2 rounded-[2.5px]", color)} key={index} />
      ))}
    </span>
  );
}

function Subtitle({ job }: { job: JobState }) {
  const info = job.info ?? job.report?.info;
  const facts = info
    ? `${FORMAT_NAMES[info.format]}${info.versionLabel ? ` ${info.versionLabel}` : ""} · ${info.width}×${info.height}×${info.length} · ${formatCount(info.volume)} blocks`
    : formatBytes(job.size);
  switch (job.status) {
    case "inspecting":
      return <span className="text-muted-foreground">Reading…</span>;
    case "queued":
      return <span className="text-info-foreground">Waiting…</span>;
    case "converting": {
      const progress = job.progress;
      const speed =
        progress && progress.blocksPerSecond > 0
          ? ` · ${formatCount(progress.blocksPerSecond)} blocks/s`
          : "";
      return (
        <span className="text-info-foreground">
          {progress ? PHASES[progress.phase] : "Starting"}…{speed}
        </span>
      );
    }
    case "done": {
      const report = job.report!;
      const size = report.outputs.reduce((sum, file) => sum + file.size, 0);
      const files =
        report.outputs.length > 1 ? ` in ${report.outputs.length} files` : "";
      return (
        <>
          <span className="text-success-foreground">
            Done in {formatDuration(report.durationMs)}
          </span>
          <span className="text-muted-foreground">
            {" "}
            · {formatBytes(size)}
            {files} · {formatCount(report.info.volume)} blocks
          </span>
        </>
      );
    }
    case "failed":
      return (
        <span className="text-error-foreground">{job.error ?? "Failed"}</span>
      );
    case "cancelled":
      return <span className="text-muted-foreground">Cancelled · {facts}</span>;
    default:
      return <span className="text-muted-foreground">{facts}</span>;
  }
}

function Row({
  job,
  selected,
  onSelect,
}: {
  job: JobState;
  selected: boolean;
  onSelect: () => void;
}) {
  const running = job.status === "converting" || job.status === "queued";
  const fraction = job.progress?.fraction ?? null;
  return (
    <div
      aria-selected={selected}
      className={cn(
        "group flex h-10.5 cursor-default items-center gap-2 rounded-lg px-1.5 transition-colors outline-none",
        selected ? "bg-foreground/8" : "hover:bg-foreground/4"
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        // Only the row itself: Enter on a button inside it should press that button.
        const pressed = event.key === "Enter" || event.key === " ";
        if (pressed && event.target === event.currentTarget) {
          event.preventDefault();
          onSelect();
        }
      }}
      role="row"
      tabIndex={selected ? 0 : -1}
      title={job.status === "failed" ? job.error : job.path}
    >
      <JobIcon job={job} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]/4.5">{job.name}</div>
        <div className="text-2xs/3.5 truncate">
          <Subtitle job={job} />
        </div>
      </div>

      {job.status === "converting" && (
        <span className="flex w-32 shrink-0 items-center gap-2">
          <ProgressBar className="min-w-0 flex-1" fraction={fraction} />
          <span className="text-2xs text-muted-foreground w-7 shrink-0 text-right font-mono tabular-nums">
            {fraction === null ? "" : `${Math.floor(fraction * 100)}%`}
          </span>
        </span>
      )}
      {job.status === "done" && <QualityPips job={job} />}

      <span className="flex shrink-0 items-center gap-0.5">
        {job.status === "done" && (
          <Button
            aria-label={`Show ${job.name} output in folder`}
            onClick={(event) => {
              event.stopPropagation();
              void api.reveal(job.report!.outputs[0]!.path);
            }}
            size="icon-xs"
            title="Show in folder"
            variant="ghost"
          >
            <FolderSearch />
          </Button>
        )}
        {canStart(job) && job.status !== "ready" && (
          <Button
            aria-label={`Try ${job.name} again`}
            onClick={(event) => {
              event.stopPropagation();
              void api.convert([job.id]);
            }}
            size="icon-xs"
            title="Try again"
            variant="ghost"
          >
            <RotateCw />
          </Button>
        )}
        <Button
          aria-label={running ? `Cancel ${job.name}` : `Remove ${job.name}`}
          className={cn(
            !(selected || running) &&
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          )}
          onClick={(event) => {
            event.stopPropagation();
            void (running ? api.cancel(job.id) : api.remove(job.id));
          }}
          size="icon-xs"
          title={running ? "Cancel" : "Remove from list"}
          variant="ghost"
        >
          <X />
        </Button>
      </span>
    </div>
  );
}

export function FileTable({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: JobState[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <span className="border-border bg-foreground/4 flex size-10 items-center justify-center rounded-xl border">
          <FileDown
            className="text-muted-foreground size-4.5"
            strokeWidth={1.75}
          />
        </span>
        <h1 className="mt-3 text-[13px] font-medium">
          Drop your schematics here
        </h1>
        <p className="text-muted-foreground mt-0.5 text-xs">
          .schem, .litematic, .nbt or .schematic. Any size.
        </p>
        <div className="mt-3.5 flex gap-1.5">
          <Button onClick={() => void api.pickFiles()} variant="default">
            Choose files
          </Button>
          <Button onClick={() => void api.pickFolder()}>
            <FolderPlus />
            Choose a folder
          </Button>
        </div>
      </div>
    );
  }

  const blocks = jobs.reduce((sum, job) => sum + (job.info?.volume ?? 0), 0);
  const finished = jobs.some((job) =>
    ["done", "failed", "cancelled"].includes(job.status)
  );

  return (
    <div className="flex h-full min-h-0 flex-col p-1.5">
      <div className="flex h-6 shrink-0 items-center gap-2 pr-1 pb-1 pl-1.5">
        <h2 className="text-muted-foreground text-xs">Files</h2>
        <span className="text-2xs text-muted-foreground/70 font-mono tabular-nums">
          {jobs.length} · {formatCount(blocks)} blocks
        </span>
        {finished && (
          <button
            className="text-2xs text-muted-foreground hover:text-foreground focus-visible:text-foreground ml-auto cursor-pointer transition-colors outline-none"
            onClick={() => void api.clearFinished()}
            type="button"
          >
            Clear finished
          </button>
        )}
      </div>
      <div
        aria-label="Files"
        className="inset min-h-0 flex-1 space-y-px overflow-y-auto p-1"
        role="table"
      >
        {jobs.map((job) => (
          <Row
            job={job}
            key={job.id}
            onSelect={() => onSelect(job.id)}
            selected={job.id === selectedId}
          />
        ))}
      </div>
    </div>
  );
}
