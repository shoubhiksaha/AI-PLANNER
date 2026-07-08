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
    const ts = tsOverride || '1700000000';
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
        mockVerifyIdToken.mockResolvedValue({ email: 'u@e.com', uid: 'u1' });
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
});
