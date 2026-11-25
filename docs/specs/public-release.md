# Public release

## Goal

Make Job Notifier something a stranger can install, understand, and trust: clear about what it reads and sends, safe on any site it runs on, and documented and packaged for the channel the user picks.

## Audit findings (basis for this spec)

Checked against the code on `feat/public-release` at d23ffb4.

- **Distribution today is developer-only.** README.md:21 installs via "Load unpacked". DOCS.md:123 says a store release "would need a small backend". No packaging step exists; the repo root mixes runtime files with test/, .github/, .claude/, CLAUDE.md, package.json.
- **Runs on every page.** manifest.json:32 injects `lib/core.js` + `content.js` into `https://*/*` and `http://*/*`. Each page gets a MutationObserver plus `innerText` reads of `<main>`/`<body>` (content.js:28-33, 548-559). On the Chrome Web Store this shows the "read and change all your data on all websites" warning and triggers in-depth review.
- **Other permissions look justified.** `storage` is used. `clipboardWrite` covers the `execCommand('copy')` fallback (popup.js:226). `host_permissions: api.anthropic.com` (manifest.json:11) covers the API call from the service worker (background.js:72).
- **Any page can trigger a paid API call and get your friends' data shown on it.** A page that displays "Application submitted" fires AUTO_ANALYZE (content.js:52-53). The background then analyzes the most recent posting from *any* tab (`lastJob`, background.js:39-40). The call is billed to the user's key, and the results overlay, with friend names and draft messages, is rendered into that page's own DOM (content.js:333-350, 430).
- **The host page can read the overlay.** The overlay is plain DOM in the page (content.js:331-350) and its `<style>` goes into the page `<head>` (content.js:325). Page scripts can read friend names, draft text, and keystrokes in the textareas. Page CSS can also restyle the overlay.
- **The example friend becomes real data.** On first run, background.js:15-21 and options.js:13-16 load `friends.json` ("Alex", alex@example.com). Once a user saves, "Alex" is stored and matched like a real friend. The "friends list is empty" error (background.js:69) can never fire on first run.
- **Raw API errors reach the user.** background.js:74-75 shows whatever the API returns (invalid key, rate limit, overloaded, bad model ID). popup.js:63 prefixes it with "Analysis failed:".
- **Copy says "Copied!" even when it fails.** content.js:482 and :496 swallow clipboard errors and flash success anyway.
- **Auto-detect is on by default** (core.js:11, popup.js:10). The default model is `claude-opus-5-5` (core.js:8), and the model field accepts any free text (options.html:22).
- **Friends are edited as raw JSON** (options.html:43-44).
- **No privacy policy, no LICENSE, no PROGRESS.md.** Version is 1.1.0 in both manifest.json:4 and package.json:3.
- **Secrets.** No key in the working tree. Test fixtures use `sk-ant-test`. `config.js` is gitignored (.gitignore:1), but nothing references it and it doesn't exist. That suggests it held a key in an earlier version. Git history has not been checked (task 1).
- **The UI conflicts with the user's global design rules.** It uses gradients (content.js:175, 213, 244, 301), backdrop blur (content.js:142-143), a purple accent everywhere (#5b5bd6 / #7c3aed, plus a purple "J" icon), 8-18px radii (content.js:152, options.css:16, popup.css:124), emoji/symbol icons (content.js:508, popup.html:22, popup.html:72), and system fonts instead of Fraunces / IBM Plex Sans.
- **Overlay accessibility gaps.** No Escape to close, focus doesn't move into the dialog, and there's no `aria-modal` (content.js:336, 351-352).
- **The CI manifest check assumes `content_scripts` exists** (.github/workflows/test.yml:28). It will throw if Q3 moves to runtime-registered scripts.

## Acceptance criteria

"[Qn]" means the criterion's exact form depends on that open question.

**Secrets and data hygiene**
1. Neither the working tree nor any commit in history contains a real API key or real personal contact data. Evidence: output of `git log --all --full-history -- config.js` and `git log --all -p -S "sk-ant-"` (hits in test fixtures only). If anything real turns up, work stops and it goes to the user before any other task.
2. On a fresh install, no friend exists until the user adds one. The example friend is shown only as help/placeholder text and is never saved or matched. Running an analysis with zero friends shows an empty state with a button to settings. Evidence: unit test plus screenshot.

**Permissions and site access**
3. Every permission and host/match pattern in manifest.json is listed with a one-line justification in the README (and the store listing doc, if [Q1] is the Web Store). Nothing unused remains. [Q3 decides the final set.]
4. [Q3] Site access matches the chosen option. Evidence: a screenshot of Chrome's install/permission prompt and of chrome://extensions "Site access".
5. Opening the popup on a job posting tab that was open before install either reads the page or tells the user to reload it. It does not show a generic "Couldn't read this page."

**Auto-detect safety**
6. [Q4] A confirmation phrase on a page never calls Claude without a user click. The prompt says which posting it will analyze (site and page title). Evidence: manual test on a local HTML page that only says "Application submitted" after a posting was viewed in another tab; network log shows no request to api.anthropic.com before the click.
7. [Q5] Auto-detect's default on a fresh install matches the chosen option, and the setup page states it.
8. Scripts on the host page cannot read friend names, emails, or draft text from the overlay, and cannot restyle it. Evidence: on a test page, `document.body.innerText` and `document.querySelectorAll('*')` from the page's own console do not contain a friend's name while the overlay shows it. The overlay looks the same on a page with aggressive global CSS (e.g. `* { color: red !important; font-size: 30px !important }`).

**Errors and states**
9. API failures show plain-language messages with a next step for: invalid key (401), permission/billing problems (403 / credit balance), rate limit (429), overloaded (529 / 5xx), unknown model (404 / invalid model), and no network. The mapping lives in lib/core.js with a unit test per case. No raw API error string reaches the UI unless the status is unrecognized.
10. Copy (per friend and Copy all, in both popup and overlay) shows a failure message when the clipboard write fails, not "Copied!".
11. The popup's no-API-key state is a setup prompt, not an error (no warning icon, no "failed" wording). Evidence: screenshot.
12. The overlay closes on Escape, moves focus into the dialog on open, returns focus on close, and sets `aria-modal="true"`. Every control is reachable by keyboard with a visible focus style in popup, options, and overlay.

**Setup and settings**
13. [Q6] Friends can be added, edited, excluded, and removed in the format chosen. Invalid input gives a specific message (existing `validateFriends` cases keep passing).
14. [Q8] The default model and the model picker match the chosen option. Every model ID offered is confirmed against Anthropic's current models list (link or note in the handoff log).
15. Before the user saves an API key, the settings page states in plain words: usage is billed to their own Anthropic account, which data is sent to Anthropic (visible job page text up to 8,000 characters; friends' names, skills, interests, level), and what is never sent (friends' contact details, recruiter link, API key to anyone but Anthropic). Evidence: screenshot.

**Privacy, license, versioning**
16. PRIVACY.md exists and covers: what is read (visible text of pages that look like job postings), what is stored locally and where (settings, key, friends in `chrome.storage.local`; recent postings in `chrome.storage.session`, cleared on browser close), what is sent to Anthropic and when, that nothing goes anywhere else (no analytics, no developer server), how to delete data (uninstall or clear), a link to Anthropic's privacy policy, and a contact. It is linked from the README and the settings page, and its URL is in the store listing doc. [Q10 decides hosting and contact.]
17. A LICENSE file exists and package.json `license` matches it. [Q9]
18. manifest.json and package.json have the same version, bumped from 1.1.0, and CI fails if they differ. [Q12]

**Packaging and docs**
19. One documented command produces a zip containing only runtime files: manifest, scripts, html/css, lib/, icons/, any bundled fonts and their licenses, and friends.json only if still used. No test/, .github/, .claude/, docs/, CLAUDE.md, or package.json. Extracting it and loading it unpacked shows no errors on chrome://extensions.
20. README covers install for the chosen channel [Q1] (Load unpacked moves under Development unless Q1 is GitHub-only), getting an API key and what it costs, adding friends, auto and manual use, privacy summary plus a link to PRIVACY.md, the permission justifications (criterion 3), troubleshooting (site not detected, key errors, reload after install), and how to remove data. DOCS.md:123 matches the chosen architecture [Q2], and the DOCS.md storage table matches the code.
21. [Q1 = Web Store] docs/store-listing.md contains: name, summary (132 characters or fewer, matching the manifest description), detailed description, category, single-purpose statement, per-permission justifications, and data-use disclosure answers consistent with PRIVACY.md. Asset files are in the repo: at least 3 screenshots at 1280x800 (overlay results, popup, settings), a 440x280 small promo tile, and the 128px icon. Sizes are checked against the Web Store's current requirements at the time of the work.

**Look**
22. [Q7] Popup, settings page, overlay, icons, and store assets follow the chosen visual direction. If it's the global design rules: no gradients, no blur, no emoji/symbol icons, one non-purple accent, radius 4px or less, minimal shadows, Fraunces headings and IBM Plex Sans body bundled locally (no request to a font CDN), left-aligned layout. Evidence: screenshots of each surface.

**Regression**
23. `npm test` and `npm run check --script-shell=bash` pass. CI is green, including the manifest-file check, which is updated if the manifest shape changes. Existing behaviors keep working: cross-site posting → confirmation, recruiter link, Open next email, Copy all, auto-detect toggle.

