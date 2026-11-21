// Reminder scheduling logic without Expo imports, so it can be tested with a fake scheduler
// (reminder-core.test.mjs). reminders.js wires it to expo-notifications and the settings file.
//
// What Android has scheduled is the truth: after any failure the result is read back from the
// scheduler, never assumed. The settings file only remembers times (and is kept in line).
import { DEFAULT_REMINDERS, normalizeReminders, parseTime } from './bridge.js';

export const REMINDER_KEYS = ['morning', 'evening'];

export const MESSAGES = {
  morning: { title: 'Plan your day', body: 'Photograph this morning’s page. Times go to Calendar, to-dos to Tasks.' },
  evening: { title: 'How did today go?', body: 'Photograph your page to tick off what you got done.' },
};

const pad = (n) => String(n).padStart(2, '0');

/** Which reminder a scheduled request is: our tag, or the title (builds before the tag). */
const reminderKeyOf = (request) => {
  const tag = request?.content?.data?.reminder;
  if (REMINDER_KEYS.includes(tag)) return tag;
  return REMINDER_KEYS.find((key) => request?.content?.title === MESSAGES[key].title) || null;
};

/**
 * Reminder settings from what is actually scheduled. A reminder is on only if it is scheduled;
 * its time comes from the trigger, else from `saved` (which also keeps the times of ones that
 * are off).
 */
export function remindersFromScheduled(scheduled, saved = DEFAULT_REMINDERS) {
  const base = normalizeReminders(saved);
  const out = {};
  for (const key of REMINDER_KEYS) out[key] = { on: false, time: base[key].time };
  for (const request of scheduled || []) {
    const key = reminderKeyOf(request);
    if (!key) continue;
    const { hour, minute } = request.trigger || {};
    const time = Number.isInteger(hour) && Number.isInteger(minute) ? `${pad(hour)}:${pad(minute)}` : base[key].time;
    out[key] = { on: true, time };
  }
  return normalizeReminders(out);
}

/** Replaces every scheduled reminder with the ones that are on in `reminders`. */
export async function scheduleWith(deps, reminders) {
  await deps.cancelAll();
  for (const key of REMINDER_KEYS) {
    if (!reminders[key].on) continue;
    const { hour, minute } = parseTime(reminders[key].time);
    await deps.scheduleOne(key, hour, minute);
  }
}

/**
 * What is in effect now: the scheduler's reminders, with remembered times for the ones off.
 * null if the schedule can't be read (the saved settings alone could be wrong).
 */
export async function loadRemindersWith(deps) {
  const saved = await deps.load();
  try {
    return remindersFromScheduled(await deps.getScheduled(), saved);
  } catch (e) {
    deps.warn?.('Reading scheduled reminders failed:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Settings file. `fs` works on three names: 'main', 'backup' and 'temp'
// ({ exists(name), read(name), write(name, text), move(from, to), remove(name) }; move replaces
// the destination). The old file is kept as 'backup' until the new one is in place, so an
// interrupted or failed save never leaves no settings behind.
// ---------------------------------------------------------------------------------------------

/** The saved settings: 'main', else 'backup' (a save that didn't finish), else the defaults. */
export async function readSettingsWith(fs, warn) {
  for (const name of ['main', 'backup']) {
    try {
      if (await fs.exists(name)) return normalizeReminders(JSON.parse(await fs.read(name)));
    } catch (e) {
      warn?.(`Reading reminder settings (${name}) failed:`, e);
    }
  }
  return DEFAULT_REMINDERS;
}

const readable = async (fs, name) => {
  try {
    if (!(await fs.exists(name))) return false;
    JSON.parse(await fs.read(name));
    return true;
  } catch {
    return false;
  }
};

export async function writeSettingsWith(fs, reminders, warn) {
  await fs.write('temp', JSON.stringify(reminders));
  // Only a readable main file becomes the backup: an unreadable one must never replace a good
  // backup (the last settings that can still be read).
  const hadMain = await readable(fs, 'main');
  if (hadMain) await fs.move('main', 'backup');
  try {
    await fs.move('temp', 'main');
  } catch (e) {
    if (hadMain) {
      try {
        await fs.move('backup', 'main');
      } catch (restoreError) {
        warn?.('Putting the old reminder settings back failed; they stay in the backup:', restoreError);
      }
    }
    throw e;
  }
  if (await fs.exists('backup')) {
    try {
      await fs.remove('backup');
    } catch (removeError) {
      warn?.('Removing the old reminder settings failed:', removeError);
    }
  }
}

/**
 * Saves the settings and schedules what is on. If anything fails, the previous reminders are put
 * back, and the result is read back from the scheduler.
 * @param deps { load, save, permission, ensureChannel, cancelAll, scheduleOne, getScheduled, warn? }
 * @returns {{ ok: boolean, reason?: 'denied'|'blocked'|'error', reminders: object|null }}
 *   reminders: what is actually scheduled afterwards, or null if that couldn't be read.
 */
export async function applyRemindersWith(deps, input) {
  const next = normalizeReminders(input);
  const current = await loadRemindersWith(deps); // null: unknown
  // If the schedule couldn't be read, the saved settings are the best thing to put back.
  const previous = current ?? (await deps.load());
  let scheduleTouched = false; // nothing to put back until the schedule starts changing
  try {
    if (next.morning.on || next.evening.on) {
      const permission = await deps.permission();
      if (permission !== 'granted') return { ok: false, reason: permission, reminders: current };
    }
    await deps.ensureChannel();
    scheduleTouched = true;
    await scheduleWith(deps, next);
    await deps.save(next);
    return { ok: true, reminders: next };
  } catch (e) {
    deps.warn?.('Saving reminders failed:', e);
    // Failed before anything was changed: leave the schedule as it is.
    if (!scheduleTouched) return { ok: false, reason: 'error', reminders: current };
    try {
      await scheduleWith(deps, previous);
    } catch (restoreError) {
      deps.warn?.('Putting the previous reminders back failed:', restoreError);
    }
    let actual;
    try {
      actual = remindersFromScheduled(await deps.getScheduled(), previous);
    } catch (readError) {
      deps.warn?.('Reading scheduled reminders failed:', readError);
      return { ok: false, reason: 'error', reminders: null };
    }
    // Keep the settings file in line with what is scheduled. If this fails too, loading still
    // reads the scheduler, so on/off stays right; only remembered times could be lost.
    try {
      await deps.save(actual);
    } catch (saveError) {
      deps.warn?.('Saving reminder settings failed:', saveError);
    }
    return { ok: false, reason: 'error', reminders: actual };
  }
}
