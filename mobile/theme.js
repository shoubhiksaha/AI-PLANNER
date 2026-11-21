// ADT design tokens for the native screens (sign-in, loading, offline), copied from
// public/styles.css so they look like the web app's Minimalist modern style.
// No React Native imports here so it can be unit-tested with `node --test`.

export const COLORS = {
  light: {
    bg: '#FFFFFF',
    surface: '#F4F6F5',
    line: '#DCE1DF',
    lineStrong: '#7A8480',
    ink: '#0A0A0A',
    inkMuted: '#4E5653',
    signal: '#01F9C9',
    onSignal: '#0A0A0A',
    signalInk: '#00735C',
    danger: '#B42318',
  },
  dark: {
    bg: '#0A0A0A',
    surface: '#121514',
    line: '#262C2A',
    lineStrong: '#6B7571',
    ink: '#F2F5F4',
    inkMuted: '#A3ADA9',
    signal: '#01F9C9',
    onSignal: '#0A0A0A',
    signalInk: '#01F9C9',
    danger: '#FF7A6B',
  },
};

// Space Grotesk is bundled by the expo-font plugin (app.json). Android names a font by its
// file name, iOS by its PostScript name.
export const FONTS = {
  android: { medium: 'SpaceGrotesk-500', bold: 'SpaceGrotesk-700' },
  ios: { medium: 'SpaceGrotesk-Medium', bold: 'SpaceGrotesk-Bold' },
};

/**
 * Colours for the native screens. Before the page has loaded they follow the device; once the
 * page reports its theme (bridge THEME message), its own background is used so the status bar
 * and edges match the chosen style (Minimalist modern or Cheerful, light or dark).
 */
export function screenColors(deviceScheme, pageTheme) {
  const dark = pageTheme ? pageTheme.dark : deviceScheme === 'dark';
  const palette = dark ? COLORS.dark : COLORS.light;
  return { ...palette, dark, edge: pageTheme?.background || palette.bg };
}
