// Morning and evening reminders to photograph the planner page (local notifications, this
// phone only). Settings come from the page's Settings › Reminders (SET_REMINDERS) and are kept in
// the app's documents folder. Tapping a reminder opens the scanner (aiplanner://scan).
import * as Notifications from 'expo-notifications';
import { File, Paths } from 'expo-file-system';
import { DEFAULT_REMINDERS, normalizeReminders, parseTime } from './bridge';

const CHANNEL_ID = 'reminders';
const STORE_NAME = 'reminders.json';

const MESSAGES = {
  morning: { title: 'Plan your day', body: 'Photograph this morning’s page. Times go to Calendar, to-dos to Tasks.' },
  evening: { title: 'How did today go?', body: 'Photograph your page to tick off what you got done.' },
};

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

export async function loadReminders() {
  try {
    const file = storeFile();
    if (!file.exists) return DEFAULT_REMINDERS;
    return normalizeReminders(JSON.parse(await file.text()));
  } catch (e) {
    console.warn('Reading reminder settings failed:', e);
    return DEFAULT_REMINDERS;
  }
}

async function saveReminders(reminders) {
  const file = storeFile();
  file.create({ overwrite: true });
  await file.write(JSON.stringify(reminders));
}

/** 'granted', 'denied' (may ask again) or 'blocked' (only Settings can turn it on). */
async function notificationPermission() {
  let status = await Notifications.getPermissionsAsync();
  if (!status.granted && status.canAskAgain) status = await Notifications.requestPermissionsAsync();
  if (status.granted) return 'granted';
  return status.canAskAgain ? 'denied' : 'blocked';
}

async function ensureChannel() {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Reminders',
    description: 'Morning and evening reminders to photograph your planner page',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

/** Replaces every scheduled reminder with the ones that are on in `reminders`. */
async function schedule(reminders) {
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const key of Object.keys(reminders)) {
    if (!reminders[key].on) continue;
    const { hour, minute } = parseTime(reminders[key].time);
    await Notifications.scheduleNotificationAsync({
      content: { ...MESSAGES[key], data: { url: 'aiplanner://scan' } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute, channelId: CHANNEL_ID },
    });
  }
}

/**
 * Saves the settings and schedules what is on. If that fails partway, the previous reminders are
 * put back, so what is saved always matches what is scheduled.
 * @returns {{ ok: boolean, reason?: 'denied'|'blocked'|'error', reminders: object }}
 *   reminders: what is actually in effect afterwards.
 */
export async function applyReminders(input) {
  const next = normalizeReminders(input);
  const previous = await loadReminders();
  try {
    if (next.morning.on || next.evening.on) {
      const permission = await notificationPermission();
      if (permission !== 'granted') return { ok: false, reason: permission, reminders: previous };
    }
    await ensureChannel();
    await schedule(next);
    await saveReminders(next);
    return { ok: true, reminders: next };
  } catch (e) {
    console.warn('Scheduling reminders failed:', e);
    try {
      await schedule(previous);
      return { ok: false, reason: 'error', reminders: previous };
    } catch (restoreError) {
      console.warn('Restoring the previous reminders failed:', restoreError);
      await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
      const none = normalizeReminders(null);
      await saveReminders(none).catch(() => {});
      return { ok: false, reason: 'error', reminders: none };
    }
  }
}

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
