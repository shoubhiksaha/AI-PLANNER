const admin = require("firebase-admin");
const { RATE_LIMIT_WINDOW_MS } = require('../utils');

async function checkRateLimit(email, endpoint, limit) {
    const db = admin.firestore();
    const docId = `${email}_${endpoint}`;
    const ref = db.collection('rateLimits').doc(docId);
    const now = Date.now();
    const expiresAt = new Date(now + (RATE_LIMIT_WINDOW_MS * 2));

    return await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(ref);
        if (doc.exists) {
            const data = doc.data();
            const windowStart = data.windowStart || 0;
            const count = data.count || 0;

            if (now - windowStart < RATE_LIMIT_WINDOW_MS) {
                if (count >= limit) {
                    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - windowStart);
                    return { allowed: false, retryAfterMs };
                }
                transaction.set(ref, { count: count + 1, windowStart, expiresAt }, { merge: true });
                return { allowed: true };
            }
        }

        // New window
        transaction.set(ref, { count: 1, windowStart: now, expiresAt });
        return { allowed: true };
    });
}

module.exports = {
    checkRateLimit
};
