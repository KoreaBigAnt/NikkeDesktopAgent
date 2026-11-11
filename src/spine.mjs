const runtimes = new Map();
let pendingRuntime = Promise.resolve();

function loadRuntime(version) {
  if (!runtimes.has(version)) {
    const loading = pendingRuntime.then(() => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/spine' + version + '.js';
      script.onload = () => resolve(window.spine.SpinePlayer);
      script.onerror = () => reject(new Error('Spine 런타임을 열 수 없습니다.'));
      document.head.append(script);
    }));
    runtimes.set(version, loading);
    pendingRuntime = loading.catch(() => runtimes.delete(version));
  }
  return runtimes.get(version);
}

export function motionNames(names, pose) {
  const exact = (...choices) => choices.find(name => names.includes(name));
  const match = pattern => names.find(name => pattern.test(name));
  if (pose === 'aim' || pose === 'cover') {
    return {
      idle: exact(pose + '_idle', 'idle') || match(/idle/i) || names[0],
      fire: pose === 'aim' ? exact('aim_fire', 'aim_shoot', 'fire', 'shoot', 'attack') ||
        match(/(?:^|_)(?:fire|shoot|attack)(?:_|$)/i) : undefined,
      toAim: exact('to_aim'),
      toCover: exact('to_cover'),
      reload: exact('cover_reload', 'cover_reloadA', 'cover_reloadB', 'reload') ||
        match(/^cover_reload/i),
      talk: exact('talk_start', 'talk', 'talk_loop'),
    };
  }
  return {
    idle: exact('idle', 'idle_01', 'idle_02', 'idle_merged', 'idle_front', 'pose_idle') ||
      match(/(?:^|_)idle(?:_|$)/i) || names[0],
    tap: exact('touch', 'click', 'tap', 'action', 'touch_01', 'click_01', 'action_01') ||
      match(/^(?:touch|click|tap|action)(?:_|\d|$)/i),
    talk: exact('talk_start', 'talk', 'talk_loop') || match(/^(?:talk|speak)(?:_|\d|$)/i),
  };
}

export function alignCombatViewports(front, rear) {
  const a = front.player.currentViewport;
  const b = rear.player.currentViewport;
  if (!a || !b) return;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.max(a.x + a.width, b.x + b.width) - x;
  const height = Math.max(a.y + a.height, b.y + b.height) - y;
  for (const model of [front, rear]) {
    Object.assign(model.player.config.viewport, { x, y, width, height, transitionTime: 0 });
    model.player.setViewport(model.motions.idle);
  }
}

export function loadPose(container, character, pose, signal, draw) {
  const combatPose = pose === 'aim' || pose === 'cover';
  const directory = '/l2d/' + character.id + (combatPose ? '/' + pose + '/' : '/');
  const stem = character.f || character.id + (combatPose ? '_' + pose + '_00' : '_00');
  const model = directory + stem;
  return (async () => {
    const response = await fetch(model + '.skel', { signal });
    if (!response.ok) throw new Error('캐릭터 파일을 불러오지 못했습니다.');
    const binary = await response.blob();
    const header = new TextDecoder().decode(await binary.slice(0, 32).arrayBuffer());
    const version = /4\.([01])\.\d+/.exec(header);
    if (!version) throw new Error('지원하는 Spine 버전은 4.0과 4.1입니다.');
    const SpinePlayer = await loadRuntime('4' + version[1]);
    signal.throwIfAborted();
    const binaryUrl = model + '.skel';
    const raw = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(binary);
    });
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let player;
      const finish = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      };
      const fail = error => {
        finish();
        queueMicrotask(() => player?.dispose());
        reject(error);
      };
      const abort = () => fail(signal.reason);
      const timeout = setTimeout(() => fail(new Error('캐릭터 텍스처 응답 시간이 초과되었습니다.')), 25000);
      signal.addEventListener('abort', abort, { once: true });
      try {
        player = new SpinePlayer(container, {
          binaryUrl,
          rawDataURIs: { [binaryUrl]: raw },
          atlasUrl: model + '.atlas',
          showControls: false, showLoading: false,
          alpha: true, backgroundColor: '#00000000', premultipliedAlpha: true,
          defaultMix: 0.14,
          draw,
          viewport: { padLeft: '5%', padRight: '5%', padTop: '4%', padBottom: '4%' },
          success: player => {
            const names = player.skeleton.data.animations.map(animation => animation.name);
            const motions = motionNames(names, pose);
            if (motions.idle) player.setAnimation(motions.idle, true);
            player.play();
            finish();
            resolve({ player, motions, names });
          },
          error: (_player, message) => fail(new Error(message)),
        });
      } catch (error) {
        fail(error);
      }
    });
  })();
}
