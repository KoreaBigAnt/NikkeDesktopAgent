import { alignCombatViewports, loadPose } from './spine.mjs';

const get = id => document.getElementById(id);
const bodyContainer = get('body-model');
const coverContainer = get('cover-model');
const aimContainer = get('aim-model');
const picker = get('character');
const sortPicker = get('character-sort');
const prompt = get('prompt');
const reply = get('reply');
const messages = get('messages');
const status = get('status');
const settings = get('settings');
const settingsMenu = get('settings-menu');
const themePicker = get('theme');
const backendPicker = get('chat-backend');
const keyField = get('gemini-key');
const keyStatus = get('key-status');
const petHit = get('pet-hit');
const rapi = { id: 'c010', name: 'Rapi', ko: '라피' };
const replyItems = new Map();
let characters = [rapi];
let releaseDates = {};
let body;
let cover;
let aim;
let loading;
let connected = false;
let connecting = false;
let chatBackend = 'gemini';
let working = false;
let receivedReply = false;
let pendingReply = false;
let replyCompleted = false;
let desktopWorking = false;
let desktopReady = false;
let stopping = false;
let talking = false;
let touching = false;
let seated = false;
let idleTimer;
let talkTimer;
let replyTimer;
let touchTimer;
let visibleMotion;
let activeModel;
let transition;
let pointer;
let editingPrompt = false;
let drag;
let suppressClick = false;
let samplePointer = false;
let pointerHit = true;
const pixel = new Uint8Array(4);

function setStatus(state, text) {
  if (status.dataset.state === state && status.textContent === text) return;
  status.dataset.state = state;
  status.textContent = text;
  prompt.title = text + ' · 우클릭으로 펫 설정';
}

function setPointerHit(hit) {
  if (pointerHit === hit) return;
  pointerHit = hit;
  window.pet.pointerHit(hit);
}

function refreshPointer() {
  samplePointer = false;
  if (drag || !settings.hidden) {
    setPointerHit(true);
    return;
  }
  if (!pointer) {
    setPointerHit(false);
    return;
  }
  const target = document.elementFromPoint(pointer.x, pointer.y);
  if (target?.closest('.dock, .reply, .asset-status')) {
    setPointerHit(true);
  } else if (target?.closest('.stage') && body) {
    samplePointer = true;
  } else {
    setPointerHit(false);
  }
}

function testModelPixel(player) {
  if (!samplePointer) return;
  if (player !== activeModel?.player) return;
  samplePointer = false;
  const { canvas, context: { gl } } = player;
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((pointer.x - rect.left) * gl.drawingBufferWidth / rect.width);
  const y = gl.drawingBufferHeight - 1 - Math.floor((pointer.y - rect.top) * gl.drawingBufferHeight / rect.height);
  pixel.fill(0);
  if (x >= 0 && y >= 0 && x < gl.drawingBufferWidth && y < gl.drawingBufferHeight) {
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  }
  setPointerHit(pixel[3] > 24);
}

function showReply(show) {
  clearTimeout(replyTimer);
  reply.hidden = !show;
  refreshPointer();
}

function scheduleReplyClose() {
  if (!reply.hidden) replyTimer = setTimeout(() => showReply(false), 8000);
}

function showSettings(show) {
  settings.hidden = !show;
  settingsMenu.hidden = false;
  get('gemini-settings').hidden = true;
  if (!show) keyField.value = '';
  get('show-reply').textContent = reply.hidden ? '대화 보기' : '대화 접기';
  syncMotion();
  refreshPointer();
}

function syncControls() {
  const service = chatBackend === 'gemini' ? 'Gemini' : 'Codex';
  get('send').hidden = working;
  get('send').disabled = connecting || pendingReply || !prompt.value.trim();
  get('stop').hidden = !working;
  get('stop').disabled = stopping;
  backendPicker.disabled = working || connecting;
  picker.disabled = working || pendingReply;
  get('save-key').disabled = working || connecting;
  if (connecting) setStatus('connecting', service + ' 연결 중');
  else if (talking) setStatus('talking', '답변 중');
  else if (working || desktopWorking) setStatus('working', working ? service + ' 응답 준비 중' : 'Codex Desktop 작업 중');
  else if (connected) setStatus('idle', service + ' 대기 중');
  else setStatus('error', service + ' 연결 필요');
}

