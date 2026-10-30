// What happened to the selected file, in plain language first and full detail one click away.
import {
  ArrowRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FolderSearch,
  Pencil,
  RotateCcw,
  RotateCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { Block18, JobState, Settings } from "../../../shared/ipc";
import type { BlockReportRow, ConvertReport } from "../../../shared/types";
import {
  formatBytes,
  formatCount,
  formatDuration,
  shortBlockName,
} from "../format";
import { api } from "../store";
import { PHASES } from "./FileTable";
import { Button, cn, Popover, ProgressBar, Segmented } from "./ui";

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function runningLabel(job: JobState): string {
  if (job.progress) {
    return PHASES[job.progress.phase];
  }
  return job.status === "queued" ? "Waiting" : "Starting";
}

function Running({ job }: { job: JobState }) {
  const now = useNow();
  const progress = job.progress;
  const elapsed = job.startedAt ? now - job.startedAt : 0;
  const eta =
    progress && progress.phase === "converting" && progress.blocksPerSecond > 0
      ? ((progress.volume - progress.blocksDone) / progress.blocksPerSecond) *
        1000
      : null;
  return (
    <div aria-live="polite" className="p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[13px]">{runningLabel(job)}</span>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {progress ? `${(progress.fraction * 100).toFixed(1)}%` : ""}
        </span>
      </div>
      <ProgressBar fraction={progress ? progress.fraction : null} />
      <div className="text-2xs text-muted-foreground mt-2 flex flex-wrap gap-x-3 font-mono tabular-nums">
        {progress && progress.volume > 0 && (
          <span>
            {formatCount(progress.blocksDone)} / {formatCount(progress.volume)}
          </span>
        )}
        {progress && progress.blocksPerSecond > 0 && (
          <span>{formatCount(progress.blocksPerSecond)} blocks/s</span>
        )}
        <span>{formatDuration(elapsed)}</span>
        {eta !== null && <span>about {formatDuration(eta)} left</span>}
      </div>
    </div>
  );
}

let blocksCache: Promise<Block18[]> | null = null;

function BlockPicker({ onPick }: { onPick: (block: Block18) => void }) {
  const [blocks, setBlocks] = useState<Block18[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    void (blocksCache ??= api.blocks18()).then(setBlocks);
  }, []);
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return blocks.slice(0, 200);
    }
    const label = (block: Block18): string => block.label.toLowerCase();
    return blocks
      .filter((block) =>
        `${label(block)} ${block.id}:${block.data}`.includes(needle)
      )
      .sort(
        (a, b) =>
          Number(label(b).startsWith(needle)) -
          Number(label(a).startsWith(needle))
      )
      .slice(0, 200);
  }, [blocks, query]);

  return (
    <div className="w-60">
      <div className="flex h-7 items-center gap-1.5 border-b px-1.5 pb-1">
        <Search className="text-muted-foreground size-3 shrink-0" />
        <input
          aria-label="Search 1.8 blocks"
          autoFocus
          className="placeholder:text-muted-foreground w-full bg-transparent text-xs outline-none"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search 1.8 blocks…"
          value={query}
        />
      </div>
      <div className="mt-1 max-h-52 overflow-y-auto">
        {results.map((block) => (
          <button
            className="hover:bg-foreground/7 focus-visible:bg-foreground/7 flex h-6.5 w-full cursor-pointer items-center justify-between gap-3 rounded-md px-1.5 text-left text-xs outline-none"
            key={`${block.id}:${block.data}`}
            onClick={() => onPick(block)}
            type="button"
          >
            <span className="truncate">{block.label}</span>
            <span className="text-3xs text-muted-foreground shrink-0 font-mono">
              {block.id}:{block.data}
            </span>
          </button>
        ))}
        {results.length === 0 && (
          <p className="text-muted-foreground px-1.5 py-1.5 text-xs">
            No matching block.
          </p>
        )}
      </div>
    </div>
  );
}

const KIND_DOTS: Record<
  BlockReportRow["kind"],
  { color: string; label: string }
> = {
  exact: { color: "bg-success", label: "Exact match" },
  substitute: {
    color: "bg-warning",
    label: "Replaced with the closest 1.8 block",
  },
  unmapped: { color: "bg-error", label: "Unknown block" },
};

type BlockFilter = "changed" | "all";

