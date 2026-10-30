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
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Block18, JobState, Settings } from "../../../shared/ipc";
import type { BlockReportRow, ConvertReport } from "../../../shared/types";
import { formatBytes, formatCount, formatDuration, shortBlockName } from "../format";
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

function Running({ job }: { job: JobState }) {
  const now = useNow();
  const progress = job.progress;
  const elapsed = job.startedAt ? now - job.startedAt : 0;
  const eta =
    progress && progress.phase === "converting" && progress.blocksPerSecond > 0
      ? ((progress.volume - progress.blocksDone) / progress.blocksPerSecond) * 1000
      : null;
  return (
    <div className="p-3" aria-live="polite">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[13px]">{progress ? PHASES[progress.phase] : job.status === "queued" ? "Waiting" : "Starting"}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {progress ? `${(progress.fraction * 100).toFixed(1)}%` : ""}
        </span>
      </div>
      <ProgressBar fraction={progress ? progress.fraction : null} />
      <div className="mt-2 flex flex-wrap gap-x-3 font-mono text-2xs tabular-nums text-muted-foreground">
        {progress && progress.volume > 0 && (
          <span>
            {formatCount(progress.blocksDone)} / {formatCount(progress.volume)}
          </span>
        )}
        {progress && progress.blocksPerSecond > 0 && <span>{formatCount(progress.blocksPerSecond)} blocks/s</span>}
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
    if (!needle) return blocks.slice(0, 200);
    const label = (block: Block18): string => block.label.toLowerCase();
    return blocks
      .filter((block) => `${label(block)} ${block.id}:${block.data}`.includes(needle))
      .sort((a, b) => Number(label(b).startsWith(needle)) - Number(label(a).startsWith(needle)))
      .slice(0, 200);
  }, [blocks, query]);

  return (
    <div className="w-60">
      <div className="flex h-7 items-center gap-1.5 border-b px-1.5 pb-1">
        <Search className="size-3 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search 1.8 blocks…"
          aria-label="Search 1.8 blocks"
          className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="mt-1 max-h-52 overflow-y-auto">
        {results.map((block) => (
          <button
            key={`${block.id}:${block.data}`}
            type="button"
            onClick={() => onPick(block)}
            className="flex h-6.5 w-full cursor-pointer items-center justify-between gap-3 rounded-md px-1.5 text-left text-xs outline-none hover:bg-foreground/7 focus-visible:bg-foreground/7"
          >
            <span className="truncate">{block.label}</span>
            <span className="shrink-0 font-mono text-3xs text-muted-foreground">
              {block.id}:{block.data}
            </span>
          </button>
        ))}
        {results.length === 0 && <p className="px-1.5 py-1.5 text-xs text-muted-foreground">No matching block.</p>}
      </div>
    </div>
  );
}

const KIND_DOTS: Record<BlockReportRow["kind"], { color: string; label: string }> = {
  exact: { color: "bg-success", label: "Exact match" },
  substitute: { color: "bg-warning", label: "Replaced with the closest 1.8 block" },
  unmapped: { color: "bg-error", label: "Unknown block" },
};

type BlockFilter = "changed" | "all";

