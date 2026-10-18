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

                let pageToken = undefined;
                let allItems = [];
                do {
                    const listRes = await calendar.events.list({
                        calendarId: 'primary',
                        timeMin: dedupStart.toISOString(),
                        timeMax: dedupEnd.toISOString(),
                        singleEvents: true,
                        maxResults: 250,
                        pageToken,
                    });
                    allItems = allItems.concat(listRes.data.items || []);
                    pageToken = listRes.data.nextPageToken;
                } while (pageToken);

                existingEvents = allItems.map(e => ({
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
                    counts.skippedDuplicates++;
                    continue;
                }
            }

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
                logger.error("Calendar event insert failed:", { error: err?.message || String(err) });
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
            logger.warn("Planner date is invalid; omitting Google Tasks due date");
        }
    }

    let existingTasksForDate = [];
    const cleanTitle = (str) => String(str || '').replace(/^[-*•]\s*/, '').replace(/\.$/, '').trim().toLowerCase();

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
                logger.error("Google Tasks insert failed:", { error: err?.message || String(err) });
                continue;
            }
        }
    }
    logger.info(`Tasks sync: created ${count}, skipped ${skippedDuplicates} duplicates`);
    return { tasks: count, skippedDuplicates };
}

function normalizeTitle(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Marks open Google Tasks as completed when the planner shows them ticked off.
 * Only tasks due on `targetDate` (YYYY-MM-DD) or with no due date are eligible,
 * entries without a title are ignored, and one failing patch never aborts the rest.
 */
async function updateCompletedTasks(tasks, plannerData, { targetDate } = {}) {
    // Get completed tasks from planner
    const completedPlannerTasks = (plannerData.todos || [])
        .filter(todo => todo && todo.done === true)
        .map(todo => normalizeTitle(todo.task))
        .filter(Boolean);

    if (completedPlannerTasks.length === 0) return 0;

    const dayMatch = String(targetDate || plannerData.date || '').match(/^\d{4}-\d{2}-\d{2}$/);
    const dayPrefix = dayMatch ? dayMatch[0] : null;

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

    const eligible = googleTasks.filter(gTask => gTask && gTask.id && normalizeTitle(gTask.title)
        && (!gTask.due || !dayPrefix || String(gTask.due).startsWith(dayPrefix)));
    if (eligible.length === 0) return 0;

    let updatedCount = 0;
    let failedCount = 0;
    const patched = new Set();
    for (const plannerTaskTitle of completedPlannerTasks) {
        // Exact (case-insensitive) match; prefer a task due that day over an undated one.
        const candidates = eligible.filter(gTask => !patched.has(gTask.id) && normalizeTitle(gTask.title) === plannerTaskTitle);
        const matchingGoogleTask = candidates.find(gTask => gTask.due) || candidates[0];
        if (!matchingGoogleTask) continue;

        try {
            await tasks.tasks.patch({
                tasklist: '@default',
                task: matchingGoogleTask.id,
                requestBody: { status: 'completed' }
            });
            patched.add(matchingGoogleTask.id);
            updatedCount++;
        } catch (err) {
            failedCount++;
            logger.warn("Failed to mark a Google Task completed", { taskId: matchingGoogleTask.id, error: err?.message || String(err) });
        }
    }
    if (failedCount > 0 && updatedCount === 0) {
        throw new Error(`Could not update ${failedCount} completed task(s).`);
    }
    return updatedCount;
}

function isNotFoundError(err) {
    const status = err?.code ?? err?.status ?? err?.response?.status;
    return Number(status) === 404;
}

/** Create the "AI Planner Data" spreadsheet with headers and formatting. */
async function createPlannerSpreadsheet(sheets) {
    const newSheet = await sheets.spreadsheets.create({
        resource: {
            properties: { title: "AI Planner Data" },
            sheets: [
                { properties: { title: "Expenses" } },
                { properties: { title: "Health" } }
            ]
        }
    });
    const spreadsheetId = newSheet.data.spreadsheetId;
    await sheets.spreadsheets.values.update({
        spreadsheetId, range: 'Expenses!A1:C1', valueInputOption: 'RAW',
        requestBody: { values: [["Date", "Item", "Amount"]] }
    });
    await sheets.spreadsheets.values.update({
        spreadsheetId, range: 'Health!A1:E1', valueInputOption: 'RAW',
        requestBody: { values: [["Date", "Exercise", "Water", "Sleep", "Energy"]] }
    });

    // Bold indigo headers, frozen top row and auto-sized columns. Formatting is
    // cosmetic, so a failure here must not fail the sync.
    const headerFormat = {
        userEnteredFormat: {
            backgroundColor: { red: 0.25, green: 0.31, blue: 0.71 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
        }
    };
    try {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
                    { updateSheetProperties: { properties: { sheetId: 1, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
                    { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: headerFormat, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
                    { repeatCell: { range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1 }, cell: headerFormat, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
                    { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 3 } } },
                    { autoResizeDimensions: { dimensions: { sheetId: 1, dimension: "COLUMNS", startIndex: 0, endIndex: 5 } } }
                ]
            }
        });
    } catch (err) {
        logger.warn("Spreadsheet formatting failed", { error: err?.message || String(err) });
    }
    return spreadsheetId;
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
    syncHealthToSheet,
    createPlannerSpreadsheet,
    isNotFoundError
};