async function loadChatSettings() {
  const config = await window.pet.chatSettings();
  chatBackend = config.backend;
  backendPicker.value = chatBackend;
  get('open-key').disabled = chatBackend !== 'gemini';
  keyField.placeholder = config.hasKey ? '키 저장됨 · 새 키 입력' : 'Google AI Studio 키';
  prompt.placeholder = chatBackend === 'gemini' ? 'Gemini로 대화하기' : 'Codex에게 메시지 보내기';
}

function applyTheme(theme) {
  const selected = theme === 'white' ? 'white' : 'black';
  document.documentElement.dataset.theme = selected;
  themePicker.value = selected;
  localStorage.setItem('chat-theme', selected);
}

function present(mode, model) {
  activeModel = model;
  visibleMotion = mode;
  bodyContainer.classList.toggle('standby', model !== body);
  coverContainer.classList.toggle('standby', !cover || model !== cover);
  aimContainer.classList.toggle('standby', !aim || model !== aim);
  bodyContainer.parentElement.dataset.motion = mode;
  refreshPointer();
}

function playCombat(model, animation, loop) {
  if (!animation) return;
  const entry = model.player.animationState.setAnimation(0, animation, loop);
  entry.mixDuration = 0;
  return entry;
}

function turnBetweenPoses(toRear) {
  const source = toRear ? cover : aim;
  const target = toRear ? aim : cover;
  const motion = toRear ? 'toAim' : 'toCover';
  const mode = toRear ? 'to-aim' : 'to-cover';
  const marker = toRear ? 'SwitchToAimSkin' : 'SwitchToCoverSkin';
  const current = {};
  transition = current;

  const finish = () => {
    if (transition !== current) return;
    playCombat(target, target.motions.idle, true);
    present(toRear ? 'rear-ready' : 'front-return', target);
    if (toRear) {
      transition = undefined;
      sync();
    } else {
      // Give the returning front pose time to appear before showing the standing model.
      setTimeout(() => {
        if (transition !== current) return;
        transition = undefined;
        sync();
      }, 120);
    }
  };

  const first = source.motions[motion] ? source : target;
  const entry = playCombat(first, first.motions[motion], false);
  if (!entry) {
    finish();
    return;
  }
  present(mode, first);
  entry.listener = {
    event(track, event) {
      if (transition !== current || activeModel !== source || event.data.name !== marker) return;
      const next = playCombat(target, target.motions[motion], false);
      if (!next) return;
      present(mode, target);
      if (track.trackTime >= next.animation.duration) finish();
      else {
        next.trackTime = track.trackTime;
        next.listener = { complete: finish };
      }
    },
    complete() {
      if (activeModel === first) finish();
    },
  };
}

function syncMotion() {
  if (transition) return;
  const waiting = !talking && !touching &&
    ((working && !receivedReply) || (!working && !receivedReply && desktopWorking && desktopReady));
  const firing = waiting && (!editingPrompt || working) && aim?.motions.fire;
  const rearVisible = visibleMotion === 'fire' || visibleMotion === 'rear-ready';
  if (firing) {
    if (!rearVisible && cover) turnBetweenPoses(true);
    else if (visibleMotion !== 'fire') {
      playCombat(aim, aim.motions.fire, true);
      present('fire', aim);
    }
    return;
  }
  if (rearVisible && cover) {
    turnBetweenPoses(false);
    return;
  }
  if (pendingReply) {
    pendingReply = false;
    showReply(true);
    messages.scrollTop = messages.scrollHeight;
    if (replyCompleted) scheduleReplyClose();
    talk();
    return;
  }
  const front = seated && !touching && cover;
  const mode = front ? (visibleMotion === 'reload' ? 'reload' : 'front') : talking ? 'talk' : 'idle';
  if (mode !== visibleMotion || activeModel !== (front ? cover : body)) {
    if (mode === 'front') playCombat(cover, cover.motions.idle, true);
    present(mode, front ? cover : body);
  }
  for (const model of [body, cover]) {
    if (!model?.motions.talk) continue;
    const state = model.player.animationState;
    const speaking = state.getCurrent(1)?.animation.name === model.motions.talk;
    if (talking && model === activeModel) {
      if (!speaking) state.setAnimation(1, model.motions.talk, true);
    } else if (speaking) {
      state.setEmptyAnimation(1, 0.15);
    }
  }
}

function noteActivity(sit = false) {
  if (sit) seated = true;
  if (!seated) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    seated = false;
    editingPrompt = false;
    sync();
  }, 60000);
}

