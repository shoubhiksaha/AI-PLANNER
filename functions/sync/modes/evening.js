/** Evening sync → completed Google Tasks + Sheets (expenses, health) + brain dump (Google Drive or Notion). */
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
const { folderUrl } = require('../../services/googleDrive');
const { saveBrainDumpToDrive } = require('./driveNotes');
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
 * Plain-language note (for the result card) about a brain-dump outcome.
 * @param {'drive'|'notion'} destination
 */
function brainDumpNote(destination, outcome) {
    const where = destination === 'drive' ? 'Google Drive' : 'Notion';
    if (outcome.ok) {
        return outcome.status === 'duplicate'
            ? `Brain dump for this date was already saved to ${where}.`
            : `Brain dump saved to ${where}.`;
    }
    return `Brain dump not saved to ${where}: ${outcome.reason}`;
}

/**
 * Refund policy: the credit is kept when at least one destination received
 * data; the caller refunds when `dataSynced` is false.
 */
async function runEveningSync(ctx) {
    const { mode, requestId, uid, parsedImages, byokConfig, aiOptions, userData, preData, userRef, timeZone, warnings, google, auth, decryptedNotionKey } = ctx;
    const notesDestination = ctx.notesDestination || 'notion';
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
        notesDestination,
    });

    // successMessages build the stored history text; notes are the short
    // sentences the client shows next to the counts.
    const successMessages = [];
    const notes = [];
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

    // Brain dump: Google Drive, or Notion when that is the user's choice and it is connected.
    let brainDumpBranchName = null;
    if (notesDestination === 'drive') {
        brainDumpBranchName = 'Drive';
        branches.push({ name: 'Drive', promise: saveBrainDumpToDrive(ctx, { plannerData, date: targetDate }) });
    } else if (preData.notionKey && preData.notionDbId) {
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
            brainDumpBranchName = 'Notion';
            branches.push({ name: 'Notion', promise: brainDumpBranch() });
        } else {
            successMessages.push("(Skipped Notion - Failed to decrypt key).");
            warnings.push("Your Notion connection needs to be set up again in Settings, so the brain dump wasn't saved.");
        }
    } else {
        successMessages.push("(Skipped Notion - Keys missing).");
        notes.push("Notion isn't connected, so the brain dump wasn't saved.");
    }

    const results = await Promise.allSettled(branches.map(b => b.promise));
    const failedBranches = [];
    const byName = {};
    results.forEach((result, i) => {
        const name = branches[i].name;
        byName[name] = result;
        if (result.status === 'rejected') {
            failedBranches.push(name === 'Drive' ? 'Google Drive' : name);
            logger.error(`${name} Sync Failed`, { error: redactSensitive(result.reason?.message || result.reason), requestId, uid });
        }
    });

    const updatedTasks = byName.Tasks.status === 'fulfilled' ? byName.Tasks.value : 0;
    if (updatedTasks > 0) successMessages.unshift(`Marked ${updatedTasks} tasks completed.`);

    let addedExpenses = 0;
    let addedHealth = 0;
    if (byName.Sheets.status === 'fulfilled') {
        const sheetResult = byName.Sheets.value;
        if (sheetResult.created) {
            successMessages.push("(Created new 'AI Planner Data' Sheet).");
            notes.push('Created your AI Planner Data sheet in Google Sheets.');
        }
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

    // Brain-dump outcome (Drive or Notion).
    let brainDumpSaved = false;
    let savedTo;
    let links;
    const brainDump = brainDumpBranchName ? byName[brainDumpBranchName] : null;
    const destinationKey = brainDumpBranchName === 'Drive' ? 'drive' : 'notion';
    if (brainDump) {
        if (brainDump.status === 'rejected') {
            const detail = brainDump.reason?.message || String(brainDump.reason);
            successMessages.push(`(${brainDumpBranchName === 'Drive' ? 'Google Drive' : 'Notion'} not saved: ${detail})`);
        } else {
            const outcome = brainDump.value;
            if (destinationKey === 'notion') appendEveningNotionOutcomeMessage(successMessages, outcome);
            else if (!outcome.empty) successMessages.push(brainDumpNote('drive', outcome));
            if (outcome.ok) notes.push(brainDumpNote(destinationKey, outcome));
            else if (!outcome.empty) warnings.push(brainDumpNote(destinationKey, outcome));
            brainDumpSaved = !!(outcome && outcome.ok && outcome.status === 'created');
            if (outcome && outcome.ok) {
                savedTo = destinationKey;
                if (destinationKey === 'drive' && outcome.folderId) links = { drive: folderUrl(outcome.folderId) };
            }
        }
    }

    const counts = { completedTasks: updatedTasks, expenses: addedExpenses, health: addedHealth > 0 ? 1 : 0 };
    if (brainDumpSaved) counts.brainDump = 1;
    const dataSynced = updatedTasks > 0 || addedExpenses > 0 || addedHealth > 0 || brainDumpSaved;

    // Refund policy: the credit is kept when at least one destination received
    // data; when nothing synced the caller refunds it.
    let partial = false;
    if (failedBranches.length > 0) {
        partial = true;
        const failure = dataSynced
            ? `⚠️ Could not sync: ${failedBranches.join(', ')}. Everything else was saved.`
            : `⚠️ Could not sync: ${failedBranches.join(', ')}. Your credit was refunded — please try again.`;
        successMessages.push(failure);
        warnings.push(failure.replace(/^⚠️\s*/, ''));
    }

    const msg = successMessages.length === 0
        ? "Night Sync output: No items found to sync."
        : "Night Sync Complete: " + successMessages.join(" ");
    return {
        msg,
        counts,
        dataSynced,
        extractionOk: true,
        partial,
        notes,
        ...(savedTo ? { savedTo } : {}),
        ...(links ? { links } : {}),
    };
}

module.exports = { runEveningSync, appendEveningNotionOutcomeMessage, brainDumpNote };
