# Themes

AI Planner has two independent appearance settings, both in the theme menu (the sun/moon button in the app bar):

- **Mode:** Match device, Light or Dark (`theme-init.js`, saved as `localStorage.theme`).
- **Style:** a *theme pack* (`public/themes/packs.js`, saved as `localStorage.style`).

Every style has a light and a dark version. Styles change only how the app looks: the features, the layout, the logo and the "An offering by ADT" footer are the same in every style.

| Style | id | What it looks like |
|---|---|---|
| Minimalist modern (default) | `minimal` | ADT's system: Signal Aqua on Deep Black, Space Grotesk and IBM Plex Sans, line icons. Defined in `public/styles.css`. |
| Cheerful | `cheerful` | The pre-redesign look: Outfit, slate greys, emerald accents, emoji icons, rounder shapes, soft shadows and one rounded panel around the content. `public/themes/cheerful.css`. |

## How it works

1. `themes/packs.js` loads in every page's `<head>`, before `theme-init.js`. It reads the saved style and sets `<html data-style="…" data-icons="emoji|line">` before first paint, so nothing flickers.
2. `styles.css` defines the default tokens (colours, fonts, radii, shadows) on `:root` and `.dark-mode`. Each other pack's stylesheet redefines those tokens under `html[data-style="<id>"]` and `html[data-style="<id>"].dark-mode`, then adds a few component touches. `npm run build:css` inlines every pack into `tailwind.css`. A pack's fonts download only when that pack is in use.
3. A pack with an `emoji` map shows emoji instead of line icons. `packs.js` puts a `<span class="icon-twin" aria-hidden="true">` right after each `<svg class="icon">` and keeps the twins up to date with a MutationObserver. That covers icons that `app.js` renders later and the theme button's changing icon. Controls (`CONTROL_ICONS`, such as the menu, close and chevrons) always stay line icons. With a pack that has no emoji map, the observer does nothing.
4. `app.js` renders one Style button per pack from `PACKS` and calls `ThemePacks.setStyle`, which saves the choice and applies it. A change in one tab reaches other open tabs through the `storage` event.
5. The browser bar colour (`<meta name="theme-color">`) comes from the pack's `themeColor`. In Match device mode it follows the device. A chosen Light or Dark mode (`<html data-theme-mode>`, set by `theme-init.js` and `applyTheme`) uses that mode's colour.

## Adding a theme pack

For example, a "90s Retro" pack with the id `retro`:

1. **Register it** in `public/themes/packs.js`: add `{ id: 'retro', label: '90s Retro', description: '…', swatch: [two colours], themeColor: { light, dark }, emoji: null | { iconName: '…' } }` to `PACKS`.
2. **Style it** in `public/themes/retro.css`:
   - Redefine the tokens under `html[data-style="retro"]` and `html[data-style="retro"].dark-mode`. Copy the full list from the top of `cheerful.css`.
   - Add only the component touches the look needs.
   - Write `url()`s relative to `public/`, because the file is inlined into `public/tailwind.css`.
3. **Import it** at the top of `public/styles.css` (`@import "./themes/retro.css";`), then run `npm run build:css` and commit `public/tailwind.css`.
4. **Fonts:** add a font only if its licence allows bundling it (for example SIL OFL without a Reserved Font Name, or with an unmodified file). Self-host it in `public/fonts/`, because the CSP only allows `font-src 'self'`. Add its licence to `public/third-party-licenses.txt`.
5. **Ship it:** add the pack's font files to `ASSETS_TO_CACHE` in `public/sw-constants.js` so the pack works offline, bump `CACHE_NAME` there, and bump the `?v=` of `tailwind.css` on every page.

The tests check that a pack is wired up completely:
- `public/__tests__/themes.test.js` checks the registry, the stylesheet and its import, that every icon in the sprite has an emoji or is a control, that every page loads the registry first, and that the service worker precaches the pack's fonts.
- `e2e/tests/emulator/quality.spec.js` runs axe on every signed-in view in a pack. Add the new pack to the Cheerful test's loop there.

## Rules for every pack

- **Readable:** every text colour pair meets WCAG AA (4.5:1, or 3:1 for large text and control boundaries) in light and in dark. Check the pairs before writing the tokens, and let the axe test confirm.
- **Calm by default:** Minimalist modern stays the default, and louder packs are opt-in. AI Planner is for people who want fewer distractions.
- **No motion that can't be turned off:** gloss, shimmer and similar effects stay static or respect `prefers-reduced-motion`. The base stylesheet already turns animations off for users who ask.
- **Brand:** the ADT logo, the lockup on the sign-in screen and the endorsement footer don't change between packs.