function talk() {
  talking = true;
  clearTimeout(talkTimer);
  talkTimer = setTimeout(() => {
    talking = false;
    sync();
  }, 1500);
  sync();
}

function sync() {
  syncControls();
  syncMotion();
}

function touch() {
  noteActivity();
  if (transition || visibleMotion === 'fire' || visibleMotion === 'reload') return;
  if (cover && activeModel === cover) {
    if (!cover.motions.reload) return;
    const model = cover;
    const entry = playCombat(model, model.motions.reload, false);
    present('reload', model);
    entry.listener = { complete() {
      if (activeModel !== model || visibleMotion !== 'reload') return;
      playCombat(model, model.motions.idle, true);
      present('front', model);
      syncMotion();
    } };
    return;
  }
  if (!body?.motions.tap) return;
  const { player, motions } = body;
  const state = player.animationState;
  const entry = state.setAnimation(0, motions.tap, false);
  if (motions.idle) state.addAnimation(0, motions.idle, true, 0);
  clearTimeout(touchTimer);
  touching = true;
  touchTimer = setTimeout(() => {
    touching = false;
    syncMotion();
  }, entry.animation.duration * 1000);
  syncMotion();
}

function showAssetStatus(message, retry = false) {
  get('asset-status').hidden = !message;
  get('asset-message').textContent = message;
  get('retry').hidden = !retry;
  refreshPointer();
}

async function selectCharacter(id) {
  const character = characters.find(entry => entry.id === id) ?? rapi;
  localStorage.setItem('character', character.id);
  loading?.abort();
  loading = new AbortController();
  const { signal } = loading;
  transition = undefined;
  body?.player.dispose();
  cover?.player.dispose();
  aim?.player.dispose();
  body = undefined;
  cover = undefined;
  aim = undefined;
  activeModel = undefined;
  clearTimeout(touchTimer);
  clearTimeout(idleTimer);
  clearTimeout(talkTimer);
  seated = false;
  desktopReady = false;
  editingPrompt = false;
  touching = false;
  talking = false;
  if (!working && !pendingReply) showReply(false);
  visibleMotion = undefined;
  petHit.disabled = true;
  showAssetStatus('캐릭터 불러오는 중');
  syncMotion();
  try {
    const model = await loadPose(bodyContainer, character, 'body', signal, testModelPixel);
    if (signal.aborted) {
      model.player.dispose();
      return;
    }
    body = model;
    petHit.disabled = false;
    showAssetStatus('');
    visibleMotion = undefined;
    syncMotion();
  } catch (error) {
    if (!signal.aborted) {
      console.warn(error);
      showAssetStatus('캐릭터를 불러오지 못했습니다.', true);
    }
    return;
  }
  const [front, rear] = await Promise.allSettled([
    loadPose(coverContainer, character, 'cover', signal, testModelPixel),
    loadPose(aimContainer, character, 'aim', signal, testModelPixel),
  ]);
  if (signal.aborted) {
    if (front.status === 'fulfilled') front.value.player.dispose();
    if (rear.status === 'fulfilled') rear.value.player.dispose();
    return;
  }
  if (front.status === 'fulfilled') cover = front.value;
  if (rear.status === 'fulfilled') aim = rear.value;
  if (cover && aim && cover.motions.idle && aim.motions.idle) alignCombatViewports(cover, aim);
  syncMotion();
}

async function loadCatalog() {
  try {
    const response = await fetch('/catalog.json');
    const data = await response.json();
    const valid = data.filter(entry => typeof entry.name === 'string' && /^c\d{3}(?:_\d+)?$/.test(entry.id));
    if (valid.length) characters = [...new Map(valid.map(entry => [entry.id, entry])).values()];
  } catch (error) {
    console.info('캐릭터 목록을 불러올 수 없습니다.', error);
  }
  sortPicker.value = localStorage.getItem('character-sort') || 'id';
  if (!sortPicker.value) sortPicker.value = 'id';
  renderCharacterList(localStorage.getItem('character'));
  await selectCharacter(picker.value);
}

