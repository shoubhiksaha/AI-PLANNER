const { logger } = require("firebase-functions/logger");
const { parseDateTime } = require("../utils");

async function syncCalendarEvents(calendar, plannerData, timeZone = 'UTC', enableDedup = true) {
    let counts = { events: 0, reminders: 0, skippedDuplicates: 0 };

    // Pre-fetch existing events for the planner date to detect duplicates
    let existingEvents = [];
    if (enableDedup) {
        try {
            let dayStart = null;
            const dateStr = String(plannerData.date || "");
            const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (dateMatch) {
                dayStart = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
            } else {
                const temp = new Date(plannerData.date);
                if (!isNaN(temp.getTime())) {
                    dayStart = new Date(temp.getFullYear(), temp.getMonth(), temp.getDate());
                }
            }
            if (dayStart) {
                dayStart.setHours(0, 0, 0, 0);
                const dayEnd = new Date(dayStart);
                dayEnd.setHours(23, 59, 59, 999);
                
                // Expand window by 24h to ensure we cover the user's timezone boundaries
                const dedupStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
                const dedupEnd = new Date(dayEnd.getTime() + 24 * 60 * 60 * 1000);

                const listRes = await calendar.events.list({
                    calendarId: 'primary',
                    timeMin: dedupStart.toISOString(),
                    timeMax: dedupEnd.toISOString(),
                    singleEvents: true,
                    maxResults: 250,
                });
                existingEvents = (listRes.data.items || []).map(e => ({
                    summary: (e.summary || '').trim().toLowerCase(),
                    start: e.start?.dateTime || e.start?.date || '',
                    end: e.end?.dateTime || e.end?.date || '',
                }));
            }
        } catch (err) {
            logger.warn("Could not pre-fetch calendar events for dedup, proceeding without:", { error: err.message });
        }
    } else {
        logger.info("Calendar dedup disabled by user preference");
    }

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

            // Idempotency: Skip if an event with the same title, start time, and end time already exists
            if (enableDedup) {
                const taskStr = String(item.task || "");
                const isDuplicate = existingEvents.some(e =>
                    e.summary === taskStr.trim().toLowerCase() && 
                    e.start.startsWith(sTime.slice(0, 16)) &&
                    e.end.startsWith(eTime.slice(0, 16))
                );
                if (isDuplicate) {
                    logger.info(`Skipping duplicate event: "${item.task}" at ${sTime}`);
                    counts.skippedDuplicates++;
                    continue;
                }
            }

            logger.info(`Creating Event: "${item.task}" Start: ${sTime} End: ${eTime}`);

            try {
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
            } catch (err) {
                logger.error("Calendar event insert failed:", { error: err?.message || String(err), task: item.task });
                continue;
            }

            if (item.block) counts.events++;
            if (item.reminder) counts.reminders++;
        }
    }
    return counts;
}

