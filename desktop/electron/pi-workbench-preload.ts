import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('piConnection', {
  connect: (origin: string) => ipcRenderer.invoke('pi-workbench:connect', origin),
})
