import { useEffect, useMemo, useState } from "react";
import type {
  Api,
  AppEvent,
  JobState,
  Settings,
  UpdateState,
} from "../../shared/ipc";

declare global {
  interface Window {
    api: Api;
  }
}

export const api = window.api;

export interface Store {
  jobs: JobState[];
  select: (id: string | null) => void;
  selected: JobState | null;
  selectedId: string | null;
  settings: Settings | null;
  threads: number;
  update: UpdateState;
  version: string;
}

export function useStore(): Store {
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [threads, setThreads] = useState(0);
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });
  const [selectedId, select] = useState<string | null>(null);

  useEffect(() => {
    void api.getState().then((state) => {
      setJobs(state.jobs);
      setSettings(state.settings);
      setThreads(state.threads);
      setVersion(state.version);
      setUpdate(state.update);
    });
    return api.onEvent((event: AppEvent) => {
      switch (event.type) {
        case "job":
          setJobs((current) => {
            const index = current.findIndex((job) => job.id === event.job.id);
            if (index === -1) {
              return [...current, event.job];
            }
            const next = current.slice();
            next[index] = event.job;
            return next;
          });
          break;
        case "removed":
          setJobs((current) => current.filter((job) => job.id !== event.id));
          select((current) => (current === event.id ? null : current));
          break;
        case "select":
          select(event.id);
          break;
        case "settings":
          setSettings(event.settings);
          break;
        case "update":
          setUpdate(event.update);
          break;
      }
    });
  }, []);

  const selected = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId]
  );
  return {
    jobs,
    select,
    selected,
    selectedId,
    settings,
    threads,
    update,
    version,
  };
}

export const canStart = (job: JobState): boolean =>
  Boolean(job.info) &&
  (job.status === "ready" ||
    job.status === "cancelled" ||
    job.status === "failed");
