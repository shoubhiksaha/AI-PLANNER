# Audit — AI Planner logo (ADT family)

Owner brief, 2026-10-21: AI Planner is ADT's showcase app for productivity-focused users, not a standalone brand. The first round (product-led "loop to tick") is audited in git history and kept in `previous/loop-to-tick/`.

| Test | k0 control (ADT mark unchanged) | k1 wave to tick (recommended) | k2 wave to calm line | k3 wave to step up |
|---|---|---|---|---|
| 1 Fluency — blind test | ⚠️ "Wavy line stepping into a block pulse … Electronics or audio company" | ✅ round F1 "Wave that flows into a check mark … Productivity or task software"; **final: mark 3/3, favicon 2/3, app icon 2/3** (below) | ❌ "Wave that ends in a flat horizontal line … Electronics or cable supplier" | ❌ "Wave that ends in a line with a single step up … Electronics or plumbing supplier" |
| 2 Gestalt unity — blur row | ✅ | ✅ one stroke survives 4 px blur (`proofs/final-family-r2/proof-logo-mark.png`) | ✅ | ✅ |
| 3 Shape signals match personality | ✅ ADT | ✅ one curve (the hand) resolving into a squared tick (done): calm and precise | ⚠️ flatline reads as a cable or a medical trace | ⚠️ reads as a broken ADT mark |
| 4 Colour–form congruence — mono row | ✅ | ✅ (`proofs/final-family-r2/small-1.png`) | ✅ | ✅ |
| 5 Typography fits tone | ✅ ADT letters | ✅ ADT's own outlined letters; second line Space Grotesk 500 caps, tracked like ADT's name line | — | — |
| 6 Distinctive — lineup | — | ✅ only wave-plus-tick in the competitor lineup (`proofs/round1/lineup.png`); colour unused in the category. Not seen: Moleskine Smart Writing, Evernote, TickTick, Structured | — | — |
| 7 Timeless, future-proof vs brief | ✅ | ✅ shows the transformation, not a destination; shares ADT's geometry so future ADT products can sit beside it | ✅ | ✅ |
| measure.py — thinnest ink / smallest counter | 20.5 % / none | mark 11.4 % / none; app icon 12.5 % / 5.5 %; favicon 12.5 % / 5.5 % (below the 8 % favicon target); lockup 3.8 % / 2.5 % (text; judged at the stated minimum size) | 20.5 % / none | 20.5 % / none |
| Craft | — | band 44/512 = ADT's; sine identical to ADT's (two half-circles, centre radius 56); tick corner 90° mitred; tip square to the stroke; tick tip 5 % above ADT's cap height in the lockup (pointed overshoot); line gap 47.4 = ADT's; coordinates ≤ 1 decimal | — | — |
| S / M / A / R / T | S ✅ M ✅ A ⚠️ R ✅ T ✅ | S ✅ M ✅ A ✅ R ✅ T ✅ | S ✅ M ⚠️ A ❌ R ✅ T ✅ | S ✅ M ⚠️ A ❌ R ✅ T ✅ |

## Blind test — verbatim answers (32 px, one colour, no context)

**Round F1** (m = k0, n = k1, o = k2, s = k3)
- blind-m: Wavy line stepping into a block pulse. (1) A squiggle followed by a rectangular step. (2) An electrical signal trace; a stylized wave with a stair step. (3) Electronics or audio company.
- blind-n: Wave that flows into a check mark. (1) A squiggle ending in a tick. (2) A wave with a swoosh or arrow; a sine curve becoming a check. (3) Productivity or task software.
- blind-o: Wave that ends in a flat horizontal line. (1) A tilde with a dash trailing off. (2) A cable or pipe bending into a run; a pen stroke or signature. (3) Electronics or cable supplier.
- blind-s: Wave that ends in a line with a single step up. (1) A squiggle with a raised step. (2) A signal waveform with a pulse edge; a tilde with a flag. (3) Electronics or plumbing supplier.

**Final F1** — tip cut flat, notch bevelled (superseded; kept as history). t = mark, u = app icon, v = favicon
- Run 1: t "A wavy black squiggle, like a hand-drawn tick or wave … stationery, pen or signature-related shop" · u "A white squiggle on a black rounded square; an app icon … streaming or audio-waveform logo … software or mobile app company" · v "A white wave-like stroke on a black rounded tile … a tick mark with a wiggle … tech or wellness app company".
- Run 2: t "A black wavy squiggle line … handwritten signature, or a sound wave … pen or stationery brand" · u "White wave on black tile … sound-wave app icon … software or app company" · v "White wave in black tile … audio waveform icon, or a heartbeat monitor sign … health or audio app".
- Run 3: t "A black wavy squiggle that dips and rises, ending in a point … handwriting or lettering studio" · u "A white wavy line on a black rounded square … audio app or tech startup" · v "A white squiggle with a tick-like end … a checkmark drawn with a wave … task or productivity app".

**Final F2** — square tip, sharp notch. w = mark (sha d6593e7b), x = app icon (thin ADT placement, superseded), y = favicon (sha feb08bdf)
- Run 1: w "A wavy line ending in a tick-like stroke … wellness or fitness app" · x "White wavy line on a black rounded square … music or audio app" · y "Thick white wavy line on a black rounded tile … heart-rate monitor trace or a bold 'w' … health or fitness tech".
- Run 2: w "black wavy stroke with tick … fitness apparel brand" · x "white squiggle in black square … audio or music software" · y "white wave-tick on black tile … health or wellness app".
- Run 3: w "A wavy line ending in a tick, dark stroke on white … a sine wave with a checkmark … stationery or print shop" · x "White squiggle on a black rounded square … consumer app or music software" · y "White wave-and-tick on a black rounded square … media or audio streaming service".

**Final F3** — app icon with the favicon's heavier geometry (z, sha 994aabe2)
- Run 1: "White wavy line on black square; a heartbeat or ECG trace, or a sound waveform; health or audio software company".
- Run 2: "a white squiggly line rising to the right, a wave ending in an upward tick, on black; a stock-price or activity trend line, a stylised '~' / wave-to-check mark; analytics, fintech, or health-tracking app".
- Run 3: "white wavy line rising to a tick-like upward end on black rounded square; an audio waveform or sound-level icon … media, audio or analytics app".

Scoring (subject = a wave that ends in a tick): **mark 3/3 pass**, **favicon 2/3 pass**, **app icon 2/3 pass** on the exact files in `final/`. Recurring second readings: sound wave, heartbeat, a handwritten "w".

## Decision

**k1 "Wave to tick"** in the ADT family. It is the only family variant strangers tied to *productivity* ("Productivity or task software"); ADT's unchanged mark read as electronics or audio, and the other variants as cable or plumbing suppliers. It keeps everything ADT's sub-brand rule fixes (band, sine period, colours, lockup) and changes only the digital half of the wave.

What it gives up: shown alone at small sizes, the sine still invites an audio or heartbeat reading, which is the same trade-off ADT's own mark carries ("strangers often connect a waveform with audio/music"). As with ADT, keep the mark next to the name: the home-screen label, the app bar and the lockup supply "AI Planner".
