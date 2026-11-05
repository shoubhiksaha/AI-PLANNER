// Native screens shown around the WebView: sign-in, opening, offline and load errors.
// They follow the web app's sign-in page and ADT tokens (theme.js).
import { useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { FONTS } from './theme';

const font = Platform.OS === 'ios' ? FONTS.ios : FONTS.android;

const LOGO = {
  light: require('./assets/brand/logo-primary.png'),
  dark: require('./assets/brand/logo-primary-reversed.png'),
};
const ADT = {
  light: require('./assets/brand/offering-by-adt-light.png'),
  dark: require('./assets/brand/offering-by-adt-dark.png'),
};
const GOOGLE_G = require('./assets/brand/google-g.png');

// The same three steps as the web sign-in page ("How it works").
const STEPS = [
  ['Plan on paper, as usual', 'Any planner, journal or notebook. Our free printable page works best.'],
  ['Take a photo of the page', 'In the morning for your plans, in the evening for what you got done.'],
  ['It lands where it belongs', 'Times go to Google Calendar, to-dos to Google Tasks, spending to Sheets, journal pages to Google Drive or Notion.'],
];

export const POLICY_LINKS = [
  ['Free planner template', '/planner.html'],
  ['Privacy', '/privacy.html'],
  ['Pricing', '/pricing-policy.html'],
  ['Refunds', '/refund-policy.html'],
];

function Lockup({ c }) {
  return (
    <Image
      source={c.dark ? LOGO.dark : LOGO.light}
      style={styles.lockup}
      resizeMode="contain"
      accessibilityRole="header"
      accessibilityLabel="AI Planner, by ADT"
    />
  );
}

function AdtFooter({ c, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.adtFooter}
      accessibilityRole="link"
      accessibilityLabel="An offering by ADT, Analog Digital Technologies. Opens analogdigital.tech"
      hitSlop={8}
    >
      <Image source={c.dark ? ADT.dark : ADT.light} style={styles.adtImage} resizeMode="contain" />
    </Pressable>
  );
}

