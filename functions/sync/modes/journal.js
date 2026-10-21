/** Journal sync → Google Drive or Notion. Pro transcribes the page; other plans only read the date. */
const { syncToNotionPage } = require('./notionPage');
const { syncToDrive } = require('./driveNotes');

function runJournalSync(ctx) {
    const aiSyncType = ctx.userData.tier === 'pro' ? 'journal_transcribe' : 'journal_date_only';
    if (ctx.notesDestination === 'drive') {
        return syncToDrive(ctx, {
            aiSyncType,
            kind: 'journal',
            label: 'Journal',
            failureWarning: "We couldn't read this page, so it was saved to Google Drive with today's date and no transcription.",
        });
    }
    return syncToNotionPage(ctx, {
        aiSyncType,
        label: 'Journal',
        failureWarning: "We couldn't read this page, so it was saved to Notion with today's date and no transcription.",
    });
}

module.exports = { runJournalSync };
