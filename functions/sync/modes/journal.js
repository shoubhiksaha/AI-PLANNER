/** Journal sync → Notion. Pro transcribes the page; other plans only read the date. */
const { syncToNotionPage } = require('./notionPage');

function runJournalSync(ctx) {
    return syncToNotionPage(ctx, {
        aiSyncType: ctx.userData.tier === 'pro' ? 'journal_transcribe' : 'journal_date_only',
        label: 'Journal',
        failureWarning: "We couldn't read this page, so it was saved to Notion with today's date and no transcription.",
    });
}

module.exports = { runJournalSync };
