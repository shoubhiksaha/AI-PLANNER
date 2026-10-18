/** Evening sync → completed Google Tasks + Sheets (expenses, health) + Notion brain dump. */
const { FieldValue } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions/logger');
const { ERROR_CODES: E } = require('../../services/requestGuard');
const { getPlannerDataFromImages, getCountWarnings } = require('../../services/gemini');
const {
    updateCompletedTasks,
    syncExpensesToSheet,
    syncHealthToSheet,
    createPlannerSpreadsheet,
    isNotFoundError,
} = require('../../services/googleSync');
const {
    uploadFileToNotion,
    syncBrainDumpToNotion,
    normalizeBrainDumpText,
} = require('../../services/notion');
const { todayInTimeZone, extensionForMime, redactSensitive } = require('../../utils');
const { SyncError } = require('../errors');

function appendEveningNotionOutcomeMessage(successMessages, outcome) {
    if (!outcome) return;
    if (outcome.ok) {
        if (outcome.status === 'duplicate') {
            successMessages.push('Notion: Brain Dump page already exists for this date.');
            return;
        }
        successMessages.push('Saved Visual Brain Dump to Notion.');
        return;
    }
    successMessages.push(`(Notion not saved: ${outcome.reason})`);
}

/**
 * Refund policy: the credit is kept when at least one destination received
 * data; the caller refunds when `dataSynced` is false.
 */
