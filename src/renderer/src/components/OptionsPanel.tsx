// The options people actually change come first. Everything else sits one click away under
// "More options", which is remembered between launches.
import {
  ChevronRight,
  ExternalLink,
  FolderOpen,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type {
  JobState,
  Settings,
  ThemePreference,
  UpdateState,
} from "../../../shared/ipc";
import type { Compression } from "../../../shared/types";
import { folderName, shortBlockName } from "../format";
import { api } from "../store";
import { Button, cn, Segmented, Switch } from "./ui";

// Above this, WorldEdit on a 1.8.8 server tends to need a lot of heap to load one file.
const LARGE_FILE_BLOCKS = 200_000_000;
const MORE_KEY = "show-more-options";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 px-0.5 text-xs">{label}</div>
      {children}
      {hint && (
        <p className="text-2xs/3.5 text-muted-foreground mt-1 px-0.5">{hint}</p>
      )}
    </div>
  );
}

function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5">
      <span className="min-w-0">
        <span className="block truncate text-xs/4">{label}</span>
        <span
          className="text-2xs/3.5 text-muted-foreground block truncate"
          title={detail}
        >
          {detail}
        </span>
      </span>
      <Switch checked={checked} label={label} onChange={onChange} />
    </div>
  );
}

const COMPRESSION = [
  {
    hint: "Standard size, and fast on most CPUs.",
    label: "Balanced",
    value: "balanced",
  },
  {
    hint: "For slower CPUs. Files are about 40% larger.",
    label: "Fastest",
    value: "fast",
  },
  {
    hint: "Takes longer for slightly smaller files.",
    label: "Smallest",
    value: "small",
  },
] satisfies { value: Compression; label: string; hint: string }[];

const SPLIT = [
  { label: "Off", value: 0 },
  { label: "2048", value: 2048 },
  { label: "1024", value: 1024 },
  { label: "512", value: 512 },
  { label: "256", value: 256 },
];

const UPDATE_STATUS: Record<
  UpdateState["status"],
  (update: UpdateState) => string
> = {
  available: (update) =>
    update.status === "available" ? `Version ${update.version} is out` : "",
  checking: () => "Checking…",
  current: () => "Up to date",
  downloading: (update) =>
    update.status === "downloading" ? `Downloading ${update.percent}%` : "",
  error: (update) => (update.status === "error" ? update.message : ""),
  idle: () => "",
  ready: (update) =>
    update.status === "ready" ? `${update.version} is ready, restart` : "",
  unavailable: () => "Only in the installed app",
};

