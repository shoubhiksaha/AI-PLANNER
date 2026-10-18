/** Morning sync → Google Calendar events/reminders + Google Tasks. */
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E } = require('../../services/requestGuard');
const { getPlannerDataFromImages, getCountWarnings } = require('../../services/gemini');
const { syncCalendarEvents, syncGoogleTasks } = require('../../services/googleSync');
const { SyncError } = require('../errors');

async function runMorningSync(ctx) {
    const { requestId, uid, parsedImages, byokConfig, aiOptions, userData, timeZone, warnings, google, auth } = ctx;
    const calendar = google.calendar({ version: 'v3', auth });
    const tasks = google.tasks({ version: 'v1', auth });
    logger.info("Parsing planner images for morning sync...", { requestId, uid });
    const plannerData = await getPlannerDataFromImages(parsedImages, 'morning', byokConfig, aiOptions);
    if (plannerData.error) {
        throw new SyncError(400, E.INVALID_IMAGE, `We couldn't read planner entries from this photo: ${String(plannerData.error).slice(0, 200)}`);
    }
    warnings.push(...getCountWarnings(plannerData, 'morning'));

    // Parallel: Add Events to Calendar AND Add Tasks to Google Tasks.
    const dedupCalendar = userData.dedupCalendar !== false; // default: ON
    const dedupTasks = userData.dedupTasks !== false;       // default: ON
    const [eventResults, taskResults] = await Promise.all([
        syncCalendarEvents(calendar, plannerData, timeZone, dedupCalendar),
        syncGoogleTasks(tasks, plannerData, dedupTasks)
    ]);

    let msg = `Morning Sync Complete! Created ${eventResults.events} events, ${eventResults.reminders} reminders, and ${taskResults.tasks} tasks.`;
    if (eventResults.skippedDuplicates > 0 || taskResults.skippedDuplicates > 0) {
        const skipDetails = [];
        if (eventResults.skippedDuplicates > 0) skipDetails.push(`${eventResults.skippedDuplicates} events`);
        if (taskResults.skippedDuplicates > 0) skipDetails.push(`${taskResults.skippedDuplicates} tasks`);
        msg += ` (Skipped ${skipDetails.join(" and ")} that already existed).`;
    }
    return {
        msg,
        counts: { events: eventResults.events, reminders: eventResults.reminders, tasks: taskResults.tasks },
        dataSynced: eventResults.events + eventResults.reminders + taskResults.tasks > 0,
        extractionOk: true,
        partial: false,
    };
}

module.exports = { runMorningSync };
