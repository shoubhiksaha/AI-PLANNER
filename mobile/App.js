import { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  StatusBar,
  View,
  Platform,
  PermissionsAndroid,
  BackHandler,
  Linking,
  AccessibilityInfo,
  Alert,
  AppState,
  useColorScheme,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import * as SplashScreen from 'expo-splash-screen';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import NetInfo from '@react-native-community/netinfo';
import { NavigationBar } from 'expo-navigation-bar';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import {
  APP_ORIGINS,
  resolveWebBaseUrl,
  parseUrl,
  isAllowedAppOrigin,
  isLoginPath,
  classifyNavigation,
  buildLoginScript,
  buildTokenUpdateScript,
  buildBackScript,
  buildCameraStateScript,
  isOpaqueCssColor,
  safeFileName,
  isOfflineState,
  isSignInRequiredError,
  backoffDelayMs,
} from './bridge';
import { screenColors } from './theme';
import { SignInScreen, OpeningScreen, OfflineScreen, LoadErrorScreen } from './screens';

// Base URL of the web app. Override per build with EXPO_PUBLIC_WEB_BASE_URL
// (e.g. the staging origin); anything other than the two app origins falls back to prod.
const WEB_BASE_URL = resolveWebBaseUrl(process.env.EXPO_PUBLIC_WEB_BASE_URL);
const APP_ORIGIN = parseUrl(WEB_BASE_URL).origin;
const START_URL = `${APP_ORIGIN}/`;
const ADT_URL = 'https://analogdigital.tech';

// Google access tokens live ~60 min; refresh a little before that.
const TOKEN_REFRESH_AGE_MS = 45 * 60 * 1000;
const REFRESH_CHECK_INTERVAL_MS = 60 * 1000;
// The splash screen stays up while the page signs in, but never longer than this.
const SPLASH_MAX_MS = 8000;
// Back waits this long for the page's answer (BACK_RESULT) before going back natively.
const BACK_RESULT_TIMEOUT_MS = 600;
// Largest file the page may hand over for saving (SAVE_FILE), in characters.
const MAX_SAVE_FILE_CHARS = 20 * 1024 * 1024;

// Keep the splash screen until the first screen is ready (sign-in, offline or the signed-in page).
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ fade: true, duration: 250 });

