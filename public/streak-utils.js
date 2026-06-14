/**
 * Client-side streak display logic (mirrors functions/utils.js computeDisplayStreak).
 */

const SYNC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function calendarDayDiff(fromDateStr, toDateStr) {
    const fromParts = fromDateStr.split('-').map(Number);
    const toParts = toDateStr.split('-').map(Number);
    const fromDate = new Date(fromParts[0], fromParts[1] - 1, fromParts[2]);
    const toDate = new Date(toParts[0], toParts[1] - 1, toParts[2]);
    return Math.round((toDate - fromDate) / (1000 * 60 * 60 * 24));
}

export function normalizeSyncDateStr(value, timeZone) {
    if (value == null || value === '') return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (SYNC_DATE_RE.test(trimmed)) return trimmed;
        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toLocaleDateString('en-CA', { timeZone });
        }
        const isoDay = trimmed.slice(0, 10);
        return SYNC_DATE_RE.test(isoDay) ? isoDay : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value).toLocaleDateString('en-CA', { timeZone });
    }
    if (typeof value === 'object') {
        if (typeof value.toDate === 'function') {
            return value.toDate().toLocaleDateString('en-CA', { timeZone });
        }
        if (typeof value.seconds === 'number') {
            return new Date(value.seconds * 1000).toLocaleDateString('en-CA', { timeZone });
        }
    }
    return null;
}

export function computeDisplayStreak(userData, todayStr) {
    const storedStreak = userData.currentStreak || 0;
    const streakFreezes = userData.streakFreezes || 0;
    const timeZone = userData.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';

    if (storedStreak === 0) return 0;

    const lastSyncDateStr = normalizeSyncDateStr(userData.lastSyncDate, timeZone);
    if (!lastSyncDateStr) return 0;

    const today = todayStr || new Date().toLocaleDateString('en-CA', { timeZone });
    const diffDays = calendarDayDiff(lastSyncDateStr, today);

    if (!Number.isFinite(diffDays) || diffDays < 0) return 0;

    if (diffDays <= 1) return storedStreak;

    const daysMissed = diffDays - 1;
    if (streakFreezes >= daysMissed) return storedStreak;

    return 0;
}
