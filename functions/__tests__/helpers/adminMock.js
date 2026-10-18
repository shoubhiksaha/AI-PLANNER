/**
 * Subpath mocks for the modular firebase-admin API used by the code
 * (firebase-admin/app, /firestore, /auth, /app-check).
 *
 * Each test file keeps its fake state in a VIRTUAL module named
 * 'mock-firebase-admin-backing' ({ initializeApp, firestore() with
 * firestore.FieldValue/FieldPath/Timestamp, auth(), appCheck() }); these mocks
 * delegate to it at call time, so tests can still swap implementations.
 * The real 'firebase-admin' root module is never mocked: code that regressed to
 * the removed namespaced API (admin.firestore()) would fail in tests too.
 *
 * Usage in a test file:
 *   jest.mock('mock-firebase-admin-backing', () => ({ ... }), { virtual: true });
 *   jest.mock('firebase-admin/app', () => require('./helpers/adminMock').app());
 *   jest.mock('firebase-admin/firestore', () => require('./helpers/adminMock').firestore());
 *   jest.mock('firebase-admin/auth', () => require('./helpers/adminMock').auth());
 *   jest.mock('firebase-admin/app-check', () => require('./helpers/adminMock').appCheck());
 */
const BACKING = 'mock-firebase-admin-backing';
const backing = () => jest.requireMock(BACKING);

module.exports = {
    BACKING,
    app: () => ({
        initializeApp: jest.fn((...args) => (backing().initializeApp ? backing().initializeApp(...args) : {})),
        getApps: jest.fn(() => []),
        getApp: jest.fn(() => ({ options: {} })),
    }),
    firestore: () => ({
        getFirestore: jest.fn((...args) => backing().firestore(...args)),
        get FieldValue() { return backing().firestore.FieldValue; },
        get FieldPath() { return backing().firestore.FieldPath; },
        get Timestamp() { return backing().firestore.Timestamp; },
    }),
    auth: () => ({
        getAuth: jest.fn((...args) => backing().auth(...args)),
    }),
    appCheck: () => ({
        getAppCheck: jest.fn((...args) => backing().appCheck(...args)),
    }),
};