**Security** (from the threat check; see the Security section)
24. Page text and friend fields are data, not instructions. The task instructions move to the request's `system` field, which says the job posting and friend fields are untrusted content and any instructions inside them must be ignored. Before page text goes into the prompt, any `<job_posting>`, `</job_posting>`, `<friends>`, or `</friends>` tags inside it are removed. Unit test: page text containing `</job_posting>` plus an instruction line produces a request with exactly one closing `</job_posting>` tag.
25. `parseResponse` treats model output as untrusted. Job fields are coerced to their schema types (string, list of strings, boolean) and length-capped. `score` must be a finite number and is clamped to 0–1. `message` must be a string and is capped. Matches with unknown, duplicate, or non-integer ids are dropped, as today. Unit test: wrong types (skills as a string, score as a string or 7, message as an object) don't throw and produce safe values.
26. Nothing reaches a friend without a click. Each email opens only from a user click on Send or Open next email, and every draft stays editable first. A draft that contains a URL or an email address shows a visible note on its card telling the user to check it before sending (helper in lib/core.js with a unit test). The system prompt tells Claude not to put links or contact details in drafts.
27. `mailtoUrl` takes the recipient only from the stored friend contact and encodes subject and body, so model output or page text can't add recipients or headers. Unit test: a job title and message containing `&cc=`, `?bcc=`, `%0A`, and a newline produce a mailto URL with one `?` and only `subject` and `body` parameters.
28. No HTML injection anywhere. Text from pages (body, title, URL), from Claude, from friends (form and import), and from API errors is rendered with `textContent`/`.value` or `escHtml`, never as raw HTML. It is never used as an `href` or `src`; the only URLs opened are `mailtoUrl` output. Evidence: a friend name, job title, draft, page title, and imported field that each contain an HTML tag show as literal text in the popup, overlay, and settings page, and no extra elements appear in the DOM.
29. The manifest CSP stays `script-src 'self'; object-src 'self'` (no `unsafe-inline`, `unsafe-eval`, or remote sources). Fonts, icons, and scripts are all bundled. The only network destination is `https://api.anthropic.com`; plain links the user clicks are the exception. Evidence: network log on settings, popup, and overlay, plus a grep of runtime files for `http://` and `https://` that lists only those links.
30. The confirmation prompt and the results are an extension page in an iframe, not host-page DOM. Friend names, emails, drafts, the recruiter link, and the analyzed posting's site and title never enter the host page's DOM. The frame gets its data only from the service worker, never from `window.postMessage`, URL parameters, or the content script. The only frame-to-page signal is a data-free close (and resize). Evidence: the criterion 8 checks, plus `window.find('<friend name>')` from the page console returns false while the overlay shows that name. If task 8 falls back to a closed shadow root, these checks still apply and security re-reviews before merge.
31. The web-accessible overlay page is harmless when any site frames it. `web_accessible_resources` lists only the overlay HTML file with `use_dynamic_url: true`; its scripts, styles, and fonts load from the extension origin and are not listed. The overlay shows only state the service worker holds for its own tab (`sender.tab.id`), created after the content script in that tab's top frame reported a confirmation. That state is cleared when the overlay closes or the tab navigates or closes. Evidence: a local test page that frames the overlay URL in a tab with no pending prompt shows nothing and sends no API request, and a page can't load `chrome-extension://<static id>/overlay.html`. If Chrome can't load the frame with `use_dynamic_url`, note it in the handoff log for security to decide.
32. The service worker checks every sender (a pure helper in lib/core.js, unit-tested). (a) A Claude call starts only on a request from this extension's own pages: `sender.id === chrome.runtime.id` and `sender.url` uses the `chrome-extension:` scheme. A content script never starts one, because its `sender.url` is the web page. The overlay's request carries no job text; the worker uses the posting it recorded. (b) Content-script messages are accepted only from a tab's top frame (`sender.tab` set, `frameId === 0`, http/https URL), only for known types, and only with string fields under length caps (text ≤ `MAX_JOB_TEXT`, title ≤ 200 characters). Anything else is ignored. (c) There are no `onMessageExternal` or `onConnectExternal` listeners and no `externally_connectable` key, so web pages and other extensions have no channel. Tests: a content-script sender asking for analysis is rejected, a popup sender is accepted, and an oversized or non-string JOB_SEEN is rejected.
33. Spending on the user's key stays bounded. The service worker caps job text at `MAX_JOB_TEXT` on every path, popup paste included. `max_tokens` stays fixed. Model and effort come only from allowlists in lib/core.js; a stored value outside them (such as a 1.x free-text model) falls back to the default. Threshold is clamped to 0–1. While an analysis is running, more clicks in that popup or tab send no extra request. Unit tests for the cap and the allowlist fallback.
34. The API key, settings, and friends live only in `chrome.storage.local` (never `storage.sync`). Postings and results live only in `chrome.storage.session` at its default trusted-contexts access level. Content scripts never read `chrome.storage`. The key never appears in a message to a content script or the overlay, in an error message, in console output, or in the friends export, and the settings page shows it in a password field. No runtime file logs the key, friend data, page text, or drafts. The settings page and PRIVACY.md say the key is stored unencrypted in this Chrome profile and suggest setting a spend limit in the Anthropic Console. Evidence: a grep of runtime files for `storage.sync`, `setAccessLevel`, and `console.`, plus a unit test that mapped error messages never contain the key.
35. The friends import and the form share one validator in lib/core.js. Input must be a JSON array, with a file of 1 MB or less and 500 entries or fewer. Each entry keeps only `name`, `contact`, `skills`, `interests`, `level`, and `notify`; other keys, including `__proto__` and `constructor`, are dropped. Strings are trimmed and capped (name 100, contact 254, level 50, each skill or interest 100 characters, 50 items per list at most). `contact` is an email address or empty, and `notify` is a boolean. A rejected import gives a specific message and leaves saved friends unchanged. The same validator runs on stored friends before they reach the prompt. Export writes only the friends list. Unit tests per rule; the existing `validateFriends` cases keep passing.
36. With auto-detect off, no page is read. Turning it off unregisters the content script (`chrome.scripting.getRegisteredContentScripts()` returns none) [Q14: and removes the all-sites permission]. If the user removes site access in Chrome, the toggle shows off. Before Chrome's permission prompt appears, one line says what will be read and that nothing is sent to Claude without a click.
37. [Q13] Which confirmation pages can show the prompt for a posting viewed in a different tab matches the user's answer to Q13.
38. The release zip contains no secrets. Its `unzip -l` listing matches the criterion 19 list (no `.env`, `config.js`, or keys), and searching the zip for `sk-ant-` finds nothing. Bundled font files come from the official upstream releases, and the source URL and SHA-256 of each are in the handoff log.

## Out of scope

- A hosted backend or proxy for API calls (unless Q2 says otherwise).
- Sending email directly (Gmail/Graph OAuth). mailto stays.
- Firefox, Safari, or Edge store builds.
- Detecting confirmations inside cross-origin iframes.
- Analytics or telemetry of any kind.
- Localization.
- Payments or paid tiers.
- The actual Web Store submission, developer account, and fee. The user does these; the team prepares everything.
- Rewriting git history. If task 1 finds a secret, the user decides.

## UI involved

Yes: popup, settings page, in-page overlay, icons, and store assets.

## Security-sensitive

Yes. It handles an API key, reads text from every site (or a chosen subset), sends page text and third-party personal data (friends) to an external API, takes user input that gets rendered into host pages, and may add permissions (`activeTab`, `scripting`, optional host permissions) and bundled third-party font files.

## Tasks

Do these in order. Tasks marked [Qn] wait for the user's answer.

1. Secret/history check (read-only): run the two git commands in criterion 1 and grep history for non-example.com email addresses. Record the output in the handoff log. Stop and escalate if anything real turns up.
2. First-run friends (criterion 2): stop loading friends.json as live data in background.js:12-22 and options.js:12-17, and show the example as placeholder/help instead. Delete friends.json if nothing needs it anymore, and update the CI file list. Add a test.
3. Error mapping (criterion 9): add a pure function in lib/core.js mapping status + API error body (plus a network-failure case) to user messages. Use it at background.js:73-76 and in the fetch catch. Add tests.
4. Copy failure feedback (criterion 10): content.js:482, 496 and popup.js copyToClipboard.
5. Popup setup state (criterion 11).
6. [Q3] Permissions: change the manifest to match the chosen option. If (c): `optional_host_permissions`, request on enabling auto-detect, register the content script at runtime with `chrome.scripting.registerContentScripts`, and use `activeTab` + `chrome.scripting.executeScript` for the popup read (this also covers criterion 5). Update the CI check at test.yml:28.
7. [Q4] Click-to-analyze prompt on confirmation (criterion 6). Send `document.title` with JOB_SEEN so the prompt can name the posting.
8. Overlay isolation and accessibility (criteria 8, 12): move the overlay into an extension page loaded in an iframe (`web_accessible_resources`), or a closed shadow root if the iframe proves impractical. Note in the handoff log which one and why. The iframe is the only option that also hides keystrokes from the page.
9. [Q6] Friends editor.
10. [Q8] Model default and picker.
11. [Q5] Auto-detect default and setup-page disclosure (criteria 7, 15).
12. [Q7] Restyle: bundle the font files with their OFL license texts, replace the icons, and update popup.css, options.css, and the overlay styles.
13. [Q9, Q10] PRIVACY.md, LICENSE, package.json `license`, and links from the settings page and README (criteria 16, 17).
14. [Q12] Version bump plus a version-equality line in the existing CI `node -e` step (criterion 18).
15. Packaging (criterion 19): the simplest option is `.gitattributes` `export-ignore` entries plus an npm script running `git archive --format=zip -o dist/job-notifier-<version>.zip HEAD`, with `dist/` gitignored. It packages committed files only; say so in the README.
16. README and DOCS.md updates (criterion 20).
17. [Q1] docs/store-listing.md and assets (criterion 21). Take screenshots from the packaged build.
18. Final pass: build the zip, load it unpacked in a clean Chrome profile, and walk through first run → setup → job posting → confirmation → share. Capture screenshots for criteria 2, 4, 6, 8, 11, 15, and 22. Run tests and the check.

## Decisions (answered by the user, 2026-11-25)

