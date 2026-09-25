// The only surface the sandboxed renderer gets: invoke a contract channel,
// subscribe to a contract event. No Node, no raw ipcRenderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Bridge, Events } from '@shared/ipc'

const bridge: Bridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: <E extends keyof Events>(event: E, listener: (payload: Events[E]) => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: Events[E]) => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },
}

contextBridge.exposeInMainWorld('granola', bridge)
