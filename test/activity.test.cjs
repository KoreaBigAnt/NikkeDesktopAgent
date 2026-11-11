const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, appendFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { DesktopActivity } = require('../src/desktop-activity.cjs');

const record = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const event = (type, fields) => record('event_msg', { type, ...fields });

test('tracks Desktop turns for the selected workspace across a large rollout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nikke-activity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const today = new Date();
  const folder = join(root, String(today.getFullYear()),
    String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0'));
  const cwd = join(root, 'project');
  const logfile = join(folder, 'rollout-test.jsonl');
  await mkdir(folder, { recursive: true });
  await writeFile(logfile, record('session_meta', { originator: 'Codex Desktop', cwd }) +
    event('task_started') + event('item_completed', { item: { type: 'CommandExecution', output: 'x'.repeat(630000) } }));
  await writeFile(join(folder, 'rollout-unrelated.jsonl'),
    record('session_meta', { originator: 'Codex Desktop', cwd: root }) + event('task_started'));
  const monitor = new DesktopActivity(root, cwd);
  assert.deepEqual(await monitor.sample(), { active: true, reply: false });

  await appendFile(logfile, event('item_completed', { item: { type: 'AgentMessage', phase: 'final_answer' } }) +
    event('task_complete'));
  assert.deepEqual(await monitor.sample(), { active: false, reply: true });
  assert.deepEqual(await monitor.sample(), { active: false, reply: false });

  await appendFile(logfile, event('task_started') + event('turn_aborted'));
  assert.deepEqual(await monitor.sample(), { active: false, reply: false });
});
