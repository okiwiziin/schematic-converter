import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Api, AppEvent } from "../shared/ipc";

const api: Api = {
  getState: () => ipcRenderer.invoke("get-state"),
  blocks18: () => ipcRenderer.invoke("blocks-18"),
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  addFiles: (files) =>
    ipcRenderer.invoke(
      "add-paths",
      files.map((file) => webUtils.getPathForFile(file)),
    ),
  pickOutput: () => ipcRenderer.invoke("pick-output"),
  setSettings: (patch) => ipcRenderer.invoke("set-settings", patch),
  convert: (ids) => ipcRenderer.invoke("convert", ids),
  cancel: (id) => ipcRenderer.invoke("cancel", id),
  remove: (id) => ipcRenderer.invoke("remove", id),
  clearFinished: () => ipcRenderer.invoke("clear-finished"),
  reveal: (path) => ipcRenderer.invoke("reveal", path),
  openOutputFolder: () => ipcRenderer.invoke("open-output-folder"),
  onEvent: (listener) => {
    const wrapped = (_event: unknown, event: AppEvent): void => listener(event);
    ipcRenderer.on("app-event", wrapped);
    return () => ipcRenderer.removeListener("app-event", wrapped);
  },
  platform: process.platform,
  glass: process.argv.includes("--window-glass"),
};

contextBridge.exposeInMainWorld("api", api);