function BlocksTab({
  rows,
  settings,
  query,
  filter,
}: {
  rows: BlockReportRow[];
  settings: Settings;
  query: string;
  filter: BlockFilter;
}) {
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "changed" && row.kind === "exact" && !row.overridden) {
        return false;
      }
      return (
        !needle ||
        row.name.toLowerCase().includes(needle) ||
        row.target.toLowerCase().includes(needle)
      );
    });
  }, [rows, filter, query]);

  const setOverride = (name: string, value: string | null): void => {
    const overrides = { ...settings.options.overrides };
    if (value === null) {
      delete overrides[name];
    } else {
      overrides[name] = value;
    }
    void api.setSettings({ options: { ...settings.options, overrides } });
  };

  if (visible.length === 0) {
    return (
      <p className="text-muted-foreground py-5 text-center text-xs">
        {query ? "No matching blocks." : "Every block has an exact 1.8 match."}
      </p>
    );
  }

  return (
    <>
      {visible.map((row) => {
        const custom = settings.options.overrides[row.name];
        const kind = KIND_DOTS[row.kind];
        return (
          <div
            className="hover:bg-foreground/4 flex h-6.5 items-center gap-2 rounded-md pr-0.5 pl-2 text-xs transition-colors"
            key={row.name}
            style={{
              containIntrinsicHeight: "auto 26px",
              contentVisibility: "auto",
            }}
          >
            <span
              aria-label={kind.label}
              className={cn("size-1.5 shrink-0 rounded-full", kind.color)}
              role="img"
              title={kind.label}
            />
            <span
              className="selectable text-2xs min-w-0 flex-1 truncate font-mono"
              title={row.name}
            >
              {shortBlockName(row.name)}
            </span>
            <ArrowRight className="text-muted-foreground/70 size-3 shrink-0" />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate" title={row.target}>
                {row.target}
              </span>
              <span className="text-3xs text-muted-foreground shrink-0 font-mono">
                {row.id}:{row.data}
              </span>
              {row.overridden && (
                <span className="text-3xs text-info-foreground shrink-0">
                  yours
                </span>
              )}
            </span>
            <span className="text-2xs text-muted-foreground w-12 shrink-0 text-right font-mono tabular-nums">
              {formatCount(row.count)}
            </span>
            {custom === undefined ? (
              <Popover
                trigger={({ toggle, open }) => (
                  <Button
                    aria-expanded={open}
                    aria-label={`Choose a different block for ${row.name}`}
                    onClick={toggle}
                    size="icon-xs"
                    title="Choose a different block"
                    variant="ghost"
                  >
                    <Pencil />
                  </Button>
                )}
              >
                {(close) => (
                  <BlockPicker
                    onPick={(block) => {
                      setOverride(row.name, `${block.id}:${block.data}`);
                      close();
                    }}
                  />
                )}
              </Popover>
            ) : (
              <Button
                aria-label={`Reset ${row.name}`}
                onClick={() => setOverride(row.name, null)}
                size="icon-xs"
                title="Back to the default mapping"
                variant="ghost"
              >
                <RotateCcw />
              </Button>
            )}
          </div>
        );
      })}
    </>
  );
}

function FilesTab({ report }: { report: ConvertReport }) {
  const shown = report.outputs.slice(0, 200);
  return (
    <>
      {report.split && (
        <p className="text-2xs/3.5 text-muted-foreground px-2 pt-0.5 pb-1.5">
          Each file remembers its place. Stand on one spot, then{" "}
          <code className="font-mono">{"//schem load"}</code> and{" "}
          <code className="font-mono">{"//paste"}</code> each one there, and the
          pieces line up.
        </p>
      )}
      {shown.map((output) => {
        const name = output.path.split(/[\\/]/u).at(-1);
        return (
          <div
            className="hover:bg-foreground/4 flex h-6.5 items-center gap-2 rounded-md pr-0.5 pl-2 text-xs transition-colors"
            key={output.path}
          >
            <span
              className="selectable min-w-0 flex-1 truncate"
              title={output.path}
            >
              {name}
            </span>
            <span className="text-2xs text-muted-foreground shrink-0 font-mono tabular-nums">
              {output.width}×{output.height}×{output.length}
            </span>
            <span className="text-2xs text-muted-foreground w-14 shrink-0 text-right font-mono tabular-nums">
              {formatBytes(output.size)}
            </span>
            <Button
              aria-label={`Show ${name} in folder`}
              onClick={() => void api.reveal(output.path)}
              size="icon-xs"
              title="Show in folder"
              variant="ghost"
            >
              <FolderSearch />
            </Button>
          </div>
        );
      })}
      {report.outputs.length > shown.length && (
        <p className="text-2xs text-muted-foreground px-2 py-1.5">
          And {report.outputs.length - shown.length} more in the same folder.
        </p>
      )}
    </>
  );
}

