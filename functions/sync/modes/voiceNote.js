/** Voice-note sync → Notion (Pro only; the plan check runs before this). */
const { syncToNotionPage } = require('./notionPage');

function runVoiceNoteSync(ctx) {
    return syncToNotionPage(ctx, {
        aiSyncType: 'voice_note',
        label: 'Voice Note',
        failureWarning: "We couldn't transcribe this recording; the audio was saved to Notion without a transcript.",
    });
}

module.exports = { runVoiceNoteSync };