export function OptionsPanel({
  settings,
  jobs,
  threads,
  version,
  updateState,
}: {
  settings: Settings;
  jobs: JobState[];
  threads: number;
  version: string;
  updateState: UpdateState;
}) {
  const [more, setMore] = useState(
    () => localStorage.getItem(MORE_KEY) === "1"
  );
  const { options } = settings;
  const update = (patch: Partial<Settings["options"]>): void =>
    void api.setSettings({ options: { ...options, ...patch } });
  const overrides = Object.entries(options.overrides);
  const hasBigFile =
    options.tileSize === 0 &&
    jobs.some(
      (job) =>
        (job.info?.volume ?? 0) > LARGE_FILE_BLOCKS && job.status !== "done"
    );

  return (
    <aside
      aria-label="Options"
      className="panel flex w-58 shrink-0 flex-col gap-3 overflow-y-auto p-2"
    >
      <Field label="Save to">
        <div className="flex gap-1">
          <Button
            className="min-w-0 flex-1 justify-start font-normal"
            onClick={() => void api.pickOutput()}
            size="sm"
            title={settings.outputDir}
          >
            <FolderOpen />
            <span className="truncate">{folderName(settings.outputDir)}</span>
          </Button>
          <Button
            aria-label="Open output folder"
            onClick={() => void api.openOutputFolder()}
            size="icon-sm"
            title="Open output folder"
          >
            <ExternalLink />
          </Button>
        </div>
      </Field>

      <Field
        hint={
          options.tileSize === 0
            ? "Off keeps one file, unless 1.8 can't hold it."
            : "Pasted from one spot, the pieces line up."
        }
        label="Split big maps into squares of"
      >
        <Segmented<number>
          fill
          label="Split big maps"
          onChange={(tileSize) => update({ tileSize })}
          options={SPLIT}
          value={options.tileSize}
        />
        {hasBigFile && (
          <p className="bg-warning-surface text-2xs/3.5 mt-1.5 flex gap-1.5 rounded-lg px-2 py-1.5">
            <TriangleAlert className="text-warning-foreground mt-px size-3 shrink-0" />
            <span>
              Big map. WorldEdit on 1.8.8 loads a whole file into memory, so
              splitting helps.
            </span>
          </p>
        )}
      </Field>

      <Field
        hint={
          COMPRESSION.find((option) => option.value === options.compression)
            ?.hint
        }
        label="Compression"
      >
        <Segmented<Compression>
          fill
          label="Compression"
          onChange={(compression) => update({ compression })}
          options={COMPRESSION}
          value={options.compression}
        />
      </Field>

      <button
        aria-expanded={more}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-6 cursor-pointer items-center gap-1 rounded-md px-0.5 text-xs transition-colors outline-none focus-visible:ring-2"
        onClick={() => {
          setMore(!more);
          localStorage.setItem(MORE_KEY, more ? "0" : "1");
        }}
        type="button"
      >
        <ChevronRight
          className={cn(
            "size-3.5 transition-transform duration-150",
            more && "rotate-90"
          )}
        />
        More options
      </button>

      {more && (
        <>
          <Field label="Keep">
            <div className="inset divide-y">
              <Toggle
                checked={options.keepTileEntities}
                detail="Signs, chests, heads, banners"
                label="Block entities"
                onChange={(keepTileEntities) => update({ keepTileEntities })}
              />
              <Toggle
                checked={options.keepEntities}
                detail="Armor stands, frames, paintings, mobs"
                label="Entities"
                onChange={(keepEntities) => update({ keepEntities })}
              />
            </div>
          </Field>

          <Field label="Blocks from mods become">
            <Segmented
              fill
              label="Blocks from mods become"
              onChange={(fallback) => update({ fallback })}
              options={[
                { label: "Air", value: "0:0" },
                { label: "Stone", value: "1:0" },
                { label: "Sponge", value: "19:0" },
              ]}
              value={options.fallback}
            />
          </Field>

          <Field label="Files">
            <div className="inset divide-y">
              <Toggle
                checked={options.overwrite}
                detail="Otherwise adds a number to the name"
                label="Replace existing"
                onChange={(overwrite) => update({ overwrite })}
              />
              <div
                className="flex items-center justify-between gap-2 px-2 py-1.5"
                title={`Each file already uses all ${threads} CPU threads for compression, so one at a time is usually quickest.`}
              >
                <span className="truncate text-xs">At once</span>
                <Segmented<number>
                  label="Convert at once"
                  onChange={(parallelJobs) =>
                    void api.setSettings({ parallelJobs })
                  }
                  options={[
                    { label: "1", value: 1 },
                    { label: "2", value: 2 },
                    { label: "4", value: 4 },
                  ]}
                  value={settings.parallelJobs}
                />
              </div>
            </div>
          </Field>

          <Field label="Updates">
            <div className="inset divide-y">
              <Toggle
                checked={settings.autoUpdate}
                detail="Checks GitHub every few hours"
                label="Update automatically"
                onChange={(autoUpdate) => void api.setSettings({ autoUpdate })}
              />
              <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate text-xs/4">
                    Version {version}
                  </span>
                  <span
                    className="text-2xs/3.5 text-muted-foreground block truncate"
                    title={UPDATE_STATUS[updateState.status](updateState)}
                  >
                    {UPDATE_STATUS[updateState.status](updateState) || "\u00a0"}
                  </span>
                </span>
                <Button
                  disabled={[
                    "unavailable",
                    "checking",
                    "downloading",
                    "ready",
                  ].includes(updateState.status)}
                  onClick={() => void api.checkForUpdates()}
                  size="xs"
                >
                  Check now
                </Button>
              </div>
            </div>
          </Field>

          <Field label="Theme">
            <Segmented<ThemePreference>
              fill
              label="Theme"
              onChange={(theme) => void api.setSettings({ theme })}
              options={[
                { label: "System", value: "system" },
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" },
              ]}
              value={settings.theme}
            />
          </Field>
        </>
      )}

      {overrides.length > 0 && (
        <Field label={`Your block choices (${overrides.length})`}>
          <div className="inset space-y-px p-1">
            {overrides.map(([name, value]) => (
              <div
                className="hover:bg-foreground/4 flex h-6 items-center gap-1 rounded-md pr-0.5 pl-1.5"
                key={name}
              >
                <span
                  className="selectable text-3xs min-w-0 flex-1 truncate font-mono"
                  title={name}
                >
                  {shortBlockName(name)}
                </span>
                <span className="text-3xs text-muted-foreground shrink-0 font-mono">
                  {value}
                </span>
                <Button
                  aria-label={`Remove your choice for ${name}`}
                  onClick={() => {
                    const next = { ...options.overrides };
                    delete next[name];
                    update({ overrides: next });
                  }}
                  size="icon-xs"
                  title="Back to the default mapping"
                  variant="ghost"
                >
                  <RotateCcw />
                </Button>
              </div>
            ))}
          </div>
        </Field>
      )}
    </aside>
  );
}
