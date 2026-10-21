# AI Planner logo

## 1. Recommendation

**"Loop to tick"** (`final/logo-primary.svg`). It's one continuous stroke that starts as a handwritten loop and finishes as a crisp tick with a squared corner and a flat end. It sits in Signal Aqua on ADT's deep-black tile, next to "AI Planner" set in Space Grotesk 700.

It says what the product does in one gesture: **what you write by hand comes out done**. In the competitor lineup it is the only mark with no container and no plain tick, and nobody else in the category uses aqua on black.

It gave up one thing. Shown alone, strangers often read the loop as a **signature** and guessed "e-signature or legal service", whereas the plain control (a notepad with a tick) was read as productivity software straight away. So always show the mark with the name "AI Planner".

## 2. What it means

- Meaning a customer can repeat: **"Your handwriting, done."**
- What strangers said (final files, 32 px, one colour, no context, three separate runs):
  - bare mark: *"Handwritten signature or checkmark"*, *"Black scribbled loop with a checkmark"*, *"Handwritten squiggle with a checkmark"*
  - app icon: *"App icon with a signature… productivity or signing app"*, *"White scribbled check on black tile"*, *"White script-check app icon"*
  - favicon: *"App icon with check mark… task or to-do software"*, *"Bold white loop with checkmark"*, *"Bold white letter-check icon"*

  Every run named the handwritten tick first. Full answers are in `audit.md`.

## 3. Design decisions

| Decision | Brief entry | Principle |
|---|---|---|
| Combination mark; symbol also works alone as the app icon | Generic name; the home screen and browser tab are the most frequent contact | §9 Distinctiveness, §11 Resizable |
| The symbol shows the transformation (hand → done), not a calendar, notebook or destination | More destinations and modes are coming (Drive, Notion, voice, health) | §12 Timeless and future-proof |
| One curve (the loop), then a squared corner and a flat end | ADT shape rule "mostly geometric and squared, one deliberate curve"; personality: personal and precise | §6 Shape psychology |
| Tick kept, but subverted with a pen loop | 4 of 9 competitors use a plain tick; the owner's earlier explorations used a tick | §9, ideation route 6 |
| Band 52/512 in the master = 35.9 in the app tile, against ADT's 36.5 | ADT family consistency | §4 Gestalt (similarity across the family) |
| Aqua on deep black; deep black on light | ADT palette; blue is over-used in the category | §7 Colour, §9 |
| Space Grotesk 700, outlined, −1 % tracking | ADT display face | §8 Typography |
| Simplified favicon: no lead-in tail, heavier band, bevelled corner, tile radius 96 | The tail's wedge closes up at 16 px | §11, §2 Simplicity |

## 4. Future plans

- **New destinations and modes** (Drive, Notion, voice notes, health sync): the mark doesn't depict any of them, so nothing goes out of date.
- **Other languages and scripts:** no Latin letter in the symbol; it sits next to Bengali or Hindi text.
- **The ADT family:** same band weight, tile shape and palette as ADT's mark, and the same "analog in, digital out" idea, without reusing ADT's waveform. AI Planner keeps its own name and mark, with the smaller "An offering by ADT" endorsement (ADT LOGO.md §8).
- **Android adaptive icons and notifications:** the bare symbol (`final/logo-mark.svg`) works as a one-colour glyph.

## 5. Your idea

- Your earlier `/logo` explorations used a **tick in a tile** and a **P**.
- The tick idea is the recommendation, subverted with the loop so its silhouette differs from Google Tasks, Microsoft To Do and Any.do.
- The P was built as c4. Strangers read it as a stylised P with a slash, and next to a tick it resembles the ₽ (rouble) sign, so it's not recommended.
- The glow and gradient treatments of the old explorations aren't used, because ADT's rules forbid glows, gradients and shadows.
- You decide.

## 6. Palette

| Role | HEX | RGB | CMYK (approximate) |
|---|---|---|---|
| Signal Aqua | `#01F9C9` | 1, 249, 201 | ≈ 65 0 35 0. Out of CMYK gamut; it prints duller, so match from a physical swatch book at print. |
| Deep Black | `#0A0A0A` | 10, 10, 10 | ≈ 60 40 40 100 (rich black) |
| White | `#FFFFFF` | 255, 255, 255 | 0 0 0 0 |

Aqua on deep black is about 14.5 : 1. **Aqua on white is 1.4 : 1, so never use it.** On light backgrounds the symbol is deep black, or sits inside the black tile.

## 7. Typeface

**Space Grotesk 700** (Florian Karsten), SIL Open Font License 1.1, free for logos. File: `fonts/SpaceGrotesk-700.ttf`, from ADT's kit. All delivered lettering is outlined to paths.

## 8. Usage

| File | Use |
|---|---|
| `final/logo-primary.svg` | Main logo on light backgrounds: black app tile with the aqua mark, plus the black wordmark |
| `final/logo-primary-reversed.svg` | Dark backgrounds: aqua mark, white wordmark |
| `final/app-icon.svg` | App icon, PWA icon, store listing, OAuth consent screen, avatars |
| `final/favicon.svg` | Browser tab, 16–32 px |
| `final/logo-mark.svg` / `final/logo-mark-aqua.svg` | The symbol alone (deep black for light backgrounds; aqua for dark only) |
| `final/logo-mono-black.svg` / `final/logo-mono-white.svg` | One-colour print, stamps, the printable planner template |

- **Clear space:** at least **x** on every side, where x = the height of the loop (about 0.6 × the wordmark cap height).
- **Minimum sizes** (from `measure.py` and the small-size sheets):
  - full lockup: 120 px wide (30 mm)
  - app icon: 24 px
  - favicon: 16 px (borderline: smallest feature 7.4 % against an 8 % target, but the loop and tick stay readable on the 16 px sheet)
  - bare symbol: 24 px
- **Don't:**
  - put aqua on white or light backgrounds
  - stretch, rotate or re-space the parts
  - put the symbol in a circle or box other than the app tile
  - add gradients, glows or shadows
  - set the name in another font
  - use the bare symbol where the name "AI Planner" isn't nearby, because alone it reads as a signature
- **Approved backgrounds:** white and light neutrals (primary lockup); deep black and dark surfaces (reversed); Signal Aqua as a large flat field with the one-colour black logo on top.

## 9. Next steps

1. Run `human-test/human-test.md` (10 minutes, 5 people from the target audience: people who keep a paper planner or journal). The key question is whether "planner" or "signature" comes first.
2. Trademark search (links below).
3. A human designer's craft pass on the loop's curvature, which was hand-authored in SVG.

## 10. Trademark — not searched

- UK: https://trademarks.ipo.gov.uk/ipo-tmtext?searchterm=AI%20Planner
- EU: https://euipo.europa.eu/eSearch/#basic/1+1+1+1/100+100+100+100/AI%20Planner
- US: https://tmsearch.uspto.gov/search/search-information (enter "AI Planner")
- India: https://tmrsearch.ipindia.gov.in/tmrpublicsearch/
- WIPO: https://branddb.wipo.int/en/quicksearch?by=brandName&v=AI%20Planner

"AI Planner" is a descriptive name, so a word-mark registration may be hard. The symbol is the more protectable asset.

## 11. Not verified

- **Human perception:** only model strangers were used; the human kit hasn't been run.
- **Competitor marks not seen:** Moleskine Smart Writing, Evernote, TickTick, Structured.
- **Print reproduction:** no physical proof of the aqua.
- **Blind-test file paths:** the images were copied to a neutral temporary folder for the stranger, so the project name couldn't leak through the path.
