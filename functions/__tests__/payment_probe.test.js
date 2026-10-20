const crypto = require('crypto');

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockTxUpdate = jest.fn();
const mockTxSet = jest.fn();
const mockOrderDocSet = jest.fn();
const mockOrderDocUpdate = jest.fn();
const mockVerifyIdToken = jest.fn();
let mockStore = {};
let mockParamValues;

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
            update: mockOrderDocUpdate,
            get: async () => mockStore[`${name}/${id}`] || { exists: false, data: () => undefined }
        })
    };
}

jest.mock('mock-firebase-admin-backing', () => {
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
}, { virtual: true });
jest.mock('firebase-admin/app', () => require('./helpers/adminMock').app());
jest.mock('firebase-admin/firestore', () => require('./helpers/adminMock').firestore());
jest.mock('firebase-admin/auth', () => require('./helpers/adminMock').auth());
jest.mock('firebase-admin/app-check', () => require('./helpers/adminMock').appCheck());

jest.mock('firebase-functions/v2/https', () => ({
    onRequest: (_opts, handler) => handler
}));

jest.mock('firebase-functions/params', () => ({
    defineString: jest.fn((name, options = {}) => ({
        value: () => mockParamValues[name] ?? options.default ?? 'x'
    })),
    defineSecret: jest.fn((name) => ({
        value: () => mockParamValues[name] ?? 'x'
    }))
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

function signedReq(bodyObj, { secret = 'live_secret_abc', ts = String(Date.now()) } = {}) {
    const raw = JSON.stringify(bodyObj);
    const req = {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-webhook-signature': sign(secret, ts, raw),
            'x-webhook-timestamp': ts,
            'x-webhook-version': '2023-08-01'
        },
        rawBody: Buffer.from(raw),
        body: bodyObj
    };
    req.get = (h) => req.headers[String(h || '').toLowerCase()];
    return req;
}

function storeOrder(overrides = {}) {
    mockStore['cashfree_orders/order_1'] = {
        exists: true,
        data: () => ({
            status: 'SUCCESS',
            price: 49,
            amountPaise: 4900,
            currency: 'INR',
            environment: 'sandbox',
            userEmail: 'u@e.com',
            userId: 'u1',
            ...overrides
        })
    };
}

function storeUser(data) {
    mockStore['users/u@e.com'] = { exists: true, data: () => data };
}

function refundBody({ amount = 49, status = 'SUCCESS', refundId = 'rf_1' } = {}) {
    return {
        type: 'REFUND_STATUS_WEBHOOK',
        data: { refund: { order_id: 'order_1', cf_refund_id: refundId, refund_amount: amount, refund_currency: 'INR', refund_status: status } }
    };
}

function webhookReq({
    secret = 'live_secret_abc',
    orderId = 'order_1',
    paymentStatus = 'SUCCESS',
    type = 'PAYMENT_SUCCESS_WEBHOOK',
    tamperSig = null,
    tsOverride = null,
    amount = 49
} = {}) {
    const bodyObj = {
        type,
        data: {
            order: {
                order_id: orderId,
                order_amount: amount,
                order_currency: 'INR'
            },
            payment: {
                payment_status: paymentStatus,
                payment_amount: amount,
                payment_currency: 'INR',
                cf_payment_id: 'cf_payment_1',
                payment_time: '2026-06-21T10:00:00+05:30'
            }
        }
    };
    const raw = JSON.stringify(bodyObj);
    const ts = tsOverride || String(Date.now());
    const sig = tamperSig !== null ? tamperSig : sign(secret, ts, raw);
    const req = {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-webhook-signature': sig,
            'x-webhook-timestamp': ts,
            'x-webhook-version': '2023-08-01'
        },
        rawBody: Buffer.from(raw),
        body: bodyObj
    };
    req.get = (h) => req.headers[String(h || '').toLowerCase()];
    return req;
}

describe('Cashfree webhook + order creation probe', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockStore = {};
        mockParamValues = {
            PAYMENTS_ENABLED: 'true',
            CASHFREE_ENVIRONMENT: 'sandbox',
            CASHFREE_NOTIFY_URL: 'https://ai-planner-project-467800.web.app/cashfreeWebhook',
            CASHFREE_APP_ID: 'app_x',
            CASHFREE_SECRET_KEY: 'live_secret_abc',
            REQUIRE_APP_CHECK: 'false',
            ALLOW_CUSTOM_BYOK_URLS: 'false'
        };
        mockVerifyIdToken.mockResolvedValue({ email: 'u@e.com', uid: 'u1', email_verified: true });
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('/pg/orders/order_1')) {
                return {
                    ok: true,
                    headers: { get: () => null },
                    json: async () => ({
                        order_id: 'order_1',
                        order_status: 'PAID',
                        order_amount: 49,
                        order_currency: 'INR',
                        customer_details: { customer_id: 'u1' }
                    })
                };
            }
            return {
                ok: true,
                headers: { get: () => null },
                json: async () => ({ payment_session_id: 'sess_x' })
            };
        });
    });

    it('P1: valid signature grants Pro tier for price 49', async () => {
        mockStore['cashfree_orders/order_1'] = {
            exists: true,
            data: () => ({
                status: 'PENDING',
                price: 49,
                amountPaise: 4900,
                currency: 'INR',
                environment: 'sandbox',
                userEmail: 'u@e.com',
                userId: 'u1'
            })
        };

        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq(), res);

        const userGrant = mockTxSet.mock.calls.find(c => c[0]._key === 'users/u@e.com');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(userGrant[1]).toMatchObject({
            tier: 'pro',
            tierCredits: 250,
            isPremium: true,
            lastTierCreditRenewalAt: expect.any(String)
        });
    });

    it('P2: duplicate SUCCESS delivery does not double-grant', async () => {
        mockStore['cashfree_orders/order_1'] = {
            exists: true,
            data: () => ({
                status: 'SUCCESS',
                price: 49,
                amountPaise: 4900,
                currency: 'INR',
                environment: 'sandbox',
                userEmail: 'u@e.com',
                userId: 'u1'
            })
        };

        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq(), res);

        const userGrant = mockTxSet.mock.calls.find(c => c[0]._key === 'users/u@e.com');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(userGrant).toBeUndefined();
    });

    it('P3: invalid signature is rejected with 401 and never runs fulfillment', async () => {
        mockStore['cashfree_orders/order_1'] = {
            exists: true,
            data: () => ({
                status: 'PENDING',
                price: 49,
                amountPaise: 4900,
                currency: 'INR',
                environment: 'sandbox',
                userEmail: 'u@e.com',
                userId: 'u1'
            })
        };

        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq({ tamperSig: 'totally-wrong' }), res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(mockRunTransaction).not.toHaveBeenCalled();
    });

    it('P4: empty configured secret fails closed and never grants', async () => {
        mockParamValues.CASHFREE_SECRET_KEY = '';
        mockStore['cashfree_orders/order_1'] = {
            exists: true,
            data: () => ({
                status: 'PENDING',
                price: 49,
                amountPaise: 4900,
                currency: 'INR',
                environment: 'sandbox',
                userEmail: 'u@e.com',
                userId: 'u1'
            })
        };

        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq({ secret: '' }), res);

        const grantCalled = mockTxSet.mock.calls.some(c => c[0]._key === 'users/u@e.com');
        expect(res.status).toHaveBeenCalledWith(503);
        expect(grantCalled).toBe(false);
    });

    it('P5: createCashfreeOrder rejects invalid price before contacting gateway', async () => {
        const res = makeRes();
        const req = {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            get: (h) => req.headers[h.toLowerCase()],
            body: { idToken: 'tok', price: 999, phone: '9876543210' }
        };
        await fns.createCashfreeOrder(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });

    it('P6: createCashfreeOrder stores normalized sandbox order', async () => {
        const res = makeRes();
        const req = {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            get: (h) => req.headers[h.toLowerCase()],
            body: { idToken: 'tok', price: '49', phone: '9876543210' }
        };

        await fns.createCashfreeOrder(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith({
            payment_session_id: 'sess_x',
            payment_environment: 'sandbox'
        });
        expect(mockOrderDocSet).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'u1',
            userEmail: 'u@e.com',
            price: 49,
            amountPaise: 4900,
            currency: 'INR',
            environment: 'sandbox',
            status: 'PENDING',
            payment_session_id: 'sess_x'
        }));
    });

    it('P7: a validly signed but stale webhook (replay) is rejected (S-09)', async () => {
        storeOrder({ status: 'PENDING' });
        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq({ tsOverride: '1700000000' }), res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.send).toHaveBeenCalledWith('Stale webhook timestamp');
        expect(mockRunTransaction).not.toHaveBeenCalled();
    });

    it('P8: a full refund revokes the plan, marks the order REFUNDED and returns 200', async () => {
        storeOrder();
        const soon = new Date(Date.now() + 10 * 86400000).toISOString();
        storeUser({ tier: 'pro', tierCredits: 260, isPremium: true, subscriptionExpiryDate: soon });
        const res = makeRes();
        await fns.cashfreeWebhook(signedReq(refundBody()), res);
        expect(res.status).toHaveBeenCalledWith(200);
        const userWrite = mockTxSet.mock.calls.find(c => c[0]._key === 'users/u@e.com');
        expect(userWrite[1]).toMatchObject({ tier: 'free', isPremium: false, tierCredits: 10 });
        const orderWrite = mockTxUpdate.mock.calls.find(c => c[0]._key === 'cashfree_orders/order_1');
        expect(orderWrite[1]).toMatchObject({ status: 'REFUNDED', processedRefundIds: ['rf_1'] });
    });

    it('P9: a partial refund is flagged for review without touching entitlements', async () => {
        storeOrder();
        storeUser({ tier: 'pro', tierCredits: 250 });
        const res = makeRes();
        await fns.cashfreeWebhook(signedReq(refundBody({ amount: 10 })), res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockTxSet.mock.calls.find(c => c[0]._key === 'users/u@e.com')).toBeUndefined();
        expect(mockTxUpdate.mock.calls[0][1]).toMatchObject({ reviewRequired: true, reviewReason: 'PARTIAL_REFUND' });
    });

    it('P10: a replayed refund id is a no-op', async () => {
        storeOrder({ status: 'REFUNDED', processedRefundIds: ['rf_1'] });
        const res = makeRes();
        await fns.cashfreeWebhook(signedReq(refundBody()), res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockTxUpdate).not.toHaveBeenCalled();
        expect(mockTxSet).not.toHaveBeenCalled();
    });

    it('P11: booster refund removes the 50 booster credits (never below 0)', async () => {
        storeOrder({ price: 19, amountPaise: 1900 });
        storeUser({ boosterCredits: 20 });
        const res = makeRes();
        await fns.cashfreeWebhook(signedReq(refundBody({ amount: 19 })), res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockTxSet.mock.calls.find(c => c[0]._key === 'users/u@e.com')[1]).toEqual({ boosterCredits: 0 });
    });

    it('P12: refund for an unknown order still returns 200 so Cashfree stops retrying', async () => {
        const res = makeRes();
        await fns.cashfreeWebhook(signedReq(refundBody()), res);
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('P13: dispute webhooks flag the order; a lost dispute revokes the plan', async () => {
        storeOrder();
        storeUser({ tier: 'pro', tierCredits: 100, subscriptionExpiryDate: new Date(Date.now() + 5 * 86400000).toISOString() });
        let res = makeRes();
        await fns.cashfreeWebhook(signedReq({
            type: 'DISPUTE_CREATED',
            data: { dispute: { dispute_id: 'd1', dispute_status: 'DISPUTE_CREATED' }, order_details: { order_id: 'order_1' } }
        }), res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockTxUpdate.mock.calls[0][1]).toMatchObject({ reviewRequired: true, reviewReason: 'DISPUTE', disputeStatus: 'DISPUTE_CREATED' });
        expect(mockTxSet).not.toHaveBeenCalled();

        jest.clearAllMocks();
        res = makeRes();
        await fns.cashfreeWebhook(signedReq({
            type: 'DISPUTE_CLOSED',
            data: { dispute: { dispute_id: 'd1', dispute_status: 'DISPUTE_MERCHANT_LOST' }, order_details: { order_id: 'order_1' } }
        }), res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockTxSet.mock.calls.find(c => c[0]._key === 'users/u@e.com')[1]).toMatchObject({ tier: 'free' });
        expect(mockTxUpdate.mock.calls[0][1]).toMatchObject({ status: 'CHARGEBACK' });
    });

    it('P14: a replayed failure webhook never overwrites REVIEW_REQUIRED', async () => {
        storeOrder({ status: 'REVIEW_REQUIRED' });
        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq({ paymentStatus: 'FAILED', type: 'PAYMENT_FAILED_WEBHOOK' }), res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockTxUpdate).not.toHaveBeenCalled();
        expect(mockOrderDocUpdate).not.toHaveBeenCalled();
    });

    it('P15: a purchase adds plan credits on top and stamps renewal in the user timezone (B-24)', async () => {
        storeOrder({ status: 'PENDING' });
        storeUser({ tier: 'free', tierCredits: 40, timeZone: 'America/Los_Angeles' });
        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq(), res);
        expect(res.status).toHaveBeenCalledWith(200);
        const grant = mockTxSet.mock.calls.find(c => c[0]._key === 'users/u@e.com')[1];
        expect(grant.tierCredits).toBe(290);
        expect(grant.lastTierCreditRenewalAt).toBe(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }));
    });

    it('P16: a payment for a deleted (anonymised) account is held for review', async () => {
        storeOrder({ status: 'PENDING', userEmail: null });
        const res = makeRes();
        await fns.cashfreeWebhook(webhookReq(), res);
        expect(res.status).toHaveBeenCalledWith(422);
        expect(mockTxUpdate.mock.calls[0][1]).toMatchObject({ status: 'REVIEW_REQUIRED', reviewReason: 'ACCOUNT_DELETED' });
    });

    it('P17: PAYMENTS_ENABLED=false rejects order creation with 503', async () => {
        mockParamValues.PAYMENTS_ENABLED = 'false';
        const res = makeRes();
        const req = {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            get: (h) => req.headers[h.toLowerCase()],
            body: { idToken: 'tok', price: 49, phone: '9876543210' }
        };
        await fns.createCashfreeOrder(req, res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'SERVICE_UNAVAILABLE' }));
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('P18: createCashfreeOrder requires a verified email', async () => {
        mockVerifyIdToken.mockResolvedValue({ email: 'u@e.com', uid: 'u1', email_verified: false });
        const res = makeRes();
        const req = {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            get: (h) => req.headers[h.toLowerCase()],
            body: { idToken: 'tok', price: 49, phone: '9876543210' }
        };
        await fns.createCashfreeOrder(req, res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'EMAIL_NOT_VERIFIED' }));
    });
});
