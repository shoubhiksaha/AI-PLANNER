/** Cashfree payments: order creation, payment/refund/dispute webhooks. */
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('../services/db');
const crypto = require('crypto');
const { logger } = require('firebase-functions/logger');
const { checkRateLimit } = require('../services/rateLimit');
const { ERROR_CODES: E, sendError, guardRequest } = require('../services/requestGuard');
const {
    normalizePrice,
    getCashfreeConfig,
    createCashfreeOrder: createCashfreeGatewayOrder,
    getCashfreeOrder
} = require('../services/cashfree');
const { setStandardHeaders, isJsonRequest, todayInTimeZone } = require('../utils');
const { TIER_CREDITS } = require('../sync/userPlan');

const FINAL_ORDER_STATUSES = new Set(['SUCCESS', 'REVIEW_REQUIRED', 'REFUNDED', 'CHARGEBACK']);
const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

// --- CASHFREE PAYMENT INTEGRATION ---
const PLAN_BY_PRICE = {
    19: { kind: 'booster', boosterCredits: 50 },
    29: { kind: 'plan', tier: 'standard', days: 30 },
    79: { kind: 'plan', tier: 'standard', days: 90 },
    290: { kind: 'plan', tier: 'standard', days: 365 },
    49: { kind: 'plan', tier: 'pro', days: 30 },
    129: { kind: 'plan', tier: 'pro', days: 90 },
    490: { kind: 'plan', tier: 'pro', days: 365 },
};

/**
 * User updates for a fulfilled purchase. Plan credits are added on top of the
 * remaining balance (never reduced) and the renewal stamp uses the user's timezone.
 */
function computePurchaseGrant(price, userData, now = new Date()) {
    const plan = PLAN_BY_PRICE[price];
    if (!plan) return null;
    if (plan.kind === 'booster') {
        return { boosterCredits: FieldValue.increment(plan.boosterCredits) };
    }
    let currentExpiry = userData.subscriptionExpiryDate ? new Date(userData.subscriptionExpiryDate) : new Date(now);
    if (Number.isNaN(currentExpiry.getTime()) || currentExpiry < now) currentExpiry = new Date(now);
    currentExpiry.setDate(currentExpiry.getDate() + plan.days);
    const renewalStamp = todayInTimeZone(userData.timeZone);
    return {
        tier: plan.tier,
        tierCredits: (Number(userData.tierCredits) || 0) + TIER_CREDITS[plan.tier],
        isPremium: true,
        subscriptionExpiryDate: currentExpiry.toISOString(),
        lastTierCreditRenewalAt: renewalStamp,
        subscriptionRenewalDate: renewalStamp.slice(0, 7)
    };
}

/** User updates that take back a refunded or charged-back purchase. */
function computeEntitlementRevocation(price, userData, now = new Date()) {
    const plan = PLAN_BY_PRICE[price];
    if (!plan) return {};
    if (plan.kind === 'booster') {
        return { boosterCredits: Math.max(0, (Number(userData.boosterCredits) || 0) - plan.boosterCredits) };
    }
    const expiry = userData.subscriptionExpiryDate ? new Date(userData.subscriptionExpiryDate) : new Date(now);
    const newExpiry = new Date(Number.isNaN(expiry.getTime()) ? now : expiry);
    newExpiry.setDate(newExpiry.getDate() - plan.days);
    const remainingCredits = Math.max(0, (Number(userData.tierCredits) || 0) - TIER_CREDITS[plan.tier]);
    if (newExpiry <= now) {
        return {
            tier: 'free',
            isPremium: false,
            tierCredits: Math.min(remainingCredits, TIER_CREDITS.free),
            subscriptionExpiryDate: now.toISOString()
        };
    }
    return { subscriptionExpiryDate: newExpiry.toISOString(), tierCredits: remainingCredits };
}