1. **Distribution:** public Chrome Web Store listing.
2. **Who pays for Claude:** each user brings their own Anthropic API key. No backend.
3. **Site access:** all-sites access becomes an optional permission, requested when the user turns auto-detect on. The popup uses `activeTab`.
4. **Auto-detect trigger:** a confirmation page shows a "Find friends for this job?" prompt. Claude is called only on click.
5. **Auto-detect default:** off on new installs until the user opts in.
6. **Friends editor:** a form (name, email, skills, interests, level, include) with JSON import/export.
7. **Look:** restyle to the user's global design rules. Accent color: **teal**. The "J" icon is redesigned in teal.
8. **Model:** a cheaper current model as the default, with a dropdown of verified model IDs.
9. **License:** MIT.
10. **Privacy policy:** PRIVACY.md in the repo (the repo is public). Contact: a link to the repo's GitHub Issues page. No personal email is published.
11. **Listing:** keep the name "Job Notifier", category Productivity. The developer account and submission are the user's to do (out of scope).
12. **Version:** 2.0.0.
13. **Q13, cross-tab prompt:** option (b). Only a posting from the same tab, or from the tab that opened it, can be offered. No any-tab `lastJob` fallback and no toolbar badge (the badge design in the Design section is not used).
14. **Q14, auto-detect off:** also remove the optional all-sites permission (`chrome.permissions.remove`). Chrome asks again when it's turned back on.
15. **Security defaults:** keep both. Drafts with a link or email get the "check before sending" note (links aren't stripped). Imports are capped at 1 MB and 500 friends.
16. **Dark mode:** not in this release.
17. **LICENSE in the zip:** include it (criterion 19 now allows LICENSE). README and PRIVACY.md stay out.
18. **Fonts:** the user approved downloading Fraunces 600 and IBM Plex Sans 400/600 (latin woff2, via Fontsource on jsDelivr) plus both OFL license files into fonts/. Done by the team lead; see the handoff log.
19. **Store summary / manifest description:** "Finds friends who'd fit a job posting and drafts a message to each. Uses your own Anthropic API key." (engineer B's suggestion, approved by the user)
20. **Upgrades from 1.x:** no migration. A stored `claude-opus-5-5` stays (it's on the allowlist). 1.x was never public; the user can switch models in settings.

## Security

What needs protecting: the user's Anthropic API key and the money billed to it; friends' personal data (names, emails, skills); the user's job-search activity (which postings they view and apply to); the host sites the content script runs on.

Untrusted input enters from: page text, title, and URL (any site once auto-detect is on); Claude's output (steerable by page text); the friends form and JSON import; Anthropic API error bodies; any page that frames the web-accessible overlay page; and messages from content scripts, which run in the site's renderer process.

**Threats**
- High. Prompt injection: a posting (or any page with job-like text, including small or low-contrast text that is still "visible") can steer scores and drafts, for example a phishing link or false claim in a message the user then sends to friends under their own name, or one friend's details copied into another's draft. It can also try to close the `<job_posting>` delimiter. (24, 25, 26)
- High. HTML injection: page text and title, model output, friend fields, imports, and API errors rendered as HTML. In host-page DOM this would run under the site's origin; in extension pages it injects markup. Today every sink uses `escHtml`, and the rewrite has to keep that. (28, 29)
- High. Cross-site exposure in the page DOM: anything rendered into the host page (friend names, drafts, keystrokes, and the prompt naming a posting from another tab and site) is readable by that site's scripts. A closed shadow root still leaks through `window.find`, selection, and inherited styles. (30)
- Medium. Web-accessible overlay page: any site can probe the static URL to see that the extension is installed (which tells it the user is job hunting), frame it, or feed it data through URL parameters or `postMessage` if the overlay accepted them. (31)
- Medium. Message spoofing: content-script messages carry page-controlled data and come from the site's renderer. If the worker started paid calls or returned friend data on them, a page or a compromised renderer could spend credits or pull data. Web pages and other extensions have no channel today (no `externally_connectable`, no external listeners), and that has to stay true. (32)
- Medium. Cross-tab leak: with the `lastJob` fallback (background.js:83), any site that shows a confirmation phrase sees the prompt frame appear in its DOM, which tells it the extension is installed and that the user viewed a job posting in the last 30 minutes. Open question Q13. (37)
- Medium. API key exposure: stored unencrypted in `chrome.storage.local`. It could leak through logs, error text, messages, the friends export, or `storage.sync`. (34)
- Medium. Cost abuse on the user's key: uncapped popup text (today `ANALYZE_JOB` text isn't capped in the worker), repeated clicks, legacy free-text model IDs, or very large friends lists. (33, 35)
- Medium. JSON import: a shared or malformed file can carry huge payloads, unexpected keys, non-string fields, or instruction text that reaches the prompt. (35, 24)
- Low. mailto header injection (extra recipients through `cc`/`bcc`). `encodeURIComponent` prevents it today; a test keeps it that way. (27)
- Low. Access when off: the all-sites permission or a registered content script staying active after auto-detect is turned off. (36, Q14)
- Low. Supply chain and packaging: bundled font files, and secrets in the zip. `git archive` ships committed files only, and `config.js` is gitignored. (38)

**Known Low risks, not blocking**
- The host page can clickjack the overlay frame (make it transparent and place a decoy over it). Worst case is one API call on the user's key or a mailto draft opening, which the user still has to send.
- `chrome.storage.local` is readable from this extension's content scripts, so a renderer exploit on a site the content script runs on could read the key. Criterion 34 keeps content scripts from using storage and discloses that the key is stored unencrypted. I didn't verify whether Chrome allows restricting `storage.local` to trusted contexts the way `storage.session` can be.
- `anthropic-dangerous-direct-browser-access: true` is needed for browser-side calls. It's acceptable here because the key belongs to the user of this browser.

**Requirements:** acceptance criteria 24–38.

## Design

This follows the global design rules (Decision 7), with teal as the one accent. All three surfaces load one shared stylesheet (for example `ui.css`) that holds the tokens and base components below, so the popup, settings page, and overlay can't drift apart. Page-specific layout stays in popup.css, options.css, and the overlay page's CSS.

### Tokens

```css
/* fonts/ holds the woff2 files and each family's OFL.txt. Latin subset. No font CDN. */
@font-face { font-family: "Fraunces"; src: url("fonts/Fraunces-SemiBold.woff2") format("woff2"); font-weight: 600; font-display: block; }
@font-face { font-family: "IBM Plex Sans"; src: url("fonts/IBMPlexSans-Regular.woff2") format("woff2"); font-weight: 400; font-display: block; }
@font-face { font-family: "IBM Plex Sans"; src: url("fonts/IBMPlexSans-SemiBold.woff2") format("woff2"); font-weight: 600; font-display: block; }

:root {
  /* Neutral base plus one accent. --error is only for error text and invalid fields. */
  --bg: #ffffff;
  --bg-subtle: #f6f6f4;      /* job summary, disclosure box, posting block, secondary hover */
  --border: #d9d9d6;         /* dividers and card outlines (decorative) */
  --border-strong: #8a8a85;  /* form controls, switch track when off: 3.5:1 on --bg */
  --text: #1d1d1b;           /* 16.9:1 on --bg */
  --text-muted: #5c5c57;     /* 6.7:1 on --bg, 6.2:1 on --bg-subtle */
  --accent: #0f766e;         /* teal: 5.5:1 on --bg, 5.1:1 on --bg-subtle; white on it 5.5:1 */
  --accent-hover: #115e59;   /* white on it 7.6:1 */
  --error: #b42318;          /* 6.6:1 on --bg, 6.1:1 on --bg-subtle */
  --scrim: rgba(29, 29, 27, 0.45);
  --shadow-panel: 0 2px 8px rgba(29, 29, 27, 0.16); /* overlay panel only; nothing else has a shadow */

  --font-heading: "Fraunces", Georgia, serif;
  --font-body: "IBM Plex Sans", Arial, sans-serif;

  --radius: 4px;    /* buttons, inputs, cards, panels */
  --radius-sm: 2px; /* chips, switch */

  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px;
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; } /* 5.5:1 against --bg */
::placeholder { color: var(--text-muted); }
```

Type scale (size and line height in px):

| Role | Font | Size | Used for |
|---|---|---|---|
| Display | Fraunces 600 | 28/34 | Settings h1 |
| Heading | Fraunces 600 | 20/26 | Settings section h2, overlay state heading |
| Subheading | Fraunces 600 | 17/22 | Popup state heading, job title, friend form heading (popup wordmark at 16) |
| Body | Plex Sans 400 | 14/21 | Everything else, including textareas |
| Label | Plex Sans 600 | 13/18 | Field labels, buttons, friend names |
| Small | Plex Sans 400 (600 where noted) | 12/16 | Help text, meta lines, chips, status lines, eyebrow |

Components:
- **Primary button:** --accent background, white Label text, 8px 14px padding, min-height 32px, --radius, no border. Hover uses --accent-hover.
- **Secondary button:** --bg background, 1px --border-strong border, --text. Hover uses --bg-subtle.
- **Text button:** no border or background, --accent text, underlined on hover. Padding keeps the target at least 24x24px.
- **Text inputs, selects, textareas:** --bg, 1px --border-strong border, --radius, 8px 10px padding, Body type. Invalid fields get an --error border plus a message below (`aria-invalid`, `aria-describedby`).
- **Checkbox:** native, `accent-color: var(--accent)`, 16px.
- **Switch:** native checkbox with `role="switch"`, 32x18 track, --radius-sm. The track is --border-strong when off and --accent when on, with a 14px white thumb. The focus ring goes on the track (`input:focus-visible + .track`). Today's toggle hides its input and shows no focus at all.
- **Chip:** Small type, 2px 6px padding, 1px --border, --radius-sm, --bg, --text. Level, Remote, and skills all use this style. No color-coded chips.
- **Card:** 1px --border, --radius, 12px padding, no shadow.
- **Error block:** 3px left border in --error, 12px left padding, heading in --text. No icon.
- **Spinner:** 16px ring, 2px --border with an --accent top. Under `prefers-reduced-motion` it doesn't spin, and the heading carries the state.
- **No gradients, blur, or symbol icons.** ⚙ becomes the text button "Settings", ✕ becomes the text button "Close", and ⚠ is replaced by the error block. The extension icon is the only image.

Rules for every surface:
- Remove every `outline: none`.
- Don't set `disabled` on a button that has focus. This covers the "Copied" and "Opened" flashes and the finished "Open next email" button. Chrome drops focus to the page body when a focused button is disabled. Keep it focusable, set `aria-disabled="true"`, and ignore clicks.
- When a click changes the state (analyze, retry, answering the prompt), focus moves to the new state's heading (`tabindex="-1"`).
- Long names, titles, emails, and URLs wrap with `overflow-wrap: anywhere`.
- Every page has `lang="en"`. DOM order matches visual order.

### Popup

The popup is 380px wide. Chrome caps its height at 600px, and the body scrolls past that. Everything is left-aligned with 16px padding.

1. Header row, with a 1px --border line below. On the left, the wordmark "Job Notifier" (h1, Fraunces 600 16px). On the right, the switch with the visible label "Auto-detect", then the text button "Settings".
2. Status line under the header (Small, `role="status"`) for auto-detect messages. Usually empty.
3. One state panel. Each state starts with an h2 in Subheading type.

| State | When | Heading | Body | Actions |
|---|---|---|---|---|
| Setup (criterion 11) | No API key | Set up Job Notifier | Job Notifier drafts messages to friends who'd fit a job posting. It uses your own Anthropic API key, so you pay Anthropic directly for each analysis. Add your key and at least one friend to start. | Primary "Open settings" |
| No friends (criterion 2) | Key set, list empty | Add a friend first | Your friends list is empty, so there's no one to match a posting to. | Primary "Add friends" (opens settings at `#friends`) |
| No friends included | Key set, every friend excluded | No friends included | Every friend on your list is excluded from matching. Include at least one in settings. | Primary "Open settings" |
| Posting found | Page read and looks like a posting | Job posting found | Check the text, then find friends who fit. | Primary "Find friends" |
| Not a posting | Page read, no posting found | Paste a job posting | This page doesn't look like a job posting. Paste the posting text below. | Primary "Find friends" |
| Page Chrome blocks | chrome://, the Web Store, the PDF viewer, other restricted pages | Paste a job posting | Chrome doesn't let extensions read this page. Paste the posting text below. | Primary "Find friends" |
| Read failed (criterion 5) | `executeScript` failed on an http(s) page | Paste a job posting | Couldn't read this page. Reload it and open Job Notifier again, or paste the posting text below. | Primary "Find friends" |
| Loading | After Find friends or Try again | Finding friends… | Claude is reading the posting and scoring your friends. (Spinner beside it, `role="status"`.) | None |
| Results | 1 or more matches | 1 friend might want this job / {n} friends might want this job | See Results below | See Results below |
| No matches | 0 matches | No strong matches | The job summary, then: None of your included friends scored {threshold}% or higher for this posting. You can lower the match threshold in settings. | Text button "Open settings" |
| Error | Analysis failed | From the error table | From the error table | From the error table, plus secondary "Edit text" (returns to the input with the text kept) |

The setup state has no error styling and no "failed" wording. Both no-friends states are checked when the popup opens, and again if the worker reports no friends.

The four input states share one textarea with the visible label "Posting text" and this help line: "The first 8,000 characters are sent to Claude, with your included friends' names, skills, interests, and level." If the text is too short: "Paste more of the posting. Job Notifier needs at least 50 characters." Nothing gets focus automatically, so a stray Enter can't start a paid request.

Auto-detect switch in the popup (criteria 7, 36):
- If the all-sites permission isn't granted yet, turning the switch on doesn't flip it. It opens an inline panel under the header instead:
  - Heading: "Turn on auto-detect?"
  - Body: "Job Notifier will read the visible text of pages you open to spot job postings and application confirmations. Nothing is sent to Claude until you click Find friends. Chrome will ask you to allow access to all sites."
  - Primary "Continue" (calls `chrome.permissions.request`) and secondary "Cancel".
- If Chrome grants access, the panel closes, the switch turns on, and the status reads "Auto-detect is on."
- If Chrome denies it, the switch stays off and the status reads "Chrome didn't grant site access, so auto-detect is still off."
- Turning the switch off takes effect immediately. Status: "Auto-detect is off."
- The popup can close while Chrome's dialog is open. The background must drive the stored state and script registration from `chrome.permissions.onAdded`/`onRemoved`, not from the popup's callback. The switch shows on only when the setting is on and the permission is held.

### Results

The popup and the overlay share this markup and CSS.

1. State heading.
2. Job summary on --bg-subtle with --radius and 12px padding: title (Subheading), company (Body), chips for level and "Remote", location in Small muted text, then skill chips. The fallbacks stay "Unknown title" and "Unknown company".
3. Recruiter field, with the existing copy:
   - Label: "Do you have a recruiter contact for this position?"
   - Help: "Optional. Paste their LinkedIn and it's added to each email and to Copy all."
   - Status: "Added to your emails.", or in --error: "That doesn't look like a LinkedIn link, so it won't be included."
4. Match cards, highest score first. Each card has:
   - A first row with the checkbox and name on the left (Label type; accessible name "Select {name}") and "{score}% match" on the right (Small 600, --accent).
   - A second row with the email in Small muted text, or "No email saved".
   - A 4-row textarea with the accessible name "Message to {name}".
   - The criterion 26 note, shown when the draft contains a URL or an email address: "This draft has a link or email address in it. Check it before you send." It uses Small --text with a 3px --border-strong left border and is rechecked as the user edits.
   - Two buttons: "Open email" (accessible name "Open email to {name}") and "Copy" (accessible name "Copy message to {name}"). "Open email" replaces today's "Send"/"Send email" because it opens a draft and sends nothing. It's the primary button when there's one match and secondary otherwise.
5. With 2 or more matches, a bulk row: primary "Open next email ({n} left)" and secondary "Copy all". When every checked email has been opened, the primary button reads "All checked emails opened" (`aria-disabled`, still focusable). The existing hint stays below: "Browsers only allow one email window per click, so this opens the checked emails one at a time."

Feedback:
- **Open email:** the button reads "Opened" for 2 seconds.
- **Copy succeeded:** the button reads "Copied" for 2 seconds. A visually hidden polite status region announces "Copied the message to {name}." or "Copied {n} messages."
- **Copy failed** (criterion 10; both the Clipboard API and the fallback failed): the button label doesn't change. A message appears under that card's actions in Small --error with `role="alert"`:
  - Per friend: "Couldn't copy. The message is selected, so press Ctrl+C (Cmd+C on a Mac)." The textarea gets focus with its text selected.
  - Copy all: "Couldn't copy. Copy each message from its box instead."
  - The message clears on the next successful copy.

### Settings page

The page is left-aligned on --bg, with no cards and no centered column.
- Page padding is 48px, dropping to 24px under 880px wide and 16px under 600px. Content max-width is 880px, anchored left.
- Header: h1 "Job Notifier settings" (Display). Below it, a lede in Body --text-muted, max 60ch wide: "To start, add your Anthropic API key and at least one friend. Everything here is saved only in this browser."
- Sections: each has a 1px --border top rule and 32px vertical padding. Each is a two-column grid. The left column (220px) holds the h2 in Heading type plus a one-line description in Small muted text. The right column (up to 520px) holds the controls. Under 880px the columns stack.
- Saving: each section saves on its own.
  - Claude has a Save button.
  - Friends saves on each add, edit, remove, include, and import.
  - Auto-detect applies on click, because Chrome's permission prompt has to run on that click.
  - Status lines (`role="status"`) sit next to the control that caused them.

**1. Claude** (`id="claude"`). Left column: "Claude" and "Job Notifier calls Claude with your own key. There is no Job Notifier server."

a. Disclosure box (criteria 15, 34). It sits above the key field in both visual and DOM order and is always visible. Style: --bg-subtle, 1px --border, --radius, 16px padding. Title (Label): "What it costs and what gets sent".
   - **You pay Anthropic directly.** Each time you click Find friends, Job Notifier sends one request to Anthropic's API with your key. It's billed to your Anthropic account at Anthropic's prices. Job Notifier itself is free. Link: "Anthropic API pricing".
   - **Sent to Anthropic:** the job posting text (up to 8,000 characters), and each included friend's name, skills, interests, and level.
   - **Never sent:** your friends' email addresses and any recruiter link you paste. They stay in this browser. Your API key goes only to Anthropic, to authorize each request.
   - **Stored unencrypted.** Your key is saved unencrypted in this Chrome profile. To cap what any key can cost, set a spend limit in the Anthropic Console. Link: "Set a spend limit".
   - Nothing goes to the developer or to any analytics service. Link: "Privacy policy".

b. API key. Label "Anthropic API key". A password field with no show toggle (criterion 34).
   - Help: "Create a key in the Anthropic Console. It starts with sk-ant-." "Anthropic Console" links to the API keys page.
   - Error: That doesn't look like an Anthropic API key. Keys start with "sk-ant-".

c. Model. Label "Model". A `<select>` of the verified IDs from task 10, each shown by display name, with the default labeled "{name} (default, lower cost)".
   - Help: "Smaller models cost less per analysis and are usually enough for matching."
   - If the stored model isn't on the allowlist, it falls back to the default (criterion 33). Until the next save, a note under the select reads: "{model ID} from an earlier version isn't offered anymore, so Job Notifier now uses {default name}."

d. A `<details>` element, closed by default, with the summary "More options":
   - **Effort:** the existing options, defaulting to "Low (cheapest)". Help: "Higher effort can score friends more carefully and costs more."
   - **Match threshold:** 0 to 1, step 0.05. Help: "Friends scoring below this aren't shown. 0.6 means a 60% match." Error: "Enter a number from 0 to 1, like 0.6."

e. Primary "Save" button.
   - Status messages: "Saved.", "Saved. Next, add at least one friend below." (no friends yet), or "Saved. Your API key was removed from this browser." (field cleared).
   - On a validation error, focus moves to the first invalid field.

**2. Friends** (`id="friends"`). Left column: "Friends" and "People you might pass a job to. Email addresses stay in this browser."

- **List:** a `<ul aria-label="Friends">`, with rows separated by 1px --border and 12px padding.
  - Left side: the name (Label), then these lines in Small muted text, each on one line with an ellipsis:
    - "{email} · {level}". Missing parts are left out, and "No email" shows when there isn't one.
    - "Skills: …"
    - "Interests: …"
  - Excluded friends show the name in --text-muted plus an "Excluded" chip.
  - Right side (wraps below the details under 480px):
    - A checkbox with the visible label "Include" (accessible name "Include {name} in matching"). It saves immediately.
    - Text buttons "Edit" and "Remove" (accessible names "Edit {name}" and "Remove {name}").
- **Remove:** native `confirm("Remove {name} from your friends list?")`, then the status "Removed {name}." Focus moves to the next row's Edit button, or to "Add friend" if the list is now empty.
- **Under the list:** secondary "Add friend", text buttons "Import JSON" and "Export JSON", and Small muted text: "Exports include email addresses. Keep the file private."
- **Empty list** (first run, criterion 2): no list is shown. The body reads "No friends yet. Add the people you'd share job postings with." The add form is open and Export is hidden.
- **Add/edit form:** one form below the list, with a Subheading of "Add a friend" or "Edit {name}". Caps and rules follow criterion 35.

  | Field | Control | Help | Error |
  |---|---|---|---|
  | Name (required) | text, `required`, maxlength 100 | | Enter a name. |
  | Email | `type="email"`, maxlength 254 | Used only to address the email draft. Never sent to Claude. | Enter an email like name@example.com, or leave it blank. |
  | Skills | text | Separate with commas, e.g. Python, React, REST APIs. | Keep each skill under 100 characters and list 50 at most. |
  | Interests | text | Separate with commas, e.g. fintech, developer tools. | Keep each interest under 100 characters and list 50 at most. |
  | Level | text, maxlength 50, `<datalist>`: Internship, New grad, Mid level, Senior, Staff or above | e.g. internship, new grad, senior. | |
  | Include in matching | checkbox, on by default | | |

  - Buttons: primary "Add friend" ("Save changes" when editing) and secondary "Cancel". Cancel is hidden while the list is empty.
  - After a save, the form closes, focus goes to that friend's Edit button, and the status reads "Added {name}." or "Saved changes to {name}."
  - The example friend appears only in help text, never as saved data.
  - Storage keys don't change: Email maps to `contact` and Include maps to `notify`. Comma lists are trimmed and blank entries dropped.
- **Import JSON:** opens a file picker (`.json`).
  - If the list is empty, a valid file is imported directly, with the status "Imported {n} friends from {file}."
  - Otherwise an inline panel appears and takes focus: "{file} has {n} friends. Your list has {m}." It has secondary "Add to my list", secondary "Replace my list", and text "Cancel". The status then reads "Added {n} friends from {file}." or "Replaced your list with {n} friends from {file}."
  - Errors appear in Small --error with `role="alert"`, and saved friends stay unchanged (criterion 35):
    - "Couldn't import {file}: it isn't valid JSON."
    - "Couldn't import {file}: it's larger than 1 MB."
    - "Couldn't import {file}: it has more than 500 friends."
    - "Couldn't import {file}: {validator message}", using the existing validator messages, for example Entry 3 needs a "name".
- **Export JSON:** downloads `job-notifier-friends.json` in the same format Import accepts.

**3. Auto-detect** (`id="auto-detect"`). Left column: "Auto-detect" and "Off unless you turn it on."
- A switch labeled "Ask me to find friends after I apply to a job".
- Help text, always visible (criteria 7, 36):
  - "When this is on, Job Notifier reads the visible text of pages you open, in your browser, to spot job postings and application confirmations. When a confirmation follows a posting, it asks before sending anything to Claude. Nothing is sent until you click Find friends."
  - "Turning it on asks Chrome for access to all sites, because applications happen on many different sites. Turning it off stops all page reading. Without it, click the Job Notifier toolbar button on a posting."
- On this page the switch calls `chrome.permissions.request` directly, since the explanation is already on screen.
- Status messages:
  - "Auto-detect is on."
  - "Auto-detect is off."
  - "Chrome didn't grant site access, so auto-detect is still off."
  - "Auto-detect is off because site access was removed in Chrome's extension settings." (setting is on, permission is missing)

**4. Privacy and data** (`id="privacy"`). Left column: "Privacy and data".
- Body: "Your key, settings, and friends are stored only in this browser. Job postings you view are kept in memory and cleared when Chrome closes."
- Links: "Read the privacy policy" (`{repo URL}/blob/main/PRIVACY.md`) and "Report a problem" (`{repo URL}/issues`).
- Body: "To delete everything Job Notifier stored, remove it from Chrome's Extensions page. To remove only your key, clear the key field and save."

Footer, in Small muted text: "Job Notifier {version} · MIT License · Source on GitHub" (links to the repo).

### Confirmation prompt and results overlay

The prompt and results are one extension page in a transparent iframe that covers the whole viewport (task 8, criteria 30, 31).
- The page inside draws the scrim and a single dialog.
- The dialog moves through these states: the prompt (or its no-key variant), then loading, then results, no matches, no friends, or an error.
- Because the frame covers the viewport, it never needs a resize signal. The only frame-to-page message is the data-free close.

Layout:
- **Scrim:** --scrim over the whole viewport, with no blur.
- **Panel:** anchored top right, 16px from the top and right edges. Width 420px, max-height `calc(100vh - 32px)`. --bg, 1px --border, --radius, --shadow-panel. The header stays fixed and the body scrolls.
- **Header** (16px padding):
  - An eyebrow row with the 16px icon and "Job Notifier" (Small 600, --text-muted) on the left, and the text button "Close" on the right. The eyebrow shows the panel comes from the extension, not the site.
  - Below it, the state heading (h2, Heading type, `tabindex="-1"`). The dialog's `aria-labelledby` points to it.
- **Narrow viewports** (under 480px wide): the panel insets 8px from the left, right, and top, and takes the full width.
- No entrance animation.

Prompt state (criterion 6):
- Heading: "Find friends for this job?"
- Posting block (--bg-subtle, --radius, 12px padding):
  - The page title in Label type, clamped to 2 lines. If the title is empty: "Untitled page".
  - Below it, in Small muted text: "Viewed on {hostname without www.} just now" or "Viewed on {hostname} {n} minute(s) ago".
- Body (the dialog's `aria-describedby`): "Job Notifier will send this posting's text and your included friends' names, skills, interests, and level to Claude. It's billed to your Anthropic API key."
- Actions: primary "Find friends" and secondary "Not now".
- "Not now", Close, Escape, and a scrim click all dismiss the prompt, and it doesn't ask again for that posting.
- No-key variant: same heading and posting block. Body: "Add your Anthropic API key in settings first. Job Notifier needs it to match this posting to your friends." Actions: primary "Open settings" and secondary "Not now".

Other states:
- Loading, results, no matches, and both no-friends states use the popup copy. In the no-friends states, the action is primary "Open settings".
- Errors use the error table. "Try again" sends the same posting again, and the already-analyzed check must not block a retry the user clicked.

Keyboard and focus (criterion 12):
- **Roles:** `role="dialog"` and `aria-modal="true"`, with `aria-labelledby` pointing to the heading. In the prompt state, `aria-describedby` points to the body. The iframe has `title="Job Notifier"`.
- **Opening:** the content script remembers `document.activeElement` and focuses the iframe. The page inside then focuses the heading, not "Find friends", so a stray Enter can't start a paid request. Test this in Chrome. If focus doesn't land inside the frame, call `iframe.focus()` again after the frame loads.
- **Tab:** Tab and Shift+Tab wrap inside the panel. Without the wrap, Tab escapes into the page behind it.
- **Escape:** closes the dialog from any state.
- **Closing:** removes the iframe and returns focus to the remembered element.
- **State changes:** focus moves to the new heading.
- **Scrim clicks:** close every state except results. In results a scrim click does nothing, so a stray click can't throw away edited drafts. Close and Escape still work there.
- **Known limit:** `aria-modal` inside a frame doesn't hide the host page from screen-reader browse mode. Fixing that would mean making the host page inert, which modifies its DOM, so we don't do it.

If the user answers (c) to Q13, a toolbar badge replaces the in-page prompt:
- Nothing is drawn in the page.
- The badge text is "1" on an --accent background, and the action title is "Job Notifier: find friends for the job you just applied to".
- Opening the popup shows the prompt state, with the same copy and actions. Loading, results, and errors then appear in the popup.

### Error copy (criterion 9)

The mapping in lib/core.js returns `{ title, body, action }`. The popup and overlay use the same copy. No message ever contains the key (criterion 34).

| Case | Detected by | Title | Body | Action |
|---|---|---|---|---|
| Invalid key | 401, `authentication_error` | Your API key wasn't accepted | Anthropic rejected the key saved in settings. It may have been deleted or mistyped. Create a new key in the Anthropic Console and paste it in settings. | Open settings |
| Out of credit | 400 whose message mentions the credit balance | Your Anthropic account is out of credit | Add credit on the Anthropic Console's billing page, then try again. | Open Anthropic billing; secondary Try again |
| No permission | 403, `permission_error` | This key can't make that request | Anthropic says this API key doesn't have permission. Check the key's workspace in the Anthropic Console, or create a new key. | Open settings |
| Rate limit | 429, `rate_limit_error` | Too many requests right now | Your Anthropic account hit its rate limit. Wait a minute, then try again. | Try again |
| Overloaded or server error | 529, `overloaded_error`, any 5xx | Anthropic's API is busy | This is on Anthropic's side, not your key or settings. Try again in a few minutes. | Try again |
| Unknown model | 404, `not_found_error`, or a 400 that names the model | The selected model isn't available | Anthropic doesn't recognize the model chosen in settings, or your account can't use it. Pick another model in settings. | Open settings |
| No network | fetch throws | Can't reach Anthropic | Check your internet connection. Work networks and VPNs sometimes block api.anthropic.com. | Try again |
| Timeout (overlay, existing 90 s) | timer | Claude didn't answer in time | There was no response after 90 seconds. Try again, or open Job Notifier from the toolbar on the posting. | Try again |
| Extension restarted | port closed early | Job Notifier stopped responding | It may have just been updated. Reload the page or reopen the popup, then try again. | None |
| Refusal | `stop_reason: refusal` | Claude couldn't analyze this | Claude declined to analyze this text. Make sure it's a job posting. | Try again |
| Cut off or unreadable reply | `max_tokens`, empty, or malformed JSON | Claude's reply was incomplete | Something went wrong reading Claude's answer. Try again. | Try again |
| Unrecognized status | anything else | Analysis failed | Anthropic returned an error ({status}): {API message} | Try again |

In the popup, every error also gets the secondary "Edit text" button.

### Icon

The icon is a flat teal tile with a white stroked "J". It doesn't depend on any font and has no gradient.
- Per Chrome's icon guidance, the 128px canvas holds 96px of artwork with 16px of padding.
- Export `icon.svg` to `icons/icon128.png` and `icons/icon48.png`.
- The 16px icon is drawn separately, full bleed and aligned to the pixel grid, because the 128px artwork loses the J when scaled down.
- Keep the SVG sources in `docs/assets/` so they stay out of the zip.

`icon.svg` (for 128 and 48):
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect x="16" y="16" width="96" height="96" rx="4" fill="#0f766e"/>
  <path d="M56 38H88M78 38V72a16 16 0 0 1-32 0" fill="none" stroke="#fff" stroke-width="14"/>
</svg>
```

`icon-16.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <rect width="16" height="16" rx="1" fill="#0f766e"/>
  <path d="M5 4H12M10 4V9a3 3 0 0 1-6 0" fill="none" stroke="#fff" stroke-width="2"/>
</svg>
```

### Store assets (criterion 21)

All store assets go in `docs/assets/`. Use PNG with no transparency, and check the sizes against the Web Store's current rules when doing the work.

Demo data is fictional only: no real people, companies, keys, or emails.
- Friends:
  - Priya Shah: priya.shah@example.com; Go, PostgreSQL, distributed systems; climate, infrastructure; Mid level.
  - Marcus Lee: marcus.lee@example.com; Python, SQL, data pipelines; analytics, sports; New grad.
  - Dana Okafor: dana.okafor@example.com; React, TypeScript, design systems; education, accessibility; Senior.
- Posting: "Data Engineering Intern" at Kestrel Grid, remote, on the local demo pages used for criterion 6.
- Serve the demo pages at `http://kestrel-grid.localhost:<port>/`. Chrome resolves `*.localhost` to this machine, so the prompt and the address bar show a believable site name.
- No captions, frames, or device mockups. The UI is the content.

Screenshots:
1. `screenshot-1-overlay.png` (1280x800, page viewport only): the demo confirmation page ("Thanks for applying to Kestrel Grid") behind the scrim. The overlay shows "2 friends might want this job", the job summary, an empty recruiter field, and two match cards with drafts.
2. `screenshot-2-popup.png` (1280x800, the whole browser window so the popup is visibly attached to the toolbar): the demo posting, with the popup in "Job posting found", the text filled in, and "Find friends" visible.
3. `screenshot-3-settings.png` (1280x800, viewport only): the top of the settings page, showing the h1, the lede, and the Claude section with the disclosure box, the masked key field, and the model select.
4. Optional, `screenshot-4-prompt.png`: the prompt state on the demo confirmation page. It shows that nothing runs without a click.

Promo tile, `promo-440x280.svg`. Export it to PNG on a machine with both fonts installed, or by opening it in Chrome.
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">
  <rect width="440" height="280" fill="#0f766e"/>
  <g transform="translate(32 32) scale(0.5833)">
    <rect width="96" height="96" rx="4" fill="#fff"/>
    <path d="M40 22H72M62 22V56a16 16 0 0 1-32 0" fill="none" stroke="#0f766e" stroke-width="14"/>
  </g>
  <text x="32" y="156" font-family="Fraunces" font-weight="600" font-size="40" fill="#fff">Job Notifier</text>
  <text x="32" y="196" font-family="IBM Plex Sans" font-size="18" fill="#fff">Share the jobs you apply to</text>
  <text x="32" y="220" font-family="IBM Plex Sans" font-size="18" fill="#fff">with friends who'd fit them.</text>
</svg>
```
The tile is left-aligned: a white mark, the wordmark, and a two-line tagline on flat teal. It stays legible at half size in store grids, and white on teal is 5.5:1.

### Responsive

- **Popup:** fixed at 380px wide. Content scrolls past Chrome's 600px height cap.
- **Settings:** two columns from 880px up, stacked below that.
  - Page padding steps down from 48px to 24px to 16px.
  - Friend row actions wrap under 480px.
  - At 200% zoom the stacked layout applies.
- **Overlay:** a 420px panel at the top right. Under 480px it goes full width with 8px insets. The body scrolls when the panel is taller than the viewport.

### Accessibility checklist

- **Contrast:** values come from the tokens. All text is at least 4.5:1. Control borders, the switch, and the focus ring are at least 3:1 against their backgrounds.
- **Labels:** every field has a visible label. Help and error text are linked with `aria-describedby`, and errors set `aria-invalid`.
- **Keyboard:** focus order follows DOM order, which follows visual order. Every control is reachable with Tab and shows the focus ring from the tokens.
- **Targets:** at least 24x24px.
- **Color:** never the only signal. Errors have text, excluded friends have a chip, and the switch has a status line.
- **Motion:** `prefers-reduced-motion` stops the spinner. Nothing else animates.

## Handoff log

**Team lead, task 1 (secret/history check):**
- `git log --all --full-history -- config.js`: no results. config.js was never committed.
- `git log --all -p -S "sk-ant-"`: only the placeholder `"sk-ant-..."` in old docs and the `sk-ant-test` fixtures. No real key.
- Email addresses in history: test fixtures (a@b.com, c@d.com), a test URL (`user:pw@linkedin.com`), and **the owner's personal email** as a friend `contact` in friends.json in c79d3e6. It was removed in 74b8f61, but it's still in public history. The same address is also the commit author email. Escalated to the user.
- Repo visibility: public.
- **User decision:** leave the repo public and leave history as it is. Criterion 1 is satisfied: no secrets, and the only real personal data in history is the owner's own address, kept by choice.

**Security, threat check:**
- Added the Security section and criteria 24–38. Inspected manifest.json, background.js, content.js, popup.js, options.js, options.html, popup.html, lib/core.js, friends.json, .gitignore, package.json, test.yml, and test names in test/core.test.js. Today every innerHTML sink uses `escHtml`, there are no external message listeners, no `externally_connectable`, no `storage.sync`, and no `console.` calls. The worker doesn't cap popup text (background.js:114), and the `ANALYZE_JOB` port accepts any sender (background.js:142-160).
- **Question for the user, Q13 (cross-tab prompt, Medium):** when a page shows "Application submitted", the extension falls back to the last posting viewed in *any* tab (background.js:83). Because the prompt frame then appears in that page, any site can show a confirmation phrase and learn that the user has Job Notifier installed and viewed a job posting in the last 30 minutes. Options: (a) accept this; (b) fall back only to a posting from the tab that opened this one (`openerTabId`), which keeps same-tab and "opens in a new tab" application flows but drops unrelated tabs; (c) show the prompt as a badge on the toolbar icon instead of in the page, so the site sees nothing, but it's easier to miss. Criterion 37 waits on this.
- **Question for the user, Q14 (turning auto-detect off):** turning it off will always stop the content script (criterion 36). Should it also give back the all-sites permission, so chrome://extensions shows no site access? The trade-off is that Chrome asks for the permission again each time auto-detect is turned back on.
- Assumed without asking, change if wrong: drafts with a link or email address get a "check before sending" note rather than having the link stripped (26). Import limits are 1 MB, 500 friends, and the field caps in 35.

**Designer, design pass:**
- Added the Design section: tokens, popup, results, settings page, prompt and overlay, error copy, icon SVGs, and store assets. Read popup.html/css/js, options.html/css/js, content.js, background.js, lib/core.js, manifest.json, the current icon, and the Security section and criteria 24–38 so the copy matches them. Criteria it uses: the link/email note (26), no key show-toggle and the unencrypted-key and spend-limit lines (34), import caps (35), model fallback (33), and the one-line explainer before Chrome's prompt (36).
- No new questions for the user. Two parts of the design depend on open questions:
  - Q14: the auto-detect copy says "Turning it off stops all page reading", which is true under either answer.
  - Q13: the design covers (c) too. A toolbar badge appears and the popup shows the prompt state.
- Choices I made without asking (change any that are wrong):
  - The prompt is modal (scrim, takes focus) and shares one dialog with the results. A corner card that doesn't take focus would mean keyboard and screen-reader users have to tab through the whole host page to reach it.
  - Initial focus goes to the dialog heading, not "Find friends".
  - A scrim click doesn't close the results.
  - The per-card "Send" button is renamed "Open email", because it opens a draft and sends nothing. Criterion 26's "Send" means this button.
  - Effort and threshold move under "More options".
  - Import asks whether to add or replace when a list already exists.
  - Settings sections save separately, and auto-detect applies on click.
- For the engineer:
  - Model option labels come from the task 10 verified list.
  - Check the Anthropic Console URLs (API keys, billing, limits) and the pricing URL when implementing.
  - Test that focus actually lands inside the overlay iframe.
  - The popup's auto-detect state must follow `chrome.permissions.onAdded`/`onRemoved` in the background, because the popup can close while Chrome's permission dialog is open.
- Not designed: dark mode (not in the spec).

**QA, test plan:**
- Files: `test/core.test.js` (logic tests appended after the existing 15) and `test/release.test.js` (static checks on manifest.json, package.json, docs, runtime files, plus a dry-run `git archive` of the working tree). Every new test name starts with "criterion N". CLAUDE.md already lists `npm test` and the check command, so it wasn't changed.
- Result on d23ffb4 plus the new tests: `npm test` runs 82 tests, with 26 passing and 56 failing. Every failure comes from a missing export, file, or behavior ("JN.describeApiError is not a function", "PRIVACY.md is missing", "content.js: #7c3aed", and so on). None comes from a test typo. `npm run check --script-shell=bash` passes.
- Already passing (regression guards): the 15 existing tests and criteria 1, 21 (icon sizes), 23 (referenced files exist, CI manifest script), 27, 28, 29 (CSP, URL scan), 32c, 34 (grep), and 38 (no secrets in zip).
- Changed one existing test: "buildRequest uses structured output and fallbacks on supported models" now checks fallbacks against the model the request actually carries. Criterion 33 can swap an off-allowlist model (for example `claude-haiku-5-5` if it isn't on the list) for the default, and the old version would then fail. It still exercises both branches.

Criterion → tests:
- core.test.js: 2 friendsStatus · 6 postingLabel · 7 defaults · 9 (10 cases + unrecognized) · 14 MODELS · 24 system/tags · 25 types + caps · 26 link note + system prompt · 27 mailto · 32a/32b senders · 33 normalizeSettings + buildRequest · 34 error has no key · 35 (fields, caps, contact/notify/name, 500, import, stored friends to prompt) · 37 recallPosting.
- release.test.js: 1 tree has no key · 2 friends.json not loaded · 3/4 manifest access · 3/21 permission justifications · 5 executeScript · 7 settings copy · 12 lang/outline/dialog · 14 select · 15 disclosure before key · 16 PRIVACY.md · 17 LICENSE · 18 version · 19 zip contents · 20 README/DOCS · 21 listing, assets, icons · 22 gradients/blur/symbols, radius/shadow, colors, fonts · 23 referenced files, CI script · 28 HTML sinks · 29 CSP, URLs · 30 overlay inputs · 31 WAR · 32c external channels · 34 storage/console, key field · 36 permission APIs + explainer · 38 zip secrets, font SHA-256.

Helper contracts (all in lib/core.js, exported on `JN`):
- `friendsStatus(friends)` returns `'empty'` (undefined or []), `'none-included'` (every friend has `notify: false`), or `'ok'`.
- `postingLabel({ title, url, seenAt }, now)` returns `{ title, meta }`. The title is trimmed, and blank becomes "Untitled page". `meta` is "Viewed on {hostname without leading www., no port} just now" under 60 s, otherwise "… 1 minute ago" or "… {n} minutes ago" (whole minutes).
- `describeApiError(status, body)` returns `{ title, body, action }`. `status` 0 means fetch threw. `body` is the parsed API JSON `{ error: { type, message } }` or anything else (null or a string), and it must not throw. `action` is `'settings' | 'billing' | 'retry'`. Titles come from the Design error table. Detection: 401 or authentication_error → settings. 400 with /credit balance/i → billing. 403 or permission_error → settings. 429 or rate_limit_error → retry. 529, overloaded_error, or any 5xx → retry. 404, not_found_error, or a 400 whose message contains "model" → settings. 0 → "Can't reach Anthropic", retry. Anything else → `{ title: 'Analysis failed', body: 'Anthropic returned an error ({status}): {message}', action: 'retry' }`. Recognized cases never include the raw API message. No output ever contains `sk-ant-`, so redact it.
- `MODELS` is `[{ id, name }]` with at least 2 entries and unique `claude-…` ids. It includes `DEFAULT_SETTINGS.model`, and the default isn't an Opus model. `EFFORTS` is a string array that includes `DEFAULT_SETTINGS.effort`. `DEFAULT_SETTINGS.autoDetect` is `false`.
- `normalizeSettings(stored)` returns `{ apiKey, model, effort, threshold, autoDetect }`. A model or effort not on its allowlist becomes the default. A finite threshold is clamped to 0–1; anything else becomes the default. `autoDetect` defaults to false. Undefined input gives the defaults.
- `buildRequest(jobText, friends, settings)` applies `normalizeSettings`, caps the job text at `MAX_JOB_TEXT`, and always uses `max_tokens` 4096. `body.system` (a string or text blocks) holds the instructions. It says the posting and friend fields are untrusted and that instructions inside them must be ignored, and it tells Claude to keep links and contact details out of drafts. Page text never goes into `system`. `<job_posting>`, `</job_posting>`, `<friends>`, and `</friends>` are removed from page text (case-insensitive). A friend field must not produce an extra `</friends>` (strip it, or escape `<` as `<` in the JSON). The user message contains each delimiter exactly once, so it can't mention the tags in prose. Friends go through the `cleanFriends` caps before `friendsForPrompt`.
- `parseResponse` never throws on wrong types (null or non-object matches, non-array `matches`, missing `job`). Job fields: title, company, level, and location are strings of at most 200 characters. Skills is an array of strings, at most 50 items of at most 100 characters each. Remote is a boolean. Match `id` must be an integer, known, and the first valid one, as today. `score` must be a number (a string score is dropped). It is clamped to 0–1 and then compared with the threshold. `message` must be a string of at most 2000 characters. A non-string message either drops the match or becomes `''`, never "[object Object]". `contact` always comes from the stored friend. The existing refusal, max_tokens, and malformed errors stay.
- `draftHasLinkOrEmail(text)` returns a boolean. It is true for `http(s)://`, `www.`, an email address, `mailto:`, and a bare domain with a path (`bit.ly/abc123`). It is false for "Node.js", "e.g.", "3.5 years", `''`, and `undefined`.
- `isExtensionPage(sender, runtimeId)` is true when `sender.id === runtimeId` and `sender.url` starts with `chrome-extension://{runtimeId}/`. Both the popup (no tab) and the overlay frame (tab set, frameId ≠ 0) pass. Gate every Claude call, and every reply that carries friend data, on it.
- `isValidContentMessage(msg, sender, runtimeId)` returns a boolean. `msg` must be an object whose type is in the content-script set: `JOB_SEEN` plus whatever confirmation type is added, never `ANALYZE_JOB`. The sender needs `sender.id === runtimeId`, `sender.tab` set, `sender.frameId === 0`, and an http(s) `sender.url`. `msg.text` must be a string of at most `MAX_JOB_TEXT` characters, and `msg.title`, when present, a string of at most 200. A null message or sender returns false.
- `cleanFriends(list)` returns `{ friends }` or `{ error }` (with no `friends` on error). The input must be an array ("Friends must be a JSON array.") of at most 500 entries (the error mentions 500). Each output entry is a new object with exactly `{ name, contact, skills, interests, level, notify }`, so `__proto__`, `constructor`, and all other keys are dropped. Don't use `Object.assign` from the input. Strings are trimmed and then truncated: name 100, level 50, each skill or interest 100. Lists keep at most 50 items, and blank items are dropped. Defaults are `contact ''`, `skills []`, `interests []`, `level ''`, and `notify true`. Errors: a missing or blank name (the existing `Entry N needs a "name".`), skills or interests that aren't lists (existing messages), a contact that isn't a plain email (the message mentions email or contact; reject `<>`, `?`, whitespace, and more than 254 characters), and a `notify` that is present but not boolean. `validateFriends` stays and returns null or the same message.
- `parseFriendsImport(text)` returns `{ friends }` or `{ error }`. Over 1 MB gives an error that mentions "1 MB". 1,000,000 bytes must pass and 1,048,577 must fail, so either 10^6 or 2^20 works. Invalid JSON gives an error containing "valid JSON". The result then goes through `cleanFriends`. The UI adds the "Couldn't import {file}: " prefix.
- `recallPosting(jobs, tab, now = Date.now())` returns the fresh `jobs[tab.id]`, else the fresh `jobs[tab.openerTabId]`, else null. It never looks at another tab.

Static contracts (test/release.test.js):
- **Manifest:** no `content_scripts`. `host_permissions` is exactly `["https://api.anthropic.com/*"]`. `optional_host_permissions` is `https://*/*` plus `http://*/*`. `permissions` includes activeTab, scripting, and storage, and may only add clipboardWrite. Each one is used in runtime JS. Version is 2.0.0 and matches package.json. The CSP is unchanged and there's no `externally_connectable`.
- **Web-accessible overlay:** `web_accessible_resources` has one entry with one `.html` resource and `use_dynamic_url: true`. That HTML has `role="dialog"` and `aria-modal="true"`. Its `<script src>` files never read `location.search`, `location.hash`, `URLSearchParams`, or `message` events.
- **content.js:** no `innerHTML`, `insertAdjacentHTML`, or `attachShadow`, since it only adds the iframe. A closed-shadow-root fallback will fail this test, which flags it for the security re-review. Neither content.js nor lib/core.js uses `chrome.storage`.
- **Popup and auto-detect:** popup.js uses `chrome.scripting.executeScript` and never `chrome.tabs.sendMessage`. Runtime JS calls `scripting.registerContentScripts`, `unregisterContentScripts`, and `permissions.request`, `.remove`, `.onAdded`, and `.onRemoved`. popup.html+js and options.html+js contain "Nothing is sent [to Claude ]until you click Find friends".
- **options.html:** contains "Off unless you turn it on", `<select id="model">`, and the `api-key` input with `type="password"`. These phrases appear before `id="api-key"`: billed to your Anthropic account, 8,000 characters, skills, interests, and level, Never sent, email addresses, recruiter link, unencrypted, spend limit. The page links PRIVACY.md.
- **Runtime files** are root `*.js|html|css`, manifest.json, `lib/**.js`, `icons/**.png`, and `fonts/**.woff2|txt`. The scans over them require:
  - No `friends.json` reference.
  - No `gradient(`, `blur(`, or `backdrop-filter`.
  - No emoji or symbol characters (Extended_Pictographic and U+25A0–27BF; ©®™ are fine).
  - Border radius is 0, ≤4px, `var(--…)`, or 50% (for the spinner).
  - `box-shadow` is only `none` or `var(--shadow-panel)`.
  - Every chromatic color is teal (hue 160–190) or the error red (hue ≤15 or ≥345).
  - No `outline: none` or `outline: 0`, and every HTML page has `lang="en"`.
  - `@font-face` exists for "Fraunces" and "IBM Plex Sans", using relative woff2 URLs that exist. Every `font-family` uses those, `var(--font-…)`, or `inherit`. No Inter. The `fonts/*.txt` OFL texts mention Fraunces and Plex.
  - No `console.`, `storage.sync`, or `setAccessLevel`.
  - No `insertAdjacentHTML`, `outerHTML =`, `document.write`, `eval(`, `new Function(`, `srcdoc`, or `javascript:`.
  - URLs only go to `*.anthropic.com`, `*.claude.com`, `github.com`, `*.linkedin.com`, the `www.w3.org` namespace, or `*` match patterns. `http://` is allowed only for the last two.
- **Packaging:** the npm script `package` contains `git archive … --format=zip`, README mentions `npm run package`, and .gitignore has `dist/`. The test archives the current working tree (temp index and object dir, so nothing is written to the repo). Every file in the archive must be a runtime file, so `.gitattributes` must export-ignore .claude, .github, test, docs, CLAUDE.md, DOCS.md, README.md, PRIVACY.md, LICENSE, package.json, .gitignore, and .gitattributes. Every file the manifest, HTML, or CSS references must be in the archive. No archived file matches `sk-ant-[A-Za-z0-9_-]{20,}`, and none is `.env*` or `config.js`. Each `fonts/*.woff2` SHA-256 hex string appears in this log.
- **PRIVACY.md** mentions: visible text, `chrome.storage.local`, `chrome.storage.session`, Anthropic, analytics, uninstall, an anthropic.com …privacy link, a github.com/…/issues link, unencrypted, and spend limit. It contains no email address. README, options.html, and docs/store-listing.md link to it.
- **LICENSE** starts with "MIT License", and package.json `license` is "MIT".
- **README** contains "Chrome Web Store", PRIVACY.md, a Troubleshooting heading, a Development heading with no "Load unpacked" before it, and every permission and host-pattern string. **DOCS.md** has no "small backend", no `lastJob`, no autoDetect "default `true`", and no "until saved, `friends.json`".
- **docs/store-listing.md** contains the manifest description verbatim (≤132 characters), "Job Notifier", "Productivity", "single purpose", PRIVACY.md, and every permission and host-pattern string.
- **Store assets:** `docs/assets/screenshot-1-overlay.png`, `screenshot-2-popup.png`, and `screenshot-3-settings.png` are 1280x800, and `promo-440x280.png` is 440x280. All are PNG color type 2 (RGB, no alpha). Manifest icons match their declared sizes.
- **CI:** every `node -e '…'` script in `.github/workflows/test.yml` exits 0. Removing `content_scripts` breaks test.yml:28 until it's updated.

Manual/screenshot checks:
- Criterion 2: on a fresh profile, screenshot the popup ("Add a friend first") and the empty settings friends list.
- Criterion 3: read the README permission lines. The test only approximates "nothing unused".
- Criterion 4: screenshot the install prompt (no all-sites warning) and chrome://extensions → Site access.
- Criterion 5: open a posting, then install the extension and open the popup on that tab. It should read the page or show the reload message.
- Criterion 6: on a local "Application submitted" page, after viewing a posting in the same tab, the service worker's Network panel shows no request to api.anthropic.com before the Find friends click. The prompt shows the site and title.
- Criterion 8: from the page console, `document.body.innerText` and `querySelectorAll('*')` don't include a friend's name. A page with `* { color: red !important; font-size: 30px !important }` doesn't change the overlay.
- Criterion 10: in the popup and the overlay frame, make `navigator.clipboard.writeText` reject and `document.execCommand` return false. Copy and Copy all should show the failure text, not "Copied".
- Criterion 11: screenshot the popup with no key.
- Criterion 12: Escape closes the overlay. Focus lands on the heading inside the frame, Tab wraps, and closing returns focus to the prior element. Tab through the popup, options, and overlay; every control shows the focus ring.
- Criterion 13: add, edit, exclude, and remove a friend, and round-trip import and export.
- Criterion 14: confirm every `MODELS` id against Anthropic's current models list, and record the link here.
- Criterion 15: screenshot the settings disclosure box.
- Criteria 16 and 20: read PRIVACY.md, README, and DOCS.md (including the storage table) for accuracy against the code.
- Criterion 21: check the data-use answers against PRIVACY.md, and check the Web Store's current asset rules at work time.
- Criterion 22: screenshot the popup, settings, overlay, icons, and store assets. Check left-aligned layout and the teal icon. Network shows no font CDN.
- Criterion 23: CI is green. Walk through: posting → confirmation in an opener-linked tab, recruiter link, Open next email, Copy all, and the auto-detect toggle.
- Criterion 26: emails open only on a click. The link note appears and updates while editing.
- Criterion 28: put `<img src=x onerror=alert(1)>` in a friend name, job title, draft, page title, and an imported field. Each shows as literal text in the popup, overlay, and settings, and no extra elements appear.
- Criterion 29: Network log on settings, popup, and overlay shows only api.anthropic.com.
- Criterion 30: `window.find('<friend name>')` from the page console returns false while the overlay shows that name.
- Criterion 31: a local page framing the overlay URL, in a tab with no pending prompt, shows nothing and sends no request. `chrome-extension://<id>/overlay.html` can't be loaded from a page. Note here if `use_dynamic_url` breaks the frame.
- Criteria 32 and 34 (code review): the overlay's request carries no job text, and the key never goes to a content script, the overlay, or the export.
- Criterion 33: double-clicking Find friends or Try again sends one request.
- Criterion 35: a rejected import leaves the list unchanged. The export contains only the array.
- Criterion 36: after turning it off, `chrome.scripting.getRegisteredContentScripts()` in the service worker console returns []. chrome://extensions shows no site access. Removing site access in Chrome turns the switch off.
- Criterion 37: a posting in tab A plus a confirmation in an unrelated tab B shows no prompt. A tab opened from A does show it.
- Criterion 38: record each font's source URL, and inspect `unzip -l dist/*.zip`.

Spec conflicts and choices made in the tests:
1. Criterion 38 says "searching the zip for `sk-ant-` finds nothing". The settings copy ("It starts with sk-ant-") and the key-prefix check in options.js ship in the zip, so that search can't come back empty. The test searches for a real key shape (`sk-ant-` plus 20 or more characters) instead.
2. Criterion 35 says "capped", but the Design's form error says "Keep each skill under 100 characters and list 50 at most." The shared validator truncates, and that's what the tests check. If that error should still show, the form checks before calling the validator.
3. "1 MB" is ambiguous. The tests accept either 10^6 or 2^20.
4. Criterion 19's list leaves LICENSE, README, and PRIVACY.md out of the zip, and the tests follow it strictly. Adding LICENSE to the zip is a one-line allowlist change if the user wants it.
5. The 4px maximum radius (criterion 22) conflicts with the Design's round 16px spinner. The tests allow 50%.
6. Criterion 29 allows only api.anthropic.com plus links the user clicks. The recruiter placeholder `https://www.linkedin.com/in/…` is neither, so the tests also allow linkedin.com.
7. Criterion 18: the version test runs in CI through `npm test`, so CI already fails on a mismatch. A separate test.yml line is optional.
8. Criterion 25 doesn't say whether a non-string message drops the match or becomes `''`. The tests accept either.
9. The Design error table's timeout, restarted, refusal, and cut-off rows aren't HTTP statuses, so they aren't in the `describeApiError` contract. They're checked manually.

**Team lead, fonts (criterion 38, Decision 18), downloaded 2026-11-25:**

| File | Source | Bytes | SHA-256 |
|---|---|---|---|
| fonts/fraunces-latin-600-normal.woff2 | https://cdn.jsdelivr.net/fontsource/fonts/fraunces@latest/latin-600-normal.woff2 | 18096 | 3a1de7711d147bad4422825045f87597fd77cca72e7c96d3b0a81735d00dda82 |
| fonts/ibm-plex-sans-latin-400-normal.woff2 | https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@latest/latin-400-normal.woff2 | 22588 | 3b646991d30055a93a4ecc499713d4347953a74a947ecab435ab72070cbdab0e |
| fonts/ibm-plex-sans-latin-600-normal.woff2 | https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@latest/latin-600-normal.woff2 | 24252 | 8960851d691c054ed38e259bdcf1a6190d157b4203ed5bb32c632a863fb8ec2f |
| fonts/Fraunces-OFL.txt | https://raw.githubusercontent.com/undercasetype/Fraunces/master/OFL.txt | 4391 | bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b |
| fonts/IBMPlex-LICENSE.txt | https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt | 4456 | 7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da |

All three .woff2 files start with the `wOF2` signature. Both license texts are SIL OFL 1.1.

**Team lead, Decision 17:** the user wants LICENSE in the zip. Routed to qa (update the release test's zip allowlist) and engineer B (don't export-ignore LICENSE).

**QA, Decisions 17–18:** release.test.js now requires LICENSE in the zip (README.md, PRIVACY.md, and other non-runtime files stay excluded, so don't export-ignore LICENSE), accepts every file under fonts/, and checks each fonts/ file's SHA-256 against its row in the team lead's table above (passes now); `npm test` is 82 tests, 28 pass and 54 fail (criterion 17 passes since engineer B added LICENSE).

**Engineer B, docs and packaging (tasks 13, 15, 16, 17 text; criteria 3, 16, 17, 19, 20, 21, 34 docs):**
- Files: new `LICENSE` (MIT, 2026, author name from c79d3e6), `PRIVACY.md`, `.gitattributes`, `docs/store-listing.md`; rewrote `README.md` and `DOCS.md`; `package.json` (version 2.0.0, `"license": "MIT"`, `package` script); `.gitignore` (+ `dist/`). No app code, manifest, tests, or assets touched. Nothing committed.
- `.gitattributes` export-ignores .claude, .github, test, docs, CLAUDE.md, DOCS.md, README.md, PRIVACY.md, package.json, .gitignore, .gitattributes. LICENSE and fonts/ ship (Decision 17).
- `npm run package` is `mkdir -p dist && git archive --format=zip -o dist/job-notifier-$npm_package_version.zip HEAD`. Bash syntax like `check`, so Windows needs `--script-shell=bash` (README says so). It archives HEAD with HEAD's own `.gitattributes`, so the zip is only right once `.gitattributes` is committed. I ran it on the uncommitted tree: it worked and, as expected, still included everything; I deleted that zip.
- `npm test`: 82 tests, 32 pass, 50 fail. `npm run check --script-shell=bash` passes. Mine now passing: 3/21 permission justifications, 17 LICENSE, 19 zip contents, 20 README/DOCS, 21 listing fields. Mine still failing, waiting on engineer A: 16 (options.html must link PRIVACY.md; PRIVACY.md itself passes every check) and 18 (manifest.json version 2.0.0). Waiting on engineer C: 21 store assets.
- Web Store requirements checked 2026-11-25 on developer.chrome.com (cws-dashboard-listing, images, cws-dashboard-privacy, user-data-faq, manifest/description): icon 128x128 with 96px artwork; 1–5 screenshots at 1280x800 or 640x400, full bleed, square corners; small promo 440x280 and marquee 1400x560 optional; summary = manifest description, 132 characters max. Not in the public docs: the dashboard's data-type checkbox labels and certification wording (I used the dashboard's known labels; confirm at submission), and the Productivity subcategory list (third-party sources show Communication, Developer Tools, Education, Tools, Workflow & Planning; the listing suggests Communication).
- Anthropic URLs: the Console is now platform.claude.com (docs.claude.com redirects there). Docs use `platform.claude.com/settings/keys`, `/settings/spend-limits`, `/docs/en/about-claude/pricing`, and `https://www.anthropic.com/legal/privacy` (effective Sep 10, 2026). Engineer A can reuse these for the settings links.
- For the reviewer:
  - DOCS.md was written from the spec before engineer A's code landed. Check against the final code: overlay file name `overlay.html`; `autoDetect` kept as its own `chrome.storage.local` key; `jobs` entries gain `title`; `analyzed` kept; the per-tab overlay state row has no key name yet (fill it in from background.js); the confirmation message type is not named.
  - README, DOCS.md, and the listing justify `clipboardWrite`. If engineer A drops it from the manifest, delete those rows.
  - PRIVACY.md says the session store holds each posting's address, title, and time viewed, which assumes task 7 stores the title.
  - README's install step names the store but has no link; add the listing URL after publishing.
- **Question for pm / team lead:** the listing summary must equal manifest.json `description`, which is still "When you apply to a job, drafts personalized messages for friends who'd be a good fit." With auto-detect off by default and the toolbar as the main flow, that reads as if it runs on its own. Suggested replacement (101 characters): "Finds friends who'd fit a job posting and drafts a message to each. Uses your own Anthropic API key." If approved, engineer A changes the manifest and I update docs/store-listing.md to match; until then the listing uses the current text so the test passes.

**Engineer B, Decision 19:** docs/store-listing.md's summary is now "Finds friends who'd fit a job posting and drafts a message to each. Uses your own Anthropic API key." (100 characters; my earlier note said 101). The "criterion 21: the store listing doc has every required field" test fails until engineer A sets the same text as the manifest.json description.

**Engineer A, core, service worker, content script, manifest (tasks 2, 3, 6, 7, 10 logic; criteria 2, 5, 6, 7, 9, 14, 24–27, 31–37 code):**
- Files: `lib/core.js`, `background.js`, `content.js` (rewritten; old in-page overlay DOM and styles removed), `manifest.json`, `popup.js` (page read only, plus a 3-line adaptation to the new reply shape), `options.js` (minimal: dropped the friends.json fetch so criterion 2's grep passes), `.github/workflows/test.yml`. Deleted `friends.json` (`git rm`, staged). Nothing committed.
- Manifest: version 2.0.0; description is the Decision 19 text; `permissions` activeTab, scripting, storage, clipboardWrite (kept; popup.js still uses `execCommand('copy')`); `host_permissions` api.anthropic.com only; `optional_host_permissions` `https://*/*`, `http://*/*`; no `content_scripts`; `web_accessible_resources` is only `overlay.html` with `use_dynamic_url: true`; CSP unchanged.
- CI: `permissions: contents: read`; the manifest check now tolerates no `content_scripts` and includes `web_accessible_resources` files. It exits 1 until `overlay.html` exists.
- Models (task 10, criterion 14): `MODELS` = `claude-haiku-5-5` (Claude Haiku 5.5, default), `claude-sonnet-5-5` (Claude Sonnet 5.5), `claude-opus-5-5` (Claude Opus 5.5). Confirmed 2026-11-25 on https://platform.claude.com/docs/en/about-claude/models/overview (all three listed as current, retirement not before Sep–Oct 2027) and https://platform.claude.com/docs/en/models/haiku-5-5/overview. Structured outputs support for all three confirmed on https://platform.claude.com/docs/en/build-with-claude/structured-outputs. Haiku 5.5 is $0.10/$0.50 per MTok, supports effort low to max, and has no server-side refusal fallback (`supportsFallbacks` stays false for it). `EFFORTS` = low, medium, high. Fable 5.2 is left out (most expensive, always-on thinking).
- Storage keys (for DOCS.md): `chrome.storage.local`: `settings` { apiKey, model, effort, threshold }, `autoDetect` (boolean, its own key), `friends`. `chrome.storage.session`: `jobs` { [tabId]: { text, title, url, seenAt, hash } }; `prompts` { [tabId]: posting plus `origin` } is the per-tab overlay state; `prompted` (last 100 posting hashes already offered). `analyzed` and `lastJob` are gone.
- Message types: content script to worker `JOB_SEEN` { text, title } and `CONFIRMATION_SEEN` {} (reply `{ show }`, or `{ off: true }` when auto-detect is off, which stops the script). Worker to content script (top frame only) `CLOSE_OVERLAY` and `STOP`. Overlay and popup messages are below.
- Auto-detect (Decision 14, criteria 4, 36): the worker registers `lib/core.js` + `content.js` (id `job-notifier-detect`, all http(s), top frame only) only while `autoDetect === true` and all-sites access is held. It re-syncs on install/update, startup, `permissions.onAdded`/`onRemoved`, and `autoDetect` changes. `onAdded` with all-sites access sets `autoDetect: true`, which covers the popup closing during Chrome's dialog. When off, it unregisters, calls `chrome.permissions.remove`, clears `prompts`, and sends `STOP` to open tabs. Revoking site access in Chrome sets `autoDetect: false`.
- **Contract for the popup and settings switch (engineer C):** to turn it on, call `if (await chrome.permissions.request({ origins: JN.ALL_SITES })) await chrome.storage.local.set({ autoDetect: true })` from the click handler. To turn it off, call `chrome.storage.local.set({ autoDetect: false })` (the worker removes the permission). Show the switch as on only when `autoDetect === true && await chrome.permissions.contains({ origins: JN.ALL_SITES })`, and listen to `chrome.storage.onChanged` for `autoDetect`. The `permissions.request` call that the criterion 36 test looks for belongs in this UI code.
- **Contract for the overlay page (engineer C):** content.js frames `chrome.runtime.getURL('overlay.html')` (no query or hash) in a full-viewport transparent iframe with `title="Job Notifier"`, `allow="clipboard-write"`, inline `!important` styles, and `color-scheme: normal`. Keep the overlay's html and body backgrounds transparent and don't set another color-scheme. content.js remembers and restores host focus, and calls `iframe.focus()` before and after load. The overlay page never reads the URL, `postMessage`, or the host page.
  1. On load: `chrome.runtime.sendMessage({ type: 'OVERLAY_STATE' })` replies `{ state: 'none' }` (nothing for this tab, so send OVERLAY_CLOSE) or `{ state: 'prompt', posting: { title, meta }, hasKey }`. `posting` is `JN.postingLabel` output, and `hasKey: false` means the no-key variant.
  2. Find friends or Try again: `const port = chrome.runtime.connect({ name: 'analyze' }); port.postMessage({ type: 'ANALYZE_TAB' })`. No job text is sent. There is one reply: `{ ok: true, result: { job, matches } }`, `{ ok: false, code: 'NO_API_KEY' }`, `{ ok: false, code: 'NO_FRIENDS', friends: 'empty' | 'none-included' }`, `{ ok: false, code: 'NO_POSTING' }` (the prompt state is gone), or `{ ok: false, error: { title, body, action } }` with `action` 'settings' | 'billing' | 'retry' | null. Repeat clicks while one is running share the same request. If the port closes with no reply, use `JN.ERRORS.restarted`. For your own 90 s timer, use `JN.ERRORS.timeout`.
  3. Close (Close, Not now, Escape, scrim): `chrome.runtime.sendMessage({ type: 'OVERLAY_CLOSE' })`. The worker clears the tab's state and tells the content script to remove the frame and return focus.
  4. Settings: call `chrome.runtime.openOptionsPage()` (or `chrome.tabs.create` with `options.html#friends`) from the overlay page itself.
  The popup uses the same port with `{ type: 'ANALYZE_JOB', jobText }` and gets the same replies.
- Worker gates: content messages must pass `JN.isValidContentMessage` and are ignored when auto-detect is off. OVERLAY_* messages and the `analyze` port need `JN.isExtensionPage`; a content script that connects is disconnected. Overlay state is keyed by `sender.tab.id` and only returned while the tab is still on the origin that reported the confirmation. A URL change to another origin, closing the tab, and OVERLAY_CLOSE clear it. Each posting is offered once (`prompted`). `recallPosting` has no any-tab fallback.
- Page reading: `visibleText` and `extractJobText(doc)` moved from content.js into lib/core.js so the popup can run them through `chrome.scripting.executeScript` (inject `lib/core.js`, then `func: () => JN.extractJobText(document)`). Non-http(s) tabs get the "Chrome doesn't let extensions read this page" copy; a failed read gets the reload copy.
- Test output: `npm test` runs 82 tests: 65 pass, 17 fail. `npm run check --script-shell=bash` passes. All 48 core.test.js tests pass, including the 15 originals. Every remaining failure waits on engineer C:
  - Settings and popup pages: 7, 14, 15, 34 (key field), 16 (options.html PRIVACY link), and 36 (`permissions.request` plus the explainer copy).
  - `overlay.html` doesn't exist yet: 12, 19, 23 (both), 30, 31.
  - Look: 22 (all four tests: popup.html symbols, popup.css/options.css radii, colors, fonts).
  - 21 (store assets).
- For the reviewer and the Chrome walkthrough. None of this could be verified here: branded Chrome no longer loads unpacked extensions from the command line, and nothing in the repo drives one.
  - `use_dynamic_url`: check that `chrome.runtime.getURL('overlay.html')` from content.js loads the frame, and that the overlay's messages pass `isExtensionPage`, which requires `sender.url` to start with `chrome-extension://<runtime id>/`. If Chrome reports the dynamic ID in `sender.url`, the overlay gets no replies, and security needs to decide on the check.
  - 1.x saved the model explicitly, so upgraders who never changed it keep `claude-opus-5-5` (it's on the allowlist). Only new installs get Haiku 5.5. Say if upgraders should be moved to the new default once.
  - Stored friends that fail `cleanFriends` (possible from 1.x) are skipped for matching (`JN.storedFriends`), not sent.
  - Interim: popup.js's switch and options.js's checkbox still write `autoDetect` without requesting the permission. The worker resets it to false, so nothing runs, but the switch looks on until engineer C rebuilds both pages.
  - DOCS.md mentions `analyzed`; it is now `prompted`. PRIVACY.md's session-store line should also mention the posting text (`jobs[].text`, up to 8,000 characters).

**Engineer B, docs synced to engineer A's code:**
- DOCS.md: the storage table now lists `settings`, `autoDetect`, and `friends` (local) plus `jobs`, `prompts`, and `prompted` (session), and says analysis results are never stored. No mention of `analyzed` or `lastJob` remains. The auto-detect section, flow diagram, sender checks, and a new Messages table cover `JOB_SEEN`, `CONFIRMATION_SEEN`, `CLOSE_OVERLAY`, `STOP`, `OVERLAY_STATE`, `OVERLAY_CLOSE`, `ANALYZE_TAB`, and `ANALYZE_JOB`, checked against background.js. The request section names the three models (Haiku 5.5 default), the efforts, and that Haiku has no refusal fallback.
- PRIVACY.md: the session rows say the posting text (up to 8,000 characters), address, title, and time stay until the tab or Chrome closes, list the pending prompt and the offered-posting fingerprints, and say results aren't stored. The earlier "and analysis results" wording was wrong and is gone.
- README and the store listing name Haiku 5.5 (default), Sonnet 5.5, and Opus 5.5. The listing's web-history answer now says "until the tab or Chrome closes". `clipboardWrite` justifications stay.
- `npm test`: 82 tests, 65 pass, 17 fail. `npm run check --script-shell=bash` passes. Mine still failing, all waiting on engineer C: 16 (options.html has to link PRIVACY.md), 19 (`overlay.html` is referenced but doesn't exist yet), and 21 store assets.