export function SignInScreen({ c, busy, error, onSignIn, onOpenPage, onOpenAdt }) {
  return (
    <ScrollView
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={styles.signInScroll}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.column}>
        <Lockup c={c} />
        <Text style={[styles.tagline, { color: c.inkMuted }]}>
          Write your day on paper. Take a photo. It’s in your calendar.
        </Text>

        <Pressable
          onPress={onSignIn}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Continue with Google"
          accessibilityState={{ disabled: busy, busy }}
          style={({ pressed }) => [
            styles.googleBtn,
            { borderColor: c.lineStrong, backgroundColor: pressed ? c.surface : c.bg },
          ]}
        >
          {busy ? (
            <ActivityIndicator color={c.ink} accessibilityLabel="Signing in" />
          ) : (
            <>
              <Image source={GOOGLE_G} style={styles.googleG} />
              <Text style={[styles.googleText, { color: c.ink }]}>Continue with Google</Text>
            </>
          )}
        </Pressable>

        {error ? (
          <View style={[styles.notice, { borderColor: c.danger }]}>
            <Text style={[styles.noticeText, { color: c.ink }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
              {error}
            </Text>
          </View>
        ) : null}

        <View style={styles.steps} accessibilityLabel="How it works">
          {STEPS.map(([title, body], i) => (
            <View key={title} style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }]}>
              <View style={[styles.stepNumber, { backgroundColor: c.bg, borderColor: c.line }]}>
                <Text style={[styles.stepNumberText, { color: c.ink }]}>{i + 1}</Text>
              </View>
              <View style={styles.stepText}>
                <Text style={[styles.cardTitle, { color: c.ink }]}>{title}</Text>
                <Text style={[styles.cardBody, { color: c.inkMuted }]}>{body}</Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={[styles.privacy, { color: c.inkMuted }]}>
          Your photos aren’t kept on our servers. AI Planner only gets access to your calendar events,
          your tasks and the files it creates in your Drive.
        </Text>

        <View style={[styles.links, { borderTopColor: c.line }]} accessibilityLabel="Policies and resources">
          {POLICY_LINKS.map(([label, path]) => (
            <Pressable
              key={path}
              onPress={() => onOpenPage(path)}
              accessibilityRole="link"
              style={styles.link}
            >
              <Text style={[styles.linkText, { color: c.inkMuted }]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        <AdtFooter c={c} onPress={onOpenAdt} />
      </View>
    </ScrollView>
  );
}

/** Shown over the WebView while the page signs in; offers a way out only if it takes long. */
export function OpeningScreen({ c, onSignInAgain, slowAfterMs = 12000 }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(timer);
  }, [slowAfterMs]);
  return (
    <View style={[styles.overlay, { backgroundColor: c.bg }]}>
      <Lockup c={c} />
      <ActivityIndicator style={styles.spinner} size="large" color={c.signalInk} />
      <Text style={[styles.overlayTitle, { color: c.ink }]} accessibilityLiveRegion="polite">
        Opening your planner…
      </Text>
      {slow && onSignInAgain ? (
        <Pressable
          onPress={onSignInAgain}
          accessibilityRole="button"
          accessibilityHint="Signs out so you can sign in with Google again"
          style={styles.textBtn}
          hitSlop={8}
        >
          <Text style={[styles.textBtnLabel, { color: c.inkMuted }]}>
            Taking too long? <Text style={[styles.underline, { color: c.ink }]}>Sign in again</Text>
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** No connection. The app retries on its own when the connection comes back. */
export function OfflineScreen({ c, onRetry }) {
  return (
    <View style={[styles.overlay, { backgroundColor: c.bg }]}>
      <Lockup c={c} />
      <Text style={[styles.overlayTitle, styles.spaced, { color: c.ink }]} accessibilityRole="header">
        You’re offline
      </Text>
      <Text style={[styles.overlayBody, { color: c.inkMuted }]} accessibilityLiveRegion="polite">
        Connect to the internet to open AI Planner. It opens on its own when you’re back online.
      </Text>
      <SecondaryButton c={c} label="Try again" onPress={onRetry} />
    </View>
  );
}

/** The page failed to load for another reason (server error, renderer crash). */
export function LoadErrorScreen({ c, message, onRetry }) {
  return (
    <View style={[styles.overlay, { backgroundColor: c.bg }]}>
      <Lockup c={c} />
      <Text
        style={[styles.overlayBody, styles.spaced, { color: c.ink }]}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        {message}
      </Text>
      <SecondaryButton c={c} label="Try again" onPress={onRetry} />
    </View>
  );
}

function SecondaryButton({ c, label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.secondaryBtn,
        { borderColor: c.lineStrong, backgroundColor: pressed ? c.surface : c.bg },
      ]}
    >
      <Text style={[styles.secondaryLabel, { color: c.ink }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  signInScroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 32 },
  column: { width: '100%', maxWidth: 448, alignSelf: 'center', alignItems: 'center' },
  lockup: { width: 220, height: 68 },
  tagline: { marginTop: 24, fontSize: 18, lineHeight: 28, textAlign: 'center' },
  googleBtn: {
    marginTop: 32, minHeight: 52, width: '100%', borderWidth: 1, borderRadius: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16,
  },
  googleG: { width: 20, height: 20, marginRight: 8 },
  googleText: { fontFamily: font.medium, fontSize: 16, lineHeight: 20, letterSpacing: 0.16 },
  notice: { width: '100%', marginTop: 16, borderWidth: 1, borderRadius: 8, padding: 12 },
  noticeText: { fontSize: 14, lineHeight: 20 },
  steps: { width: '100%', marginTop: 40, gap: 12 },
  card: { flexDirection: 'row', borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  stepNumber: {
    width: 36, height: 36, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  stepNumberText: { fontFamily: font.bold, fontSize: 15 },
  stepText: { flex: 1 },
  cardTitle: { fontFamily: font.bold, fontSize: 15, lineHeight: 20 },
  cardBody: { marginTop: 4, fontSize: 13, lineHeight: 18 },
  privacy: { marginTop: 24, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  links: {
    width: '100%', marginTop: 40, paddingTop: 24, borderTopWidth: 1,
    flexDirection: 'row', flexWrap: 'wrap',
  },
  link: { width: '50%', minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  linkText: { fontSize: 14 },
  adtFooter: { marginTop: 24, minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  adtImage: { width: 123, height: 36 },
  overlay: {
    ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28,
  },
  spinner: { marginTop: 40 },
  overlayTitle: { marginTop: 16, fontFamily: font.bold, fontSize: 18, textAlign: 'center' },
  spaced: { marginTop: 40 },
  overlayBody: { marginTop: 8, fontSize: 15, lineHeight: 22, textAlign: 'center', maxWidth: 360 },
  textBtn: { marginTop: 32, minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  textBtnLabel: { fontSize: 14, textAlign: 'center' },
  underline: { textDecorationLine: 'underline', fontFamily: font.medium },
  secondaryBtn: {
    marginTop: 24, minHeight: 44, minWidth: 160, paddingHorizontal: 20, borderWidth: 1, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  secondaryLabel: { fontFamily: font.medium, fontSize: 15, letterSpacing: 0.15 },
});