function BlocksTab({ rows, settings, query, filter }: { rows: BlockReportRow[]; settings: Settings; query: string; filter: BlockFilter }) {
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "changed" && row.kind === "exact" && !row.overridden) return false;
      return !needle || row.name.toLowerCase().includes(needle) || row.target.toLowerCase().includes(needle);
    });
  }, [rows, filter, query]);

  const setOverride = (name: string, value: string | null): void => {
    const overrides = { ...settings.options.overrides };
    if (value === null) delete overrides[name];
    else overrides[name] = value;
    void api.setSettings({ options: { ...settings.options, overrides } });
  };

  if (visible.length === 0) {
    return (
      <p className="py-5 text-center text-xs text-muted-foreground">
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
            key={row.name}
            style={{ contentVisibility: "auto", containIntrinsicHeight: "auto 26px" }}
            className="flex h-6.5 items-center gap-2 rounded-md pr-0.5 pl-2 text-xs transition-colors hover:bg-foreground/4"
          >
            <span aria-label={kind.label} title={kind.label} className={cn("size-1.5 shrink-0 rounded-full", kind.color)} />
            <span className="selectable min-w-0 flex-1 truncate font-mono text-2xs" title={row.name}>
              {shortBlockName(row.name)}
            </span>
            <ArrowRight className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate" title={row.target}>
                {row.target}
              </span>
              <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                {row.id}:{row.data}
              </span>
              {row.overridden && <span className="shrink-0 text-3xs text-info-foreground">yours</span>}
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
              {formatCount(row.count)}
            </span>
            {custom !== undefined ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Reset ${row.name}`}
                title="Back to the default mapping"
                onClick={() => setOverride(row.name, null)}
              >
                <RotateCcw />
              </Button>
            ) : (
              <Popover
                trigger={({ toggle, open }) => (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Choose a different block for ${row.name}`}
                    aria-expanded={open}
                    title="Choose a different block"
                    onClick={toggle}
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
        <p className="px-2 pb-1.5 pt-0.5 text-2xs/3.5 text-muted-foreground">
          Each file remembers its place. Stand on one spot, then <code className="font-mono">//schem load</code> and{" "}
          <code className="font-mono">//paste</code> each one there, and the pieces line up.
        </p>
      )}
      {shown.map((output) => {
        const name = output.path.split(/[\\/]/).at(-1);
        return (
          <div key={output.path} className="flex h-6.5 items-center gap-2 rounded-md pr-0.5 pl-2 text-xs transition-colors hover:bg-foreground/4">
            <span className="selectable min-w-0 flex-1 truncate" title={output.path}>
              {name}
            </span>
            <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
              {output.width}×{output.height}×{output.length}
            </span>
            <span className="w-14 shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground">
              {formatBytes(output.size)}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Show ${name} in folder`}
              title="Show in folder"
              onClick={() => void api.reveal(output.path)}
            >
              <FolderSearch />
            </Button>
          </div>
        );
      })}
      {report.outputs.length > shown.length && (
        <p className="px-2 py-1.5 text-2xs text-muted-foreground">
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
      <CircleCheck className="size-3.5 shrink-0 text-success" strokeWidth={2} />
    ) : (
      <TriangleAlert className="size-3.5 shrink-0 text-warning" strokeWidth={2} />
    );
  const body = (
    <>
      <span className="mt-px flex h-4.5 items-center">{icon}</span>
      <span className="min-w-0 flex-1 text-left text-xs/4.5">{children}</span>
      {detail && <span className="shrink-0 pt-px text-2xs/4 text-muted-foreground">{detail}</span>}
      {onClick && <ChevronRight className="mt-0.75 size-3.5 shrink-0 text-muted-foreground" />}
    </>
  );
  const shared = "flex w-full items-start gap-2 rounded-md px-2 py-1";
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(shared, "cursor-pointer outline-none transition-colors hover:bg-foreground/4 focus-visible:ring-2 focus-visible:ring-ring")}>
      {body}
    </button>
  ) : (
    <div className={shared}>{body}</div>
  );
}

function SummaryTab({ job, report, open }: { job: JobState; report: ConvertReport; open: (tab: Tab) => void }) {
  const stats = useMemo(() => {
    const solid = report.blocks.filter((row) => !(row.id === 0 && row.kind === "exact"));
    const placed = solid.reduce((sum, row) => sum + row.count, 0);
    const replaced = solid.filter((row) => row.kind === "substitute");
    const unknown = solid.filter((row) => row.kind === "unmapped");
    const replacedBlocks = replaced.reduce((sum, row) => sum + row.count, 0);
    return { replaced, unknown, replacedShare: placed > 0 ? (replacedBlocks / placed) * 100 : 0 };
  }, [report]);
  const size = report.outputs.reduce((sum, file) => sum + file.size, 0);
  const rate = report.info.volume / Math.max(report.durationMs / 1000, 0.001);
  // The block counts below already cover this one.
  const notes = report.warnings.filter((warning) => !/unknown block types? used/.test(warning));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto">
        {stats.replaced.length === 0 && stats.unknown.length === 0 ? (
          <SummaryRow tone="good" detail="Nothing to review">
            Every block has an exact 1.8 match
          </SummaryRow>
        ) : (
          <>
            {stats.replaced.length > 0 && (
              <SummaryRow
                tone="warn"
                detail={`${stats.replacedShare < 0.1 ? "under 0.1" : stats.replacedShare.toFixed(1)}% of blocks`}
                onClick={() => open("blocks")}
              >
                {stats.replaced.length} block {stats.replaced.length === 1 ? "type" : "types"} replaced with the closest 1.8 block
              </SummaryRow>
            )}
            {stats.unknown.length > 0 && (
              <SummaryRow tone="warn" detail="Used the fallback" onClick={() => open("blocks")}>
                {stats.unknown.length} unknown block {stats.unknown.length === 1 ? "type" : "types"}, probably from mods
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
          <SummaryRow tone="good" detail={report.entitiesWritten > 0 ? `${report.entitiesWritten.toLocaleString("en-US")} entities` : undefined}>
            {report.tileEntitiesWritten.toLocaleString("en-US")} block entities kept
          </SummaryRow>
        )}
        <SummaryRow tone="good" detail={`${formatCount(rate)} blocks/s`} onClick={() => open("files")}>
          Saved {formatBytes(size)} in {report.outputs.length} {report.outputs.length === 1 ? "file" : "files"}
        </SummaryRow>
      </div>
      <div className="flex shrink-0 gap-1.5 pt-1.5">
        <Button variant="default" size="lg" className="min-w-0 flex-1" onClick={() => void api.reveal(report.outputs[0]!.path)}>
          <FolderSearch />
          Show in folder
        </Button>
        <Button
          size="lg"
          className="w-8.5 px-0"
          aria-label="Convert again"
          title="Convert again"
          onClick={() => void api.convert([job.id])}
        >
          <RotateCw />
        </Button>
      </div>
    </div>
  );
}

function Finished({ job, settings }: { job: JobState; settings: Settings }) {
  const report = job.report!;
  const changed = useMemo(() => report.blocks.filter((row) => row.kind !== "exact" || row.overridden).length, [report]);
  const [tab, setTab] = useState<Tab>("summary");
  const [filter, setFilter] = useState<BlockFilter>(changed > 0 ? "changed" : "all");
  const [query, setQuery] = useState("");
  const pendingChange = report.blocks.some(
    (row) => (settings.options.overrides[row.name] !== undefined) !== row.overridden,
  );

  return (
    <div className="flex h-full min-h-0 flex-col p-1.5">
      <div className="flex shrink-0 items-center gap-1.5 pb-1.5">
        <Segmented<Tab>
          size="md"
          label="Details"
          value={tab}
          onChange={setTab}
          options={[
            { value: "summary", label: "Summary" },
            { value: "blocks", label: "Blocks", count: report.blocks.length },
            { value: "files", label: "Files", count: report.outputs.length },
          ]}
        />
        {tab === "blocks" && (
          <>
            <Segmented<BlockFilter>
              size="md"
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "changed", label: "Changed", count: changed },
                { value: "all", label: "All" },
              ]}
            />
            <div className="flex h-7.5 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border px-2">
              <Search className="size-3 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter…"
                aria-label="Filter blocks"
                className="w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
          </>
        )}
        {pendingChange && (
          <Button variant="default" className="ml-auto" onClick={() => void api.convert([job.id])}>
            <RotateCw />
            Apply changes
          </Button>
        )}
      </div>
      <div className={cn("min-h-0 flex-1", tab === "summary" ? "" : "inset overflow-y-auto p-1")}>
        {tab === "summary" && <SummaryTab job={job} report={report} open={setTab} />}
        {tab === "blocks" && <BlocksTab rows={report.blocks} settings={settings} query={query} filter={filter} />}
        {tab === "files" && <FilesTab report={report} />}
      </div>
    </div>
  );
}

export function DetailPane({ job, settings }: { job: JobState; settings: Settings }) {
  if (job.status === "converting" || job.status === "queued") return <Running job={job} />;
  if (job.status === "failed") {
    return (
      <div role="alert" className="flex gap-2 bg-error-surface p-3 text-xs">
        <CircleAlert className="mt-px size-3.5 shrink-0 text-error-foreground" />
        <span className="selectable min-w-0">{job.error}</span>
      </div>
    );
  }
  if (job.status === "done" && job.report) return <Finished key={job.id} job={job} settings={settings} />;
  return null;
}

export const isTallDetail = (job: JobState | null): boolean => job?.status === "done" && Boolean(job.report);

export const hasDetail = (job: JobState): boolean =>
  job.status === "converting" || job.status === "queued" || job.status === "failed" || isTallDetail(job);