async function createCashfreeOrderHandler(req, res) {
    let normalizedPrice = null;
    let normalizedPhone = '';
    const identity = await guardRequest(req, res, {
        endpoint: 'createCashfreeOrder',
        checkRevoked: true,
        // Validate the order cheaply before touching auth or the gateway.
        beforeAuth: (request, response) => {
            const { idToken, price, phone } = request.body || {};
            if (!idToken || price === undefined || price === null || !phone) {
                sendError(response, 400, E.BAD_REQUEST, "Missing required fields");
                return false;
            }
            normalizedPrice = normalizePrice(price);
            if (normalizedPrice === null) {
                sendError(response, 400, E.BAD_REQUEST, 'Invalid price');
                return false;
            }
            normalizedPhone = String(phone).replace(/\D/g, '');
            if (!/^[6-9]\d{9}$/.test(normalizedPhone)) {
                sendError(response, 400, E.BAD_REQUEST, 'Invalid Indian mobile number');
                return false;
            }
            return true;
        }
    });
    if (!identity) return;
    const { email: userEmail, uid: userId } = identity;

    try {
        const config = getCashfreeConfig();
        const orderId = `order_${crypto.randomUUID()}`;
        const data = await createCashfreeGatewayOrder(config, {
            order_id: orderId,
            order_amount: normalizedPrice,
            order_currency: "INR",
            customer_details: {
                customer_id: userId,
                customer_email: userEmail,
                customer_phone: normalizedPhone
            },
            order_meta: {
                notify_url: config.notifyUrl
            }
        });

        if (!data?.payment_session_id || (data.order_id && data.order_id !== orderId)) {
            logger.error("Cashfree returned an invalid order creation response", { orderId });
            return sendError(res, 502, 'PAYMENT_GATEWAY_ERROR', "Payment gateway returned an invalid response");
        }

        // Store pending order in firestore
        await db().collection('cashfree_orders').doc(orderId).set({
            userId,
            userEmail,
            price: normalizedPrice,
            amountPaise: normalizedPrice * 100,
            currency: 'INR',
            environment: config.environment,
            status: 'PENDING',
            createdAt: FieldValue.serverTimestamp(),
            payment_session_id: data.payment_session_id
        });

        res.status(200).send({
            payment_session_id: data.payment_session_id,
            payment_environment: config.checkoutMode
        });
    } catch (error) {
        if (error?.code === 'PAYMENTS_DISABLED' || error?.code === 'PAYMENTS_MISCONFIGURED') {
            logger.warn("Payment order creation rejected by configuration", { code: error.code });
            return sendError(res, 503, E.SERVICE_UNAVAILABLE, "Payments are temporarily unavailable");
        }
        logger.error("Cashfree Route Error", { error: error?.message });
        return sendError(res, 502, 'PAYMENT_GATEWAY_ERROR', "Payment gateway failure");
    }
}

function webhookTimestampMs(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) return NaN;
    // Cashfree sends milliseconds; accept seconds too.
    return timestamp.length <= 10 ? value * 1000 : value;
}

