/**
 * Minimal in-memory Firestore for unit tests: documents, sub-collections,
 * collection-group queries (where/orderBy/limit/startAfter), transactions,
 * batches and the FieldValue sentinels below. Not a test suite itself.
 */

const FieldValue = {
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    increment: (n) => ({ __fv: 'increment', n }),
    delete: () => ({ __fv: 'delete' }),
};
const DOCUMENT_ID = '__name__';
const FieldPath = { documentId: () => DOCUMENT_ID };

function clone(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
    }
    return value;
}

function compare(a, b) {
    const av = a instanceof Date ? a.getTime() : a;
    const bv = b instanceof Date ? b.getTime() : b;
    if (av === bv) return 0;
    return av < bv ? -1 : 1;
}

function createFakeFirestore({ now = () => new Date() } = {}) {
    const store = new Map(); // path -> data
    const stats = { writes: 0 };

    function applyWrite(path, data, { merge = false, update = false } = {}) {
        if (update && !store.has(path)) {
            const err = new Error(`NOT_FOUND: ${path}`);
            err.code = 5;
            throw err;
        }
        const base = (merge || update) && store.has(path) ? clone(store.get(path)) : {};
        for (const [key, value] of Object.entries(data)) {
            if (value && value.__fv === 'delete') delete base[key];
            else if (value && value.__fv === 'serverTimestamp') base[key] = now();
            else if (value && value.__fv === 'increment') base[key] = (Number(base[key]) || 0) + value.n;
            else base[key] = clone(value);
        }
        store.set(path, base);
        stats.writes += 1;
    }

    function snapshot(ref) {
        const exists = store.has(ref.path);
        const data = exists ? clone(store.get(ref.path)) : undefined;
        return { id: ref.id, ref, exists, data: () => data, get: (f) => (data ? data[f] : undefined) };
    }

    function docRef(path) {
        const segments = path.split('/');
        const ref = {
            id: segments[segments.length - 1],
            path,
            get parent() { return collectionRef(segments.slice(0, -1).join('/')); },
            collection: (name) => collectionRef(`${path}/${name}`),
            get: async () => snapshot(ref),
            set: async (data, opts = {}) => applyWrite(path, data, { merge: !!opts.merge }),
            update: async (data) => applyWrite(path, data, { update: true }),
            delete: async () => { store.delete(path); stats.writes += 1; },
        };
        return ref;
    }

    function query(matchPath, state = { filters: [], order: null, limitN: Infinity, after: null }) {
        const next = (patch) => query(matchPath, { ...state, ...patch });
        return {
            where: (field, op, value) => next({ filters: [...state.filters, { field, op, value }] }),
            orderBy: (field, direction = 'asc') => next({ order: { field, direction } }),
            limit: (n) => next({ limitN: n }),
            startAfter: (snap) => next({ after: snap }),
            get: async () => {
                let docs = [...store.keys()].filter(matchPath).sort().map(p => snapshot(docRef(p)));
                for (const { field, op, value } of state.filters) {
                    docs = docs.filter((d) => {
                        const v = field === DOCUMENT_ID ? d.id : d.data()[field];
                        if (v === undefined) return false;
                        const c = compare(v, value);
                        return { '==': c === 0, '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[op];
                    });
                }
                if (state.order) {
                    const { field, direction } = state.order;
                    docs.sort((x, y) => {
                        const xv = field === DOCUMENT_ID ? x.ref.path : x.data()[field];
                        const yv = field === DOCUMENT_ID ? y.ref.path : y.data()[field];
                        return compare(xv, yv) * (direction === 'desc' ? -1 : 1);
                    });
                }
                if (state.after) {
                    const idx = docs.findIndex(d => d.ref.path === state.after.ref.path);
                    docs = idx >= 0 ? docs.slice(idx + 1) : docs;
                }
                docs = docs.slice(0, state.limitN);
                return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn) => docs.forEach(fn) };
            },
        };
    }

    function collectionRef(path) {
        const depth = path.split('/').length + 1;
        const base = query((p) => p.startsWith(`${path}/`) && p.split('/').length === depth);
        return {
            ...base,
            id: path.split('/').pop(),
            path,
            get parent() {
                const segs = path.split('/');
                return segs.length > 1 ? docRef(segs.slice(0, -1).join('/')) : null;
            },
            doc: (id) => docRef(`${path}/${id || Math.random().toString(36).slice(2)}`),
            add: async (data) => {
                const ref = docRef(`${path}/${Math.random().toString(36).slice(2)}`);
                await ref.set(data);
                return ref;
            },
        };
    }

    const db = {
        collection: (name) => collectionRef(name),
        collectionGroup: (name) => query((p) => {
            const segs = p.split('/');
            return segs.length >= 2 && segs[segs.length - 2] === name;
        }),
        batch: () => {
            const ops = [];
            return {
                set: (ref, data, opts = {}) => { ops.push(() => applyWrite(ref.path, data, { merge: !!opts.merge })); },
                update: (ref, data) => { ops.push(() => applyWrite(ref.path, data, { update: true })); },
                delete: (ref) => { ops.push(() => store.delete(ref.path)); },
                commit: async () => { ops.forEach(op => op()); },
            };
        },
        runTransaction: async (fn) => {
            const ops = [];
            const t = {
                get: async (ref) => (typeof ref.get === 'function' ? ref.get() : null),
                set: (ref, data, opts = {}) => { ops.push(() => applyWrite(ref.path, data, { merge: !!opts.merge })); return t; },
                update: (ref, data) => { ops.push(() => applyWrite(ref.path, data, { update: true })); return t; },
                delete: (ref) => { ops.push(() => store.delete(ref.path)); return t; },
            };
            const result = await fn(t);
            ops.forEach(op => op());
            return result;
        },
        // Test helpers
        _store: store,
        _stats: stats,
        _seed: (path, data) => store.set(path, clone(data)),
        _read: (path) => (store.has(path) ? clone(store.get(path)) : undefined),
    };
    return db;
}

module.exports = { createFakeFirestore, FieldValue, FieldPath };
