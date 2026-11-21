// Morning and evening reminders to photograph the planner page (local notifications, this
// phone only). Settings come from the page's Settings › Reminders (SET_REMINDERS). What is on is
// read from Android's schedule; the app's documents folder only remembers the times.
// Tapping a reminder opens the scanner (aiplanner://scan). Logic: reminder-core.js.
import * as Notifications from 'expo-notifications';
import { File, Paths } from 'expo-file-system';
import { DEFAULT_REMINDERS, normalizeReminders } from './bridge';
import { MESSAGES, applyRemindersWith, loadRemindersWith } from './reminder-core';

const CHANNEL_ID = 'reminders';
const STORE_NAME = 'reminders.json';

// A reminder that arrives while the app is open still shows, quietly.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

const storeFile = () => new File(Paths.document, STORE_NAME);

async function readSaved() {
  try {
    const file = storeFile();
    if (!file.exists) return DEFAULT_REMINDERS;
    return normalizeReminders(JSON.parse(await file.text()));
  } catch (e) {
    console.warn('Reading reminder settings failed:', e);
    return DEFAULT_REMINDERS;
  }
}

// Written to a temporary file first, then moved over the old one, so a failed write never
// leaves a half-written settings file.
async function writeSaved(reminders) {
  const tmp = new File(Paths.document, `${STORE_NAME}.tmp`);
  tmp.create({ overwrite: true });
  await tmp.write(JSON.stringify(reminders));
  await tmp.move(storeFile(), { overwrite: true });
}

/** 'granted', 'denied' (may ask again) or 'blocked' (only Settings can turn it on). */
async function notificationPermission() {
  let status = await Notifications.getPermissionsAsync();
  if (!status.granted && status.canAskAgain) status = await Notifications.requestPermissionsAsync();
  if (status.granted) return 'granted';
  return status.canAskAgain ? 'denied' : 'blocked';
}

const deps = {
  load: readSaved,
  save: writeSaved,
  permission: notificationPermission,
  ensureChannel: () =>
    Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Reminders',
      description: 'Morning and evening reminders to photograph your planner page',
      importance: Notifications.AndroidImportance.DEFAULT,
    }),
  cancelAll: () => Notifications.cancelAllScheduledNotificationsAsync(),
  scheduleOne: (key, hour, minute) =>
    Notifications.scheduleNotificationAsync({
      content: { ...MESSAGES[key], data: { url: 'aiplanner://scan', reminder: key } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute, channelId: CHANNEL_ID },
    }),
  getScheduled: () => Notifications.getAllScheduledNotificationsAsync(),
  warn: (...args) => console.warn(...args),
};

/** What is in effect now (Android's schedule, with remembered times for reminders that are off). */
export const loadReminders = () => loadRemindersWith(deps);

/**
 * Saves the settings and schedules what is on; on failure puts the previous ones back.
 * @returns {{ ok: boolean, reason?: 'denied'|'blocked'|'error', reminders: object|null }}
 *   reminders: what is actually scheduled afterwards, or null if that couldn't be read.
 */
export const applyReminders = (input) => applyRemindersWith(deps, input);

/** Link of the reminder that opened the app (or was tapped while it ran), once. */
export function addReminderTapListener(onUrl) {
  const handle = (response) => {
    const url = response?.notification?.request?.content?.data?.url;
    if (typeof url === 'string') onUrl(url);
  };
  handle(Notifications.getLastNotificationResponse());
  Notifications.clearLastNotificationResponse();
  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  return () => sub.remove();
}