type Tab = "summary" | "blocks" | "files";

function SummaryRow({
  tone,
  children,
  detail,
  onClick,
}: {
  tone: "good" | "warn";
  children: ReactNode;
  detail?: string;
  onClick?: () => void;
}) {
  const icon =
    tone === "good" ? (
      <CircleCheck className="text-success size-3.5 shrink-0" strokeWidth={2} />
    ) : (
      <TriangleAlert
        className="text-warning size-3.5 shrink-0"
        strokeWidth={2}
      />
    );
  const body = (
    <>
      <span className="mt-px flex h-4.5 items-center">{icon}</span>
      <span className="min-w-0 flex-1 text-left text-xs/4.5">{children}</span>
      {detail && (
        <span className="text-2xs/4 text-muted-foreground shrink-0 pt-px">
          {detail}
        </span>
      )}
      {onClick && (
        <ChevronRight className="text-muted-foreground mt-0.75 size-3.5 shrink-0" />
      )}
    </>
  );
  const shared = "flex w-full items-start gap-2 rounded-md px-2 py-1";
  return onClick ? (
    <button
      className={cn(
        shared,
        "hover:bg-foreground/4 focus-visible:ring-ring cursor-pointer transition-colors outline-none focus-visible:ring-2"
      )}
      onClick={onClick}
      type="button"
    >
      {body}
    </button>
  ) : (
    <div className={shared}>{body}</div>
  );
}

function SummaryTab({
  job,
  report,
  open,
}: {
  job: JobState;
  report: ConvertReport;
  open: (tab: Tab) => void;
}) {
  const stats = useMemo(() => {
    const solid = report.blocks.filter(
      (row) => !(row.id === 0 && row.kind === "exact")
    );
    const placed = solid.reduce((sum, row) => sum + row.count, 0);
    const replaced = solid.filter((row) => row.kind === "substitute");
    const unknown = solid.filter((row) => row.kind === "unmapped");
    const replacedBlocks = replaced.reduce((sum, row) => sum + row.count, 0);
    return {
      replaced,
      replacedShare: placed > 0 ? (replacedBlocks / placed) * 100 : 0,
      unknown,
    };
  }, [report]);
  const size = report.outputs.reduce((sum, file) => sum + file.size, 0);
  const rate = report.info.volume / Math.max(report.durationMs / 1000, 0.001);
  // The block counts below already cover this one.
  const notes = report.warnings.filter(
    (warning) => !/unknown block types? used/u.test(warning)
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto">
        {stats.replaced.length === 0 && stats.unknown.length === 0 ? (
          <SummaryRow detail="Nothing to review" tone="good">
            Every block has an exact 1.8 match
          </SummaryRow>
        ) : (
          <>
            {stats.replaced.length > 0 && (
              <SummaryRow
                detail={`${stats.replacedShare < 0.1 ? "under 0.1" : stats.replacedShare.toFixed(1)}% of blocks`}
                onClick={() => open("blocks")}
                tone="warn"
              >
                {stats.replaced.length} block{" "}
                {stats.replaced.length === 1 ? "type" : "types"} replaced with
                the closest 1.8 block
              </SummaryRow>
            )}
            {stats.unknown.length > 0 && (
              <SummaryRow
                detail="Used the fallback"
                onClick={() => open("blocks")}
                tone="warn"
              >
                {stats.unknown.length} unknown block{" "}
                {stats.unknown.length === 1 ? "type" : "types"}, probably from
                mods
              </SummaryRow>
            )}
          </>
        )}
        {notes.map((note) => (
          <SummaryRow key={note} tone="warn">
            <span className="selectable">{note}</span>
          </SummaryRow>
        ))}
        {report.tileEntitiesWritten + report.entitiesWritten > 0 && (
          <SummaryRow
            detail={
              report.entitiesWritten > 0
                ? `${report.entitiesWritten.toLocaleString("en-US")} entities`
                : undefined
            }
            tone="good"
          >
            {report.tileEntitiesWritten.toLocaleString("en-US")} block entities
            kept
          </SummaryRow>
        )}
        <SummaryRow
          detail={`${formatCount(rate)} blocks/s`}
          onClick={() => open("files")}
          tone="good"
        >
          Saved {formatBytes(size)} in {report.outputs.length}{" "}
          {report.outputs.length === 1 ? "file" : "files"}
        </SummaryRow>
      </div>
      <div className="flex shrink-0 gap-1.5 pt-1.5">
        <Button
          className="min-w-0 flex-1"
          onClick={() => void api.reveal(report.outputs[0]!.path)}
          size="lg"
          variant="default"
        >
          <FolderSearch />
          Show in folder
        </Button>
        <Button
          aria-label="Convert again"
          className="w-8.5 px-0"
          onClick={() => void api.convert([job.id])}
          size="lg"
          title="Convert again"
        >
          <RotateCw />
        </Button>
      </div>
    </div>
  );
}

