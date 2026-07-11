const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // We don't have this but we can use default credentials if we run inside the firebase CLI environment... wait, we can just use firebase-tools firestore:set? No, that doesn't exist easily. 
