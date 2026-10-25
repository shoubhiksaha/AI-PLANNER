# ADT AI Planner — logo

## 1. Recommendation

**"Wave to tick"** (`final/logo-primary.svg`). AI Planner is ADT's showcase app, so its logo is a member of the ADT family, not a standalone brand. ADT's own waveform starts the same way — the same band, the same sine, the same Signal Aqua on Deep Black — and where ADT's wave turns into a square pulse, AI Planner's turns into a **tick**. The lockup is ADT's lockup with the product as the second line: **wave + ADT, then AI PLANNER** underneath (ADT LOGO.md §4, the "ADT Handyman" pattern).

It beat the plain family mark on the stranger test: ADT's unchanged wave read as "electronics or audio", while this one read as "**wave that flows into a check mark … productivity or task software**". It stays quiet on purpose — one stroke, one colour, no extra elements — for people who want their tools to stay out of the way.

What it gives up: alone and small, the wave can still read as a sound wave or a heartbeat (ADT's own mark has the same trade-off). Keep it next to the name.

## 2. What it means

- Meaning a customer can repeat: **"The messy page in, the done list out."** — ADT's "Analog In, Digital Out", applied to a planner.
- What strangers said (final files, 32 px, one colour, three runs each): bare mark *"A wavy line ending in a tick-like stroke"*, *"black wavy stroke with tick"*, *"A wavy line ending in a tick"*; app icon *"a wave ending in an upward tick"*, *"white wavy line rising to a tick-like upward end"*; favicon *"white wave-tick on black tile"*, *"White wave-and-tick on a black rounded square"*. Every answer is in `audit.md`.

## 3. Design decisions

| Decision | Brief entry | Principle |
|---|---|---|
| ADT family mark, not a product brand | Owner: "a showcase frontline app made by ADT" | §10 Appropriateness |
| Band, sine period, colours and lockup identical to ADT; only the digital half changes | ADT LOGO.md §4 sub-brand rule | §4 Gestalt (similarity across the family) |
| The digital half is a tick | The product's outcome: plans that get done | §6 Shape psychology, ideation route 3 |
| Square tip across the stroke, sharp notch between wave and tick | A flat-cut tip and a bevelled notch made strangers see a "w" / zigzag (`audit.md`, Final F1) | §2 Simplicity, §15 fluency |
| Second line "AI PLANNER" in Space Grotesk 500 caps, spanning the lockup | ADT's name-line treatment; one rectangular unit | §5 Hierarchy, §8 Typography |
| App icon and favicon use a heavier, wider wave than ADT's tile | ADT's thin tile placement hid the tick at 32 px (`audit.md`, Final F2) | §11 Resizable |
| One stroke, one colour, nothing decorative | Owner: "to minimise distraction" | §2 Simplicity |

## 4. Future plans

- **More ADT products:** each can take ADT's wave and change only its digital half, exactly as this one does, so the family reads together.
- **New destinations and modes** (Drive, Notion, voice, health): the tick is the outcome, not a destination, so nothing goes out of date.
- **Other languages:** the symbol has no Latin letters.

## 5. Your idea

- **Round 1 — "loop to tick":** this was a standalone AI Planner mark with a small "An offering by ADT" badge, and it's kept in `previous/loop-to-tick/`. You corrected the brief: AI Planner is an ADT showcase product for focused users.
- **This round:** the brief was rebuilt from ADT's own system, so the product carries ADT's name and wave.
- **What carried over:** the tick, which was the round-1 hook and also the idea in your earlier explorations in `/logo`, now lives in the digital half of the wave.

## 6. Palette

| Role | HEX | RGB | CMYK (approximate) |
|---|---|---|---|
| Signal Aqua | `#01F9C9` | 1, 249, 201 | ≈ 65 0 35 0 — out of CMYK gamut; match from a physical swatch book at print |
| Deep Black | `#0A0A0A` | 10, 10, 10 | ≈ 60 40 40 100 (rich black) |
| White | `#FFFFFF` | 255, 255, 255 | 0 0 0 0 |

Aqua on deep black ≈ 14.5 : 1; **aqua on white ≈ 1.4 : 1 — never**. On light backgrounds the logo is deep black; aqua appears only on dark or inside the black tile.

## 7. Typeface

- "ADT" is ADT's own outlined letters, copied unchanged from `~/Desktop/ADT Papers/brand/logo/final/logo-primary.svg`.
- "AI PLANNER" is **Space Grotesk 500** (Florian Karsten, SIL OFL 1.1), from `fonts/SpaceGrotesk-500.ttf`, outlined, with +29.5 % tracking so it spans the lockup.
- No file depends on installed fonts.

## 8. Usage

| File | Use |
|---|---|
| `final/logo-primary.svg` | Main logo on white and light backgrounds (deep black) |
| `final/logo-primary-reversed.svg` | Dark backgrounds: aqua wave, white ADT, aqua AI PLANNER (ADT's reversed pattern) |
| `final/app-icon.svg` | App icon, PWA, store listing, Google sign-in screen, avatars |
| `final/app-icon-aqua.svg` | The same icon in black on Signal Aqua (ADT's approved "aqua as a large flat field with the one-colour black logo on top"), for the app's Cheerful style |
| `final/favicon.svg` | Browser tab, 16–32 px |
| `final/logo-mark.svg` / `logo-mark-aqua.svg` | Wave alone (deep black on light; aqua on dark only) |
| `final/logo-mono-black.svg` / `logo-mono-white.svg` | One-colour print, stamps, the printable planner template |

- **Clear space:** at least **x** on every side, where x = the height of the tick's short arm (about 0.55 × the ADT cap height).
- **Minimum sizes:**
  - full lockup: 180 px wide (40 mm), where "AI PLANNER" is about 15 px tall;
  - app icon: 24 px;
  - favicon: 16 px. Its smallest feature measures 5.5 % against the 8 % favicon target, but the tick and wave stay readable on the 16 px sheet.
- **Don't:**
  - put aqua on white;
  - stretch, rotate or re-space the parts;
  - change the sine (it's ADT's);
  - add gradients, glows or shadows;
  - set "AI PLANNER" in another font;
  - use the wave alone where neither "ADT" nor "AI Planner" is nearby.
- **In the app:**
  - sign-in screen: the full lockup;
  - app bar and menu: app tile plus "AI Planner" as a text label;
  - menu footer and content pages: a quiet link to analogdigital.tech.

## 9. Next steps

1. Run `human-test/human-test.md` with 5 people from the audience: focused planner and journal users.
2. Ask ADT's brand owner, which is you, to confirm that the family rule allows a tick as the digital half.
3. A designer's craft pass on the notch where the wave meets the tick.

## 10. Trademark — not searched

- UK: https://trademarks.ipo.gov.uk/ipo-tmtext?searchterm=AI%20Planner
- EU: https://euipo.europa.eu/eSearch/#basic/1+1+1+1/100+100+100+100/AI%20Planner
- US: https://tmsearch.uspto.gov/search/search-information (enter "AI Planner")
- India: https://tmrsearch.ipindia.gov.in/tmrpublicsearch/
- WIPO: https://branddb.wipo.int/en/quicksearch?by=brandName&v=AI%20Planner

## 11. Not verified

- **Human perception:** only model strangers were used. The human kit in `human-test/` shows the family finalists against ADT's own mark.
- **Competitor marks not seen:** Moleskine Smart Writing, Evernote, TickTick, Structured.
- **Print:** no physical proof of the aqua.
