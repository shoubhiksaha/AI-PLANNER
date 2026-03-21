const { logger } = require("firebase-functions/logger");
const { parseDateTime } = require("../utils");

async function syncCalendarEvents(calendar, plannerData, timeZone = 'Asia/Kolkata') {
    let counts = { events: 0, reminders: 0 };
    for (const item of (plannerData.schedule || [])) {
        if ((item.block || item.reminder) && item.task) {
            const startTime = parseDateTime(item.time, plannerData.date);

            // Safety check: Skip if time couldn't be parsed
            if (!startTime) continue;

            // Assume event lasts 1 hour.
            const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

            // Fix: Use localized time strings for Google Calendar to prevent UTC shift
            const toLocalISO = (date) => {
                const offset = date.getTimezoneOffset() * 60000;
                return new Date(date.getTime() - offset).toISOString().slice(0, 19);
            };

            const sTime = toLocalISO(startTime);
            const eTime = toLocalISO(endTime);
            logger.info(`Creating Event: "${item.task}" Start: ${sTime} End: ${eTime}`);

            await calendar.events.insert({
                calendarId: 'primary',
                resource: {
                    summary: item.task,
                    start: { dateTime: sTime, timeZone: timeZone },
                    end: { dateTime: eTime, timeZone: timeZone },
                    reminders: {
                        useDefault: false,
                        overrides: item.reminder ? [{ method: 'popup', minutes: 10 }] : [],
                    },
                },
            });
            if (item.block) counts.events++;
            if (item.reminder) counts.reminders++;
        }
    }
    return counts;
}

async function syncGoogleTasks(tasks, plannerData) {
    let count = 0;
    let dueDate = new Date(plannerData.date);
    if (isNaN(dueDate.getTime())) {
        dueDate = new Date(); // Fallback to today if date is invalid or missing
    }
    dueDate.setHours(23, 59, 59, 999);

    for (const item of (plannerData.todos || [])) {
        if (item.task) {
            await tasks.tasks.insert({
                tasklist: '@default',
                requestBody: {
                    title: item.task,
                    status: item.done ? 'completed' : 'needsAction',
                    due: dueDate.toISOString()
                }
            });
            count++;
        }
    }
    return count;
}

async function updateCompletedTasks(tasks, plannerData) {
    // Get completed tasks from planner
    const completedPlannerTasks = (plannerData.todos || [])
        .filter(todo => todo.done === true)
        .map(todo => todo.task);

    if (completedPlannerTasks.length === 0) return 0;

    // Get active tasks from Google
    const res = await tasks.tasks.list({
        tasklist: '@default',
        showCompleted: false,
    });

    const googleTasks = res.data.items;
    if (!googleTasks || googleTasks.length === 0) return 0;

    let updatedCount = 0;
    for (const plannerTaskTitle of completedPlannerTasks) {
        // Exact match
        const matchingGoogleTask = googleTasks.find(gTask => gTask.title.trim().toLowerCase() === plannerTaskTitle.trim().toLowerCase());

        if (matchingGoogleTask) {
            logger.info(`Marking task completed: "${matchingGoogleTask.title}"`);
            await tasks.tasks.patch({
                tasklist: '@default',
                task: matchingGoogleTask.id,
                requestBody: { status: 'completed' }
            });
            updatedCount++;
        }
    }
    return updatedCount;
}

async function syncExpensesToSheet(sheets, plannerData, spreadsheetId) {
    if (!plannerData.expenses || plannerData.expenses.length === 0) return 0;

    const rows = plannerData.expenses.map(expense => [
        plannerData.date, 
        expense.item,
        expense.amount
    ]);

    const range = 'Expenses!A:C';

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: rows },
        });
        return rows.length;
    } catch (err) {
        logger.error('Failed to sync expenses:', { error: err.message });
        return 0; 
    }
}

async function syncHealthToSheet(sheets, plannerData, spreadsheetId) {
    if (!plannerData.health || Object.keys(plannerData.health).length === 0) return 0;

    const row = [
        plannerData.date,
        plannerData.health.exercise || "",
        plannerData.health.water || 0,
        plannerData.health.sleep || 0,
        plannerData.health.energy || 0
    ];

    const range = 'Health!A:E';

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [row] },
        });
        return 1;
    } catch (err) {
        logger.error('Failed to sync health:', { error: err.message });
        return 0;
    }
}

module.exports = {
    syncCalendarEvents,
    syncGoogleTasks,
    updateCompletedTasks,
    syncExpensesToSheet,
    syncHealthToSheet
};
