# QuickDrop redesign audit

Skill: `design-taste-frontend` (tasteskill v2) from `Leonxlnx/taste-skill`. The requested
`redesign-existing-projects` skill no longer exists in that repo; this is its replacement.
QuickDrop is an app screen (worked in, not read), so the skill's **app-screen run**
(`references/app-screens.md`) applies, not the landing-page run.

**Scan**
- `lint.mjs --app`: 5 FAIL (4 gradients, 1 emoji glyph), 27 WARN (shadows, monospace, backdrop blur).
- `inspect.mjs --app` (1440 / 768 / 390): 1 FAIL `button-fx` (shadow on a button), 2 WARN (`SF Mono`
  not loaded on Windows, 34px h1). Screenshots in `.taste-skill/before/`.
- Manual look at Home, Connecting and Session at 402px (iPhone 17 Pro) and 1440px, light and dark,
  with two tabs connected and real transfers in the list.

**Page mapping.** QuickDrop has three screens: Home, Connecting, Session. The requested pages map like this:

| Requested | In QuickDrop |
| --- | --- |
| Landing page | Home (`#home`: receive / send tabs) |
| Room page (desktop + mobile) | Session (`#session`: drop zone, transfer list, composer) |
| Settings drawer | No drawer exists. The only setting is the "تنزيل تلقائي" switch row under the transfer list |
| Security Dashboard | Does not exist. The closest UI is the status pill, the "اتصال مباشر ومشفّر" line in the nav bar and the privacy footnote |

**Fixed constraint.** The visual identity is intentional: iOS-style Liquid Glass, SF Pro (system) type,
dark/light themes. Findings that conflict with it are listed under *Skipped* and not applied.

## Diagnose

| # | Page | File / component | Problem | Fix | Impact |
| --- | --- | --- | --- | --- | --- |
| L1 | Landing | `index.html` `#paneRecv` / `#paneSend`, `.segmented` | At 1440px the whole screen is a 560px column, so two thirds of the window is empty, and on a computer the send form is hidden behind a tab. | At 900px and wider, show Receive and Send side by side and hide the segmented control. Phones keep the tabs. | high |
| L2 | All (tokens) | `style.css` `--shadow`, `.card`, `.hero`, `.qr-tile`, `.mark`, `.credit a` | Resting cards and buttons carry soft drop shadows (inspector FAIL `button-fx` on the LinkedIn button; 20 shadow WARNs). iOS inset-grouped surfaces are flat too: white on grouped grey. | Flat surfaces separated by the existing tone step. Shadows stay only on what floats: the HUD toast, the drop overlay and the switch knob. The QR keeps a 0.5px edge. | high |
| L3 | Landing | `style.css` `.receive::before` | Radial gradient glow behind the QR code (lint FAIL `gradient`). | Remove it. The radar rings already mark the card as "waiting for a device". | medium |
| L4 | Landing | `style.css` `.thumb` | File-type labels (`PDF`, `HEIC`) are set in monospace; mono is for IDs and code only. | Use the text face. The device code and OTP boxes stay mono: they are IDs. | low |
| R1 | Room desktop | `style.css` `.app`, `.session-body`, `.composer-inner` | Same 560px column at 1440px: a short list, then a tall empty band, with the composer stretched across the whole window. | At 900px and wider: two columns. The drop zone and the iPhone notice stay in view on one side; the transfer list and the setting sit on the other. The composer aligns to the same width. | high |
| R2 | Room (all) | `style.css` `.avatar`, `.dial.is-failed .avatar` | Gradient fill on the device avatar (lint FAIL `gradient` ×2). | Flat brand fill; flat grey when the connection fails. | medium |
| R3 | Room (all) | `style.css` `.hero::before` | Radial gradient glow inside the drop zone (lint FAIL `gradient`). | Remove it. | medium |
| R4 | Room (all) | `style.css` `.st-done` | Every finished row prints its state in green ("وصل", "تم الإرسال"), so colour stops meaning anything; the skill keeps colour for rows that need attention. | Finished states in secondary grey. Blue stays for in progress, red for failed, and the green check icon on sent files stays as the one success mark. | medium |
| R5 | Room (all) | `app.js` `STATE_TEXT.sent` | "تم الإرسال ✓" repeats the check glyph that the row's trailing icon already shows (lint FAIL `emoji`). | Text "تم الإرسال"; the icon carries the check. | low |
| M1 | Room mobile | `style.css` `@media (max-width: 420px) .item`, `app.js` `addButton` | On a phone every finished row wraps its buttons (تنزيل / نسخ / فتح) onto a second line, so the list turns into a stack of buttons and each row doubles in height. | Under 420px the row actions become 44px icon buttons on the same line; their label stays as the accessible name. Wider screens keep the labelled capsules. | high |
| S1 | Settings | `index.html` `#autoDl` group | The switch has no explanation of what it does or of what changes on iPhone. | One footnote under the group saying what the switch does. | medium |
| D1 | Security dashboard | — | Not applicable: there is no security screen. The status pill, nav subtitle and privacy footnote already state the connection state and that files never touch a server. | None. | — |

## Skipped — identity conflicts

Flagged by the skill as generic, kept because they are the intended iOS / Liquid Glass identity:

| Flag | Where | Why it stays |
| --- | --- | --- |
| Backdrop blur / glass (`glass` WARN ×3) | `.navbar`, `.composer`, `.drop-overlay` | Liquid Glass bars are the identity. |
| 34px h1 (`app-title-size` WARN) | `.large-title` | The iOS Large Title (34pt) on a top-level screen. |
| Icons in coloured squares | `.row-icon--blue/gray/green` | iOS Settings-style row icons. |
| Soft radii (14–22px) and full pill capsules | cards, groups, `.capsule`, `.pill` | iOS inset-grouped geometry. |
| Brand-blue filled primary instead of near-black | `.btn-primary`, `.send` | The iOS tint colour is the app's accent. |
| System font instead of a dealt typeface; no `draw.mjs` direction | `--font` | SF Pro is fixed by the brand (the skill's `--keep palette,type` case), so no style was dealt. |
| iOS segmented control, switch, HUD toast | `.segmented`, `.switch`, `.hud` | Native iOS controls. |
| `SF Mono` declared but not loaded on Windows (`font-fallback` WARN) | `--mono` | SF Mono is the first choice on Apple devices; other systems fall back to IBM Plex Mono, which loads. |

## Skipped — other reasons

| Flag | Where | Why it stays |
| --- | --- | --- |
| Radar ping rings (decorative motion) | `.radar` | The AirDrop "discovering" signal: the one element this product has, and it marks a live waiting state. It is turned off under Reduce Motion. |
| Generic section noun "العناصر" | `#listTitle` | The wording comes from QuickDrop's design-system copy table, which was applied word for word. |
