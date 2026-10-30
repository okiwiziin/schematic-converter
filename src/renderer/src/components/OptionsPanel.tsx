// The options people actually change come first. Everything else sits one click away under
// "More options", which is remembered between launches.
import { ChevronRight, ExternalLink, FolderOpen, RotateCcw, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { JobState, Settings, ThemePreference } from "../../../shared/ipc";
import type { Compression } from "../../../shared/types";
import { folderName, shortBlockName } from "../format";
import { api } from "../store";
import { Button, cn, Segmented, Switch } from "./ui";

// Above this, WorldEdit on a 1.8.8 server tends to need a lot of heap to load one file.
const LARGE_FILE_BLOCKS = 200_000_000;
const MORE_KEY = "show-more-options";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 px-0.5 text-xs text-muted-foreground">{label}</div>
      {children}
      {hint && <p className="mt-1 px-0.5 text-2xs/3.5 text-muted-foreground">{hint}</p>}
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
        <span className="block truncate text-2xs/3.5 text-muted-foreground" title={detail}>
          {detail}
        </span>
      </span>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

const COMPRESSION = [
  { value: "balanced", label: "Balanced", hint: "Standard size, and fast on most CPUs." },
  { value: "fast", label: "Fastest", hint: "For slower CPUs. Files are about 40% larger." },
  { value: "small", label: "Smallest", hint: "Takes longer for slightly smaller files." },
] satisfies { value: Compression; label: string; hint: string }[];

const SPLIT = [
  { value: 0, label: "Off" },
  { value: 2048, label: "2048" },
  { value: 1024, label: "1024" },
  { value: 512, label: "512" },
  { value: 256, label: "256" },
];

export function OptionsPanel({ settings, jobs, threads }: { settings: Settings; jobs: JobState[]; threads: number }) {
  const [more, setMore] = useState(() => localStorage.getItem(MORE_KEY) === "1");
  const { options } = settings;
  const update = (patch: Partial<Settings["options"]>): void =>
    void api.setSettings({ options: { ...options, ...patch } });
  const overrides = Object.entries(options.overrides);
  const hasBigFile =
    options.tileSize === 0 && jobs.some((job) => (job.info?.volume ?? 0) > LARGE_FILE_BLOCKS && job.status !== "done");

  return (
    <aside aria-label="Options" className="panel flex w-58 shrink-0 flex-col gap-3 overflow-y-auto p-2">
      <Field label="Save to">
        <div className="flex gap-1">
          <Button
            size="sm"
            className="min-w-0 flex-1 justify-start font-normal"
            title={settings.outputDir}
            onClick={() => void api.pickOutput()}
          >
            <FolderOpen />
            <span className="truncate">{folderName(settings.outputDir)}</span>
          </Button>
          <Button
            size="icon-sm"
            aria-label="Open output folder"
            title="Open output folder"
            onClick={() => void api.openOutputFolder()}
          >
            <ExternalLink />
          </Button>
        </div>
      </Field>

      <Field
        label="Split big maps into squares of"
        hint={options.tileSize === 0 ? "Off keeps one file, unless 1.8 can't hold it." : "Pasted from one spot, the pieces line up."}
      >
        <Segmented<number>
          fill
          label="Split big maps"
          value={options.tileSize}
          onChange={(tileSize) => update({ tileSize })}
          options={SPLIT}
        />
        {hasBigFile && (
          <p className="mt-1.5 flex gap-1.5 rounded-lg bg-warning-surface px-2 py-1.5 text-2xs/3.5">
            <TriangleAlert className="mt-px size-3 shrink-0 text-warning-foreground" />
            <span>Big map. WorldEdit on 1.8.8 loads a whole file into memory, so splitting helps.</span>
          </p>
        )}
      </Field>

      <Field label="Compression" hint={COMPRESSION.find((option) => option.value === options.compression)?.hint}>
        <Segmented<Compression>
          fill
          label="Compression"
          value={options.compression}
          onChange={(compression) => update({ compression })}
          options={COMPRESSION}
        />
      </Field>

      <button
        type="button"
        aria-expanded={more}
        onClick={() => {
          setMore(!more);
          localStorage.setItem(MORE_KEY, more ? "0" : "1");
        }}
        className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-0.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn("size-3.5 transition-transform duration-150", more && "rotate-90")} />
        More options
      </button>

      {more && (
        <>
          <Field label="Keep">
            <div className="inset divide-y">
              <Toggle
                label="Block entities"
                detail="Signs, chests, heads, banners"
                checked={options.keepTileEntities}
                onChange={(keepTileEntities) => update({ keepTileEntities })}
              />
              <Toggle
                label="Entities"
                detail="Armor stands, frames, paintings, mobs"
                checked={options.keepEntities}
                onChange={(keepEntities) => update({ keepEntities })}
              />
            </div>
          </Field>

          <Field label="Blocks from mods become">
            <Segmented
              fill
              label="Blocks from mods become"
              value={options.fallback}
              onChange={(fallback) => update({ fallback })}
              options={[
                { value: "0:0", label: "Air" },
                { value: "1:0", label: "Stone" },
                { value: "19:0", label: "Sponge" },
              ]}
            />
          </Field>

          <Field label="Files">
            <div className="inset divide-y">
              <Toggle
                label="Replace existing"
                detail="Otherwise adds a number to the name"
                checked={options.overwrite}
                onChange={(overwrite) => update({ overwrite })}
              />
              <div
                className="flex items-center justify-between gap-2 px-2 py-1.5"
                title={`Each file already uses all ${threads} CPU threads for compression, so one at a time is usually quickest.`}
              >
                <span className="truncate text-xs">At once</span>
                <Segmented<number>
                  label="Convert at once"
                  value={settings.parallelJobs}
                  onChange={(parallelJobs) => void api.setSettings({ parallelJobs })}
                  options={[
                    { value: 1, label: "1" },
                    { value: 2, label: "2" },
                    { value: 4, label: "4" },
                  ]}
                />
              </div>
            </div>
          </Field>

          <Field label="Theme">
            <Segmented<ThemePreference>
              fill
              label="Theme"
              value={settings.theme}
              onChange={(theme) => void api.setSettings({ theme })}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </Field>
        </>
      )}

      {overrides.length > 0 && (
        <Field label={`Your block choices (${overrides.length})`}>
          <div className="inset space-y-px p-1">
            {overrides.map(([name, value]) => (
              <div key={name} className="flex h-6 items-center gap-1 rounded-md pr-0.5 pl-1.5 hover:bg-foreground/4">
                <span className="selectable min-w-0 flex-1 truncate font-mono text-3xs" title={name}>
                  {shortBlockName(name)}
                </span>
                <span className="shrink-0 font-mono text-3xs text-muted-foreground">{value}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove your choice for ${name}`}
                  title="Back to the default mapping"
                  onClick={() => {
                    const next = { ...options.overrides };
                    delete next[name];
                    update({ overrides: next });
                  }}
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
