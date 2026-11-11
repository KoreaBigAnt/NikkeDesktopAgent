const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');

class Codex extends EventEmitter {
  constructor(executable, cwd, approve) {
    super();
    this.executable = executable;
    this.cwd = cwd;
    this.approve = approve;
    this.pending = new Map();
    this.nextId = 0;
  }

  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.start().catch(error => {
      this.close();
      throw error;
    });
    return this.ready;
  }

  async start() {
    const child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const fail = error => {
      if (this.child !== child) return;
      this.close();
      this.emit('disconnected', error.message);
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('exit', code => fail(new Error(stderr.trim() || `Codex 종료 (${code})`)));
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child === child) void this.receive(line);
    });
    await this.request('initialize', {
      clientInfo: { name: 'nikke_desktop_agent', title: 'NIKKE Desktop Agent', version: '0.1.0' },
    });
    this.write({ method: 'initialized' });
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex에 연결할 수 없습니다.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 응답 시간 초과 (${method})`));
      }, 30000);
      const settle = callback => value => {
        clearTimeout(timeout);
        this.pending.delete(id);
        callback(value);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.get(id).reject(error);
      }
    });
  }

  async receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params, result, error } = message;
    if (id === undefined) {
      if (method) this.emit('event', method, params ?? {});
      return;
    }
    if (!method) {
      const pending = this.pending.get(id);
      if (error) pending?.reject(new Error(error.message));
      else pending?.resolve(result);
      return;
    }
    const child = this.child;
    let response;
    try {
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        response = { result: { decision: await this.approve(method, params) ? 'accept' : 'decline' } };
      } else {
        response = { error: { code: -32601, message: `펫에서 지원하지 않는 Codex 요청: ${method}` } };
      }
    } catch (error) {
      response = { error: { code: -32603, message: error.message } };
    }
    if (this.child === child) {
      try {
        this.write({ id, ...response });
      } catch {
        // The app server shut down while the request was open.
      }
    }
  }

  close() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.kill();
    for (const pending of this.pending.values()) pending.reject(new Error('Codex 연결이 종료되었습니다.'));
  }
}

module.exports = { Codex };