// Configure the Native Google Sign-In SDK once at module load.
GoogleSignin.configure({
  webClientId: '195957114195-t8bcn0ppiekdd8pj35s0jc22lk2a0k06.apps.googleusercontent.com',
  iosClientId: '195957114195-hols2jof51j0f0bde36qrjd0tmq5j5e1.apps.googleusercontent.com',
  scopes: [
    'openid',
    'profile',
    'email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/drive.file',
  ],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const signInRequiredError = () => {
  const err = new Error('Google sign-in required.');
  err.signInRequired = true;
  return err;
};

// Fetch fresh tokens from the native Google SDK without user interaction.
async function fetchSilentTokens({ staleAccessToken } = {}) {
  // Android caches access tokens until expiry; drop the one the web reported as rejected.
  if (staleAccessToken && Platform.OS === 'android') {
    try {
      await GoogleSignin.clearCachedAccessToken(staleAccessToken);
    } catch (e) {
      console.warn('Clearing cached Google access token failed:', e);
    }
  }
  const userInfo = await GoogleSignin.signInSilently();
  if (userInfo?.type === 'noSavedCredentialFound') throw signInRequiredError();
  const userTokens = await GoogleSignin.getTokens();
  const idToken = userInfo?.data?.idToken || userInfo?.idToken || userTokens.idToken;
  const accessToken = userTokens.accessToken;
  if (!idToken || !accessToken) throw new Error('Google Sign-In did not return usable tokens.');
  return { idToken, accessToken };
}

function describeLoginError(error) {
  switch (error?.code) {
    case statusCodes.SIGN_IN_CANCELLED:
    case statusCodes.IN_PROGRESS:
      return null;
    case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
      return 'Google Play Services is missing or out of date. Update it and try again.';
    default:
      return 'Sign-in failed. Check your connection and try again.';
  }
}

const isOfflineNow = async () => {
  try {
    return isOfflineState(await NetInfo.fetch());
  } catch {
    return false;
  }
};

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const deviceScheme = useColorScheme();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingLogin, setIsCheckingLogin] = useState(true);
  const [isNativeLoginInProgress, setIsNativeLoginInProgress] = useState(false);
  const [loginError, setLoginError] = useState(null);
  const [webBridgeStatus, setWebBridgeStatus] = useState('idle');
  const [pageTheme, setPageTheme] = useState(null); // { dark, background } reported by the page
  const [isOffline, setIsOffline] = useState(false);
  const [webError, setWebError] = useState(null);
  const [webViewKey, setWebViewKey] = useState(0);
  const [splashDone, setSplashDone] = useState(false);

  const webviewRef = useRef(null);
  const tokensRef = useRef(null);
  const tokenIssuedAtRef = useRef(0);
  const canGoBackRef = useRef(false);
  const currentUrlRef = useRef(START_URL);
  const refreshInFlightRef = useRef(null);
  const refreshFailuresRef = useRef(0);
  const nextRefreshAttemptAtRef = useRef(0);
  const refreshSessionRef = useRef(null);
  const backTimerRef = useRef(null);
  const bootRef = useRef(null);
  const bootRunRef = useRef(0); // bumped to drop the result of a sign-in check that was abandoned
  const isOfflineRef = useRef(false);

  const isPageReady = webBridgeStatus === 'authenticated' || webBridgeStatus === 'ready';
  // Native screens follow the device until the page reports its own theme.
  const c = screenColors(deviceScheme, isAuthenticated ? pageTheme : null);

  const setOffline = (offline) => {
    isOfflineRef.current = offline;
    setIsOffline(offline);
  };

  const hideSplash = useCallback(() => {
    setSplashDone((done) => {
      if (!done) SplashScreen.hideAsync().catch(() => {});
      return true;
    });
  }, []);

  const clearStoredLogin = async () => {
    await SecureStore.deleteItemAsync('idToken');
    await SecureStore.deleteItemAsync('accessToken');
    await SecureStore.deleteItemAsync('tokenTime');
  };

  const applyTokens = (nextTokens) => {
    tokensRef.current = nextTokens;
    tokenIssuedAtRef.current = Date.now();
    refreshFailuresRef.current = 0;
    nextRefreshAttemptAtRef.current = 0;
  };

  const resetNativeSession = async (message = null) => {
    await clearStoredLogin();
    tokensRef.current = null;
    tokenIssuedAtRef.current = 0;
    canGoBackRef.current = false;
    setIsAuthenticated(false);
    setWebBridgeStatus('idle');
    setPageTheme(null);
    setWebError(null);
    setLoginError(message);
    if (message) AccessibilityInfo.announceForAccessibility(message);
    try {
      await GoogleSignin.signOut();
    } catch (e) {
      console.warn('Google sign-out cleanup failed:', e);
    }
  };

  // Hand a fresh access token to the page (C7). The script re-checks location.origin.
  const injectAccessToken = (accessToken) => {
    if (!isAllowedAppOrigin(currentUrlRef.current)) return;
    webviewRef.current?.injectJavaScript(buildTokenUpdateScript(accessToken, APP_ORIGINS));
  };

  // Silent token refresh. 'webRequest' (GOOGLE_TOKEN_REFRESH_REQUEST) retries quickly
  // inside the web's 15 s window; interval refreshes back off between ticks.
  // Only a sign-in-required result ends the session; transient errors keep it.
  const refreshSession = (reason) => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const run = (async () => {
      const maxAttempts = reason === 'webRequest' ? 3 : 1;
      // Drop Android's cached token so the refresh yields a full-lifetime one.
      const staleAccessToken = tokensRef.current?.accessToken;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const fresh = await fetchSilentTokens({ staleAccessToken: attempt === 0 ? staleAccessToken : undefined });
          applyTokens(fresh);
          injectAccessToken(fresh.accessToken);
          return fresh;
        } catch (e) {
          if (isSignInRequiredError(e, statusCodes.SIGN_IN_REQUIRED)) {
            await resetNativeSession('Your Google session ended. Please sign in again.');
            return null;
          }
          console.warn(`Silent Google token refresh failed (${reason}, attempt ${attempt + 1}):`, e);
          if (attempt < maxAttempts - 1) await sleep(backoffDelayMs(attempt, 1000, 4000));
        }
      }
      refreshFailuresRef.current += 1;
      nextRefreshAttemptAtRef.current =
        Date.now() + backoffDelayMs(refreshFailuresRef.current - 1, 30 * 1000, 10 * 60 * 1000);
      return null;
    })();
    refreshInFlightRef.current = run;
    const clearInFlight = () => {
      refreshInFlightRef.current = null;
    };
    run.then(clearInFlight, clearInFlight);
    return run;
  };
  refreshSessionRef.current = refreshSession;

  const handleNativeLogin = async () => {
    if (isNativeLoginInProgress) return;
    setIsNativeLoginInProgress(true);
    setLoginError(null);

    try {
      await GoogleSignin.hasPlayServices();
      const userInfo = await GoogleSignin.signIn();
      if (userInfo?.type && userInfo.type !== 'success') return; // cancelled by the user

      const userTokens = await GoogleSignin.getTokens();
      const idToken = userInfo.data?.idToken || userInfo.idToken || userTokens.idToken;
      const accessToken = userTokens.accessToken;

      if (idToken && accessToken) {
        setWebBridgeStatus('authenticating');
        applyTokens({ idToken, accessToken });
        setIsAuthenticated(true);
      } else {
        throw new Error('Google Sign-In did not return usable tokens.');
      }
    } catch (error) {
      console.error('Google Sign-In Error:', error);
      const message = describeLoginError(error);
      setLoginError(message);
      if (message) AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setIsNativeLoginInProgress(false);
    }
  };

  // On app start: clear legacy app-managed token storage and attempt native silent sign-in.
  // OAuth tokens stay in memory only; the native Google SDK manages its own account session.
  // Offline, it waits for the connection instead of showing the sign-in screen.
  const boot = async () => {
    if (await isOfflineNow()) {
      bootRef.current = 'waiting';
      setOffline(true);
      setIsCheckingLogin(false);
      return;
    }
    const run = ++bootRunRef.current;
    bootRef.current = 'running';
    setIsCheckingLogin(true);
    try {
      await clearStoredLogin();
      await GoogleSignin.hasPlayServices();
      const fresh = await fetchSilentTokens();
      if (run !== bootRunRef.current) return;
      setWebBridgeStatus('authenticating');
      applyTokens(fresh);
      setIsAuthenticated(true);
    } catch {
      if (run !== bootRunRef.current) return;
      await clearStoredLogin();
    }
    bootRef.current = 'done';
    setIsCheckingLogin(false);
  };

  // "Sign in again" while the sign-in check hangs: drop that check and show the sign-in screen.
  const abandonBoot = () => {
    bootRunRef.current += 1;
    bootRef.current = 'done';
    setIsCheckingLogin(false);
    resetNativeSession();
  };

  useEffect(() => {
    boot();
  }, []);

  // Connection changes: show the offline screen when the page can't load, and pick up where
  // we were (sign-in check or page load) as soon as the connection is back.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (isOfflineState(state) || !isOfflineRef.current) return;
      setOffline(false);
      if (bootRef.current === 'waiting') boot();
      else retryWebView();
    });
    return () => unsubscribe();
  }, []);

  // Hide the splash once there is something to see.
  useEffect(() => {
    if (splashDone) return undefined;
    if (!isCheckingLogin && (!isAuthenticated || isOffline || webError || isPageReady)) {
      hideSplash();
      return undefined;
    }
    const timer = setTimeout(hideSplash, SPLASH_MAX_MS);
    return () => clearTimeout(timer);
  }, [splashDone, isCheckingLogin, isAuthenticated, isOffline, webError, isPageReady, hideSplash]);

  // Refresh the Google access token before it expires while the app is open.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const interval = setInterval(() => {
      const issuedAt = tokenIssuedAtRef.current;
      if (!issuedAt || Date.now() - issuedAt < TOKEN_REFRESH_AGE_MS) return;
      if (Date.now() < nextRefreshAttemptAtRef.current) return;
      refreshSessionRef.current?.('interval');
    }, REFRESH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  // Android Back: the page closes its menu, dialog or screen first (BACK_RESULT); otherwise the
  // WebView goes back, and on the dashboard the app closes as usual.
  const goBackNatively = () => {
    clearTimeout(backTimerRef.current);
    backTimerRef.current = null;
    if (canGoBackRef.current && webviewRef.current) webviewRef.current.goBack();
    else BackHandler.exitApp();
  };

  useEffect(() => {
    if (Platform.OS !== 'android' || !isAuthenticated) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!webviewRef.current || isOffline || webError || !isPageReady) return false;
      if (!isAllowedAppOrigin(currentUrlRef.current)) {
        if (!canGoBackRef.current) return false;
        webviewRef.current.goBack();
        return true;
      }
      if (backTimerRef.current) return true; // still waiting for the page's answer
      webviewRef.current.injectJavaScript(buildBackScript(APP_ORIGINS));
      backTimerRef.current = setTimeout(goBackNatively, BACK_RESULT_TIMEOUT_MS);
      return true;
    });
    return () => sub.remove();
  }, [isAuthenticated, isOffline, webError, isPageReady]);

  // Camera (Android): the WebView silently ignores a camera input without the CAMERA permission,
  // so the page asks the app first (REQUEST_CAMERA). The page learns the current state here.
  const tellPageCameraState = async ({ reopen = false } = {}) => {
    if (Platform.OS !== 'android') return;
    const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA).catch(() => false);
    webviewRef.current?.injectJavaScript(buildCameraStateScript(granted, { reopen }, APP_ORIGINS));
  };

  const requestCamera = async () => {
    let result;
    try {
      result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
    } catch (e) {
      console.warn('Camera permission request failed:', e);
      return;
    }
    if (result === PermissionsAndroid.RESULTS.GRANTED) {
      await tellPageCameraState({ reopen: true });
    } else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
      Alert.alert(
        'Camera is turned off',
        'To photograph your pages, allow Camera for AI Planner in Settings. You can still add photos from your gallery.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => {}) },
        ],
      );
    }
  };

  useEffect(() => {
    if (isPageReady) tellPageCameraState();
  }, [isPageReady]);

  // Coming back from Settings may have changed the permission.
  useEffect(() => {
    if (!isPageReady) return undefined;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tellPageCameraState();
    });
    return () => sub.remove();
  }, [isPageReady]);

  // "Download your data": the page hands the file over (SAVE_FILE); save it and open the share sheet.
  const saveFile = async (payload) => {
    const text = payload?.text;
    if (typeof text !== 'string' || text.length > MAX_SAVE_FILE_CHARS) return;
    try {
      const file = new File(Paths.cache, safeFileName(payload.fileName));
      file.create({ overwrite: true });
      await file.write(text);
      await Sharing.shareAsync(file.uri, {
        mimeType: payload.mimeType === 'application/json' ? 'application/json' : 'text/plain',
        dialogTitle: 'Save your AI Planner data',
        UTI: 'public.json',
      });
    } catch (e) {
      console.warn('Saving the file failed:', e);
      Alert.alert('Couldn’t save the file', 'Please try again.');
    }
  };

  // Messages from the WebView. Only the app's own pages may send them.
  const handleMessage = async (event) => {
    const data = event.nativeEvent.data;
    let parsedMessage = null;

    try {
      parsedMessage = JSON.parse(data);
    } catch {
      // Older web messages are plain strings.
    }

    if (!isAllowedAppOrigin(event.nativeEvent.url || currentUrlRef.current)) return;
    const messageType = parsedMessage?.type || data;
    const payload = parsedMessage?.payload;

    if (messageType === 'GOOGLE_TOKEN_REFRESH_REQUEST') {
      refreshSessionRef.current?.('webRequest');
    } else if (messageType === 'SIGNOUT') {
      await resetNativeSession();
    } else if (messageType === 'MOBILE_LOGIN_SUCCESS') {
      setWebBridgeStatus('authenticated');
    } else if (messageType === 'MOBILE_APP_READY') {
      setWebBridgeStatus('ready');
    } else if (messageType === 'MOBILE_LOGIN_ERROR') {
      console.warn('Mobile WebView login bridge failed:', payload || data);
      // A cached page can load offline and then fail to sign in; that is not a bad login.
      if (await isOfflineNow()) {
        setOffline(true);
        return;
      }
      await resetNativeSession("We couldn't connect your Google login to AI Planner. Please sign in again.");
    } else if (messageType === 'THEME') {
      if (typeof payload?.dark === 'boolean') {
        setPageTheme({
          dark: payload.dark,
          background: isOpaqueCssColor(payload.background) ? payload.background.trim() : null,
        });
      }
    } else if (messageType === 'BACK_RESULT') {
      if (!backTimerRef.current) return;
      clearTimeout(backTimerRef.current);
      backTimerRef.current = null;
      if (payload?.handled !== true) goBackNatively();
    } else if (messageType === 'REQUEST_CAMERA') {
      if (Platform.OS === 'android') await requestCamera();
    } else if (messageType === 'SAVE_FILE') {
      await saveFile(payload);
    } else if (messageType === 'HAPTIC_LIGHT') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else if (messageType === 'HAPTIC_HEAVY') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
  };

  // Inject the login bridge once the app shell loads (only / or /index.html on an app origin).
  const handleWebViewLoad = (event) => {
    const url = event?.nativeEvent?.url || currentUrlRef.current;
    if (!isAuthenticated || !tokensRef.current) return;
    if (!isAllowedAppOrigin(url) || !isLoginPath(parseUrl(url).pathname)) return;
    webviewRef.current?.injectJavaScript(buildLoginScript(tokensRef.current, APP_ORIGINS));
  };

  const handleNavigationStateChange = (navState) => {
    canGoBackRef.current = !!navState.canGoBack;
    if (navState.url) currentUrlRef.current = navState.url;
  };

  const openInBrowser = (url) => {
    WebBrowser.openBrowserAsync(url).catch((e) => console.warn('Opening browser failed:', e));
  };

  const openWithOS = async (url) => {
    try {
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
        return;
      }
    } catch (e) {
      console.warn('canOpenURL failed, trying openURL:', e);
    }
    // canOpenURL returns false for schemes not listed in LSApplicationQueriesSchemes /
    // Android <queries>; openURL may still succeed, so try it directly.
    try {
      await Linking.openURL(url);
    } catch (e) {
      console.warn(`No app can open ${url.split(':')[0]}: links`, e);
    }
  };

  const routeNavigation = (request) => {
    const decision = classifyNavigation(request, APP_ORIGIN);
    if (decision === 'allow') return true;
    if (decision === 'browser') openInBrowser(request.url);
    else if (decision === 'linking') openWithOS(request.url);
    return false;
  };

  const onShouldStartLoadWithRequest = (request) => routeNavigation(request);

  // target="_blank" / window.open
  const handleOpenWindow = (event) => {
    const url = event.nativeEvent.targetUrl;
    const decision = classifyNavigation({ url, isTopFrame: true }, APP_ORIGIN);
    if (decision === 'linking') openWithOS(url);
    else if (decision !== 'block') openInBrowser(url);
  };

  const handleWebError = async (event) => {
    const { description, code } = event.nativeEvent || {};
    console.warn('WebView load error:', code, description);
    if (await isOfflineNow()) {
      setOffline(true);
      return;
    }
    setWebError("Couldn't load AI Planner. Check your connection and try again.");
  };

  const handleHttpError = (event) => {
    const { statusCode, url } = event.nativeEvent || {};
    console.warn('WebView HTTP error:', statusCode, url);
    if (statusCode >= 500 && isAllowedAppOrigin(url)) {
      setWebError('AI Planner is temporarily unavailable. Please try again in a moment.');
    }
  };

  function retryWebView() {
    setWebError(null);
    setWebBridgeStatus((status) => (status === 'idle' ? status : 'authenticating'));
    canGoBackRef.current = false;
    setWebViewKey((k) => k + 1); // remount: a failed first load has nothing to reload
  }

  const retryFromOffline = async () => {
    if (await isOfflineNow()) return;
    setOffline(false);
    if (bootRef.current === 'waiting') boot();
    else retryWebView();
  };

  // Android: the renderer died; the WebView instance can't be reused, so remount it.
  const handleRenderProcessGone = (event) => {
    console.warn('WebView render process gone:', event.nativeEvent?.didCrash);
    canGoBackRef.current = false;
    setWebViewKey((k) => k + 1);
  };

  // iOS: WKWebView content process terminated (memory pressure); reload the page.
  const handleContentProcessDidTerminate = () => {
    console.warn('WebView content process terminated; reloading.');
    webviewRef.current?.reload();
  };

  const openPage = (path) => openInBrowser(`${APP_ORIGIN}${path}`);
  const systemBars = (
    <>
      <StatusBar barStyle={c.dark ? 'light-content' : 'dark-content'} backgroundColor={c.edge} />
      {Platform.OS === 'android' ? <NavigationBar style={c.dark ? 'dark' : 'light'} /> : null}
    </>
  );

  if (isCheckingLogin) {
    // The splash screen covers the first check (for at most SPLASH_MAX_MS); after that, or for a
    // later check (back online), the spinner shows, with a way out if the check hangs.
    return (
      <SafeAreaView style={[styles.fill, { backgroundColor: c.bg }]}>
        {systemBars}
        {splashDone ? <OpeningScreen c={c} onSignInAgain={abandonBoot} /> : null}
      </SafeAreaView>
    );
  }

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={[styles.fill, { backgroundColor: c.bg }]}>
        {systemBars}
        {isOffline ? (
          <OfflineScreen c={c} onRetry={retryFromOffline} />
        ) : (
          <SignInScreen
            c={c}
            busy={isNativeLoginInProgress}
            error={loginError}
            onSignIn={handleNativeLogin}
            onOpenPage={openPage}
            onOpenAdt={() => openInBrowser(ADT_URL)}
          />
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.edge }]}>
      {systemBars}
      <WebView
        key={webViewKey}
        ref={webviewRef}
        source={{ uri: START_URL }}
        style={[styles.fill, { backgroundColor: c.edge }]}
        // Routing is done in onShouldStartLoadWithRequest; a narrow whitelist would send
        // Cashfree frames and UPI links to Linking before our handler runs.
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        cacheEnabled={true}
        incognito={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsBackForwardNavigationGestures={true}
        // Voice notes record in the page; iOS asks once per app, not once per page.
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        allowsInlineMediaPlayback={true}
        bounces={false}
        overScrollMode="never"
        onLoadStart={() => setWebError(null)}
        onLoadEnd={handleWebViewLoad}
        onMessage={handleMessage}
        onNavigationStateChange={handleNavigationStateChange}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onOpenWindow={handleOpenWindow}
        onError={handleWebError}
        onHttpError={handleHttpError}
        renderError={() => <View style={[styles.fill, { backgroundColor: c.bg }]} />}
        onRenderProcessGone={handleRenderProcessGone}
        onContentProcessDidTerminate={handleContentProcessDidTerminate}
      />
      {isOffline ? (
        <OfflineScreen c={c} onRetry={retryFromOffline} />
      ) : webError ? (
        <LoadErrorScreen c={c} message={webError} onRetry={retryWebView} />
      ) : !isPageReady ? (
        <OpeningScreen c={c} onSignInAgain={() => resetNativeSession()} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
