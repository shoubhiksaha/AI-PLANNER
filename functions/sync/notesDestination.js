/**
 * Where journal pages, evening brain dumps and voice notes are saved:
 * Google Drive (no setup: the Google sign-in already grants drive.file) or Notion.
 */
const NOTES_DESTINATIONS = Object.freeze(['drive', 'notion']);

function isValidNotesDestination(value) {
    return NOTES_DESTINATIONS.includes(value);
}

function hasNotionConnection(userData) {
    return !!(userData && userData.notionKey && userData.notionDbId);
}

/**
 * The explicit choice when valid; otherwise Notion for users who already
 * connected it (unchanged behaviour), and Google Drive for everyone else.
 * @returns {'drive'|'notion'}
 */
function resolveNotesDestination(userData) {
    const chosen = userData && userData.notesDestination;
    if (isValidNotesDestination(chosen)) return chosen;
    return hasNotionConnection(userData) ? 'notion' : 'drive';
}

/** Whether a sync needs the user's Google access token. */
function modeNeedsGoogle(mode, notesDestination) {
    if (mode === 'morning' || mode === 'evening') return true;
    if (mode === 'journal' || mode === 'voice_note') return notesDestination === 'drive';
    return false;
}

module.exports = {
    NOTES_DESTINATIONS,
    isValidNotesDestination,
    hasNotionConnection,
    resolveNotesDestination,
    modeNeedsGoogle,
};
