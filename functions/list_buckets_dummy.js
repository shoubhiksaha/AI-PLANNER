const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json"); // We don't have this file locally usually in this env...

// Wait, we are in the user's environment. We can't use serviceAccountKey unless they have it.
// We can try to use `firebase-admin` with default credentials if logged in via `firebase login`.
// But `firebase projects:list` or `firebase storage:bucket:list` via CLI is better.

console.log("Use CLI tool instead.");
