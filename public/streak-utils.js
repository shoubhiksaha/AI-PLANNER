/**
 * Client-side streak display logic (mirrors functions/utils.js computeDisplayStreak).
 */

function calendarDayDiff(fromDateStr, toDateStr) {
    const fromParts = fromDateStr.split('-').map(Number);
    const toParts = toDateStr.split('-').map(Number);
    const fromDate = new Date(fromParts[0], fromParts[1] - 1, fromParts[2]);
    const toDate = new Date(toParts[0], toParts[1] - 1, toParts[2]);
    return Math.round((toDate - fromDate) / (1000 * 60 * 60 * 24));
}

export function computeDisplayStreak(userData, todayStr) {
    const storedStreak = userData.currentStreak || 0;
    const lastSyncDateStr = userData.lastSyncDate;
    const streakFreezes = userData.streakFreezes || 0;
    const timeZone = userData.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';

    if (!lastSyncDateStr || storedStreak === 0) return 0;

    const today = todayStr || new Date().toLocaleDateString('en-CA', { timeZone });
    const diffDays = calendarDayDiff(lastSyncDateStr, today);

    if (diffDays <= 1) return storedStreak;

    const daysMissed = diffDays - 1;
    if (streakFreezes >= daysMissed) return storedStreak;

    return 0;
}
