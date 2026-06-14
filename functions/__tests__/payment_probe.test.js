const crypto = require('crypto');

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockTxUpdate = jest.fn();
const mockTxSet = jest.fn();
const mockOrderDocSet = jest.fn();
const mockVerifyIdToken = jest.fn();
let mockStore = {};

const mockRunTransaction = jest.fn(async (cb) => {
    const t = {
        get: async (ref) => mockStore[ref._key] || { exists: false, data: () => undefined },
        update: mockTxUpdate,
        set: mockTxSet
    };
    return cb(t);
});

function mockCollection(name) {
    return {
        doc: (id) => ({
            _key: `${name}/${id}`,
            set: mockOrderDocSet,
            get: async () => mockStore[`${name}/${id}`] || { exists: false, data: () => undefined }
        })
    };
}

jest.mock('firebase-admin', () => {
    const FieldValue = { increment: (n) => ({ __inc: n }), serverTimestamp: () => 'ts' };
    const firestore = Object.assign(
        jest.fn(() => ({ collection: mockCollection, runTransaction: mockRunTransaction })),
        { FieldValue }
    );
    return {
        initializeApp: jest.fn(),
        firestore,
        auth: jest.fn(() => ({ verifyIdToken: mockVerifyIdToken }))
    };
});

jest.mock('firebase-functions/v2/https', () => ({
    onRequest: (opts, handler) => handler
}));
jest.mock('firebase-functions/params', () => ({
    defineString: jest.fn(() => ({ value: () => 'x' })),
    defineSecret: jest.fn(() => ({ value: () => 'x' }))
}));

process.env.NODE_ENV = 'test';
const fns = require('../index');

function makeRes() {
    const res = {};
    res.set = jest.fn(() => res);
    res.status = jest.fn(() => res);
    res.send = jest.fn(() => res);
    return res;
}

function sign(secret, ts, raw) {
    return crypto.createHmac('sha256', secret).update(ts + raw).digest('base64');
}

function webhookReq(secret, { orderId = 'order_1', paymentStatus = 'SUCCESS', tamperSig = null, tsOverride = null } = {}) {
    const bodyObj = { data: { order: { order_id: orderId }, payment: { payment_status: paymentStatus } } };
    const raw = JSON.stringify(bodyObj);
    const ts = tsOverride || '1700000000';
    const sig = tamperSig !== null ? tamperSig : sign(secret, ts, raw);
    return { method: 'POST', headers: { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts }, rawBody: Buffer.from(raw), body: bodyObj };
}

describe('Cashfree webhook + order creation probe', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockStore = {};
        global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ payment_session_id: 'sess_x' }) }));
    });

    // P1: valid signature → correct fulfillment
    it('P1: valid signature grants Pro tier for price 49', async () => {
        const secret = 'live_secret_abc';
        process.env.CASHFREE_SECRET_KEY = secret;
        mockStore['cashfree_orders/order_1'] = { exists: true, data: () => ({ status: 'PENDING', price: 49, userEmail: 'u@e.com' }) };
        mockStore['users/u@e.com'] = { exists: true, data: () => ({}) };

        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq(secret), res);

        const userGrant = mockTxSet.mock.calls.find(c => c[0]._key === 'users/u@e.com');
        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: 'P1_valid_pro', status: res.status.mock.calls.flat(), grant: userGrant ? userGrant[1] : null }));
        expect(res.status).toHaveBeenCalledWith(200);
        expect(userGrant[1]).toMatchObject({ tier: 'pro', tierCredits: 250, isPremium: true, lastTierCreditRenewalAt: expect.any(String) });
    });

    // P2: duplicate delivery is idempotent
    it('P2: duplicate SUCCESS delivery does not double-grant', async () => {
        const secret = 'live_secret_abc';
        process.env.CASHFREE_SECRET_KEY = secret;
        mockStore['cashfree_orders/order_1'] = { exists: true, data: () => ({ status: 'SUCCESS', price: 49, userEmail: 'u@e.com' }) };
        mockStore['users/u@e.com'] = { exists: true, data: () => ({}) };

        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq(secret), res);

        const userGrant = mockTxSet.mock.calls.find(c => c[0]._key === 'users/u@e.com');
        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: 'P2_idempotent', status: res.status.mock.calls.flat(), userGrantCalled: !!userGrant }));
        expect(res.status).toHaveBeenCalledWith(200);
        expect(userGrant).toBeUndefined(); // no second grant
    });

    // P3: invalid signature → 401, no transaction
    it('P3: invalid signature is rejected with 401 and never runs fulfillment', async () => {
        const secret = 'live_secret_abc';
        process.env.CASHFREE_SECRET_KEY = secret;
        mockStore['cashfree_orders/order_1'] = { exists: true, data: () => ({ status: 'PENDING', price: 49, userEmail: 'u@e.com' }) };

        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq(secret, { tamperSig: 'totally-wrong' }), res);

        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: 'P3_bad_sig', status: res.status.mock.calls.flat(), txRan: mockRunTransaction.mock.calls.length }));
        expect(res.status).toHaveBeenCalledWith(401);
        expect(mockRunTransaction).not.toHaveBeenCalled();
    });

    // P4: with empty secret the webhook must fail CLOSED (no grant)
    it('P4: empty secret rejects the webhook and never grants', async () => {
        process.env.CASHFREE_SECRET_KEY = '';
        mockStore['cashfree_orders/order_1'] = { exists: true, data: () => ({ status: 'PENDING', price: 49, userEmail: 'u@e.com' }) };
        mockStore['users/u@e.com'] = { exists: true, data: () => ({}) };

        // Attacker computes HMAC with empty key (the old documented fallback)
        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq('', {}), res);

        const statuses = res.status.mock.calls.flat();
        const grantCalled = mockTxSet.mock.calls.some(c => c[0]._key === 'users/u@e.com');
        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: 'P4_empty_secret', status: statuses, forgedAccepted: statuses.includes(200), grantCalled }));
        expect(statuses).not.toContain(200);
        expect(grantCalled).toBe(false);
    });

    // P5: order creation rejects non-allowlisted price
    it('P5: createCashfreeOrder rejects invalid price before contacting gateway', async () => {
        const res = makeRes();
        const req = { method: 'POST', headers: { 'content-type': 'application/json' }, get: (h) => req.headers[h.toLowerCase()], body: { idToken: 'tok', price: 999 } };
        await fns.createCashfreeOrder(req, res);

        console.log('PROBE_RESULT ' + JSON.stringify({ scenario: 'P5_bad_price', status: res.status.mock.calls.flat(), fetchCalled: global.fetch.mock.calls.length, verifyCalled: mockVerifyIdToken.mock.calls.length }));
        expect(res.status).toHaveBeenCalledWith(400);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
