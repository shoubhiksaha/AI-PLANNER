// Reminder scheduling against a fake Android scheduler: what's reported is always what's scheduled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRemindersWith, loadRemindersWith, remindersFromScheduled, readSettingsWith, writeSettingsWith, MESSAGES } from './reminder-core.js';

const OFF = { morning: { on: false, time: '08:00' }, evening: { on: false, time: '21:00' } };
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A fake scheduler and settings file; `fail` names steps that throw. */
function fakePhone({ scheduled = [], saved = OFF, fail = {} } = {}) {
  const state = { scheduled: [...scheduled], saved: plain(saved), saves: 0 };
  const maybeFail = (step) => {
    if (typeof fail[step] === 'function' ? fail[step](state) : fail[step]) throw new Error(`${step} failed`);
  };
  const deps = {
    load: async () => plain(state.saved),
    save: async (r) => { state.saves += 1; maybeFail('save'); state.saved = plain(r); },
    permission: async () => fail.permission || 'granted',
    ensureChannel: async () => maybeFail('ensureChannel'),
    cancelAll: async () => { maybeFail('cancelAll'); state.scheduled = []; },
    scheduleOne: async (key, hour, minute) => {
      maybeFail(`schedule:${key}`);
      state.scheduled.push({ content: { ...MESSAGES[key], data: { reminder: key } }, trigger: { type: 'daily', hour, minute } });
    },
    getScheduled: async () => { maybeFail('getScheduled'); return plain(state.scheduled); },
    warn: () => {},
  };
  return { deps, state };
}
const daily = (key, hour, minute) => ({ content: { ...MESSAGES[key], data: { reminder: key } }, trigger: { type: 'daily', hour, minute } });
const onKeys = (r) => Object.keys(r).filter((k) => r[k].on);

test('saving schedules what is on and remembers it', async () => {
  const { deps, state } = fakePhone();
  const result = await applyRemindersWith(deps, { morning: { on: true, time: '07:30' }, evening: { on: false, time: '21:00' } });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.reminders), { morning: { on: true, time: '07:30' }, evening: { on: false, time: '21:00' } });
  assert.deepEqual(state.scheduled.map((r) => r.trigger), [{ type: 'daily', hour: 7, minute: 30 }]);
  assert.deepEqual(state.saved.morning, { on: true, time: '07:30' });
});