/** REFUND_STATUS_WEBHOOK: revoke a fully refunded purchase; flag partial refunds. */
async function handleRefundWebhook(payload) {
    const refund = payload?.data?.refund || {};
    const orderId = refund.order_id;
    if (typeof orderId !== 'string' || !orderId || orderId.length > 128) return { status: 400, body: "Invalid refund payload" };
    const refundStatus = String(refund.refund_status || '').toUpperCase().slice(0, 32);
    const refundId = String(refund.cf_refund_id || refund.refund_id || '').slice(0, 128);
    const refundPaise = Math.round(Number(refund.refund_amount) * 100);
    const firestore = db();
    const orderRef = firestore.collection('cashfree_orders').doc(orderId);

    const outcome = await firestore.runTransaction(async (t) => {
        const snap = await t.get(orderRef);
        if (!snap.exists) return 'order-not-found';
        const order = snap.data();
        const processed = Array.isArray(order.processedRefundIds) ? order.processedRefundIds : [];
        if (refundId && processed.includes(refundId)) return 'duplicate';

        const userRef = order.userEmail ? firestore.collection('users').doc(order.userEmail) : null;
        const userSnap = userRef ? await t.get(userRef) : null;

        const orderUpdates = {
            lastRefundStatus: refundStatus || null,
            lastRefundId: refundId || null,
            updatedAt: FieldValue.serverTimestamp()
        };
        if (refundStatus !== 'SUCCESS') {
            t.update(orderRef, orderUpdates);
            return 'recorded';
        }
        orderUpdates.processedRefundIds = refundId ? [...processed, refundId] : processed;
        if (order.status !== 'SUCCESS') {
            // Refund for an order we never fulfilled (or already revoked): record only.
            t.update(orderRef, { ...orderUpdates, reviewRequired: true, reviewReason: 'REFUND_ON_UNFULFILLED_ORDER' });
            return 'flagged';
        }
        const expectedPaise = Number.isInteger(order.amountPaise) ? order.amountPaise : (normalizePrice(order.price) || 0) * 100;
        if (!Number.isFinite(refundPaise) || refundPaise < expectedPaise) {
            t.update(orderRef, { ...orderUpdates, reviewRequired: true, reviewReason: 'PARTIAL_REFUND' });
            return 'flagged';
        }
        if (userRef && userSnap && userSnap.exists) {
            t.set(userRef, computeEntitlementRevocation(normalizePrice(order.price), userSnap.data() || {}), { merge: true });
        }
        t.update(orderRef, { ...orderUpdates, status: 'REFUNDED', refundedAt: FieldValue.serverTimestamp() });
        return 'revoked';
    });
    logger.info("Refund webhook processed", { orderId, outcome, refundStatus });
    return { status: 200, body: `Refund webhook ${outcome}` };
}

/** DISPUTE_* webhooks: flag the order; revoke entitlements when the dispute is lost. */
async function handleDisputeWebhook(payload) {
    const dispute = payload?.data?.dispute || {};
    const orderId = payload?.data?.order_details?.order_id || dispute.order_id;
    if (typeof orderId !== 'string' || !orderId || orderId.length > 128) return { status: 400, body: "Invalid dispute payload" };
    const disputeStatus = String(dispute.dispute_status || payload.type || '').toUpperCase().slice(0, 64);
    const disputeId = String(dispute.dispute_id || dispute.cf_dispute_id || '').slice(0, 128);
    const lost = /MERCHANT_LOST|MERCHANT_ACCEPTED|CHARGEBACK_LOST|DISPUTE_LOST/.test(disputeStatus);
    const firestore = db();
    const orderRef = firestore.collection('cashfree_orders').doc(orderId);

    const outcome = await firestore.runTransaction(async (t) => {
        const snap = await t.get(orderRef);
        if (!snap.exists) return 'order-not-found';
        const order = snap.data();
        const userRef = order.userEmail ? firestore.collection('users').doc(order.userEmail) : null;
        const userSnap = userRef && lost ? await t.get(userRef) : null;

        const orderUpdates = {
            disputeStatus,
            disputeId: disputeId || null,
            reviewRequired: true,
            reviewReason: 'DISPUTE',
            updatedAt: FieldValue.serverTimestamp()
        };
        if (lost && order.status === 'SUCCESS') {
            if (userRef && userSnap && userSnap.exists) {
                t.set(userRef, computeEntitlementRevocation(normalizePrice(order.price), userSnap.data() || {}), { merge: true });
            }
            t.update(orderRef, { ...orderUpdates, status: 'CHARGEBACK' });
            return 'revoked';
        }
        t.update(orderRef, orderUpdates);
        return 'flagged';
    });
    logger.warn("Dispute webhook processed", { orderId, outcome, disputeStatus });
    return { status: 200, body: `Dispute webhook ${outcome}` };
}

