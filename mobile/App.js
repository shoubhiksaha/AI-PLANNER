import { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  StatusBar,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  PermissionsAndroid,
  BackHandler,
  Linking,
  AccessibilityInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
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
  isSignInRequiredError,
  backoffDelayMs,
} from './bridge';

// Base URL of the web app. Override per build with EXPO_PUBLIC_WEB_BASE_URL
// (e.g. the staging origin); anything other than the two app origins falls back to prod.
const WEB_BASE_URL = resolveWebBaseUrl(process.env.EXPO_PUBLIC_WEB_BASE_URL);
const APP_ORIGIN = parseUrl(WEB_BASE_URL).origin;
const START_URL = `${APP_ORIGIN}/`;

// Google access tokens live ~60 min; refresh a little before that.
const TOKEN_REFRESH_AGE_MS = 45 * 60 * 1000;
const REFRESH_CHECK_INTERVAL_MS = 60 * 1000;

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

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingLogin, setIsCheckingLogin] = useState(true);
  const [isNativeLoginInProgress, setIsNativeLoginInProgress] = useState(false);
  const [loginError, setLoginError] = useState(null);
  const [webBridgeStatus, setWebBridgeStatus] = useState('idle');
  const [appTheme, setAppTheme] = useState('light'); // Tracks website's dark/light mode
  const [webError, setWebError] = useState(null);
  const [webViewKey, setWebViewKey] = useState(0);

  const webviewRef = useRef(null);
  const tokensRef = useRef(null);
  const tokenIssuedAtRef = useRef(0);
  const canGoBackRef = useRef(false);
  const currentUrlRef = useRef(START_URL);
  const refreshInFlightRef = useRef(null);
  const refreshFailuresRef = useRef(0);
  const nextRefreshAttemptAtRef = useRef(0);
  const cameraPermissionAskedRef = useRef(false);
  const refreshSessionRef = useRef(null);

  const isDark = appTheme === 'dark';
  const themeBg = isDark ? '#0f172a' : '#ffffff';

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

  // Native Login Function
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
  useEffect(() => {
    async function loadSavedTokens() {
      try {
        await clearStoredLogin();
        await GoogleSignin.hasPlayServices();
        const fresh = await fetchSilentTokens();
        setWebBridgeStatus('authenticating');
        applyTokens(fresh);
        setIsAuthenticated(true);
      } catch {
        await clearStoredLogin();
      }
      setIsCheckingLogin(false);
    }
    loadSavedTokens();
  }, []);

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

  // Android hardware Back navigates WebView history before leaving the app.
  useEffect(() => {
    if (Platform.OS !== 'android' || !isAuthenticated) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current && webviewRef.current) {
        webviewRef.current.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [isAuthenticated]);

  // Android only grants CAMERA at runtime, and the WebView file chooser omits the camera
  // option without it. Ask once after sign-in (not at launch), only if not yet granted.
  useEffect(() => {
    if (Platform.OS !== 'android' || cameraPermissionAskedRef.current) return;
    if (webBridgeStatus !== 'authenticated' && webBridgeStatus !== 'ready') return;
    cameraPermissionAskedRef.current = true;
    (async () => {
      try {
        const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
        if (!granted) {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
            title: 'Camera access',
            message: 'Allow camera access to photograph your notebook pages for syncing.',
            buttonPositive: 'Allow',
            buttonNegative: 'Not now',
          });
        }
      } catch (e) {
        console.warn('Camera permission request failed:', e);
      }
    })();
  }, [webBridgeStatus]);

  // Messages from the WebView (logout, haptics, theme, token refresh requests).
  const handleMessage = async (event) => {
    const data = event.nativeEvent.data;
    let parsedMessage = null;

    try {
      parsedMessage = JSON.parse(data);
    } catch {
      // Existing web messages are plain strings.
    }

    const messageType = parsedMessage?.type || data;

    if (messageType === 'GOOGLE_TOKEN_REFRESH_REQUEST') {
      if (isAllowedAppOrigin(event.nativeEvent.url || currentUrlRef.current)) {
        refreshSessionRef.current?.('webRequest');
      }
    } else if (messageType === 'SIGNOUT') {
      await resetNativeSession();
    } else if (messageType === 'MOBILE_LOGIN_SUCCESS') {
      setWebBridgeStatus('authenticated');
    } else if (messageType === 'MOBILE_APP_READY') {
      setWebBridgeStatus('ready');
    } else if (messageType === 'MOBILE_LOGIN_ERROR') {
      console.warn('Mobile WebView login bridge failed:', parsedMessage?.payload || data);
      await resetNativeSession("We couldn't connect your Google login to AI Planner. Please sign in again.");
    } else if (messageType === 'HAPTIC_LIGHT') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else if (messageType === 'HAPTIC_HEAVY') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } else if (messageType === 'THEME_DARK') {
      setAppTheme('dark');
    } else if (messageType === 'THEME_LIGHT') {
      setAppTheme('light');
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

  const handleWebError = (event) => {
    const { description, code } = event.nativeEvent || {};
    console.warn('WebView load error:', code, description);
    setWebError("Couldn't load AI Planner. Check your connection and try again.");
  };

  const handleHttpError = (event) => {
    const { statusCode, url } = event.nativeEvent || {};
    console.warn('WebView HTTP error:', statusCode, url);
    if (statusCode >= 500 && isAllowedAppOrigin(url)) {
      setWebError('AI Planner is temporarily unavailable. Please try again in a moment.');
    }
  };

  const retryWebView = () => {
    setWebError(null);
    canGoBackRef.current = false;
    setWebViewKey((k) => k + 1); // remount: a failed first load has nothing to reload
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

  if (isCheckingLogin) {
    return (
      <SafeAreaView style={styles.authContainer}>
        <ActivityIndicator size="large" color="#007AFF" accessibilityLabel="Checking sign-in" />
      </SafeAreaView>
    );
  }

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={styles.authContainer}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.authContent}>
          <Text style={styles.title} accessibilityRole="header">AI Planner</Text>
          <Text style={styles.subtitle}>Secure Native Login</Text>

          <TouchableOpacity
            style={[styles.loginBtn, isNativeLoginInProgress && styles.loginBtnDisabled]}
            onPress={handleNativeLogin}
            disabled={isNativeLoginInProgress}
            accessibilityRole="button"
            accessibilityLabel="Sign in with Google"
            accessibilityState={{ disabled: isNativeLoginInProgress, busy: isNativeLoginInProgress }}
          >
            {isNativeLoginInProgress ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.loginBtnText}>Sign in with Google</Text>
            )}
          </TouchableOpacity>

          {loginError ? (
            <Text style={styles.loginError} accessibilityRole="alert" accessibilityLiveRegion="polite">
              {loginError}
            </Text>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: themeBg }]}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <WebView
        key={webViewKey}
        ref={webviewRef}
        source={{ uri: START_URL }}
        style={styles.webview}
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
        renderError={() => <View style={[styles.webview, { backgroundColor: themeBg }]} />}
        onRenderProcessGone={handleRenderProcessGone}
        onContentProcessDidTerminate={handleContentProcessDidTerminate}
      />
      {webError ? (
        <View style={[styles.overlay, { backgroundColor: themeBg }]}>
          <Text
            style={[styles.overlayTitle, { color: isDark ? '#ffffff' : '#0f172a' }]}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {webError}
          </Text>
          <TouchableOpacity
            style={[styles.overlayBtn, styles.retryBtn]}
            onPress={retryWebView}
            accessibilityRole="button"
            accessibilityLabel="Retry loading AI Planner"
          >
            <Text style={styles.overlayBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : webBridgeStatus !== 'authenticated' && webBridgeStatus !== 'ready' ? (
        <View style={[styles.overlay, { backgroundColor: themeBg }]}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text
            style={[styles.overlayTitle, { color: isDark ? '#ffffff' : '#0f172a' }]}
            accessibilityLiveRegion="polite"
          >
            Authenticating secure session
          </Text>
          <Text style={[styles.overlaySubtitle, { color: isDark ? '#cbd5e1' : '#64748b' }]}>
            Connecting your native Google login to AI Planner.
          </Text>
          <TouchableOpacity
            style={[styles.overlayBtn, styles.resetBtn]}
            onPress={() => resetNativeSession()}
            accessibilityRole="button"
            accessibilityLabel="Refresh login"
            accessibilityHint="Signs out so you can sign in with Google again"
          >
            <Text style={styles.overlayBtnText}>Refresh Login</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  webview: {
    flex: 1,
  },
  authContainer: {
    flex: 1,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  authContent: {
    width: '80%',
    alignItems: 'center',
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#000000',
  },
  subtitle: {
    fontSize: 16,
    color: '#666666',
    marginBottom: 48,
  },
  loginBtn: {
    backgroundColor: '#007AFF',
    minHeight: 48,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 8,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginBtnDisabled: {
    backgroundColor: '#A0C8FF',
  },
  loginBtnText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
  },
  loginError: {
    marginTop: 16,
    fontSize: 14,
    lineHeight: 20,
    color: '#b91c1c',
    textAlign: 'center',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  overlayTitle: {
    marginTop: 18,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  overlaySubtitle: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  overlayBtn: {
    marginTop: 24,
    minHeight: 44,
    minWidth: 44,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetBtn: {
    backgroundColor: '#ef4444',
  },
  retryBtn: {
    backgroundColor: '#007AFF',
  },
  overlayBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
