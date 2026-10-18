import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  APP_ORIGINS,
  PROD_ORIGIN,
  STAGING_ORIGIN,
  parseUrl,
  resolveWebBaseUrl,
  isAllowedAppOrigin,
  isLoginPath,
  classifyNavigation,
  buildLoginScript,
  buildTokenUpdateScript,
  isSignInRequiredError,
  backoffDelayMs,
} from './bridge.js';

test('parseUrl extracts origin and path', () => {
  assert.deepEqual(parseUrl('https://Planner.analogdigital.tech:443/index.html?x=1#y'), {
    protocol: 'https:',
    host: 'planner.analogdigital.tech',
    origin: 'https://planner.analogdigital.tech',
    pathname: '/index.html',
  });
  assert.equal(parseUrl('https://planner.analogdigital.tech').pathname, '/');
  assert.equal(parseUrl('https://planner.analogdigital.tech.evil.com/').origin, 'https://planner.analogdigital.tech.evil.com');
  assert.equal(parseUrl('upi://pay?pa=x').protocol, 'upi:');
  assert.equal(parseUrl('not a url').protocol, '');
});

test('resolveWebBaseUrl only accepts the two app origins', () => {
  assert.equal(resolveWebBaseUrl(undefined), PROD_ORIGIN);
  assert.equal(resolveWebBaseUrl('https://staging-planner.analogdigital.tech/'), STAGING_ORIGIN);
  assert.equal(resolveWebBaseUrl('https://evil.example.com'), PROD_ORIGIN);
  assert.equal(resolveWebBaseUrl('http://planner.analogdigital.tech'), PROD_ORIGIN);
});

test('isAllowedAppOrigin / isLoginPath', () => {
  assert.ok(isAllowedAppOrigin('https://planner.analogdigital.tech/'));
  assert.ok(isAllowedAppOrigin('https://staging-planner.analogdigital.tech/index.html'));
  assert.ok(!isAllowedAppOrigin('https://sdk.cashfree.com/'));
  assert.ok(isLoginPath('/') && isLoginPath('/index.html'));
  assert.ok(!isLoginPath('/planner.html'));
});

test('classifyNavigation routes requests (M-02, M-03)', () => {
  const app = PROD_ORIGIN;
  const nav = (url, isTopFrame = true) => classifyNavigation({ url, isTopFrame }, app);
  assert.equal(nav('https://planner.analogdigital.tech/'), 'allow');
  assert.equal(nav('https://planner.analogdigital.tech/index.html?mobileBridgeReload=1'), 'allow');
  for (const page of ['pricing-policy.html', 'refund-policy.html', 'planner.html', 'gear.html', 'privacy.html', 'planner-file.pdf']) {
    assert.equal(nav(`https://planner.analogdigital.tech/${page}`), 'browser', page);
  }
  assert.equal(nav('https://sdk.cashfree.com/js/v3/checkout'), 'allow');
  assert.equal(nav('https://payments.cashfree.com/order'), 'allow');
  assert.equal(nav('https://notcashfree.com/'), 'browser');
  assert.equal(nav('https://bank.example.com/3ds', false), 'allow');
  assert.equal(nav('https://example.com/'), 'browser');
  assert.equal(nav('https://staging-planner.analogdigital.tech/'), 'browser');
  for (const url of ['upi://pay?pa=a@b', 'intent://pay#Intent;scheme=upi;end', 'tez://upi/pay', 'phonepe://pay', 'paytmmp://pay', 'gpay://upi/pay', 'mailto:a@b.c', 'tel:+911234']) {
    assert.equal(nav(url), 'linking', url);
    assert.equal(nav(url, false), 'linking', url);
  }
  assert.equal(nav('javascript:alert(1)'), 'block');
  assert.equal(nav('file:///etc/passwd'), 'block');
  assert.equal(nav('about:blank'), 'allow');
  assert.equal(classifyNavigation({}, app), 'block');
});

function runInPage(script, { origin, pathname, extra = {} }) {
  const posted = [];
  const window = {
    location: { origin, pathname, href: origin + pathname },
    ReactNativeWebView: { postMessage: (m) => posted.push(m) },
    ...extra,
  };
  const document = {
    addEventListener() {},
    documentElement: { classList: { contains: () => false } },
  };
  const context = vm.createContext({
    window,
    document,
    navigator: {},
    URL,
    setTimeout: () => 0,
    Promise,
    MutationObserver: class { observe() {} },
  });
  vm.runInContext(script, context);
  return { window, posted };
}

test('token update script only runs on app origins and escapes values (S-08, M-01)', () => {
  const tricky = 'tok");alert(1);// ';
  const calls = [];
  const update = (t) => calls.push(t);
  runInPage(buildTokenUpdateScript(tricky, APP_ORIGINS), {
    origin: 'https://evil.example.com', pathname: '/', extra: { mobileUpdateAccessToken: update },
  });
  assert.equal(calls.length, 0);
  runInPage(buildTokenUpdateScript(tricky, APP_ORIGINS), {
    origin: STAGING_ORIGIN, pathname: '/anything', extra: { mobileUpdateAccessToken: update },
  });
  assert.deepEqual(calls, [tricky]);
  // missing function is a no-op, not a throw
  runInPage(buildTokenUpdateScript('x', APP_ORIGINS), { origin: PROD_ORIGIN, pathname: '/' });
});

test('login script checks origin and path before handing tokens (S-08, M-02)', () => {
  const calls = [];
  const mobileLogin = (...args) => { calls.push(args); return Promise.resolve(); };
  const script = buildLoginScript({ idToken: 'id"x', accessToken: 'acc' }, APP_ORIGINS);
  runInPage(script, { origin: 'https://evil.example.com', pathname: '/', extra: { mobileLogin } });
  runInPage(script, { origin: PROD_ORIGIN, pathname: '/planner.html', extra: { mobileLogin } });
  assert.equal(calls.length, 0);
  runInPage(script, { origin: PROD_ORIGIN, pathname: '/index.html', extra: { mobileLogin } });
  assert.deepEqual(calls, [['id"x', 'acc']]);
});

test('isSignInRequiredError / backoffDelayMs (M-06)', () => {
  assert.ok(isSignInRequiredError({ code: 'SIGN_IN_REQUIRED' }, 'SIGN_IN_REQUIRED'));
  assert.ok(isSignInRequiredError({ signInRequired: true }, 'SIGN_IN_REQUIRED'));
  assert.ok(!isSignInRequiredError({ code: 'NETWORK_ERROR' }, 'SIGN_IN_REQUIRED'));
  assert.ok(!isSignInRequiredError(null, 'SIGN_IN_REQUIRED'));
  assert.equal(backoffDelayMs(0, 1000, 4000), 1000);
  assert.equal(backoffDelayMs(1, 1000, 4000), 2000);
  assert.equal(backoffDelayMs(5, 1000, 4000), 4000);
});
