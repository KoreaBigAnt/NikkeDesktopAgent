const { open, readdir, stat } = require('node:fs/promises');
const { join, resolve } = require('node:path');

const maxAge = 20 * 60 * 1000;
const tailSize = 256 * 1024;

function readEvent(line) {
  try {
    const record = JSON.parse(line);
    if (record.type === 'event_msg' || record.type === 'session_meta') return record.payload;
  } catch {
    // The first or last line of a tail read may be incomplete.
  }
  return null;
}

function turnActivity(text) {
  let active;
  let reply = false;
  for (const line of text.split('\n')) {
    const event = readEvent(line);
    if (!event) continue;
    if (event.type === 'task_started' || event.type === 'turn_started') {
      active = true;
      reply = false;
    }
    if (event.type === 'task_complete' || event.type === 'turn_completed' || event.type === 'turn_aborted') {
      active = false;
    }
    if (event.type === 'agent_message' ||
        (event.type === 'item_completed' && /^agent_?message$/i.test(event.item?.type ?? ''))) {
      reply = true;
    }
  }
  return { active, reply };
}

function workspace(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

class DesktopActivity {
  constructor(directory, cwd) {
    this.directory = directory;
    this.cwd = workspace(cwd);
    this.files = new Map();
    this.initial = true;
  }

  async sample() {
    const now = Date.now();
    const seen = new Set();
    let active = false;
    let reply = false;
    for (const time of [now, now - 86400000]) {
      const date = new Date(time);
      const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0'));
      const folder = join(this.directory, ...parts);
      const files = await readdir(folder).catch(() => []);
      for (const file of files) {
        if (!/^rollout-.*\.jsonl$/.test(file)) continue;
        const path = join(folder, file);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile() || now - info.mtimeMs > maxAge) continue;
        seen.add(path);
        const old = this.files.get(path);
        const state = old?.size === info.size && old?.mtime === info.mtimeMs
          ? old : await this.inspect(path, info, old).catch(() => old);
        if (!state) continue;
        this.files.set(path, state);
        active ||= Boolean(state.active);
        if (state !== old && !this.initial) reply ||= Boolean(state.reply);
      }
    }
    for (const path of this.files.keys()) {
      if (!seen.has(path)) this.files.delete(path);
    }
    this.initial = false;
    return { active, reply };
  }

  async inspect(path, info, old) {
    const state = { size: info.size, mtime: info.mtimeMs, matches: old?.matches };
    if (state.matches === false) return state;
    const file = await open(path, 'r');
    try {
      if (state.matches === undefined) {
        const head = Buffer.alloc(Math.min(info.size, 128 * 1024));
        await file.read(head, 0, head.length, 0);
        const newline = head.indexOf(10);
        if (newline < 0) return state;
        const meta = readEvent(head.subarray(0, newline).toString());
        state.matches = /codex desktop/i.test(meta?.originator ?? '') &&
          !meta.parent_thread_id && !meta.source?.subagent && meta.cwd && workspace(meta.cwd) === this.cwd;
      }
      if (!state.matches) return state;
      const minimum = old?.active !== undefined && old.size <= info.size ? old.size : 0;
      let end = info.size;
      let partial = Buffer.alloc(0);
      while (end > minimum && state.active === undefined) {
        const offset = Math.max(minimum, end - tailSize);
        const buffer = Buffer.alloc(end - offset);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        const content = Buffer.concat([buffer.subarray(0, bytesRead), partial]);
        const split = offset > minimum ? content.indexOf(10) : -1;
        if (offset > minimum && split < 0) {
          // Large tool records can exceed a block. Only lifecycle and reply records are needed.
          partial = Buffer.alloc(0);
        } else {
          partial = content.subarray(0, split + 1);
          const summary = turnActivity(content.subarray(split + 1).toString());
          state.active = summary.active;
          if (!old || end > old.size) state.reply ||= summary.reply;
        }
        end = offset;
      }
      state.active ??= old?.active;
      return state;
    } finally {
      await file.close();
    }
  }
}

module.exports = { DesktopActivity, turnActivity };
