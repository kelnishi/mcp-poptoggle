import { contextBridge, ipcRenderer } from 'electron';

// Make sure context bridge is available
if (contextBridge && ipcRenderer) {
  // Expose protected methods that allow the renderer process to use
  // the ipcRenderer without exposing the entire object
  contextBridge.exposeInMainWorld('api', {
    // Express server communication
    // Updated to accept an optional data parameter
    serverRequest: (endpoint: string, data?: any) => {
      console.log(`Preload: serverRequest to ${endpoint}`, data ? 'with data' : 'without data');
      return ipcRenderer.invoke('server-request', endpoint, data);
    },

    openFile: (filename: string) => {
      console.log(`Preload: openFile ${filename}`);
      return ipcRenderer.invoke('open-file', filename);
    }
  });
} else {
  console.error('Electron APIs not available in preload script');
}