function Finished({ job, settings }: { job: JobState; settings: Settings }) {
  const report = job.report!;
  const changed = useMemo(
    () =>
      report.blocks.filter((row) => row.kind !== "exact" || row.overridden)
        .length,
    [report]
  );
  const [tab, setTab] = useState<Tab>("summary");
  const [filter, setFilter] = useState<BlockFilter>(
    changed > 0 ? "changed" : "all"
  );
  const [query, setQuery] = useState("");
  const pendingChange = report.blocks.some(
    (row) =>
      (settings.options.overrides[row.name] !== undefined) !== row.overridden
  );

  return (
    <div className="flex h-full min-h-0 flex-col p-1.5">
      <div className="flex shrink-0 items-center gap-1.5 pb-1.5">
        <Segmented<Tab>
          label="Details"
          onChange={setTab}
          options={[
            { label: "Summary", value: "summary" },
            { count: report.blocks.length, label: "Blocks", value: "blocks" },
            { count: report.outputs.length, label: "Files", value: "files" },
          ]}
          size="md"
          value={tab}
        />
        {tab === "blocks" && (
          <>
            <Segmented<BlockFilter>
              label="Show"
              onChange={setFilter}
              options={[
                { count: changed, label: "Changed", value: "changed" },
                { label: "All", value: "all" },
              ]}
              size="md"
              value={filter}
            />
            <div className="border-border flex h-7.5 min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2">
              <Search className="text-muted-foreground size-3 shrink-0" />
              <input
                aria-label="Filter blocks"
                className="placeholder:text-muted-foreground w-full min-w-0 bg-transparent text-xs outline-none"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter…"
                value={query}
              />
            </div>
          </>
        )}
        {pendingChange && (
          <Button
            className="ml-auto"
            onClick={() => void api.convert([job.id])}
            variant="default"
          >
            <RotateCw />
            Apply changes
          </Button>
        )}
      </div>
      <div
        className={cn(
          "min-h-0 flex-1",
          tab === "summary" ? "" : "inset overflow-y-auto p-1"
        )}
      >
        {tab === "summary" && (
          <SummaryTab job={job} open={setTab} report={report} />
        )}
        {tab === "blocks" && (
          <BlocksTab
            filter={filter}
            query={query}
            rows={report.blocks}
            settings={settings}
          />
        )}
        {tab === "files" && <FilesTab report={report} />}
      </div>
    </div>
  );
}

export function DetailPane({
  job,
  settings,
}: {
  job: JobState;
  settings: Settings;
}) {
  if (job.status === "converting" || job.status === "queued") {
    return <Running job={job} />;
  }
  if (job.status === "failed") {
    return (
      <div className="bg-error-surface flex gap-2 p-3 text-xs" role="alert">
        <CircleAlert className="text-error-foreground mt-px size-3.5 shrink-0" />
        <span className="selectable min-w-0">{job.error}</span>
      </div>
    );
  }
  if (job.status === "done" && job.report) {
    return <Finished job={job} key={job.id} settings={settings} />;
  }
  return null;
}

export const isTallDetail = (job: JobState | null): boolean =>
  job?.status === "done" && Boolean(job.report);

export const hasDetail = (job: JobState): boolean =>
  job.status === "converting" ||
  job.status === "queued" ||
  job.status === "failed" ||
  isTallDetail(job);