async function syncGoogleTasks(tasks, plannerData, enableDedup = true) {
    let count = 0;
    let skippedDuplicates = 0;
    let exactDueIso = null;
    let dueMinIso = null;
    let dueMaxIso = null;
    
    // Google Tasks API discards time information.
    // To prevent timezone offset shifts from saving the task on the wrong UTC day, 
    // explicitly use strict UTC midnight strings based on the YYYY-MM-DD date.
    const dateStr = String(plannerData.date || "");
    const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateMatch) {
        const year = dateMatch[1];
        const month = dateMatch[2];
        const day = dateMatch[3];
        
        exactDueIso = `${year}-${month}-${day}T00:00:00.000Z`;

        // Widen the API fetch window by 1 day on each side to avoid Google API strict inequality quirks
        const midDate = new Date(parseInt(year), parseInt(month)-1, parseInt(day));
        const prevDate = new Date(midDate.getTime() - 86400000);
        const nextDate = new Date(midDate.getTime() + 86400000);
        
        dueMinIso = `${prevDate.getFullYear()}-${String(prevDate.getMonth()+1).padStart(2,'0')}-${String(prevDate.getDate()).padStart(2,'0')}T00:00:00.000Z`;
        dueMaxIso = `${nextDate.getFullYear()}-${String(nextDate.getMonth()+1).padStart(2,'0')}-${String(nextDate.getDate()).padStart(2,'0')}T23:59:59.999Z`;
    } else {
        const temp = new Date(plannerData.date);
        if (!isNaN(temp.getTime())) {
            const year = temp.getFullYear();
            const month = String(temp.getMonth() + 1).padStart(2, '0');
            const day = String(temp.getDate()).padStart(2, '0');
            
            exactDueIso = `${year}-${month}-${day}T00:00:00.000Z`;

            // Widen the API fetch window by 1 day on each side to avoid Google API strict inequality quirks
            const prevTemp = new Date(temp.getTime() - 86400000);
            const nextTemp = new Date(temp.getTime() + 86400000);
            
            dueMinIso = `${prevTemp.getFullYear()}-${String(prevTemp.getMonth()+1).padStart(2,'0')}-${String(prevTemp.getDate()).padStart(2,'0')}T00:00:00.000Z`;
            dueMaxIso = `${nextTemp.getFullYear()}-${String(nextTemp.getMonth()+1).padStart(2,'0')}-${String(nextTemp.getDate()).padStart(2,'0')}T23:59:59.999Z`;
        } else {
            logger.warn("Planner date is invalid; omitting Google Tasks due date", { plannerDate: plannerData.date });
        }
    }

    let existingTasksForDate = [];
    const cleanTitle = (str) => String(str || '').replace(/^[-\*•]\s*/, '').replace(/\.$/, '').trim().toLowerCase();

    if (enableDedup && exactDueIso) {
        try {
            let pageToken = undefined;
            // Get the exact day prefix we are looking for (e.g., "2026-05-02")
            let targetPrefix = "";
            if (dateMatch) {
                targetPrefix = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
            } else {
                const temp = new Date(plannerData.date);
                if (!isNaN(temp.getTime())) targetPrefix = `${temp.getFullYear()}-${String(temp.getMonth()+1).padStart(2,'0')}-${String(temp.getDate()).padStart(2,'0')}`;
            }

            do {
                const res = await tasks.tasks.list({
                    tasklist: '@default',
                    showCompleted: true,
                    showHidden: true,
                    dueMin: dueMinIso,
                    dueMax: dueMaxIso,
                    maxResults: 100,
                    pageToken: pageToken,
                });
                if (res.data.items) {
                    existingTasksForDate = existingTasksForDate.concat(
                        res.data.items
                            .filter(t => !targetPrefix || (t.due && t.due.startsWith(targetPrefix)))
                            .map(t => cleanTitle(t.title))
                    );
                }
                pageToken = res.data.nextPageToken;
            } while (pageToken);
        } catch (err) {
            logger.warn("Could not pre-fetch tasks for dedup, proceeding without:", { error: err.message });
        }
    } else if (!enableDedup) {
        logger.info("Tasks dedup disabled by user preference");
    }

    for (const item of (plannerData.todos || [])) {
        if (item.task) {
            // Idempotency: Skip if a task with the same title already exists for this date
            if (enableDedup) {
                const titleLower = cleanTitle(item.task);
                if (existingTasksForDate.includes(titleLower)) {
                    logger.info(`Skipping duplicate task: "${item.task}"`);
                    skippedDuplicates++;
                    continue;
                }
            }

            try {
                const requestBody = {
                    title: String(item.task || ""),
                    status: item.done ? 'completed' : 'needsAction',
                };
                if (exactDueIso) requestBody.due = exactDueIso;

                await tasks.tasks.insert({
                    tasklist: '@default',
                    requestBody
                });
                count++;
                // Add to existing list to prevent duplicates within the same sync batch
                if (enableDedup) existingTasksForDate.push(cleanTitle(item.task));
            } catch (err) {
                logger.error("Google Tasks insert failed:", { error: err?.message || String(err), task: item.task });
                continue;
            }
        }
    }
    logger.info(`Tasks sync: created ${count}, skipped ${skippedDuplicates} duplicates`);
    return { tasks: count, skippedDuplicates };
}

async function updateCompletedTasks(tasks, plannerData) {
    // Get completed tasks from planner
    const completedPlannerTasks = (plannerData.todos || [])
        .filter(todo => todo.done === true)
        .map(todo => todo.task);

    if (completedPlannerTasks.length === 0) return 0;

    // Get active tasks from Google (with pagination)
    let googleTasks = [];
    let pageToken = undefined;
    do {
        const res = await tasks.tasks.list({
            tasklist: '@default',
            showCompleted: false,
            maxResults: 100,
            pageToken: pageToken,
        });
        if (res.data.items) {
            googleTasks = googleTasks.concat(res.data.items);
        }
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    if (googleTasks.length === 0) return 0;

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
        const getRes = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Expenses!A:A',
        });
        const existingDates = (getRes.data.values || []).map(row => row[0]);
        if (existingDates.includes(plannerData.date)) {
            logger.info("Expenses already synced for this date, skipping duplicate append.");
            return 0;
        }

        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'RAW',
            requestBody: { values: rows },
        });
        return rows.length;
    } catch (err) {
        // Surface genuine API failures so the caller can warn the user and refund the
        // credit. "Empty" and "already synced" are handled above as legitimate 0 returns.
        logger.error('Failed to sync expenses:', { error: err.message });
        throw err;
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
        const getRes = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Health!A:A',
        });
        const existingDates = (getRes.data.values || []).map(row => row[0]);
        if (existingDates.includes(plannerData.date)) {
            logger.info("Health already synced for this date, skipping duplicate append.");
            return 0;
        }

        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'RAW',
            requestBody: { values: [row] },
        });
        return 1;
    } catch (err) {
        // Surface genuine API failures so the caller can warn the user and refund the
        // credit. "Empty" and "already synced" are handled above as legitimate 0 returns.
        logger.error('Failed to sync health:', { error: err.message });
        throw err;
    }
}

module.exports = {
    syncCalendarEvents,
    syncGoogleTasks,
    updateCompletedTasks,
    syncExpensesToSheet,
    syncHealthToSheet
};
