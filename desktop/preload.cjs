const { contextBridge, ipcRenderer } = require('electron');

const versionArgument = process.argv.find(argument => argument.startsWith('--sweatshop-version='));
contextBridge.exposeInMainWorld('sweatshopDesktop', Object.freeze({
  version: versionArgument?.slice('--sweatshop-version='.length) ?? '0.1.0',
  platform: process.platform,
  chooseDirectory: () => ipcRenderer.invoke('sweatshop:choose-directory'),
  choosePromptFile: () => ipcRenderer.invoke('sweatshop:choose-prompt-file'),
  openRequestUrl: id => ipcRenderer.invoke('sweatshop:open-request-url', id),
  copyText: text => {
    if (typeof text !== 'string' || text.length > 1_000_000) return Promise.reject(new Error('复制内容过长或格式无效'));
    return ipcRenderer.invoke('sweatshop:copy-text', text);
  },
}));