test('if the settings file can\'t be written, the previous schedule is put back and reported', async () => {
  // Evening at 21:00 is on; the person turns on morning too, and the file write fails.
  const { deps, state } = fakePhone({
    scheduled: [daily('evening', 21, 0)],
    saved: { ...OFF, evening: { on: true, time: '21:00' } },
    fail: { save: (s) => s.saves === 1 },
  });
  const result = await applyRemindersWith(deps, { morning: { on: true, time: '08:00' }, evening: { on: true, time: '21:00' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'error');
  assert.deepEqual(onKeys(result.reminders), ['evening']);
  assert.deepEqual(onKeys(remindersFromScheduled(state.scheduled)), ['evening']);
  // The file was brought back in line with what is scheduled.
  assert.deepEqual(onKeys(state.saved), ['evening']);
});

test('if putting the previous schedule back fails partway, what is left scheduled is reported', async () => {
  // Morning was on. Turning on evening fails, and restoring morning fails too: nothing is left.
  let cancels = 0;
  const { deps, state } = fakePhone({
    scheduled: [daily('morning', 8, 0)],
    saved: { ...OFF, morning: { on: true, time: '08:00' } },
    fail: { 'schedule:evening': true, 'schedule:morning': (s) => s.scheduled.length === 0 && ++cancels > 1 },
  });
  const result = await applyRemindersWith(deps, { morning: { on: true, time: '08:00' }, evening: { on: true, time: '21:00' } });
  assert.equal(result.ok, false);
  assert.deepEqual(plain(result.reminders), plain(remindersFromScheduled(state.scheduled, OFF)));
  assert.deepEqual(onKeys(result.reminders), []);
  assert.equal(state.scheduled.length, 0);
});

test('if cancelling fails during the restore, a reminder still scheduled is reported as on, not "all off"', async () => {
  const { deps, state } = fakePhone({
    scheduled: [daily('evening', 21, 0)],
    saved: { ...OFF, evening: { on: true, time: '21:00' } },
    // Turning evening off: cancelling fails every time, so evening stays scheduled.
    fail: { cancelAll: true },
  });
  const result = await applyRemindersWith(deps, OFF);
  assert.equal(result.ok, false);
  assert.equal(state.scheduled.length, 1);
  assert.deepEqual(plain(result.reminders.evening), { on: true, time: '21:00' });
});

test('if the schedule can\'t be read back, no state is reported', async () => {
  const { deps } = fakePhone({ fail: { 'schedule:morning': true } });
  // Reading works before the change and fails after it.
  let reads = 0;
  const getScheduled = deps.getScheduled;
  deps.getScheduled = async () => { reads += 1; if (reads > 1) throw new Error('read failed'); return getScheduled(); };
  const result = await applyRemindersWith(deps, { ...OFF, morning: { on: true, time: '08:00' } });
  assert.deepEqual(result, { ok: false, reason: 'error', reminders: null });
});

test('permission refused: nothing changes', async () => {
  const { deps, state } = fakePhone({ fail: { permission: 'blocked' } });
  const result = await applyRemindersWith(deps, { ...OFF, morning: { on: true, time: '08:00' } });
  assert.deepEqual(plain(result), { ok: false, reason: 'blocked', reminders: OFF });
  assert.equal(state.scheduled.length, 0);
  assert.equal(state.saves, 0);
});

test('loading trusts the schedule over the file, and keeps remembered times for reminders that are off', async () => {
  // The file says morning is on at 07:15, but only evening is scheduled (at 20:45).
  const { deps } = fakePhone({
    scheduled: [daily('evening', 20, 45)],
    saved: { morning: { on: true, time: '07:15' }, evening: { on: false, time: '21:00' } },
  });
  assert.deepEqual(plain(await loadRemindersWith(deps)), { morning: { on: false, time: '07:15' }, evening: { on: true, time: '20:45' } });
});

test('reminders scheduled by older builds (no tag) are recognised by their title', () => {
  const old = [{ content: { ...MESSAGES.morning, data: { url: 'aiplanner://scan' } }, trigger: { hour: 6, minute: 5 } }];
  assert.deepEqual(plain(remindersFromScheduled(old)), { morning: { on: true, time: '06:05' }, evening: { on: false, time: '21:00' } });
});

test('if the schedule can\'t be read at all, loading reports unknown (null), not the saved settings', async () => {
  const { deps } = fakePhone({ saved: { ...OFF, morning: { on: true, time: '08:00' } }, fail: { getScheduled: true } });
  assert.equal(await loadRemindersWith(deps), null);
});

test('repeated read failures: a failed change reports unknown, and permission refusal reports unknown too', async () => {
  // Reading never works; scheduling the new reminder fails.
  const { deps } = fakePhone({ saved: { ...OFF, morning: { on: true, time: '08:00' } }, fail: { getScheduled: true, 'schedule:evening': true } });
  assert.deepEqual(await applyRemindersWith(deps, { ...OFF, evening: { on: true, time: '21:00' } }), { ok: false, reason: 'error', reminders: null });
  const refused = fakePhone({ fail: { getScheduled: true, permission: 'denied' } });
  assert.deepEqual(await applyRemindersWith(refused.deps, { ...OFF, morning: { on: true, time: '08:00' } }), { ok: false, reason: 'denied', reminders: null });
});

/** A fake documents folder; `fail` names operations that throw ('move:temp>main' etc.). */
function fakeFolder(files = {}, fail = {}) {
  const state = { files: { ...files } };
  const check = (op) => { if (fail[op]) throw new Error(`${op} failed`); };
  const fs = {
    exists: async (name) => name in state.files,
    read: async (name) => { check(`read:${name}`); return state.files[name]; },
    write: async (name, text) => { check(`write:${name}`); state.files[name] = text; },
    // Like Android: the destination is deleted first, then the file is moved.
    move: async (from, to) => { delete state.files[to]; check(`move:${from}>${to}`); state.files[to] = state.files[from]; delete state.files[from]; },
    remove: async (name) => { check(`remove:${name}`); delete state.files[name]; },
  };
  return { fs, state };
}
const json = (r) => JSON.stringify(r);
const MORNING = { ...OFF, morning: { on: true, time: '07:00' } };

test('settings file: a save replaces it and leaves no temporary or backup file', async () => {
  const { fs, state } = fakeFolder({ main: json(OFF) });
  await writeSettingsWith(fs, MORNING);
  assert.deepEqual(Object.keys(state.files), ['main']);
  assert.deepEqual(plain(await readSettingsWith(fs)), MORNING);
});

test('settings file: if moving the new file into place fails, the old settings are put back', async () => {
  const { fs, state } = fakeFolder({ main: json(OFF) }, { 'move:temp>main': true });
  await assert.rejects(writeSettingsWith(fs, MORNING));
  assert.equal(state.files.main, json(OFF));
  assert.deepEqual(plain(await readSettingsWith(fs)), OFF);
});

test('settings file: if the old file can\'t be put back either, the backup is still read', async () => {
  const { fs, state } = fakeFolder({ main: json(OFF) }, { 'move:temp>main': true, 'move:backup>main': true });
  await assert.rejects(writeSettingsWith(fs, MORNING, () => {}));
  assert.equal('main' in state.files, false);
  assert.deepEqual(plain(await readSettingsWith(fs)), OFF);
});

test('settings file: an unreadable main file falls back to the backup, then to the defaults', async () => {
  assert.deepEqual(plain(await readSettingsWith(fakeFolder({ main: '{broken', backup: json(MORNING) }).fs, () => {})), MORNING);
  assert.deepEqual(plain(await readSettingsWith(fakeFolder({ main: '{broken' }).fs, () => {})), OFF);
});

test('settings file: an unreadable main file never replaces a good backup, even if the save then fails', async () => {
  const { fs, state } = fakeFolder({ main: '{broken', backup: json(MORNING) }, { 'move:temp>main': true });
  await assert.rejects(writeSettingsWith(fs, OFF, () => {}));
  assert.equal(state.files.backup, json(MORNING));
  assert.deepEqual(plain(await readSettingsWith(fs, () => {})), MORNING);
});

test('settings file: a successful save over an unreadable file leaves just the new file', async () => {
  const { fs, state } = fakeFolder({ main: '{broken', backup: json(MORNING) });
  await writeSettingsWith(fs, OFF);
  assert.deepEqual(Object.keys(state.files), ['main']);
  assert.deepEqual(plain(await readSettingsWith(fs)), OFF);
});

test('a failure before the schedule changes (e.g. the channel) leaves the schedule alone', async () => {
  // The schedule can't be read and the channel can't be created: evening stays scheduled as it
  // was, nothing is cancelled or rebuilt from the (stale) saved settings.
  let cancels = 0;
  const { deps, state } = fakePhone({
    scheduled: [daily('evening', 21, 0)],
    saved: { ...OFF, morning: { on: true, time: '08:00' } },
    fail: { getScheduled: true, ensureChannel: true },
  });
  const cancelAll = deps.cancelAll;
  deps.cancelAll = async () => { cancels += 1; return cancelAll(); };
  const result = await applyRemindersWith(deps, { ...OFF, evening: { on: true, time: '21:30' } });
  assert.deepEqual(result, { ok: false, reason: 'error', reminders: null });
  assert.equal(cancels, 0);
  assert.deepEqual(state.scheduled.map((r) => r.content.data.reminder), ['evening']);
  assert.equal(state.saves, 0);
});
