/** Voice-note sync → Google Drive or Notion (Pro only; the plan check runs before this). */
const { syncToNotionPage } = require('./notionPage');
const { syncToDrive } = require('./driveNotes');

function runVoiceNoteSync(ctx) {
    if (ctx.notesDestination === 'drive') {
        return syncToDrive(ctx, {
            aiSyncType: 'voice_note',
            kind: 'voiceNote',
            label: 'Voice note',
            failureWarning: "We couldn't transcribe this recording; the audio was saved to Google Drive without a transcript.",
        });
    }
    return syncToNotionPage(ctx, {
        aiSyncType: 'voice_note',
        label: 'Voice Note',
        failureWarning: "We couldn't transcribe this recording; the audio was saved to Notion without a transcript.",
    });
}

module.exports = { runVoiceNoteSync };
