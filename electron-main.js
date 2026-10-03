/**
 * ============================================================
 *  PAPO - Electron (app desktop para Windows / macOS / Linux)
 *  Feito e programado por: Kauan_hexa
 * ============================================================
 *
 * Funcionamento:
 *   1. Se PUBLIC_SERVER_URL existir -> abre o app diretamente da nuvem
 *   2. Senão -> inicia o servidor Node.js (server.js) num subprocesso e abre
 *      "http://localhost:PORT" dentro da janela do Electron.
 *
 * Para rodar:
 *   npm run electron
 *
 * Para gerar .exe do Windows:
 *   npm run electron:build:win
 *   (os arquivos ficam na pasta "dist")
 * ============================================================
 */

const { app, BrowserWindow, shell, Tray, Menu, nativeImage, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');

const USE_REMOTE_URL = process.env.PUBLIC_SERVER_URL && process.env.PUBLIC_SERVER_URL.length > 0;
const PORT = parseInt(process.env.PORT || '3000', 10);
const LOCAL_URL = `http://localhost:${PORT}`;
const START_URL = USE_REMOTE_URL ? process.env.PUBLIC_SERVER_URL : LOCAL_URL;

let mainWindow = null;
let tray = null;
let serverProcess = null;

function getIconPath() {
  const ico = path.join(__dirname, 'public', 'icon-512.png');
  if (fs.existsSync(ico)) return ico;
  return undefined;
}

function startLocalServerIfNeeded() {
  if (USE_REMOTE_URL) return Promise.resolve();
  return new Promise((resolve) => {
    const entry = path.join(__dirname, 'server.js');
    console.log('[Electron] Iniciando servidor local em', entry, 'na porta', PORT);

    serverProcess = fork(entry, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: Object.assign({}, process.env, { PORT: String(PORT), ELECTRON: '1' })
    });

    serverProcess.stdout.on('data', (d) => process.stdout.write('[SERVIDOR] ' + d.toString()));
    serverProcess.stderr.on('data', (d) => process.stderr.write('[SERVIDOR-ERR] ' + d.toString()));
    serverProcess.on('error', (err) => console.error('[Electron] Erro no servidor filho:', err));
    serverProcess.on('exit', (code) => {
      console.log('[Electron] Servidor filho encerrou com código', code);
    });

    setTimeout(resolve, 2500);
  });
}

// Libera pedidos de permissao de microfone/tela feitos pela pagina
// (getUserMedia / getDisplayMedia), necessarios para a chamada de voz
// e o compartilhamento de tela funcionarem dentro do app desktop.
function setupMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
      return;
    }
    callback(false);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 480,
    backgroundColor: '#111b21',
    title: 'Papo',
    autoHideMenuBar: true,
    icon: getIconPath() ? nativeImage.createFromPath(getIconPath()) : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(START_URL);

  mainWindow.on('close', (event) => {
    if (!app.isQuiting && process.platform === 'win32') {
      event.preventDefault();
      mainWindow.hide();
      if (tray && tray.displayBalloon) {
        tray.displayBalloon({
          title: 'Papo',
          content: 'O app continuou minimizado na bandeja.',
          icon: getIconPath() ? nativeImage.createFromPath(getIconPath()) : undefined
        });
      }
    }
  });
}

function createTray() {
  try {
    const iconPath = getIconPath();
    if (!iconPath) return;
    const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    if (image.isEmpty()) return;

    tray = new Tray(image);
    tray.setToolTip('Papo');

    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir Papo', click: () => { if (mainWindow) mainWindow.show(); } },
      { label: 'Sair', click: () => { app.isQuiting = true; app.quit(); } }
    ]));

    tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
    tray.on('click', () => { if (mainWindow) mainWindow.show(); });
  } catch (e) {
    console.warn('[Electron] Não foi possível criar tray:', e && e.message);
  }
}

// Sem isso, o navegador.mediaDevices.getDisplayMedia() usado no
// compartilhamento de tela durante a chamada NAO funciona dentro do
// Electron (ele não tem um seletor de tela nativo por padrão).
// Isso faz o app desktop abrir o seletor de tela/janela do sistema
// (Windows/macOS) ou, como alternativa, a primeira tela disponível
// (Linux) quando o usuário clica em "Compartilhar tela" na chamada.
function setupScreenShareForElectron() {
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        if (!sources || sources.length === 0) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        console.error('[Electron] Erro ao capturar tela:', err);
        callback({});
      }
    }, { useSystemPicker: true });
  } catch (err) {
    console.warn('[Electron] setDisplayMediaRequestHandler indisponível nesta versão do Electron:', err && err.message);
  }
}

app.whenReady().then(async () => {
  await startLocalServerIfNeeded();
  setupMediaPermissions();
  setupScreenShareForElectron();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin') {
    app.isQuiting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuiting = true;
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill('SIGTERM'); } catch (_) {}
  }
});
