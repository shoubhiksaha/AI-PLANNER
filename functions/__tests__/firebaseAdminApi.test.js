/**
 * Guard against firebase-admin API drift: every firebase-admin subpath and
 * named export the production code imports must exist in the INSTALLED package.
 * (firebase-admin 14 removed the namespaced admin.firestore()/admin.auth() API;
 * unit tests mock firebase-admin, so only this check sees the real surface.)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['sync', 'handlers', 'services', 'testing', 'scripts'];
const SOURCE_FILES = ['index.js', 'params.js', 'utils.js'];

function productionFiles() {
    const out = SOURCE_FILES.map(f => path.join(ROOT, f));
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) out.push(full);
        }
    };
    SOURCE_DIRS.forEach(d => walk(path.join(ROOT, d)));
    return out;
}

/** { 'firebase-admin/firestore': Set(['getFirestore', 'FieldValue']), ... } plus root-module requires. */
function collectImports() {
    const imports = {};
    const rootRequires = [];
    const destructured = /const\s*\{([^}]+)\}\s*=\s*require\(\s*['"](firebase-admin(?:\/[\w-]+)?)['"]\s*\)/g;
    const anyRequire = /require\(\s*['"](firebase-admin(?:\/[\w-]+)?)['"]\s*\)/g;
    for (const file of productionFiles()) {
        const src = fs.readFileSync(file, 'utf8');
        let m;
        while ((m = destructured.exec(src))) {
            const names = m[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
            imports[m[2]] = imports[m[2]] || new Set();
            names.forEach(n => imports[m[2]].add(n));
        }
        while ((m = anyRequire.exec(src))) {
            if (m[1] === 'firebase-admin') rootRequires.push(path.relative(ROOT, file));
            imports[m[1]] = imports[m[1]] || new Set();
        }
    }
    return { imports, rootRequires };
}

// Members of the imported classes/objects that the code relies on.
const REQUIRED_MEMBERS = {
    'firebase-admin/firestore': {
        FieldValue: ['serverTimestamp', 'increment', 'delete', 'arrayUnion'],
        FieldPath: ['documentId'],
    },
};

describe('firebase-admin modular API (real package)', () => {
    const { imports, rootRequires } = collectImports();

    test('the code imports only firebase-admin subpaths, never the root namespace', () => {
        expect(rootRequires).toEqual([]);
        expect(Object.keys(imports).sort()).toEqual(expect.arrayContaining([
            'firebase-admin/app', 'firebase-admin/auth', 'firebase-admin/app-check', 'firebase-admin/firestore',
        ]));
    });

    test('only services/db.js opens Firestore (no bare getFirestore elsewhere; round 3)', () => {
        const offenders = productionFiles()
            .filter(f => path.relative(ROOT, f) !== path.join('services', 'db.js'))
            .filter(f => /\bgetFirestore\b/.test(fs.readFileSync(f, 'utf8')))
            .map(f => path.relative(ROOT, f));
        expect(offenders).toEqual([]);
        const dbSource = fs.readFileSync(path.join(ROOT, 'services', 'db.js'), 'utf8');
        expect(dbSource).toMatch(/getFirestore\(getApp\(\), id\)/);
    });

    test('CommonJS subpaths load in Jest via jest.requireActual and export what the code uses', () => {
        for (const sub of ['firebase-admin/app', 'firebase-admin/firestore']) {
            const mod = jest.requireActual(sub);
            for (const name of imports[sub] || []) {
                expect({ sub, name, type: typeof mod[name] }).toEqual({ sub, name, type: 'function' });
            }
        }
        const { FieldValue, FieldPath } = jest.requireActual('firebase-admin/firestore');
        for (const m of REQUIRED_MEMBERS['firebase-admin/firestore'].FieldValue) expect(typeof FieldValue[m]).toBe('function');
        for (const m of REQUIRED_MEMBERS['firebase-admin/firestore'].FieldPath) expect(typeof FieldPath[m]).toBe('function');
    });

    test('every imported subpath and name exists when loaded by real Node (as in Cloud Functions)', () => {
        // firebase-admin/auth and /app-check depend on ESM-only jose, which Jest cannot
        // require; Node 22 loads it natively, so check those in a child process.
        const spec = Object.fromEntries(Object.entries(imports).map(([sub, names]) => [sub, [...names]]));
        const script = `
            const spec = ${JSON.stringify(spec)};
            const members = ${JSON.stringify(REQUIRED_MEMBERS)};
            const missing = [];
            for (const [sub, names] of Object.entries(spec)) {
                let mod;
                try { mod = require(sub); } catch (e) { missing.push(sub + ' (' + e.message.split('\\n')[0] + ')'); continue; }
                for (const n of names) if (typeof mod[n] !== 'function') missing.push(sub + '#' + n);
                for (const [n, ms] of Object.entries(members[sub] || {})) {
                    for (const m of ms) if (typeof (mod[n] || {})[m] !== 'function') missing.push(sub + '#' + n + '.' + m);
                }
            }
            process.stdout.write(JSON.stringify(missing));
        `;
        const run = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
        expect(run.stderr).toBe('');
        expect(JSON.parse(run.stdout)).toEqual([]);
    });
});
