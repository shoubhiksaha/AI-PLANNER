# Audit — AI Planner logo

Evidence paths are relative to `brand/logo/`. Blind-test images were anonymised (`proofs/blind/*/key.txt` maps letters to concepts).

| Test | c0 control (page + tick) | c1/c1a loop to tick (recommended) | c2 loop on line | c3 settling lines | c4 P that ticks | c5 page + loop tick |
|---|---|---|---|---|---|---|
| 1 Fluency — blind test | ✅ round 1: "Notepad with checkmark", productivity software | ✅ round 1 "Handwritten checkmark with loop"; round 2 "Handwritten check mark with loop, signature-like"; **final 3/3 pass** (see below) | ❌ "Loop above horizontal bar", hardware/jewellery | ❌ "Three wavy horizontal lines", heating/water | ❌ "Stylized P with diagonal slash", design company | ✅ round 2 "Check mark inside a checkbox", forms/compliance software (generic) |
| 2 Gestalt unity — blur row | ✅ one unit (`proofs/round1/proof-c0-control.png`) | ✅ one continuous stroke survives 4 px blur (`proofs/round1/proof-c1-loop-to-tick.png`, `proofs/final/proof-app-icon.png`) | ✅ | ⚠️ three parts stay three parts | ✅ | ✅ (`proofs/round3/proof-c5-lockup.png`) |
| 3 Shape signals match personality | ⚠️ rounded, generic | ✅ one curve (hand) + squared corner and flat end (digital): approachable and precise | ✅ | ⚠️ soft, reads as water | ⚠️ letter-led | ⚠️ container dominates |
| 4 Colour–form congruence — mono row | ✅ | ✅ structure holds in one colour (`proofs/final/small-1.png` mono row) | ✅ | ✅ | ✅ | ✅ |
| 5 Typography fits tone | — | ✅ Space Grotesk 700, the ADT family display face; geometric with a human `a` | — | — | — | ✅ same |
| 6 Distinctive — lineup | ❌ notepad + tick sits with Google Tasks / Microsoft To Do / Any.do | ✅ only mark with a loop and no container; shares "tick" meaning with 4 of 9 competitors but not their silhouette (`proofs/round1/lineup.png`). Aqua on deep black is unused by every competitor seen. Not seen: Moleskine Smart Writing, Evernote, TickTick, Structured | ✅ | ✅ | ⚠️ close to the ₽ rouble sign | ❌ checkbox silhouette is the category default |
| 7 Timeless core, future-proof vs brief | ⚠️ draws "a planner page" (today's product) | ✅ shows the transformation (hand → done), not a destination or device; no Latin letter | ✅ | ✅ | ⚠️ tied to the letter P | ⚠️ draws a page |
| measure.py — thinnest ink / smallest counter | 7.5 % / 12.6 % | final mark 8.5 % / 4.5 %; app icon 8.2 % / 4.3 %; **favicon 8.2 % / 7.4 % (borderline vs 8 %)**; lockup 9.5 % / 4.8 % (`proofs/final`) | 11.5 % / 10.6 % | 8.1 % / none | 7.9 % / 7.9 % | 6.1 % / 7.0 % |
| Craft — overshoot / stroke / gap / spacing | not measured | stroke 1.00 (single band, 52 units = 35.9 in the 512 tile vs ADT 36.5); loop top overshoots the tick end by 6 % of mark height; symbol↔wordmark gap 0.62 × cap height; symbol centred on cap centre (heavy mark); coordinates ≤ 1 decimal | not measured | not measured | not measured | not measured |
| S / M / A / R / T | S ✅ M ⚠️ A ✅ R ✅ T ⚠️ | S ✅ M ✅ A ✅ R ✅ (favicon variant) T ✅ | S ✅ M ⚠️ A ❌ R ✅ T ✅ | S ✅ M ❌ A ❌ R ✅ T ✅ | S ✅ M ⚠️ A ❌ R ✅ T ⚠️ | S ✅ M ⚠️ A ✅ R ✅ T ⚠️ |

## Blind test — verbatim answers

**Round 1** (32 px, one colour): a = c0, b = c1, c = c2, d = c3, e = c4
- blind-a: (1) Notepad with checkmark; (2) a wall calendar page, a paper receipt with a tick; (3) productivity or task-management software.
- blind-b: (1) Handwritten checkmark with loop; (2) a cursive letter "y" or "v", a pen-drawn swoosh; (3) signature or e-signature service.
- blind-c: (1) Loop above horizontal bar; (2) a hair clip or bobby pin, a lowercase "ℓ" or hook; (3) hardware or jewelry supplier.
- blind-d: (1) Three wavy horizontal lines; (2) a heat or steam symbol, a water-surface icon; (3) heating or water services.
- blind-e: (1) Stylized P with diagonal slash; (2) a play arrow with a bar, a pen nib or flag; (3) design or software company.

**Round 2**: f = c1a, g = c1b (tick on a ruled line), h = c5
- blind-f: Handwritten check mark with loop, signature-like. (1) Signature-like handwritten check mark; (2) a tick-mark sketch or a loopy letter "L" or "R"; (3) legal or sign-off services.
- blind-g: Handwritten check mark over a horizontal line. (1) Signature line with a check mark; (2) a checked box with the box cut off, or a "sign here" underline; (3) legal or signing services.
- blind-h: Handwritten check mark inside a rectangle. (1) Check mark inside a checkbox; (2) a signed form field or a stamped approval seal; (3) forms or compliance software.

**Final, 3 runs on the exact `final/` files** (p = `logo-mark.svg` sha f2be3150, q = `app-icon.svg` sha e6778c7b, r = `favicon.svg` sha 94de426d)
- Run 1 — p: (1) Handwritten signature or checkmark; (2) a cursive letter with a loop and tail; a pen-drawn bird or swoosh; (3) legal or notary services. · q: (1) App icon with a signature; (2) a letter R with a tick; a cursive script symbol; (3) productivity or signing app. · r: (1) App icon with check mark; (2) a letter Q with a tick; a map pin with a checkmark; (3) task or to-do software.
- Run 2 — p: (1) Black scribbled loop with a checkmark; (2) a handwritten signature; a lowercase letter "l" with a tick; (3) legal or document-signing service. · q: (1) White scribbled check on black tile; (2) inverted signature stamp; dark-mode app icon; (3) e-signature app or brand. · r: (1) Bold white loop with checkmark, black tile; (2) a stylized letter "Q" with a tick; a verified-badge icon; (3) verification or e-signature company.
- Run 3 — p: (1) Handwritten squiggle with a checkmark; (2) a handwritten signature; a stylized letter Q with a tick; (3) e-signature or legal services. · q: (1) White script-check app icon; (2) a reversed-out signature; a verified-badge logo; (3) digital signature software. · r: (1) Bold white letter-check icon; (2) a heavy letter P with a checkmark; a verified-status badge; (3) mobile app brand identity.

Scoring: every final answer names the intended subject (a handwritten tick) in (1) → **pass 3/3 runs for all three files**. The recurring second reading is **"signature / e-signature"**; the control's category read ("productivity software") was more direct.

## Decision

**c1a "Loop to tick"**. It is the only concept that passed the stranger test *and* separates from the lineup: no container, a silhouette no competitor has, and a colour nobody in the category uses. It says the product's promise in one gesture: what you write by hand comes out done.

What it gives up: strangers place the bare mark in **e-signature / legal** before **planning**. The control (a notepad with a tick) was read as productivity software straight away, but it looks like Google Tasks, Microsoft To Do and Any.do. The trade-off is accepted because the mark always appears with the name "AI Planner" (home-screen label, header lockup, store listing, OAuth screen), which supplies the category. The human test kit (`human-test/`) checks this with real people.