function renderCharacterList(selected) {
  const localizedByName = new Map(characters
    .filter(entry => typeof entry.ko === 'string' && entry.ko.trim())
    .map(entry => [entry.id.split('_')[0] + ':' + entry.name, entry.ko.trim()]));
  const entries = characters.map(entry => {
    const korean = typeof entry.ko === 'string' ? entry.ko.trim() : '';
    const sameCharacter = localizedByName.get(entry.id.split('_')[0] + ':' + entry.name);
    return { id: entry.id, label: korean || sameCharacter || (entry.id === rapi.id ? rapi.ko : entry.name) };
  });
  const names = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
  const ids = new Intl.Collator('en', { numeric: true });
  entries.sort((a, b) => {
    let order = 0;
    if (sortPicker.value === 'name') order = names.compare(a.label, b.label);
    if (sortPicker.value === 'release') {
      order = (releaseDates[a.id] ?? '9999-12-31').localeCompare(releaseDates[b.id] ?? '9999-12-31');
    }
    return order || ids.compare(a.id, b.id);
  });
  const unknown = document.createElement('optgroup');
  unknown.label = '출시일 미확인';
  const options = [];
  for (const entry of entries) {
    const option = new Option(`[${entry.id}] ${entry.label}`, entry.id);
    if (sortPicker.value === 'release' && !releaseDates[entry.id]) unknown.append(option);
    else options.push(option);
  }
  if (unknown.childElementCount) options.push(unknown);
  picker.replaceChildren(...options);
  picker.value = characters.some(entry => entry.id === selected) ? selected : rapi.id;
  if (!picker.value) picker.selectedIndex = 0;
}

function appendMessage(text, className) {
  const node = document.createElement('p');
  node.className = className;
  node.textContent = text;
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

function showError(error) {
  const message = String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
  showReply(true);
  appendMessage(message, 'error');
  refreshPointer();
}

async function connect(reportError) {
  if (connected) return true;
  connecting = true;
  syncControls();
  try {
    await window.pet.connect();
    connected = true;
    return true;
  } catch (error) {
    if (reportError) showError(error);
    return false;
  } finally {
    connecting = false;
    syncControls();
  }
}

async function submit(event) {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || working || pendingReply || connecting || !await connect(true)) return;
  if (working || pendingReply) return;
  const userMessage = appendMessage(text, 'user');
  prompt.value = '';
  editingPrompt = false;
  prompt.blur();
  showReply(false);
  clearTimeout(talkTimer);
  talking = false;
  receivedReply = false;
  replyCompleted = false;
  working = true;
  noteActivity(true);
  sync();
  try {
    await window.pet.submit(text);
  } catch (error) {
    userMessage.remove();
    if (!prompt.value) prompt.value = text;
    working = false;
    showError(error);
    sync();
  }
}

window.pet.onEvent(event => {
  if (event.type === 'pointer') {
    pointer = event.point;
    refreshPointer();
    return;
  }
  if (event.type === 'working') working = true;
  if (event.type === 'delta' || event.type === 'message') {
    const hasText = Boolean(event.text.trim());
    if (!replyItems.has(event.itemId)) replyItems.set(event.itemId, appendMessage('', 'assistant'));
    const node = replyItems.get(event.itemId);
    if (event.type === 'delta') node.textContent += event.text;
    else node.textContent = event.text;
    messages.scrollTop = messages.scrollHeight;
    refreshPointer();
    if (hasText) {
      noteActivity(true);
      if (!receivedReply) pendingReply = true;
      receivedReply = true;
      if (!pendingReply) talk();
    }
  }
  if (event.type === 'done') {
    working = false;
    stopping = false;
    replyItems.clear();
    if (event.status === 'completed' && receivedReply) {
      noteActivity(true);
      replyCompleted = true;
      if (!pendingReply) scheduleReplyClose();
    }
    if (event.status === 'failed') showError(event.error || 'Codex 작업에 실패했습니다.');
    if (event.status === 'interrupted') {
      appendMessage('작업을 중지했습니다.', 'info');
      showReply(true);
    }
  }
  if (event.type === 'desktop') {
    if (!event.active) desktopReady = true;
    if (!working && event.active && !desktopWorking) receivedReply = false;
    desktopWorking = event.active;
    if (event.reply && !working && desktopReady) talk();
  }
  if (event.type === 'disconnected') {
    if (connected || working) showError(event.message);
    connected = false;
    working = false;
    stopping = false;
    replyItems.clear();
  }
  sync();
});

