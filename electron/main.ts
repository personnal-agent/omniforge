import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { ElectronProcessOrchestrator } from './orchestrator';

type AppMode = 'Studio' | 'Agents';

let mainWindow: BrowserWindow | null = null;
let activeMode: AppMode = 'Studio';
const repoRoot = path.resolve(__dirname, '..');
const orchestrator = new ElectronProcessOrchestrator(repoRoot);

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#FAFAFA',
    title: 'Omniforge — Hybrid Studio & Multi-Agent Workspace',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
  const fastapiUrl = orchestrator.getEndpoints().fastapi;
  const prodPath = path.join(repoRoot, 'frontend', 'dist', 'index.html');

  const devReachable = isDev ? await orchestrator.probeHealth(devUrl) : false;
  if (devReachable) {
    console.log(`[Electron] Chargement du serveur Vite: ${devUrl}`);
    await mainWindow.loadURL(devUrl);
  } else if (await orchestrator.probeHealth(`${fastapiUrl}/api/health`)) {
    console.log(`[Electron] Chargement du bundle compilé via FastAPI: ${fastapiUrl}`);
    await mainWindow.loadURL(fastapiUrl);
  } else {
    console.log(`[Electron] Chargement du bundle local: ${prodPath}`);
    await mainWindow.loadFile(prodPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers pour la commutation multi-vues
ipcMain.handle('switch-mode', async (_event, mode: AppMode) => {
  if (mode !== 'Studio' && mode !== 'Agents') {
    throw new Error(`Mode invalide: ${mode}`);
  }
  activeMode = mode;
  console.log(`[Electron IPC] Commutation vers le mode: ${activeMode}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mode-changed', activeMode);
  }
  return;
});

ipcMain.handle('get-app-mode', async () => {
  return activeMode;
});

ipcMain.handle('get-system-status', async () => {
  const endpoints = orchestrator.getEndpoints();
  const isHealthy = await orchestrator.probeHealth(`${endpoints.fastapi}/api/health`);
  const port = parseInt(new URL(endpoints.fastapi).port || '8000', 10);
  return {
    fastapi: isHealthy,
    port,
  };
});

// Cycle de vie de l'application
app.whenReady().then(async () => {
  try {
    await orchestrator.startFastAPI();
  } catch (err) {
    console.error('[Electron] Erreur au démarrage de FastAPI:', err);
  }

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  console.log('[Electron] Toutes les fenêtres sont fermées, arrêt supervisé...');
  await orchestrator.stopAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  await orchestrator.stopAll();
});
