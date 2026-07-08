const { defineSecret, defineString } = require('firebase-functions/params');

const CASHFREE_APP_ID = defineSecret('CASHFREE_APP_ID');
const CASHFREE_SECRET_KEY = defineSecret('CASHFREE_SECRET_KEY');
const CASHFREE_ENVIRONMENT = defineString('CASHFREE_ENVIRONMENT', { default: 'disabled' });
const CASHFREE_NOTIFY_URL = defineString('CASHFREE_NOTIFY_URL', {
    default: 'https://ai-planner-project-467800.web.app/cashfreeWebhook'
});
const PAYMENTS_ENABLED = defineString('PAYMENTS_ENABLED', { default: 'false' });

const CASHFREE_API_VERSION = '2023-08-01';
const CASHFREE_TIMEOUT_MS = 15000;
const VALID_PRICES = new Set([19, 29, 49, 79, 129, 290, 490]);
const ENVIRONMENTS = {
    sandbox: {
        apiBaseUrl: 'https://sandbox.cashfree.com/pg',
        checkoutMode: 'sandbox'
    },
    production: {
        apiBaseUrl: 'https://api.cashfree.com/pg',
        checkoutMode: 'production'
    }
};

function normalizePrice(value) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || !Number.isInteger(normalized) || !VALID_PRICES.has(normalized)) {
        return null;
    }
    return normalized;
}

function getCashfreeConfig() {
    if (String(PAYMENTS_ENABLED.value()).toLowerCase() !== 'true') {
        const error = new Error('Payments are disabled.');
        error.code = 'PAYMENTS_DISABLED';
        throw error;
    }

    const environment = String(CASHFREE_ENVIRONMENT.value() || '').toLowerCase();
    const environmentConfig = ENVIRONMENTS[environment];
    if (!environmentConfig) {
        const error = new Error('Cashfree environment is not configured.');
        error.code = 'PAYMENTS_MISCONFIGURED';
        throw error;
    }

    const appId = CASHFREE_APP_ID.value();
    const secretKey = CASHFREE_SECRET_KEY.value();
    if (!appId || !secretKey) {
        const error = new Error('Cashfree credentials are not configured.');
        error.code = 'PAYMENTS_MISCONFIGURED';
        throw error;
    }

    return {
        environment,
        ...environmentConfig,
        appId,
        secretKey,
        notifyUrl: CASHFREE_NOTIFY_URL.value()
    };
}

async function cashfreeRequest(config, path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CASHFREE_TIMEOUT_MS);
    try {
        const response = await fetch(`${config.apiBaseUrl}${path}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'x-client-id': config.appId,
                'x-client-secret': config.secretKey,
                'x-api-version': CASHFREE_API_VERSION,
                ...(options.headers || {})
            },
            redirect: 'error',
            signal: controller.signal
        });

        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            data = null;
        }

        if (!response.ok) {
            const error = new Error(`Cashfree API request failed with status ${response.status}.`);
            error.code = 'CASHFREE_API_ERROR';
            error.status = response.status;
            error.responseData = data;
            throw error;
        }
        return data;
    } catch (error) {
        if (error?.name === 'AbortError') {
            const timeoutError = new Error('Cashfree API request timed out.');
            timeoutError.code = 'CASHFREE_TIMEOUT';
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function createCashfreeOrder(config, order) {
    return cashfreeRequest(config, '/orders', {
        method: 'POST',
        body: JSON.stringify(order)
    });
}

async function getCashfreeOrder(config, orderId) {
    return cashfreeRequest(config, `/orders/${encodeURIComponent(orderId)}`, {
        method: 'GET'
    });
}

module.exports = {
    CASHFREE_APP_ID,
    CASHFREE_SECRET_KEY,
    CASHFREE_ENVIRONMENT,
    CASHFREE_NOTIFY_URL,
    PAYMENTS_ENABLED,
    CASHFREE_API_VERSION,
    VALID_PRICES,
    normalizePrice,
    getCashfreeConfig,
    createCashfreeOrder,
    getCashfreeOrder
};