async function cashfreeWebhookHandler(req, res) {
    setStandardHeaders(res);
    // Webhooks are server-to-server POSTs
    if (req.method !== 'POST') return res.status(405).send({ error: "Method not allowed", errorCode: E.BAD_REQUEST });
    if (!isJsonRequest(req)) return res.status(415).send("Unsupported media type");
    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
        return res.status(400).send("Raw webhook body required");
    }
    if (req.rawBody.length > 128 * 1024) {
        return res.status(413).send("Webhook payload too large");
    }

    try {
        const config = getCashfreeConfig();
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];
        const webhookVersion = req.headers['x-webhook-version'];
        if (
            typeof signature !== 'string'
            || typeof timestamp !== 'string'
            || !/^\d{10,16}$/.test(timestamp)
            || !['2023-08-01', '2025-01-01'].includes(webhookVersion)
        ) {
            return res.status(400).send("Missing or invalid webhook headers");
        }
        const rawBody = req.rawBody.toString('utf8');
        const expectedSig = crypto.createHmac('sha256', config.secretKey)
            .update(timestamp + rawBody).digest('base64');
        const receivedBuffer = Buffer.from(signature);
        const expectedBuffer = Buffer.from(expectedSig);
        if (
            receivedBuffer.length !== expectedBuffer.length
            || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
        ) {
            return res.status(401).send('Invalid webhook signature');
        }
        // Replay protection: a validly signed webhook is only accepted while fresh.
        const tsMs = webhookTimestampMs(timestamp);
        if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > WEBHOOK_MAX_AGE_MS) {
            logger.warn("Rejected stale or future-dated webhook", { ageMs: Number.isFinite(tsMs) ? Date.now() - tsMs : null });
            return res.status(400).send("Stale webhook timestamp");
        }

        const payload = req.body;
        const type = String(payload?.type || '');
        if (type === 'REFUND_STATUS_WEBHOOK' || payload?.data?.refund) {
            const result = await handleRefundWebhook(payload);
            return res.status(result.status).send(result.body);
        }
        if (type.startsWith('DISPUTE') || payload?.data?.dispute) {
            const result = await handleDisputeWebhook(payload);
            return res.status(result.status).send(result.body);
        }

        if (!payload?.data?.order || !payload?.data?.payment) {
            return res.status(400).send("Invalid payload");
        }

        const orderId = payload.data.order.order_id;
        const txStatus = payload.data.payment.payment_status;
        if (typeof orderId !== 'string' || orderId.length > 128 || typeof txStatus !== 'string' || txStatus.length > 32) {
            return res.status(400).send("Invalid payment fields");
        }

        const rl = await checkRateLimit(`cashfree_${orderId}`, 'cashfreeWebhook', 60);
        if (!rl.allowed) return res.status(429).send("Too many webhook attempts");

        const orderRef = db().collection('cashfree_orders').doc(orderId);
        const initialOrderSnap = await orderRef.get();
        if (!initialOrderSnap.exists) return res.status(404).send("Order not found");
        const initialOrder = initialOrderSnap.data();
        if (initialOrder.status === 'SUCCESS') return res.status(200).send("Webhook already processed");
        if (FINAL_ORDER_STATUSES.has(initialOrder.status)) return res.status(200).send("Order requires review");
        if (initialOrder.environment !== config.environment) {
            return res.status(409).send("Payment environment mismatch");
        }

        const expectedPrice = normalizePrice(initialOrder.price);
        const expectedAmountPaise = Number.isInteger(initialOrder.amountPaise)
            ? initialOrder.amountPaise
            : (expectedPrice === null ? null : expectedPrice * 100);
        if (expectedPrice === null || expectedAmountPaise === null) {
            await orderRef.update({
                status: 'REVIEW_REQUIRED',
                reviewReason: 'INVALID_STORED_PRICE',
                updatedAt: FieldValue.serverTimestamp()
            });
            return res.status(422).send("Order requires review");
        }

        const webhookOrderAmountPaise = Math.round(Number(payload.data.order.order_amount) * 100);
        const webhookCurrency = payload.data.order.order_currency;
        if (webhookOrderAmountPaise !== expectedAmountPaise || webhookCurrency !== 'INR') {
            return res.status(409).send("Webhook order amount or currency mismatch");
        }

        if (txStatus === 'SUCCESS' && payload.type !== 'PAYMENT_SUCCESS_WEBHOOK') {
            return res.status(400).send("Invalid success webhook type");
        }

        if (txStatus !== 'SUCCESS') {
            await db().runTransaction(async (t) => {
                const latest = await t.get(orderRef);
                // A late or replayed failure never overwrites a final state.
                if (!latest.exists || FINAL_ORDER_STATUSES.has(latest.data().status)) return;
                t.update(orderRef, {
                    status: txStatus,
                    updatedAt: FieldValue.serverTimestamp()
                });
            });
            return res.status(200).send("Non-success webhook recorded");
        }

        const gatewayOrder = await getCashfreeOrder(config, orderId);
        const gatewayAmountPaise = Math.round(Number(gatewayOrder?.order_amount) * 100);
        if (
            gatewayOrder?.order_id !== orderId
            || gatewayOrder?.order_status !== 'PAID'
            || gatewayAmountPaise !== expectedAmountPaise
            || gatewayOrder?.order_currency !== 'INR'
            || (gatewayOrder?.customer_details?.customer_id
                && gatewayOrder.customer_details.customer_id !== initialOrder.userId)
        ) {
            return res.status(409).send("Cashfree order verification failed");
        }

        const paymentId = String(payload.data.payment.cf_payment_id || '');
        if (!paymentId || paymentId.length > 128) {
            return res.status(400).send("Missing payment identifier");
        }

        const transactionResult = await db().runTransaction(async (t) => {
            const orderSnap = await t.get(orderRef);
            if (!orderSnap.exists) {
                throw new Error("Order not found");
            }

            const orderData = orderSnap.data();
            if (orderData.status === 'SUCCESS') {
                return { alreadyProcessed: true };
            }
            if (FINAL_ORDER_STATUSES.has(orderData.status)) {
                return { reviewRequired: true, alreadyFinal: true };
            }
            if (orderData.environment !== config.environment) {
                throw new Error("Payment environment mismatch");
            }

            const p = normalizePrice(orderData.price);
            if (p === null || !orderData.userEmail) {
                t.update(orderRef, {
                    status: 'REVIEW_REQUIRED',
                    reviewReason: p === null ? 'INVALID_STORED_PRICE' : 'ACCOUNT_DELETED',
                    cashfreePaymentId: paymentId,
                    updatedAt: FieldValue.serverTimestamp()
                });
                return { reviewRequired: true };
            }

            const userRef = db().collection('users').doc(orderData.userEmail);
            const userSnap = await t.get(userRef);
            const userData = userSnap.exists ? userSnap.data() : {};
            const updates = computePurchaseGrant(p, userData) || {};

            t.update(orderRef, {
                status: 'SUCCESS',
                updatedAt: FieldValue.serverTimestamp(),
                cashfreePaymentId: paymentId,
                paymentStatus: txStatus,
                paymentAmount: Number(payload.data.payment.payment_amount),
                paymentCurrency: payload.data.payment.payment_currency || null,
                paymentTime: payload.data.payment.payment_time || null,
                verifiedOrderStatus: gatewayOrder.order_status
            });

            t.set(userRef, updates, { merge: true });
            logger.info("Cashfree payment fulfilled", { orderId, userId: orderData.userId, price: p });
            return { fulfilled: true };
        });

        if (transactionResult?.reviewRequired) {
            return res.status(transactionResult.alreadyFinal ? 200 : 422).send("Order requires review");
        }
        res.status(200).send("Webhook received");
    } catch (error) {
        if (error.message === "Order not found") {
            return res.status(404).send("Order not found");
        }
        if (error?.code === 'PAYMENTS_DISABLED' || error?.code === 'PAYMENTS_MISCONFIGURED') {
            logger.error("Cashfree webhook rejected by configuration", { code: error.code });
            return res.status(503).send("Webhook not configured");
        }
        logger.error("Webhook Error", { error: error?.message });
        res.status(500).send("Webhook Error");
    }
}

module.exports = {
    createCashfreeOrderHandler,
    cashfreeWebhookHandler,
    computePurchaseGrant,
    computeEntitlementRevocation,
};