get('prompt-form').addEventListener('submit', submit);
prompt.addEventListener('input', () => {
  editingPrompt = true;
  noteActivity(true);
  if (!working) {
    clearTimeout(talkTimer);
    talking = false;
    if (replyCompleted && !pendingReply) showReply(false);
  }
  sync();
});
prompt.addEventListener('blur', () => {
  editingPrompt = false;
  syncMotion();
});
prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    get('prompt-form').requestSubmit();
  }
});
picker.addEventListener('change', () => {
  showSettings(false);
  void selectCharacter(picker.value);
});
sortPicker.addEventListener('change', () => {
  localStorage.setItem('character-sort', sortPicker.value);
  renderCharacterList(picker.value);
});
themePicker.addEventListener('change', () => applyTheme(themePicker.value));
get('open-persona').addEventListener('click', async () => {
  showSettings(false);
  try {
    await window.pet.openPersona(themePicker.value);
  } catch (error) {
    showError(error);
  }
});
get('open-key').addEventListener('click', () => {
  settingsMenu.hidden = true;
  get('gemini-settings').hidden = false;
  keyField.focus();
});
get('back-settings').addEventListener('click', () => showSettings(true));
backendPicker.addEventListener('change', async () => {
  connecting = true;
  syncControls();
  try {
    await window.pet.setBackend(backendPicker.value);
    connected = false;
    desktopWorking = false;
    keyField.value = '';
    keyStatus.textContent = '';
    await loadChatSettings();
  } catch (error) {
    backendPicker.value = chatBackend;
    showError(error);
  } finally {
    connecting = false;
    await connect(false);
  }
});
get('gemini-settings').addEventListener('submit', async event => {
  event.preventDefault();
  const key = keyField.value.trim();
  if (!key || working || connecting) return;
  keyField.value = '';
  connecting = true;
  syncControls();
  keyStatus.textContent = 'Google에서 키 확인 중';
  try {
    await window.pet.saveKey(key);
    await loadChatSettings();
    connected = true;
    keyStatus.textContent = 'Gemini 연결 완료';
  } catch (error) {
    keyStatus.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  } finally {
    connecting = false;
    syncControls();
  }
});
get('retry').addEventListener('click', loadCatalog);
petHit.addEventListener('pointerdown', event => {
  if (event.button !== 0 || drag) return;
  suppressClick = false;
  drag = { id: event.pointerId, x: event.screenX, y: event.screenY };
  petHit.setPointerCapture(event.pointerId);
  window.pet.startDrag();
});
petHit.addEventListener('pointermove', event => {
  if (event.pointerId !== drag?.id) return;
  if (Math.hypot(event.screenX - drag.x, event.screenY - drag.y) >= 4) suppressClick = true;
  if (suppressClick) window.pet.moveDrag();
});
petHit.addEventListener('lostpointercapture', event => {
  if (event.pointerId !== drag?.id) return;
  drag = undefined;
  window.pet.endDrag();
  refreshPointer();
});
petHit.addEventListener('click', event => {
  if (!suppressClick || event.detail === 0) touch();
});
petHit.addEventListener('wheel', event => {
  if (!event.deltaY) return;
  event.preventDefault();
  window.pet.zoom(event.deltaY < 0 ? 1 : -1);
}, { passive: false });
window.addEventListener('resize', refreshPointer);
document.addEventListener('contextmenu', event => {
  if (event.target.closest('.messages')) return;
  event.preventDefault();
  showSettings(settings.hidden);
});
document.addEventListener('pointerdown', event => {
  if (event.button === 0 && !settings.hidden && !settings.contains(event.target)) showSettings(false);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!settings.hidden) showSettings(false);
  else showReply(false);
});
window.addEventListener('blur', () => showSettings(false));
get('show-reply').addEventListener('click', () => {
  showReply(reply.hidden);
  showSettings(false);
});
get('hide-reply').addEventListener('click', () => showReply(false));
get('pin').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.setAttribute('aria-pressed', await window.pet.pin());
  showSettings(false);
});
get('minimize').addEventListener('click', window.pet.hide);
get('close').addEventListener('click', window.pet.close);
get('stop').addEventListener('click', async () => {
  stopping = true;
  syncControls();
  try {
    await window.pet.stop();
  } catch (error) {
    stopping = false;
    showError(error);
    syncControls();
  }
});

applyTheme(localStorage.getItem('chat-theme'));
void loadChatSettings().then(() => connect(false)).catch(showError);
void fetch('/character-release-dates.json').then(response => response.json()).then(dates => {
  releaseDates = dates;
  if (sortPicker.value === 'release' && picker.value) renderCharacterList(picker.value);
}).catch(() => {});
void loadCatalog();