async function runEveningSync(ctx) {
    const { mode, requestId, uid, parsedImages, byokConfig, aiOptions, userData, preData, userRef, timeZone, warnings, google, auth, decryptedNotionKey } = ctx;
    const tasks = google.tasks({ version: 'v1', auth });
    const sheets = google.sheets({ version: 'v4', auth });
    logger.info("Parsing planner images for evening sync...", { requestId, uid });
    const plannerData = await getPlannerDataFromImages(parsedImages, 'evening', byokConfig, aiOptions);
    if (plannerData.error) {
        throw new SyncError(400, E.INVALID_IMAGE, `We couldn't read planner entries from this photo: ${String(plannerData.error).slice(0, 200)}`);
    }
    warnings.push(...getCountWarnings(plannerData, 'evening'));

    logger.info("Evening planner extraction summary", {
        requestId,
        uid,
        hasBrainDumpText: !!normalizeBrainDumpText(plannerData.brainDump),
        expenseCount: plannerData.expenses.length,
        completedTodoCount: plannerData.todos.length,
    });

    const successMessages = [];
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(String(plannerData.date)) ? plannerData.date : todayInTimeZone(timeZone);

    const createAndStoreSpreadsheet = async () => {
        const newId = await createPlannerSpreadsheet(sheets);
        await userRef.set({ spreadsheetId: newId }, { merge: true });
        return newId;
    };
    const sheetsBranch = async () => {
        let spreadsheetId = userData.spreadsheetId || preData.spreadsheetId;
        let created = false;
        if (!spreadsheetId) {
            logger.info("No spreadsheet found. Creating new one...", { requestId, uid });
            spreadsheetId = await createAndStoreSpreadsheet();
            created = true;
        }
        const writeAll = (sid) => Promise.allSettled([
            syncExpensesToSheet(sheets, plannerData, sid),
            syncHealthToSheet(sheets, plannerData, sid)
        ]);
        let [expenses, health] = await writeAll(spreadsheetId);
        const missing = [expenses, health].some(r => r.status === 'rejected' && isNotFoundError(r.reason));
        if (missing && !created) {
            // The user deleted the sheet: forget it and create a fresh one.
            logger.warn("Spreadsheet not found; recreating", { requestId, uid });
            await userRef.set({ spreadsheetId: FieldValue.delete() }, { merge: true });
            spreadsheetId = await createAndStoreSpreadsheet();
            created = true;
            [expenses, health] = await writeAll(spreadsheetId);
        }
        return { expenses, health, created };
    };

    const branches = [
        { name: 'Tasks', promise: updateCompletedTasks(tasks, plannerData, { targetDate }) },
        { name: 'Sheets', promise: sheetsBranch() },
    ];

    // Handle Notion Branch
    if (preData.notionKey && preData.notionDbId) {
        if (decryptedNotionKey) {
            const brainDumpBranch = async () => {
                const brainDumpText = normalizeBrainDumpText(plannerData.brainDump);
                if (plannerData.brainDump != null && typeof plannerData.brainDump !== 'string') {
                    return { ok: false, reason: `AI returned brainDump as ${typeof plannerData.brainDump}; expected handwritten text.` };
                }
                const firstImage = parsedImages[0];
                const hasImage = !!(firstImage && firstImage.base64Data);
                if (!brainDumpText && !hasImage) {
                    return { ok: false, reason: 'No Brain Dump text found on the planner page and no image to attach.' };
                }
                let fileId = null;
                if (hasImage) {
                    const buffer = Buffer.from(firstImage.base64Data, 'base64');
                    fileId = await uploadFileToNotion(decryptedNotionKey, buffer, firstImage.mimeType, `${mode}_planner.${extensionForMime(firstImage.mimeType)}`);
                }
                return syncBrainDumpToNotion({ ...plannerData, brainDump: brainDumpText }, decryptedNotionKey, preData.notionDbId, fileId);
            };
            branches.push({ name: 'Notion', promise: brainDumpBranch() });
        } else {
            successMessages.push("(Skipped Notion - Failed to decrypt key).");
        }
    } else {
        successMessages.push("(Skipped Notion - Keys missing).");
    }

    const results = await Promise.allSettled(branches.map(b => b.promise));
    const failedBranches = [];
    const byName = {};
    results.forEach((result, i) => {
        const name = branches[i].name;
        byName[name] = result;
        if (result.status === 'rejected') {
            failedBranches.push(name);
            logger.error(`${name} Sync Failed`, { error: redactSensitive(result.reason?.message || result.reason), requestId, uid });
        }
    });

    const updatedTasks = byName.Tasks.status === 'fulfilled' ? byName.Tasks.value : 0;
    if (updatedTasks > 0) successMessages.unshift(`Marked ${updatedTasks} tasks completed.`);

    let addedExpenses = 0;
    let addedHealth = 0;
    if (byName.Sheets.status === 'fulfilled') {
        const sheetResult = byName.Sheets.value;
        if (sheetResult.created) successMessages.push("(Created new 'AI Planner Data' Sheet).");
        if (sheetResult.expenses.status === 'fulfilled') addedExpenses = sheetResult.expenses.value;
        else {
            failedBranches.push('Expenses');
            logger.error("Expenses Sync Failed", { error: redactSensitive(sheetResult.expenses.reason?.message), requestId, uid });
        }
        if (sheetResult.health.status === 'fulfilled') addedHealth = sheetResult.health.value;
        else {
            failedBranches.push('Health');
            logger.error("Health Sync Failed", { error: redactSensitive(sheetResult.health.reason?.message), requestId, uid });
        }
    }
    if (addedExpenses > 0) successMessages.push(`Added ${addedExpenses} expenses to Sheet.`);
    if (addedHealth > 0) successMessages.push(`Logged Health & Wellness.`);

    let notionCreated = false;
    if (byName.Notion) {
        if (byName.Notion.status === 'rejected') {
            const detail = byName.Notion.reason?.message || String(byName.Notion.reason);
            successMessages.push(`(Notion not saved: ${detail})`);
        } else {
            appendEveningNotionOutcomeMessage(successMessages, byName.Notion.value);
            notionCreated = !!(byName.Notion.value && byName.Notion.value.ok && byName.Notion.value.status === 'created');
        }
    }

    const counts = { completedTasks: updatedTasks, expenses: addedExpenses, health: addedHealth > 0 ? 1 : 0 };
    const dataSynced = updatedTasks > 0 || addedExpenses > 0 || addedHealth > 0 || notionCreated;

    // Refund policy: the credit is kept when at least one destination received
    // data; when nothing synced the caller refunds it.
    let partial = false;
    if (failedBranches.length > 0) {
        partial = true;
        successMessages.push(dataSynced
            ? `⚠️ Could not sync: ${failedBranches.join(', ')}. Everything else was saved.`
            : `⚠️ Could not sync: ${failedBranches.join(', ')}. Your credit was refunded — please try again.`);
    }

    const msg = successMessages.length === 0
        ? "Night Sync output: No items found to sync."
        : "Night Sync Complete: " + successMessages.join(" ");
    return { msg, counts, dataSynced, extractionOk: true, partial };
}

module.exports = { runEveningSync, appendEveningNotionOutcomeMessage };
