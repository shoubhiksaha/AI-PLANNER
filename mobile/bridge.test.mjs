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
  buildBackScript,
  buildCameraStateScript,
  isSafeCssColor,
  isOpaqueCssColor,
  safeFileName,
  isOfflineState,
  isSignInRequiredError,
  backoffDelayMs,
  parseAppLink,
  buildAppStateScript,
  buildOpenScript,
  buildAddImagesScript,
  clampScanPages,
  fitWithin,
  normalizeFileUri,
  parseTime,
  normalizeReminders,
  DEFAULT_REMINDERS,
} from './bridge.js';
import { COLORS, screenColors } from './theme.js';

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

function runInPage(script, { origin, pathname, extra = {}, documentExtra = {}, globals = {} }) {
  const posted = [];
  const window = {
    location: { origin, pathname, href: origin + pathname },
    ReactNativeWebView: { postMessage: (m) => posted.push(m) },
    ...extra,
  };
  const document = {
    addEventListener() {},
    documentElement: { classList: { contains: () => false } },
    ...documentExtra,
  };
  const context = vm.createContext({
    window,
    document,
    navigator: {},
    URL,
    setTimeout: () => 0,
    Promise,
    MutationObserver: class { observe() {} },
    ...globals,
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('after login the page reports its theme: dark flag and its own background colour', async () => {
  const mobileLogin = () => Promise.resolve();
  const { posted } = runInPage(buildLoginScript({ idToken: 'i', accessToken: 'a' }, APP_ORIGINS), {
    origin: PROD_ORIGIN,
    pathname: '/',
    extra: { mobileLogin },
    documentExtra: {
      body: {},
      documentElement: { classList: { contains: (c) => c === 'dark-mode' } },
    },
    globals: {
      requestAnimationFrame: (fn) => fn(),
      getComputedStyle: () => ({ backgroundColor: 'rgb(15, 23, 42)' }),
    },
  });
  await flush();
  const themes = posted.map((m) => { try { return JSON.parse(m); } catch { return null; } })
    .filter((m) => m && m.type === 'THEME');
  assert.deepEqual(themes, [{ type: 'THEME', payload: { dark: true, background: 'rgb(15, 23, 42)' } }]);
});

test('Back script asks the page and reports whether it handled Back, only on app origins', () => {
  const ask = (extra, origin = PROD_ORIGIN) => runInPage(buildBackScript(APP_ORIGINS), { origin, pathname: '/', extra })
    .posted.map((m) => JSON.parse(m));
  assert.deepEqual(ask({ handleNativeBack: () => true }), [{ type: 'BACK_RESULT', payload: { handled: true } }]);
  assert.deepEqual(ask({ handleNativeBack: () => false }), [{ type: 'BACK_RESULT', payload: { handled: false } }]);
  assert.deepEqual(ask({}), [{ type: 'BACK_RESULT', payload: { handled: false } }]);
  assert.deepEqual(ask({ handleNativeBack: () => { throw new Error('x'); } }), [{ type: 'BACK_RESULT', payload: { handled: false } }]);
  assert.deepEqual(ask({ handleNativeBack: () => true }, 'https://evil.example.com'), []);
});

test('camera state script sets the flag and reopens the tapped camera input only when granted', () => {
  const clicks = [];
  const input = { click: () => clicks.push('click') };
  const page = (allowed, reopen) => runInPage(buildCameraStateScript(allowed, { reopen }, APP_ORIGINS), {
    origin: PROD_ORIGIN, pathname: '/', extra: { __aiPlannerPendingCamera: input },
    documentExtra: { contains: (el) => el === input },
  }).window;
  const denied = page(false, true);
  assert.equal(denied.__aiPlannerCameraAllowed, false);
  assert.equal(clicks.length, 0);
  assert.equal(page(true, false).__aiPlannerCameraAllowed, true);
  assert.equal(clicks.length, 0);
  const granted = page(true, true);
  assert.equal(granted.__aiPlannerCameraAllowed, true);
  assert.equal(granted.__aiPlannerPendingCamera, null);
  assert.deepEqual(clicks, ['click']);
  const foreign = runInPage(buildCameraStateScript(true, {}, APP_ORIGINS), { origin: 'https://evil.example.com', pathname: '/' }).window;
  assert.equal(foreign.__aiPlannerCameraAllowed, undefined);
});

test('page colours are checked before they paint native views', () => {
  for (const ok of ['rgb(248, 250, 252)', 'rgba(10, 10, 10, 0.5)', '#0F172A', '#fff']) assert.ok(isSafeCssColor(ok), ok);
  for (const bad of ['red', 'url(x)', 'rgb(1,2,3);x', '', null, 'rgb(1, 2)']) assert.ok(!isSafeCssColor(bad), String(bad));
  assert.ok(!isOpaqueCssColor('rgba(0, 0, 0, 0)'));
  assert.ok(isOpaqueCssColor('rgb(255, 255, 255)'));
});

test('safeFileName keeps plain names and rejects paths and odd names', () => {
  assert.equal(safeFileName('ai-planner-data-2026-11-06.json'), 'ai-planner-data-2026-11-06.json');
  assert.equal(safeFileName('my data (1).json'), 'my-data--1-.json');
  assert.equal(safeFileName('.hidden.json'), 'hidden.json');
  for (const bad of ['../../etc/passwd', 'noext', '', 42, 'a.json/..']) {
    assert.equal(safeFileName(bad), 'ai-planner-export.json', String(bad));
  }
});

test('isOfflineState treats unknown reachability as online', () => {
  assert.ok(isOfflineState({ isConnected: false, isInternetReachable: null }));
  assert.ok(isOfflineState({ isConnected: true, isInternetReachable: false }));
  assert.ok(!isOfflineState({ isConnected: true, isInternetReachable: null }));
  assert.ok(!isOfflineState(null));
});

test('screenColors follows the device until the page reports its theme', () => {
  assert.equal(screenColors('dark', null).bg, COLORS.dark.bg);
  assert.equal(screenColors('light', null).edge, COLORS.light.bg);
  const cheerfulDark = screenColors('light', { dark: true, background: 'rgb(15, 23, 42)' });
  assert.equal(cheerfulDark.dark, true);
  assert.equal(cheerfulDark.ink, COLORS.dark.ink);
  assert.equal(cheerfulDark.edge, 'rgb(15, 23, 42)');
  assert.equal(screenColors('dark', { dark: false, background: null }).edge, COLORS.light.bg);
});

test('parseAppLink accepts only the shortcut and reminder screens', () => {
  assert.equal(parseAppLink('aiplanner://scan'), 'scan');
  assert.equal(parseAppLink('aiplanner:///history'), 'history');
  assert.equal(parseAppLink('aiplanner://reports/?from=shortcut'), 'reports');
  for (const bad of ['aiplanner://settings', 'https://planner.analogdigital.tech/scan', 'aiplanner://scan/x', '', null, 'aiplanner://']) {
    assert.equal(parseAppLink(bad), null, String(bad));
  }
});

test('app state, open and add-images scripts reach the page only on app origins', () => {
  const calls = [];
  const extra = {
    aiPlannerAppStateChanged: () => calls.push('state'),
    aiPlannerOpen: (t) => calls.push(['open', t]),
    aiPlannerAddImages: (imgs) => calls.push(['add', imgs]),
  };
  const state = { scanner: true, reminders: DEFAULT_REMINDERS };
  const page = runInPage(buildAppStateScript(state, APP_ORIGINS), { origin: PROD_ORIGIN, pathname: '/', extra }).window;
  assert.deepEqual(JSON.parse(JSON.stringify(page.__aiPlannerApp)), state); // created in the page's realm
  runInPage(buildOpenScript('history', APP_ORIGINS), { origin: STAGING_ORIGIN, pathname: '/', extra });
  const images = [{ name: 'page-1.jpg', mimeType: 'image/jpeg', base64: 'AAA"</script>' }];
  runInPage(buildAddImagesScript(images, APP_ORIGINS), { origin: PROD_ORIGIN, pathname: '/', extra });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), ['state', ['open', 'history'], ['add', images]]);

  assert.equal(buildOpenScript('settings', APP_ORIGINS), null);
  const foreign = runInPage(buildAppStateScript(state, APP_ORIGINS), { origin: 'https://evil.example.com', pathname: '/', extra }).window;
  assert.equal(foreign.__aiPlannerApp, undefined);
  runInPage(buildAddImagesScript(images, APP_ORIGINS), { origin: 'https://evil.example.com', pathname: '/', extra });
  assert.equal(calls.length, 3); // nothing reached the foreign page
});

test('scan page counts and photo sizes are kept in range', () => {
  assert.equal(clampScanPages(3), 3);
  assert.equal(clampScanPages(0), 1);
  assert.equal(clampScanPages('x'), 1);
  assert.equal(clampScanPages(500), 20);
  assert.deepEqual(fitWithin(4000, 3000, 2400), { width: 2400, height: 1800 });
  assert.deepEqual(fitWithin(3000, 4000, 2400), { width: 1800, height: 2400 });
  assert.equal(fitWithin(1200, 1600, 2400), null);
  assert.equal(fitWithin(0, 0, 2400), null);
});

test('reminder settings fall back to defaults for anything invalid', () => {
  assert.deepEqual(parseTime('07:05'), { hour: 7, minute: 5 });
  for (const bad of ['7:05', '24:00', '12:60', '', null]) assert.equal(parseTime(bad), null, String(bad));
  assert.deepEqual(normalizeReminders(null), DEFAULT_REMINDERS);
  assert.deepEqual(
    normalizeReminders({ morning: { on: true, time: '06:30' }, evening: { on: 'yes', time: '9pm' }, extra: 1 }),
    { morning: { on: true, time: '06:30' }, evening: { on: false, time: '21:00' } },
  );
});

test('shared file URIs are normalised so images can be loaded', () => {
  assert.equal(normalizeFileUri('file:/data/user/0/app/cache/1000000018'), 'file:///data/user/0/app/cache/1000000018');
  assert.equal(normalizeFileUri('file:///data/x.jpg'), 'file:///data/x.jpg');
  assert.equal(normalizeFileUri('content://media/external/images/media/5'), 'content://media/external/images/media/5');
});
