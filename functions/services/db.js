/**
 * The ONLY place that opens Firestore. Production uses the `(default)` database
 * and staging the `staging` database of the same project, chosen by the
 * FIRESTORE_DATABASE_ID param; every handler, job and script goes through here
 * so an environment can never read or write the other one's data.
 */
const { getApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { firestoreDatabaseId } = require('../params');

/**
 * Firestore for an explicit database id (scripts pass their --database flag).
 * firebase-admin caches one instance per (app, databaseId), so this is cheap.
 */
function firestoreFor(databaseId) {
    const id = String(databaseId || '').trim();
    if (!id) throw new Error('A Firestore database id is required.');
    return getFirestore(getApp(), id);
}

/** Firestore of this deployment's environment (FIRESTORE_DATABASE_ID). */
function db() {
    return firestoreFor(firestoreDatabaseId());
}

module.exports = { db, firestoreFor };
