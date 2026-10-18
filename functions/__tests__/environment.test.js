/**
 * Round 3: one Firebase project, two environments. Firestore database, region
 * and origin allowlist all follow the environment's params.
 */
const ENV_KEYS = ['APP_ENVIRONMENT', 'FIRESTORE_DATABASE_ID', 'FUNCTIONS_REGION'];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    jest.resetModules();
});

describe('params helpers (real firebase-functions params read process.env)', () => {
    test('appEnvironment: missing/empty/unknown → production; known values pass through', () => {
        const { appEnvironment } = require('../params');
        delete process.env.APP_ENVIRONMENT;
        expect(appEnvironment()).toBe('production');
        process.env.APP_ENVIRONMENT = '';
        expect(appEnvironment()).toBe('production');
        process.env.APP_ENVIRONMENT = 'qa';
        expect(appEnvironment()).toBe('production');
        process.env.APP_ENVIRONMENT = 'staging';
        expect(appEnvironment()).toBe('staging');
        process.env.APP_ENVIRONMENT = 'EMULATOR';
        expect(appEnvironment()).toBe('emulator');
    });

    test('firestoreDatabaseId: unset → (default)', () => {
        const { firestoreDatabaseId } = require('../params');
        delete process.env.FIRESTORE_DATABASE_ID;
        expect(firestoreDatabaseId()).toBe('(default)');
        process.env.FIRESTORE_DATABASE_ID = ' staging ';
        expect(firestoreDatabaseId()).toBe('staging');
    });
});

describe('services/db honours FIRESTORE_DATABASE_ID', () => {
    function load() {
        const app = { name: '[DEFAULT]' };
        const getFirestore = jest.fn((a, id) => ({ app: a, databaseId: id }));
        jest.doMock('firebase-admin/app', () => ({ getApp: () => app }));
        jest.doMock('firebase-admin/firestore', () => ({ getFirestore }));
        return { ...require('../services/db'), getFirestore, app };
    }

    test('staging environment opens the "staging" database', () => {
        process.env.FIRESTORE_DATABASE_ID = 'staging';
        const { db, getFirestore, app } = load();
        expect(db()).toEqual({ app, databaseId: 'staging' });
        expect(getFirestore).toHaveBeenCalledWith(app, 'staging');
    });

    test('production (unset) opens the (default) database', () => {
        delete process.env.FIRESTORE_DATABASE_ID;
        const { db, getFirestore, app } = load();
        expect(db().databaseId).toBe('(default)');
        expect(getFirestore).toHaveBeenCalledWith(app, '(default)');
    });

    test('scripts open an explicit database and an empty id is refused', () => {
        const { firestoreFor } = load();
        expect(firestoreFor('staging').databaseId).toBe('staging');
        expect(() => firestoreFor('')).toThrow('database id is required');
        expect(() => firestoreFor('   ')).toThrow('database id is required');
    });
});

describe('region: every function follows FUNCTIONS_REGION', () => {
    test('index.js calls setGlobalOptions({ region: FUNCTIONS_REGION }) before defining any function, and no function overrides it', () => {
        const onRequest = jest.fn((opts, handler) => handler);
        const onSchedule = jest.fn((opts, handler) => handler);
        const setGlobalOptions = jest.fn();
        jest.doMock('firebase-functions/v2/https', () => ({ onRequest }));
        jest.doMock('firebase-functions/v2/scheduler', () => ({ onSchedule }));
        jest.doMock('firebase-functions/v2/options', () => ({ setGlobalOptions }));
        jest.doMock('firebase-admin/app', () => ({ initializeApp: jest.fn(), getApps: () => [], getApp: jest.fn() }));
        jest.doMock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
        jest.doMock('firebase-admin/app-check', () => ({ getAppCheck: jest.fn() }));
        jest.doMock('../services/kms', () => ({ generateAndWrapDEK: jest.fn(), unwrapAndDecrypt: jest.fn() }));

        require('../index');
        const { FUNCTIONS_REGION } = require('../params');

        expect(setGlobalOptions).toHaveBeenCalledTimes(1);
        expect(setGlobalOptions).toHaveBeenCalledWith({ region: FUNCTIONS_REGION });
        expect(String(FUNCTIONS_REGION)).toBe('params.FUNCTIONS_REGION');
        const firstDefinition = Math.min(...onRequest.mock.invocationCallOrder, ...onSchedule.mock.invocationCallOrder);
        expect(setGlobalOptions.mock.invocationCallOrder[0]).toBeLessThan(firstDefinition);
        expect(onRequest).toHaveBeenCalledTimes(12);
        expect(onSchedule).toHaveBeenCalledTimes(1);
        for (const [opts] of [...onRequest.mock.calls, ...onSchedule.mock.calls]) {
            expect(opts.region).toBeUndefined();
        }
    });
});

describe('scripts require an explicit --database', () => {
    const path = require('path');
    const { spawnSync } = require('child_process');
    const run = (script, args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', script), ...args], {
        encoding: 'utf8', env: { PATH: process.env.PATH },
    });

    test('grant_credits.js exits 2 without --database (before touching Firestore)', () => {
        const r = run('grant_credits.js', ['--project=ai-planner-project-467800', '--amount=25', '--grant-id=launch-2026-10']);
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('--database');
    });

    test('security_migration.js exits 2 without --database (before touching Firestore)', () => {
        const r = run('security_migration.js', ['--dry-run']);
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('--database');
    });
});
