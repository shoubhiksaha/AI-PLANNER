import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StyleSheet, StatusBar, View, Text, TouchableOpacity, ActivityIndicator, Platform, PermissionsAndroid } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

// Handle notifications when the app is open
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Tells Expo to listen for the redirect back from the secure browser
WebBrowser.maybeCompleteAuthSession();

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

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [tokens, setTokens] = useState(null);
  const [isCheckingLogin, setIsCheckingLogin] = useState(true);
  const [isNativeLoginInProgress, setIsNativeLoginInProgress] = useState(false);
  const [webBridgeStatus, setWebBridgeStatus] = useState('idle');
  const [appTheme, setAppTheme] = useState('light'); // Tracks website's dark/light mode
  const [expoPushToken, setExpoPushToken] = useState(null);
  const webviewRef = useRef(null);

  // Memoize the base URL so state changes (like theme) don't trigger a full web reload
  const nocacheUrl = useMemo(() => 'https://planner.analogdigital.tech/?nocache=' + Date.now(), []);

  const clearStoredLogin = async () => {
    await SecureStore.deleteItemAsync('idToken');
    await SecureStore.deleteItemAsync('accessToken');
    await SecureStore.deleteItemAsync('tokenTime');
  };

  const resetNativeSession = async () => {
    await clearStoredLogin();
    setTokens(null);
    setIsAuthenticated(false);
    setWebBridgeStatus('idle');
    try {
      await GoogleSignin.signOut();
    } catch (e) {
      console.warn('Google sign-out cleanup failed:', e);
    }
  };

  // Native Login Function
  const handleNativeLogin = async () => {
    if (isNativeLoginInProgress) return;
    setIsNativeLoginInProgress(true);

    try {
      await GoogleSignin.hasPlayServices();
      const userInfo = await GoogleSignin.signIn();
      if (userInfo?.type && userInfo.type !== 'success') return;

      const userTokens = await GoogleSignin.getTokens();
      
      const idToken = userInfo.data?.idToken || userInfo.idToken || userTokens.idToken;
      const accessToken = userTokens.accessToken;

      if (idToken && accessToken) {
        setWebBridgeStatus('authenticating');
        setTokens({ idToken, accessToken });
        setIsAuthenticated(true);
        await SecureStore.setItemAsync('idToken', idToken);
        await SecureStore.setItemAsync('accessToken', accessToken);
        await SecureStore.setItemAsync('tokenTime', Date.now().toString());
      } else {
        throw new Error('Google Sign-In did not return usable tokens.');
      }
    } catch (error) {
      console.error('Google Sign-In Error:', error);
    } finally {
      setIsNativeLoginInProgress(false);
    }
  };

  // Check for saved login on app start
  useEffect(() => {
    // 1. Request Push Notification Permissions silently in the background
    async function registerForPushNotificationsAsync() {
      try {
        if (Device.isDevice) {
          const { status: existingStatus } = await Notifications.getPermissionsAsync();
          let finalStatus = existingStatus;
          if (existingStatus !== 'granted') {
            const { status } = await Notifications.requestPermissionsAsync();
            finalStatus = status;
          }
          if (finalStatus === 'granted') {
            const token = (await Notifications.getExpoPushTokenAsync({
              projectId: 'ai-planner-project-467800',
            })).data;
            setExpoPushToken(token);
          }
        }
      } catch (e) {
        console.warn('Push notification registration failed:', e);
      }
    }
    registerForPushNotificationsAsync();

    // 1b. Request Camera Permission so Android WebView file chooser shows the camera option
    async function requestCameraPermission() {
      try {
        if (Platform.OS === 'android') {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
        }
      } catch (e) {
        console.warn('Camera permission request failed:', e);
      }
    }
    requestCameraPermission();

    // 2. Load Saved Credentials
    async function loadSavedTokens() {
      try {
        const savedIdToken = await SecureStore.getItemAsync('idToken');
        const savedAccessToken = await SecureStore.getItemAsync('accessToken');
        const savedTime = await SecureStore.getItemAsync('tokenTime');
        
        // Tokens expire in 1 hour. Check if it's older than 50 minutes.
        const isExpired = !savedTime || (Date.now() - parseInt(savedTime)) > 50 * 60 * 1000;

        if (savedIdToken && savedAccessToken && !isExpired) {
          setWebBridgeStatus('authenticating');
          setTokens({ idToken: savedIdToken, accessToken: savedAccessToken });
          setIsAuthenticated(true);
        } else if (savedIdToken && isExpired) {
          // Token is expired, but user was logged in previously.
          // Silently refresh the token so they never get logged out.
          try {
            await GoogleSignin.hasPlayServices();
            const userInfo = await GoogleSignin.signInSilently();
            const userTokens = await GoogleSignin.getTokens();
            
            const idToken = userInfo.data?.idToken || userInfo.idToken || userTokens.idToken;
            const accessToken = userTokens.accessToken;

            if (idToken && accessToken) {
              setWebBridgeStatus('authenticating');
              setTokens({ idToken, accessToken });
              setIsAuthenticated(true);
              await SecureStore.setItemAsync('idToken', idToken);
              await SecureStore.setItemAsync('accessToken', accessToken);
              await SecureStore.setItemAsync('tokenTime', Date.now().toString());
            } else {
              await clearStoredLogin();
            }
          } catch (e) {
            console.warn('Silent login refresh failed on startup:', e);
            await clearStoredLogin();
          }
        }
      } catch (e) {}
      setIsCheckingLogin(false);
    }
    loadSavedTokens();
  }, []);

  // Actively monitor token expiration while app is open and refresh silently
  useEffect(() => {
    if (!isAuthenticated) return;
    const interval = setInterval(async () => {
      const savedTime = await SecureStore.getItemAsync('tokenTime');
      if (savedTime && (Date.now() - parseInt(savedTime)) > 50 * 60 * 1000) {
        // Token expired while using the app. Refresh it silently instead of logging out!
        try {
          const userInfo = await GoogleSignin.signInSilently();
          const userTokens = await GoogleSignin.getTokens();
          const idToken = userInfo.data?.idToken || userInfo.idToken || userTokens.idToken;
          const accessToken = userTokens.accessToken;

          if (idToken && accessToken) {
            setTokens({ idToken, accessToken });
            await SecureStore.setItemAsync('idToken', idToken);
            await SecureStore.setItemAsync('accessToken', accessToken);
            await SecureStore.setItemAsync('tokenTime', Date.now().toString());
            
            // Re-inject the fresh token into the WebView
            webviewRef.current?.injectJavaScript(`
              if (window.__AI_PLANNER_NATIVE_LOGIN_COMPLETE) {
                // Token updated under the hood
              }
              true;
            `);
          } else {
            await resetNativeSession();
          }
        } catch (e) {
          console.warn('Silent login refresh failed during active session:', e);
          await resetNativeSession();
        }
      }
    }, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  // Catch messages from the WebView (like Logging out, Haptics, or Theme changes)
  const handleMessage = async (event) => {
    const data = event.nativeEvent.data;
    let parsedMessage = null;

    try {
      parsedMessage = JSON.parse(data);
    } catch {
      // Existing web messages are plain strings.
    }

    const messageType = parsedMessage?.type || data;
    
    if (messageType === 'SIGNOUT') {
      await resetNativeSession();
    } 
    else if (messageType === 'MOBILE_LOGIN_SUCCESS') {
      setWebBridgeStatus('authenticated');
    }
    else if (messageType === 'MOBILE_APP_READY') {
      setWebBridgeStatus('ready');
    }
    else if (messageType === 'MOBILE_LOGIN_ERROR') {
      console.warn('Mobile WebView login bridge failed:', parsedMessage?.payload || data);
      await resetNativeSession();
    }
    else if (messageType === 'HAPTIC_LIGHT') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    else if (messageType === 'HAPTIC_HEAVY') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
    else if (messageType === 'THEME_DARK') {
      setAppTheme('dark');
    }
    else if (messageType === 'THEME_LIGHT') {
      setAppTheme('light');
    }
  };

  // Inject the token into the PWA once the WebView loads
  const handleWebViewLoad = () => {
    if (isAuthenticated && tokens) {
      // Use JSON.stringify to safely inject strings and prevent XSS or parsing errors
      const safeIdToken = tokens.idToken ? JSON.stringify(tokens.idToken) : 'null';
      const safeAccessToken = JSON.stringify(tokens.accessToken);
      const safePushToken = expoPushToken ? JSON.stringify(expoPushToken) : 'null';

      const injectCode = `
        (function() {
          // Forcefully unregister ALL service workers instantly on load to fix sticky cache bugs
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(function(registrations) {
              registrations.forEach(function(registration) {
                registration.unregister();
              });
            });
          }

          // Retry mechanism: wait for mobileLogin to become available
          var retryCount = 0;
          var maxRetries = 20;

          function postNative(type, payload) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, payload: payload || {} }));
          }

          function failBridge(message) {
            postNative('MOBILE_LOGIN_ERROR', { message: message });
          }

          function reloadWithoutServiceWorker() {
            var nextUrl = new URL(window.location.href);
            if (nextUrl.searchParams.get('mobileBridgeReload') === '1') {
              failBridge('Mobile login bridge was unavailable after a clean reload.');
              return;
            }

            nextUrl.searchParams.set('mobileBridgeReload', '1');
            window.location.replace(nextUrl.toString());
          }
          
          function tryLogin() {
            if (window.__AI_PLANNER_NATIVE_LOGIN_COMPLETE || window.__AI_PLANNER_NATIVE_LOGIN_PENDING) {
              setupUI();
              return;
            }

            if (window.mobileLogin) {
              window.__AI_PLANNER_NATIVE_LOGIN_PENDING = true;
              Promise.resolve(window.mobileLogin(${safeIdToken}, ${safeAccessToken}, ${safePushToken}))
                .then(function() {
                  window.__AI_PLANNER_NATIVE_LOGIN_COMPLETE = true;
                  setupUI();
                })
                .catch(function(error) {
                  window.__AI_PLANNER_NATIVE_LOGIN_PENDING = false;
                  if (!window.__AI_PLANNER_NATIVE_LOGIN_ERROR_POSTED) {
                    failBridge(error && error.message ? error.message : 'Mobile login bridge failed.');
                  }
                });
            } else if (retryCount < maxRetries) {
              retryCount++;
              setTimeout(tryLogin, 500); // Wait 500ms and try again
            } else {
              // After all retries are exhausted, clear service worker cache once.
              reloadWithoutServiceWorker();
            }
          }
          
          function setupUI() {
            if (window.__AI_PLANNER_NATIVE_UI_READY) {
              return;
            }
            window.__AI_PLANNER_NATIVE_UI_READY = true;

            // --- 1. Global native feedback on interactive elements ---
            document.addEventListener('click', function(e) {
              var logoutTarget = e.target.closest('[data-drawer="logout"], #btn-logout');
              if (logoutTarget) {
                window.ReactNativeWebView.postMessage('SIGNOUT');
                return;
              }

              var target = e.target.closest('button, a, input[type="submit"], .dash-btn');
              if (target) {
                var isHeavy = (target.innerText || '').toLowerCase().includes('sync');
                window.ReactNativeWebView.postMessage(isHeavy ? 'HAPTIC_HEAVY' : 'HAPTIC_LIGHT');
              }
            }, true);

            // --- 2. Dynamic Theme Observer (Watches website's Dark Mode) ---
            var observer = new MutationObserver(function() {
              var isDark = document.documentElement.classList.contains('dark-mode') || document.documentElement.classList.contains('oled-mode');
              window.ReactNativeWebView.postMessage(isDark ? 'THEME_DARK' : 'THEME_LIGHT');
            });
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
            
            // Initial Theme check
            if (document.documentElement.classList.contains('dark-mode') || document.documentElement.classList.contains('oled-mode')) {
              window.ReactNativeWebView.postMessage('THEME_DARK');
            }
          }
          
          tryLogin();
        })();
        true;
      `;
      webviewRef.current?.injectJavaScript(injectCode);
    }
  };

  // Intercept external links (like Privacy Policy or PDFs) and open them safely
  const onShouldStartLoadWithRequest = (request) => {
    const { url } = request;
    
    // Parse the URL safely
    let parsedHost = '';
    try { parsedHost = new URL(url).hostname; } catch(e) { /* invalid URL */ }

    // Force Privacy Policy and PDF files to open in the native overlay
    if (url.includes('privacy.html') || url.toLowerCase().endsWith('.pdf')) {
      WebBrowser.openBrowserAsync(url);
      return false; 
    }

    // Allow normal navigation within the main app (strict hostname check)
    if (parsedHost === 'planner.analogdigital.tech' || url.startsWith('about:blank')) {
      return true;
    }
    
    // Open any other external links natively
    WebBrowser.openBrowserAsync(url);
    return false; // Stop WebView
  };

  if (isCheckingLogin) {
    return (
      <SafeAreaView style={styles.authContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
      </SafeAreaView>
    );
  }

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={styles.authContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
        <View style={styles.authContent}>
          <Text style={styles.title}>AI Planner</Text>
          <Text style={styles.subtitle}>Secure Native Login</Text>
          
          <TouchableOpacity 
            style={[styles.loginBtn, isNativeLoginInProgress && styles.loginBtnDisabled]}
            onPress={handleNativeLogin}
            disabled={isNativeLoginInProgress}
          >
            {isNativeLoginInProgress ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.loginBtnText}>Sign in with Google</Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: appTheme === 'dark' ? '#0f172a' : '#ffffff' }]}>
      <StatusBar 
        barStyle={appTheme === 'dark' ? "light-content" : "dark-content"} 
        backgroundColor={appTheme === 'dark' ? '#0f172a' : '#ffffff'} 
      />
      <WebView 
        ref={webviewRef}
        source={{ uri: nocacheUrl }}
        style={styles.webview}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        sharedCookiesEnabled={true}
        cacheEnabled={false}
        incognito={false}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        bounces={false}
        overScrollMode="never"
        onLoadEnd={handleWebViewLoad}
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      />
      {webBridgeStatus !== 'authenticated' && webBridgeStatus !== 'ready' && (
        <View style={[styles.bridgeOverlay, { backgroundColor: appTheme === 'dark' ? '#0f172a' : '#ffffff' }]}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={[styles.bridgeTitle, { color: appTheme === 'dark' ? '#ffffff' : '#0f172a' }]}>
            Authenticating secure session
          </Text>
          <Text style={[styles.bridgeSubtitle, { color: appTheme === 'dark' ? '#cbd5e1' : '#64748b' }]}>
            Connecting your native Google login to AI Planner.
          </Text>
          <TouchableOpacity style={styles.bridgeResetBtn} onPress={resetNativeSession}>
            <Text style={styles.bridgeResetText}>Refresh Login</Text>
          </TouchableOpacity>
        </View>
      )}
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
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 8,
    width: '100%',
    alignItems: 'center',
  },
  loginBtnDisabled: {
    backgroundColor: '#A0C8FF',
  },
  loginBtnText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '600',
  },
  bridgeOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  bridgeTitle: {
    marginTop: 18,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  bridgeSubtitle: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  bridgeResetBtn: {
    marginTop: 24,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: '#ef4444',
  },
  bridgeResetText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
