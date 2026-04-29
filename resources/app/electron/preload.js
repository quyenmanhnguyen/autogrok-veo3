const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getPathForFile: (file) => webUtils.getPathForFile(file),
    selectFolder: () => ipcRenderer.invoke('file:selectFolder'),
    selectFiles: (options) => ipcRenderer.invoke('file:selectFiles', options),
    getImagesFromFolder: (folderPath) => ipcRenderer.invoke('file:getImagesFromFolder', folderPath),
    readFile: (filePath) => ipcRenderer.invoke('file:readFile', filePath),
    getFileUrl: (filePath) => ipcRenderer.invoke('file:getFileUrl', filePath),
    openFolder: (folderPath) => ipcRenderer.invoke('file:openFolder', folderPath),
    openPath: (filePath) => ipcRenderer.invoke('file:openPath', filePath),
    showItemInFolder: (filePath) => ipcRenderer.invoke('file:showItemInFolder', filePath),
    deleteFile: (filePath) => ipcRenderer.invoke('file:deleteFile', filePath),

    auth: {
        login: (credentials) => ipcRenderer.invoke('auth:login', credentials),
        getAccounts: () => ipcRenderer.invoke('auth:getAccounts'),
        saveAccounts: (accounts) => ipcRenderer.invoke('auth:saveAccounts', accounts),
        setupAccounts: (accounts) => ipcRenderer.invoke('auth:setupAccounts', accounts),
        importTxt: () => ipcRenderer.invoke('account:importTxt'),
    },

    license: {
        check: () => ipcRenderer.invoke('license:check'),
        validate: (key) => ipcRenderer.invoke('license:validate', key),
        deactivate: () => ipcRenderer.invoke('license:deactivate'),
        getMachineId: () => ipcRenderer.invoke('license:getMachineId'),
    },

    api: {
        backendLogin: (params) => ipcRenderer.invoke('api:backendLogin', params),
        backendVerifyToken: (params) => ipcRenderer.invoke('api:backendVerifyToken', params),
        backendGetProfile: (params) => ipcRenderer.invoke('api:backendGetProfile', params),
        backendLogout: (params) => ipcRenderer.invoke('api:backendLogout', params),
    },

    assistant: {
        open: (url) => ipcRenderer.invoke('assistant:open', url),
    },

    image: {
        generate: (params) => ipcRenderer.invoke('image:generate', params),
    },

    video: {
        generate: (params) => ipcRenderer.invoke('video:generate', params),
        merge: (params) => ipcRenderer.invoke('video:merge', params),
    },

    i2v: {
        generate: (params) => ipcRenderer.invoke('i2v:generate', params),
    },

    refimg: {
        generate: (params) => ipcRenderer.invoke('refimg:generate', params),
    },

    onProgress: (callback) => {
        ipcRenderer.on('job:progress', (_, data) => callback(data));
    },

    onLog: (callback) => {
        ipcRenderer.on('log', (_, data) => callback(data));
    },

    removeProgressListener: () => {
        ipcRenderer.removeAllListeners('job:progress');
    },

    removeLogListener: () => {
        ipcRenderer.removeAllListeners('log');
    },

    updater: {
        checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
        downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
        quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
        getStatus: () => ipcRenderer.invoke('updater:getStatus'),
        onUpdateEvent: (callback) => {
            const subscription = (_event, data) => callback(data);
            ipcRenderer.on('auto-updater', subscription);
            return subscription;
        },
        removeUpdateListener: (callback) => {
            ipcRenderer.removeListener('auto-updater', callback);
        }
    },
});
