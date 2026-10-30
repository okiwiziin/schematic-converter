import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Api, AppEvent } from "../shared/ipc";

const api: Api = {
  addFiles: (files) =>
    ipcRenderer.invoke(
      "add-paths",
      files.map((file) => webUtils.getPathForFile(file))
    ),
  blocks18: () => ipcRenderer.invoke("blocks-18"),
  cancel: (id) => ipcRenderer.invoke("cancel", id),
  checkForUpdates: () => ipcRenderer.invoke("check-updates"),
  clearFinished: () => ipcRenderer.invoke("clear-finished"),
  convert: (ids) => ipcRenderer.invoke("convert", ids),
  getState: () => ipcRenderer.invoke("get-state"),
  glass: process.argv.includes("--window-glass"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  onEvent: (listener) => {
    const wrapped = (_event: unknown, event: AppEvent): void => listener(event);
    ipcRenderer.on("app-event", wrapped);
    return () => ipcRenderer.removeListener("app-event", wrapped);
  },
  openOutputFolder: () => ipcRenderer.invoke("open-output-folder"),
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickOutput: () => ipcRenderer.invoke("pick-output"),
  platform: process.platform,
  remove: (id) => ipcRenderer.invoke("remove", id),
  reveal: (path) => ipcRenderer.invoke("reveal", path),
  setSettings: (patch) => ipcRenderer.invoke("set-settings", patch),
};

contextBridge.exposeInMainWorld("api", api);
