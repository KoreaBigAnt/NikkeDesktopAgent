const { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, screen } = require('electron');
const { existsSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');
const { readdir } = require('node:fs/promises');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { Codex } = require('./codex.cjs');
const { Gemini } = require('./gemini.cjs');
const { DesktopActivity } = require('./desktop-activity.cjs');

const cwd = resolve(process.env.NIKKE_WORKSPACE || process.cwd());
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
let window;
let personaWindow;
let codex;
const gemini = new Gemini();
let chatSettings = { backend: 'gemini' };
let savingKey = false;
let threadId;
let turnId;
let sending = false;
let activityTimer;
let pointerTimer;
let dragOrigin;
let petScale = 1;
const petWidth = 266;
const petHeight = 360;

function readPersona(value) {
  return {
    personality: typeof value?.personality === 'string' ? value.personality.trim().slice(0, 800) : '',
    systemPrompt: typeof value?.systemPrompt === 'string' ? value.systemPrompt.trim().slice(0, 4000) : '',
  };
}

function settingsPath() {
  return join(app.getPath('userData'), 'pet-chat.json');
}

function saveChatSettings(next) {
  const path = settingsPath();
  writeFileSync(path + '.tmp', JSON.stringify(next));
  renameSync(path + '.tmp', path);
  chatSettings = next;
}

function geminiKey() {
  if (!chatSettings.key) throw new Error('펫을 우클릭하고 Gemini API 키를 저장해 주세요.');
  try {
    return safeStorage.decryptString(Buffer.from(chatSettings.key, 'base64'));
  } catch {
    throw new Error('저장한 Gemini 키를 열 수 없습니다. 펫 설정에서 키를 다시 저장해 주세요.');
  }
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'nikke', privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

const bundled = {
  '/': join(__dirname, 'index.html'),
  '/pet.css': join(__dirname, 'pet.css'),
  '/pet.mjs': join(__dirname, 'pet.mjs'),
  '/persona.html': join(__dirname, 'persona.html'),
  '/persona.mjs': join(__dirname, 'persona.mjs'),
  '/spine.mjs': join(__dirname, 'spine.mjs'),
  '/character-release-dates.json': join(__dirname, 'character-release-dates.json'),
  '/spine.css': require.resolve('spine41/dist/spine-player.css'),
  '/spine40.js': require.resolve('spine40/dist/iife/spine-player.min.js'),
  '/spine41.js': require.resolve('spine41/dist/iife/spine-player.min.js'),
};

const githubAssets = 'https://raw.githubusercontent.com/Nikke-db/Nikke-db.github.io/main';
const liveAssets = 'https://nikke-db-legacy.pages.dev';
const catalogUrls = [
  'https://raw.githubusercontent.com/Nikke-db/nikke-db-vue/main/src/utils/json/l2d.json',
  githubAssets + '/js/json/l2d.json',
];
const assetPath = /^\/l2d\/[a-z\d_-]+\/(?:aim\/|cover\/)?[a-z\d_.-]+\.(?:skel|atlas|png|webp|jpe?g)$/i;

async function requestResource(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'pet' || request.method !== 'GET') return new Response(null, { status: 404 });
  const path = url.pathname;
  if (Object.hasOwn(bundled, path)) return net.fetch(pathToFileURL(bundled[path]).href);
  const urls = path === '/catalog.json' ? catalogUrls : assetPath.test(path)
    ? [liveAssets + path, githubAssets + path] : [];
  for (const source of urls) {
    try {
      const response = await net.fetch(source, {
        signal: AbortSignal.timeout(10000), redirect: 'error', credentials: 'omit',
      });
      if (!response.ok) continue;
      const type = path === '/catalog.json' ? 'application/json'
        : path.endsWith('.atlas') ? 'text/plain'
          : path.endsWith('.skel') ? 'application/octet-stream'
            : 'image/' + path.split('.').at(-1).replace('jpg', 'jpeg');
      return new Response(response.body, { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' } });
    } catch {
      // Use the public mirror when the asset host is unavailable.
    }
  }
  return new Response(null, { status: 404 });
}

async function findCodex() {
  if (process.env.NIKKE_CODEX_PATH) return process.env.NIKKE_CODEX_PATH;
  if (process.platform !== 'win32') return 'codex';
  for (const folder of (process.env.PATH || '').split(';').filter(Boolean)) {
    const file = join(folder.replace(/^"|"$/g, ''), 'codex.exe');
    if (existsSync(file)) return file;
  }
  if (process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const dirs = await readdir(root).catch(() => []);
    const candidates = dirs.map(dir => join(root, dir, 'codex.exe')).filter(file => existsSync(file));
    candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  return 'codex.exe';
}

function send(type, details = {}) {
  if (window && !window.isDestroyed()) window.webContents.send('pet:event', { type, ...details });
}

async function approve(method, params) {
  if (!window || window.isDestroyed()) return false;
  const command = method === 'item/commandExecution/requestApproval';
  const detail = [params.reason, params.cwd, params.command, params.grantRoot].filter(Boolean).join('\n');
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    message: command ? 'Codex 명령 실행을 허용할까요?' : 'Codex 파일 변경을 허용할까요?',
    detail, buttons: ['거절', '이번만 허용'], defaultId: 0, cancelId: 0,
  });
  return response === 1;
}

function onCodexEvent(method, params) {
  if (!threadId || params.threadId !== threadId) return;
  if (method === 'turn/started') {
    turnId = params.turn.id;
    send('working');
  } else if (method === 'item/agentMessage/delta' && params.turnId === turnId) {
    send('delta', { itemId: params.itemId, text: params.delta });
  } else if (method === 'item/completed' && params.turnId === turnId && params.item.type === 'agentMessage') {
    send('message', { itemId: params.item.id, text: params.item.text });
  } else if (method === 'turn/completed' && (params.turn.id === turnId || sending)) {
    turnId = undefined;
    send('done', {
      status: params.turn.status,
      error: params.turn.error?.message,
    });
  }
}

async function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({
    width: petWidth, height: petHeight,
    x: x + width - petWidth - 22, y: y + height - petHeight - 18,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadURL('nikke://pet/');
  let lastPoint;
  pointerTimer = setInterval(() => {
    if (window.isDestroyed() || !window.isVisible() || window.isMinimized()) return;
    const { x, y } = screen.getCursorScreenPoint();
    const bounds = window.getContentBounds();
    const localX = x - bounds.x;
    const localY = y - bounds.y;
    const inside = localX >= 0 && localY >= 0 && localX < bounds.width && localY < bounds.height;
    const key = inside ? `${localX},${localY}` : '';
    if (key === lastPoint) return;
    lastPoint = key;
    send('pointer', { point: inside ? { x: localX, y: localY } : null });
  }, 25);
}

async function openPersona(theme) {
  if (personaWindow && !personaWindow.isDestroyed()) {
    personaWindow.focus();
    return;
  }
  const popup = new BrowserWindow({
    parent: window, modal: true, width: 430, height: 440, show: false, autoHideMenuBar: true,
    title: '페르소나 설정', backgroundColor: theme === 'white' ? '#fbfbfd' : '#171821',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  personaWindow = popup;
  popup.once('closed', () => { personaWindow = undefined; });
  popup.once('ready-to-show', () => popup.show());
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.webContents.on('will-navigate', event => event.preventDefault());
  try {
    await popup.loadURL('nikke://pet/persona.html?theme=' + (theme === 'white' ? 'white' : 'black'));
  } catch (error) {
    if (!popup.isDestroyed()) popup.destroy();
    throw error;
  }
}

app.whenReady().then(async () => {
  protocol.handle('nikke', requestResource);
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    chatSettings = {
      backend: saved.backend === 'codex' ? 'codex' : 'gemini',
      key: saved.key,
      persona: readPersona(saved.persona),
    };
  } catch {
    // A fresh installation starts in Gemini mode.
  }
  codex = new Codex(await findCodex(), cwd, approve);
  codex.on('event', onCodexEvent);
  codex.on('disconnected', message => {
    threadId = undefined;
    turnId = undefined;
    if (chatSettings.backend === 'codex') send('disconnected', { message });
  });

  ipcMain.on('pet:pointer-hit', (_event, hit) => window.setIgnoreMouseEvents(!dragOrigin && hit !== true));
  ipcMain.on('pet:drag-start', () => {
    const [x, y] = window.getPosition();
    dragOrigin = { x, y, cursor: screen.getCursorScreenPoint() };
    window.setIgnoreMouseEvents(false);
  });
  ipcMain.on('pet:drag-move', () => {
    if (!dragOrigin) return;
    const cursor = screen.getCursorScreenPoint();
    window.setPosition(dragOrigin.x + cursor.x - dragOrigin.cursor.x,
      dragOrigin.y + cursor.y - dragOrigin.cursor.y);
  });
  ipcMain.on('pet:drag-end', () => { dragOrigin = undefined; });
  ipcMain.on('pet:zoom', (_event, direction) => {
    if (dragOrigin || (direction !== 1 && direction !== -1)) return;
    const bounds = window.getBounds();
    const { workArea } = screen.getDisplayMatching(bounds);
    const limit = Math.min(1.65, workArea.width / petWidth, workArea.height / petHeight);
    petScale = Math.min(limit, Math.max(0.65, petScale + direction * 0.1));
    const width = Math.round(petWidth * petScale);
    const height = Math.round(petHeight * petScale);
    const x = Math.round(bounds.x + (bounds.width - width) / 2);
    const y = bounds.y + bounds.height - height;
    window.setBounds({
      x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
      y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
      width, height,
    });
  });
  ipcMain.handle('pet:chat-settings', () => ({ backend: chatSettings.backend, hasKey: Boolean(chatSettings.key) }));
  ipcMain.handle('pet:open-persona', (_event, theme) => openPersona(theme));
  ipcMain.handle('pet:persona', () => readPersona(chatSettings.persona));
  ipcMain.handle('pet:save-persona', (event, persona) => {
    if (event.sender !== personaWindow?.webContents) throw new Error('페르소나 설정 창에서 저장해 주세요.');
    saveChatSettings({ ...chatSettings, persona: readPersona(persona) });
  });
  ipcMain.handle('pet:set-backend', (_event, backend) => {
    if (turnId || sending || gemini.active || savingKey) throw new Error('현재 작업이 끝난 뒤 바꿔 주세요.');
    if (backend !== 'gemini' && backend !== 'codex') throw new Error('지원하지 않는 대화 방식입니다.');
    saveChatSettings({ ...chatSettings, backend });
    if (backend === 'gemini') send('desktop', { active: false, reply: false });
  });
  ipcMain.handle('pet:save-key', async (_event, key) => {
    if (savingKey || gemini.active) throw new Error('현재 작업이 끝난 뒤 다시 시도해 주세요.');
    if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{16,512}$/.test(key)) {
      throw new Error('Google AI Studio에서 발급한 API 키를 입력해 주세요.');
    }
    if (!safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('이 PC에서 키를 암호화할 수 없습니다.');
    }
    savingKey = true;
    try {
      await Gemini.validateKey(key);
      saveChatSettings({ ...chatSettings, key: safeStorage.encryptString(key).toString('base64') });
    } finally {
      savingKey = false;
    }
  });
  ipcMain.handle('pet:connect', async () => {
    if (chatSettings.backend === 'gemini') {
      geminiKey();
      return;
    }
    await codex.connect();
    const { account, requiresOpenaiAuth } = await codex.request('account/read', { refreshToken: false });
    if (!account && requiresOpenaiAuth) throw new Error('Codex Desktop 또는 codex login에서 먼저 로그인해 주세요.');
  });
  ipcMain.handle('pet:submit', async (_event, text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new Error('입력 내용을 확인해 주세요.');
    if (chatSettings.backend === 'gemini') {
      if (gemini.active || savingKey) throw new Error('현재 작업이 끝난 뒤 다시 시도해 주세요.');
      return gemini.chat(geminiKey(), text.trim(), send, readPersona(chatSettings.persona));
    }
    if (sending || turnId) throw new Error('Codex가 이미 작업 중입니다.');
    sending = true;
    try {
      await codex.connect();
      if (!threadId) {
        const { thread } = await codex.request('thread/start', { cwd, threadSource: 'user' });
        threadId = thread.id;
      }
      await codex.request('turn/start', {
        threadId, input: [{ type: 'text', text: text.trim(), text_elements: [] }],
      });
    } finally {
      sending = false;
    }
  });
  ipcMain.handle('pet:stop', () => {
    if (chatSettings.backend === 'gemini') return gemini.stop();
    if (turnId) return codex.request('turn/interrupt', { threadId, turnId });
  });
  ipcMain.handle('pet:pin', () => {
    window.setAlwaysOnTop(!window.isAlwaysOnTop());
    return window.isAlwaysOnTop();
  });
  ipcMain.on('pet:hide', () => window.minimize());
  ipcMain.on('pet:close', () => window.close());

  await createWindow();
  const desktop = new DesktopActivity(join(codexHome, 'sessions'), cwd);
  const poll = async () => {
    const activity = chatSettings.backend === 'codex' ? await desktop.sample().catch(() => ({ active: false, reply: false })) : null;
    if (!app.isReady() || !window || window.isDestroyed()) return;
    if (activity && chatSettings.backend === 'codex') send('desktop', activity);
    activityTimer = setTimeout(poll, 1600);
  };
  void poll();
}).catch(error => {
  dialog.showErrorBox('NIKKE Desktop Agent', error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  clearTimeout(activityTimer);
  clearInterval(pointerTimer);
  codex?.close();
  gemini.stop();
});
