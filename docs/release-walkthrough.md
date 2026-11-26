# Job Notifier 2.0.0: real-Chrome release walkthrough

This script covers every manual check in [public-release.md](specs/public-release.md) and [passphrase-storage.md](specs/passphrase-storage.md) that needs a real Chrome. Run it top to bottom in one clean profile. Section 12 erases data, so keep it near the end.

- **[Blocker]** marks a step where a failure stops the release: security, privacy, data loss, a Claude call you didn't click for, or a broken core flow. Report any other failure too. The lead decides whether to fix it now or accept it.
- Each step lists the criterion it proves: plain numbers are public-release criteria, P-numbers are passphrase criteria.
- Not in this script: CI, reading the docs (criteria 3, 16, 20, 21, and the docs part of P-09), and the zip and font checks that `npm test` already runs (19, 38).
- You need a real Anthropic API key with a spend limit set. The run makes about 10 Claude Haiku 5.5 calls, which cost well under 10 cents in total. Use the test passphrase `walkthrough-pass-1`, not a real one.

## Pre-checked steps and what's still manual

On 2026-11-26, [walkthrough-auto/precheck.js](walkthrough-auto/precheck.js) ran this script in headless Chrome 157 and Edge 158, with mocked Anthropic replies and no real key. The results and evidence are in [walkthrough-auto/RESULTS.md](walkthrough-auto/RESULTS.md). Each automated step below has a "Pre-checked" line. Headless can't show Chrome's toolbar, window, or permission dialog, and the all-sites steps ran on a test copy of the manifest, so these steps still need you in real Chrome:

1. **Setup (section 0):** build, unzip, serve the pages, load unpacked, and note the ID.
2. **5.1 to 5.5, Chrome's permission dialog on the release build:** the dialog's wording and screenshot, then Deny (5.1) and Allow (5.2). After turning auto-detect off, `permissions.contains` must return `false` and Details must show no all-sites access (5.3). The dialog opens straight from settings (5.4). Remove the grant on the Details page (5.5).
3. **7.1 and 7.2 (FAIL in the pre-check):** check whether real Chrome also logs `"status":"loading"` for `pushState` and hash changes, and what Find friends does afterwards.
4. **7.4:** turn auto-detect off from the popup while the prompt shows. The overlay must go at once.
5. **8.4:** double-click Find friends on the overlay prompt (FAIL in the pre-check: the overlay closes), and use DevTools Offline (the run simulated offline by failing the request).
6. **10.1 and 10.5:** paste into Notepad, and check that the mail app opens a draft (the run captured the `mailto:` URL instead of launching it).
7. **11.5:** the toolbar icon and the overall look.
8. **13.1 to 13.3:** the whole-window `screenshot-2-popup.png`.
9. **Report screenshots:** 5.1 needs Chrome's dialog from a real window. Headless copies of 1.2, 2.3, 3.1, 3.4, 6.1, 6.4, and 11.5 are in the run's `shots` folder, if the lead accepts them.

Optional: 4.8 with **Exit** from Chrome's menu (the run closed headless Chrome through the DevTools protocol, then relaunched it on the same profile).

**Shortest path through the manual steps:** Setup, 2.2 (passphrase), 3.3 (key), 3.6 (import `demo-friends.json`), 5.1 to 5.6, 7.1, 7.2, 7.4, 8.4, 10.1, 10.5, 11.5, 13.1 to 13.3. Every other step passed all of its automated checks. Whether to skip or spot-check those is the lead's call.

## 0. Setup

**Build and unzip** (PowerShell, from the repo root):

```powershell
cd "C:\Users\jairg\Desktop\Stuff\Prgrm Portfolio\job-notifier"
npm run package --script-shell=bash
# If "bash" resolves to WSL, use: npm run package --script-shell="C:\Program Files\Git\bin\bash.exe"
Get-FileHash dist\job-notifier-2.0.0.zip -Algorithm SHA256
Remove-Item -Recurse -Force "$env:TEMP\job-notifier-2.0.0" -ErrorAction SilentlyContinue
Expand-Archive dist\job-notifier-2.0.0.zip -DestinationPath "$env:TEMP\job-notifier-2.0.0"
```

**Serve the test pages** in a second terminal and leave it running. The pages serve `docs/`, so they can reuse the store-shot stylesheet in `docs/assets/harness/`.

```powershell
npx --yes http-server docs -p 8080 -c-1
# or: python -m http.server 8080 --directory docs
```

Chrome resolves every `*.localhost` name to this machine. `kestrel-grid.localhost` is the job site and `hire-portal.localhost` is "another site". Everything is under `/walkthrough-pages/`:

| File | Use |
|---|---|
| `posting.html` | The job posting. Each load gets a new Job ID, so it counts as a new posting (each posting is offered only once). Its links lead to every confirmation page below. |
| `confirmation.html` | "Thanks for applying" page with an autofocused **Download receipt** button. |
| `loud-css.html` | The confirmation page with `* { color: red !important; font-size: 30px !important }`. |
| `spa.html` | One-page form. **Submit application** changes the URL with `pushState` and shows "Application submitted" without a page load. |
| `xss-posting.html` | Posting whose page title and job title contain `<img src=x onerror=alert(1)>`. |
| `frame-test.html` | Frames whatever overlay URL you paste. |
| `demo-friends.json`, `xss-friends.json`, `bad-import.json` | Import files: 4 fictional friends, 1 friend with an HTML payload, and broken JSON. |

**Clean profile.** Launch Chrome with the posting already open, so that tab exists before the extension is installed (step 3.11 needs it). Don't touch that first tab until step 3.11.

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:TEMP\jn-walkthrough-profile" --no-first-run --window-size=1280,800 http://kestrel-grid.localhost:8080/walkthrough-pages/posting.html
```

**Install.** In a new tab, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `%TEMP%\job-notifier-2.0.0`. Note the extension **ID** on the card. Pin Job Notifier from the puzzle-piece menu.

**DevTools you'll use:**
- **SW console / SW Network:** on the card, click **Inspect views: service worker**. In Network, check **Preserve log**. Keep this window open, except where a step says to close it.
- **Page console:** F12 on the web page, Console tab, context dropdown set to **top**.
- **Overlay console:** the same page DevTools with the context dropdown set to the `overlay.html` frame.
- **Popup console:** right-click the toolbar icon and choose **Inspect popup**. This keeps the popup open.

## 1. Install and first run

- [ ] **1.1 [Blocker]** Expect: the card shows Job Notifier 2.0.0 with no **Errors** button, and a settings tab opens by itself. Its heading is "Create a passphrase", with the lede "Create a passphrase to encrypt your API key and friends list in this browser." The Claude and Friends sections are hidden, and Auto-detect and Privacy and data are visible. (P-10, 19, P-05)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **1.2 [Blocker]** On the card, open **Details**. Expect: nothing under Permissions or Site access mentions all sites or all websites, and api.anthropic.com is the only site listed. Take a screenshot. An unpacked load shows no install dialog; Chrome's permission prompt is captured in 5.1. (4, P-09)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: Report screenshot of the Details page from real Chrome, if the lead wants one from a windowed run.
- [ ] **1.3** Open the popup. Expect: the heading "Set up Job Notifier" with "Job Notifier encrypts your Anthropic API key and friends list in this browser. Open settings to create a passphrase…", a primary **Open settings** button, no error styling or "failed" wording, no footer, and the Auto-detect switch off. (P-06, 7, 11)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **1.4** In settings, find the Auto-detect section. Expect: "Off unless you turn it on.", the switch off, and help text ending "Nothing is sent until you click Find friends." (7, 36)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.

## 2. Passphrase setup

- [ ] **2.1** Click **Create passphrase** three times, with different input each time:
  - Both fields empty. Expect: "Enter a passphrase." and a red border on Passphrase, with focus there.
  - `short` in both fields. Expect: "Use at least 8 characters (not all spaces)."
  - `walkthrough-pass-1` and `walkthrough-pass-2`. Expect: "Passphrases don't match. Enter the same passphrase in both fields." and a red border on Confirm passphrase, which is cleared and focused. (P-05)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **2.2 [Blocker]** Enter `walkthrough-pass-1` in both fields and click **Create passphrase**. Expect: "Encrypting and saving…", then "Passphrase created. Unlocked for this session." The vault section turns into "Passphrase lock" with **Lock now**, Claude and Friends appear, and both passphrase fields are empty. SW Network logs no request. (P-01, P-05)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **2.3** Open the popup and take a screenshot. Expect: "Set up Job Notifier" with "…It uses your own Anthropic API key, so you pay Anthropic directly for each analysis…", no warning icon, and no "failed" wording. The footer reads "Unlocked for this session" and **Lock now**. (11, P-06)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.

## 3. Settings

- [ ] **3.1** Take a screenshot of the disclosure box above the key field. Expect the title "What it costs and what gets sent", plus all of these:
  - billing to your own Anthropic account
  - "the job posting text (up to 8,000 characters), and each included friend's name, skills, interests, and level"
  - **Never sent:** email addresses and the recruiter link, and "Your passphrase never leaves this browser."
  - **Encrypted with your passphrase.**

  The key field is masked, with no show toggle. (15, P-09)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.2** Open the Model menu. Expect exactly these three, with Haiku selected: "Claude Haiku 5.5 (default, lower cost)", "Claude Sonnet 5.5", and "Claude Opus 5.5". (14)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.3 [Blocker]** Paste your API key and click **Save**. Expect: "Saved. Next, add at least one friend below." The field stays masked and SW Network logs no request. (P-07, P-01)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.4 [Blocker]** Check Friends and the popup, and take a screenshot of each:
  - Friends section. Expect: "No friends yet. Add the people you'd share job postings with.", the add form open, and no **Export JSON** button.
  - Popup. Expect: "Add a friend first", "Your friends list is empty, so there's no one to match a posting to.", and **Add friends**. Clicking it opens settings at Friends. (2, P-06)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.5** Add a friend named `Test Friend` with the email `not-an-email`. Expect: "Enter an email like name@example.com, or leave it blank.", a red border, and focus on Email. Change the email to `test.friend@example.com`. Expect: "Added Test Friend." (13, P-07, 12)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.6** Click **Import JSON** and pick `demo-friends.json`. Expect: "demo-friends.json has 4 friends. Your list has 1." Click **Add to my list**. Expect: "Added 4 friends from demo-friends.json." and 5 friends in the list. (13, P-07)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.7 [Blocker]** Import `bad-import.json`. Expect: "Couldn't import bad-import.json: it isn't valid JSON." The list still has 5 friends. (P-07, 35)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.8** Make three changes:
  - Edit Test Friend's level to `Senior`. Expect: "Saved changes to Test Friend."
  - Uncheck **Include** for Dana Okafor. Expect: an "Excluded" chip.
  - Click **Remove** on Test Friend. Expect: a dialog asking "Remove Test Friend from your friends list?". **Cancel** keeps the friend. **OK** removes them and shows "Removed Test Friend." (13, P-07)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.9 [Blocker]** Read the note under Export: "Exports a readable, unencrypted JSON file…". Click **Export JSON** and open the downloaded `job-notifier-friends.json`. Expect: an array of the 4 friends with only name, contact, skills, interests, level, and notify. No API key, settings, or vault fields. (P-07, P2)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.10 [Blocker]** Run this in the SW console:

  ```js
  const local = await chrome.storage.local.get(null);
  const session = await chrome.storage.session.get(null);
  const sync = await chrome.storage.sync.get(null);
  const all = JSON.stringify([local, session, sync]);
  console.log(Object.keys(local), local.settings, local.vault.v, local.vault.kdf, Object.keys(session), sync);
  console.log(['sk-ant-', 'Priya', 'priya.shah@example.com', 'walkthrough-pass-1'].map(s => `${s}: ${all.includes(s)}`));
  globalThis.iv1 = local.vault.cipher.iv;
  ```

  Expect:
  - `local` has `vault` and `settings` and no `friends`.
  - `settings` is `{ model, effort, threshold }` with no `apiKey`.
  - `vault.v` is 1, and `kdf` is PBKDF2, SHA-256, 600000 iterations, with a salt.
  - `session` has `vaultKey`, and `sync` is `{}`.
  - All four `includes` checks print `false`.

  Then check Dana's **Include** again (she stays included from here on), and run `(await chrome.storage.local.get('vault')).vault.cipher.iv !== iv1`. Expect `true` (a fresh nonce on every write). Paste the output into your report. (P-01, P-02, 34)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.11 [Blocker]** Switch to the first tab, the one opened before install and never reloaded, and click the toolbar icon. Expect: "Job posting found" with the posting text in the box. Not "Couldn't read this page". Don't click **Find friends**. (5)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **3.12** Clear the key field and click **Save**. Expect: "Saved. Your API key was removed from this browser." The popup now shows the "Set up Job Notifier" setup state. Paste the key back and click **Save**. Expect: "Saved." (P-07)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.

## 4. Lock, unlock, and restart (P1)

- [ ] **4.1 [Blocker]** In settings, click **Lock now**. Expect:
  - "Locking…", then the heading "Unlock saved data" and "Locked. Your API key and friends were cleared from memory."
  - Claude and Friends are hidden.
  - In the SW console, `await chrome.storage.session.get('vaultKey')` returns `{}`.
  - The popup shows "Locked" with **Open settings to unlock** and no footer.

  (P-04, P-05, P-06)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **4.2 [Blocker]** In the SW console, run `globalThis.before = JSON.stringify((await chrome.storage.local.get('vault')).vault)`. Then unlock with `wrong-pass-123`. Expect:
  - "Unlocking saved data…", then "Wrong passphrase. Try again, or use Forgot passphrase? to erase saved data and start over."
  - A red border on the field, which is cleared and focused, and the vault stays locked.
  - `JSON.stringify((await chrome.storage.local.get('vault')).vault) === before` returns `true`.

  (P-04, P-05, P-02)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **4.3 [Blocker]** Unlock with `walkthrough-pass-1`. Expect: "Passphrase lock", the key field filled and masked, and 4 friends with Dana not excluded. SW Network logs no request. (P-04, P-01)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **4.4** Open a second settings tab (right-click the icon and choose **Options**). Expect each of these to show up in tab B without reloading it:
  - **Lock now** in tab A. Tab B switches to "Unlock saved data", and its key field and friend list are gone.
  - Unlock in tab A. Tab B shows "Passphrase lock" and the friends.
  - Exclude Marcus in tab B. Tab A shows the "Excluded" chip.

  Include Marcus again afterwards. (P-04, P-05)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **4.5 [Blocker]** On the posting tab, open the popup and click **Lock now** in the footer. Expect: the "Locked" heading, focused, and both settings tabs switch to "Unlock saved data". (P1, P-04, P-06)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **4.6** Click **Open settings to unlock** in the popup and unlock. Reopen the popup on the posting tab. Expect: "Job posting found" again, and SW Network logs no request. (P-06)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **4.7** Close the SW DevTools window. Open `chrome://serviceworker-internals`, find `chrome-extension://<ID>/`, and click **Stop**. Reopen the popup. Expect: still unlocked ("Job posting found", with the footer). Reopen SW DevTools and check **Preserve log**. (P-04)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **4.8 [Blocker]** Quit Chrome from the menu (⋮, then **Exit**) and relaunch it with the Setup command. Expect:
  - The popup shows "Locked".
  - Settings shows "Unlock saved data".
  - In SW DevTools (reopened), `await chrome.storage.session.get(null)` returns `{}`.

  Unlock with `walkthrough-pass-1`. Keep SW DevTools open with **Preserve log** from here to the end. (P-04, P1)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Optional: quit with **Exit** from Chrome's menu. The run closed headless Chrome through the DevTools protocol, relaunched it on the same profile, and found it locked with the session empty.

## 5. Auto-detect and permissions

Paste these into the SW console whenever a step says "snippets":

```js
await chrome.scripting.getRegisteredContentScripts();
await chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] });
```

- [ ] **5.1 [Blocker]** In the popup, click the Auto-detect switch. Expect: the switch stays off and a panel opens: "Turn on auto-detect?", "Job Notifier will read the visible text of pages you open… Nothing is sent to Claude until you click Find friends. Chrome will ask you to allow access to all sites." Click **Continue**. Chrome's dialog asks to read and change data on all websites; take a screenshot of it. Click **Deny**. Reopen the popup. Expect: the switch is off. If the popup stayed open, it reads "Chrome didn't grant site access, so auto-detect is still off." (36, 4)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: Chrome's permission dialog (wording, screenshot), Deny, and the "Chrome didn't grant site access" line.
- [ ] **5.2 [Blocker]** Repeat, and this time click **Allow**. Reopen the popup. Expect: the switch is on. Snippets: one script with id `job-notifier-detect`, js `['lib/core.js', 'content.js']`, matching both patterns, then `true`. Details shows all-sites access. (36, 4, 23)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: Chrome's dialog and the Allow click on the release build. The run granted access through Chrome's site-access control on the test copy, which fires the same permissions.onAdded the worker listens to.
- [ ] **5.3 [Blocker]** In settings, turn the switch off. Expect: "Auto-detect is off." Snippets: `[]`, then `false`. Details shows no all-sites access again, and the popup switch is off. (36, Decision 14)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: permissions.contains returning false and Details showing no all-sites access (release build only).
- [ ] **5.4** In settings, turn the switch on. Expect: Chrome's dialog appears right away, with no extra panel because the explanation is already on the page. Click **Allow**. Expect: "Auto-detect is on." (36)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: Chrome's dialog appearing right away, then Allow (the test copy already holds access, so Chrome answered without a dialog).
- [ ] **5.5 [Blocker]** On `chrome://extensions`, open Details and remove the all-sites grant under Site access (choose **On click**, or remove the entry). Expect: the switch shows off in both the popup and settings. Settings may read "Auto-detect is off because site access was removed in Chrome's extension settings." Snippets: `[]`, then `false`. (36)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: Remove the grant on the release build's Details page (the run used Chrome's site-access control on the test copy).
- [ ] **5.6** Turn auto-detect back on and allow it. Leave it on for sections 6 to 10.
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.

## 6. Overlay and isolation

Before each overlay step, press F5 on `posting.html` so it counts as a new posting.

- [ ] **6.1 [Blocker]** Click **Apply now**. Expect within about 2 seconds:
  - A dimmed page with a panel at the top right. The panel shows the "Job Notifier" eyebrow and **Close**.
  - The heading "Find friends for this job?" above a block with "Data Engineering Intern | Kestrel Grid" and "Viewed on kestrel-grid.localhost just now".
  - The body "Job Notifier will send this posting's text and your included friends' names, skills, interests, and level to Claude. It's billed to your Anthropic API key."
  - **Find friends** and **Not now** buttons.

  SW Network logs no api.anthropic.com request. Take a screenshot. (6, 30)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **6.2 [Blocker]** Click **Find friends**. Expect: "Finding friends…", then "{n} friends might want this job" with a job summary, the recruiter field, and match cards. SW Network logs exactly one POST to `api.anthropic.com/v1/messages`, after the click. (6, 23, 33)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **6.3 [Blocker]** While the results are showing, run this in the page console. Use a friend name that's on screen.

  ```js
  const name = 'Marcus Lee', title = 'Data Engineering Intern';
  [document.body.innerText.includes(name),
   [...document.querySelectorAll('*')].some(el => el.textContent.includes(name)),
   document.documentElement.outerHTML.includes(title),
   window.find(name)];
  ```

  Expect `[false, false, false, false]`. Close the overlay. (8, 30)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **6.4 [Blocker]** Reload the posting and click **Apply, confirmation page with aggressive CSS**. Expect: the page text is huge and red, but the overlay looks the same as in 6.1 (dark text at normal size, teal buttons, serif heading). Take a screenshot, then click **Not now**. (8)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **6.5 [Blocker]** Reload the posting in tab A. Press Ctrl+N and open `http://kestrel-grid.localhost:8080/walkthrough-pages/confirmation.html` in that new window. Expect: no prompt after 5 seconds. Close the window. In tab A, click **Apply on the partner site (opens a new tab)**. Expect: the new hire-portal.localhost tab shows the prompt, with "Viewed on kestrel-grid.localhost just now". Click **Not now**. (37, 23)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **6.6** In settings, click **Lock now**. Reload the posting and click **Apply now**. Expect: "Your saved API key and friends list are locked. Open settings to unlock them, then return here to run the check." with **Open settings to unlock** and **Not now**. Click **Open settings to unlock**, unlock, and switch back to the confirmation tab. Expect: the normal prompt with **Find friends**, focus on the heading, and no request in SW Network. (P-06, P-03)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **6.7 [Blocker]** Click **Find friends**, then within 2 seconds switch to settings and click **Lock now**. Go back to the confirmation tab. Expect: "Job Notifier is locked" with "Your saved API key and friends list were locked, so any results were cleared. Open settings to unlock." No match cards ever appear, and the request in SW Network shows as canceled or unused. (P-06, P-04)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **6.8 [Blocker]** Unlock. On the posting tab, open the popup, click **Find friends**, and right away click **Lock now** in the footer. Expect: "Locked". Reopen the popup 30 seconds later. Expect: still "Locked", with no results. Unlock again. (P-06, P-04)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. The run held the reply for 3 s and reopened the popup after 5 s instead of 30 s. Nothing left to check by hand.

## 7. Navigation

First, log tab updates in the SW console:

```js
chrome.tabs.onUpdated.addListener((id, info) => console.log('onUpdated', id, JSON.stringify(info)));
```

- [ ] **7.1** Reload the posting and click **Apply with the one-page form**, then **Submit application**. Expect: the URL ends `?step=done`, the heading reads "Application submitted", and the prompt appears within about 2 seconds. The `onUpdated` line for the `pushState` has no `"status":"loading"`. (31, security round 1)
  > Pre-checked in headless Chrome 157 and Edge 158: FAIL. For the `pushState`, both browsers logged `{"status":"loading","url":"…/spa.html?step=done"}` and then `{"status":"complete"}`. The prompt still appeared about 1.1 s after Submit, because the confirmation showed after the URL change. Still manual: confirm the log line in real Chrome.
- [ ] **7.2** With the prompt showing, run `history.pushState({}, '', '?step=receipt')` and then `location.hash = 'receipt'` in the page console. Expect: `onUpdated` lines with the new URLs and no `"status":"loading"`. The prompt stays, and **Find friends** returns results instead of closing the overlay. If Chrome does log `loading`, paste the exact lines: the prompt is then cleared in single-page apps. (31)
  > Pre-checked in headless Chrome 157 and Edge 158: FAIL. Both browsers logged `"status":"loading"` for the `pushState` and for the hash change, and the worker dropped the tab's prompt. Find friends then stayed on "Finding friends…" and sent no request, and Close and Escape didn't remove the overlay until the page was reloaded. Still manual: confirm in real Chrome.
- [ ] **7.3 [Blocker]** Reload the posting, click **Apply now**, and when the prompt shows, press F5 on the confirmation page. Expect: the overlay disappears, the log shows `"status":"loading"`, and no prompt comes back after the reload, because each posting is offered once. In the SW console, `(await chrome.storage.session.get('prompts')).prompts` has no entry for this tab. (31)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **7.4 [Blocker]** Reload the posting and click **Apply now** to get the prompt. Open the popup on that tab and turn Auto-detect off. Expect:
  - The overlay is removed from the page at once.
  - In the page console, `document.activeElement.textContent` returns `"Download receipt"`.
  - The section 5 snippets return `[]` and `false`.

  Turn auto-detect back on and allow it. (36, security round 2)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: Turning auto-detect off from the popup on the release build: the overlay must go at once (the test copy stops at chrome.permissions.remove).

## 8. Security negatives

- [ ] **8.1 [Blocker]** Use a `sender.url` breakpoint to check the overlay's sender and that the frame stays inert until it's ready.
  - Reload the posting and wait 2 seconds. In SW DevTools, open **Sources**, then `background.js`, and click line number 704 (`if (JN.isValidContentMessage(msg, sender, chrome.runtime.id)) {`) to set a breakpoint.
  - Click **Apply now**. The worker pauses. In the SW console, `[msg.type, sender.url, sender.frameId]` returns `['CONFIRMATION_SEEN', 'http://kestrel-grid.localhost:8080/walkthrough-pages/confirmation.html', 0]`. If a different `msg.type` comes first, press F8 until you get this one. Then press F8.
  - It pauses again. `[msg.type, sender.url, sender.frameId, sender.id === chrome.runtime.id, new URL(sender.url).host === chrome.runtime.id]` returns `['OVERLAY_STATE', 'chrome-extension://…/overlay.html', <number above 0>, true, <true or false>]`. Write down the last value: `false` means Chrome reports the dynamic ID, which the check accepts.
  - Stay paused for 6 seconds or more, then click **Download receipt** on the page. Expect: it changes to "Receipt clicked" (the page stays clickable while the frame isn't ready). The frame is gone after 5 seconds: Elements shows no `iframe[title="Job Notifier"]`.
  - Click the line number to remove the breakpoint, then press F8. Expect: the overlay doesn't come back, and no api.anthropic.com request is logged.

  (31, 32a, security rounds 1 and 2)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **8.2 [Blocker]** Check what a page can frame.
  - In a new tab, open `frame-test.html`. Enter `chrome-extension://<ID>/overlay.html` with the ID from the card and click **Frame it**. Expect: the frame shows Chrome's blocked-page error or stays blank, and the page console logs "Denying load of chrome-extension://…/overlay.html…".
  - On a fresh prompt (reload the posting, then **Apply now**), use page DevTools Elements to copy the `src` of `iframe[title="Job Notifier"]`. Write down whether its host differs from the card's ID. Click **Not now**.
  - Paste that `src` into frame-test and click **Frame it**. Expect: the frame stays empty, with no scrim and no dialog, and no request is logged.

  (31, `use_dynamic_url`)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **8.3 [Blocker]** Check that HTML shows up as literal text everywhere, and that no `alert` dialog ever appears.
  - Import `xss-friends.json` and choose **Add to my list**. Expect: the list shows the name as the literal text `<img src=x onerror=alert(1)>`, and "Skills: <img src=x onerror=alert(1)>, Python, SQL, data pipelines".
  - Open `xss-posting.html` in the posting tab, then open the popup with **Inspect popup** and click **Find friends**. Expect: the job title, and the payload friend's name if it's a match, show as literal text.
  - Click **Apply now** on that page. Expect: the prompt title shows the literal text `<img src=x onerror=alert(1)> Data Engineering Intern | Kestrel Grid`. Click **Find friends** and type `<img src=x onerror=alert(1)>` into one draft. It stays text.
  - In the settings, popup, and overlay consoles, `document.querySelectorAll('img[src="x"]').length` returns `0`.

  Remove the payload friend afterwards. (28)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **8.4 [Blocker]** On the posting, open the popup and double-click **Find friends**. Expect: one new request. Next, set SW DevTools Network throttling to **Offline**, or disconnect from the network. Reopen the popup and click **Find friends**. Expect: "Can't reach Anthropic" with "Check your internet connection. Work networks and VPNs sometimes block api.anthropic.com.", **Try again**, and **Edit text**. Go back online and double-click **Try again**. Expect: exactly one new request, then results. Reload the posting, click **Apply now**, and double-click **Find friends** on the prompt. Expect: one request. (33, 9)
  > Pre-checked in headless Chrome 157 and Edge 158: FAIL. A double-click sent one request in the popup (also for Try again after offline) and on the overlay. But a double-click on the overlay's Find friends closes the overlay: once the panel shrinks to "Finding friends…", the second click lands on the dimmed area, so the results never show. Still manual: DevTools Offline, and the overlay double-click in real Chrome.
- [ ] **8.5 [Blocker]** In the popup console, run:

  ```js
  await chrome.runtime.sendMessage({ type: 'POPUP_STATUS' });
  await chrome.runtime.sendMessage({ type: 'VAULT_GET_DATA' }).catch(e => e.message);
  ```

  Expect `{ vaultState: 'unlocked', hasKey: true, friendsStatus: 'ok' }`, with no key or names. The second call returns `undefined` or an error, never data. Next, lock in settings, reopen **Inspect popup**, and run:

  ```js
  await chrome.runtime.sendMessage({ type: 'VAULT_UNLOCK', passphrase: 'walkthrough-pass-1' }).catch(e => e.message);
  const port = chrome.runtime.connect({ name: 'analyze' });
  port.onMessage.addListener(reply => console.log(reply));
  port.postMessage({ type: 'ANALYZE_JOB', jobText: 'Data engineering intern, Python and SQL, remote internship. '.repeat(3) });
  ```

  Expect: the first call returns `undefined` or an error, and `POPUP_STATUS` still returns `{ vaultState: 'locked' }`. The port logs `{ ok: false, code: 'LOCKED' }`, and no request is logged. Unlock in settings. (P-03, P-06)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.

## 9. Accessibility

- [ ] **9.1** Open the popup on the posting and press Enter right away. Expect: nothing starts. Press Tab repeatedly. Expect this order, each with a 2px teal focus ring: the Auto-detect switch (ring on the track), **Settings**, the Posting text box, **Find friends**, **Lock now**. (12)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **9.2** In settings, Tab through the whole page. Expect: every control (Lock now, key, model, More options and its fields, Save, every friend control, Import, Export, the Auto-detect switch, every link) shows the ring, in the order you see them, with none skipped. The invalid-field red borders were checked in 2.1, 3.5, and 4.2. (12, P-05)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **9.3** Reload the posting. Tab to **Apply now** and press Enter. When the prompt appears, press Enter. Expect: no request, because focus is on the heading. Expect Tab to cycle **Find friends**, **Not now**, **Close**, **Find friends**, with Shift+Tab going the other way. **Download receipt** behind the overlay never gets focus. Press Escape. Expect: the overlay closes and the ring is on **Download receipt**. (12)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **9.4** Reload the posting, click **Apply now**, and click the dimmed area outside the panel. Expect: the prompt closes. Reload the posting again, click **Apply now**, then **Find friends**. Expect: focus moves to the "Finding friends…" heading, then to the results heading. Tab reaches the checkboxes, message boxes, **Open email**, **Copy**, the recruiter field, and the bulk buttons, all with rings. Clicking the dimmed area does nothing in results. Escape closes. (12)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.

## 10. Copy and mailto

Copy all and Open next email need 2 or more matches. If you get fewer, set Match threshold to `0.4` under **More options** in settings and click **Save**.

- [ ] **10.1** On the posting, open the popup with **Inspect popup** and click **Find friends**. Click **Copy** on a card. Expect: "Copied" for 2 seconds, and pasting into Notepad gives that draft. **Copy all** gives all checked drafts. (10, 23)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: Pasting into Notepad (the run read the browser clipboard).
- [ ] **10.2** In the same popup console, run:

  ```js
  navigator.clipboard.writeText = () => Promise.reject(new Error('blocked'));
  document.execCommand = () => false;
  ```

  Click **Copy**. Expect: the label stays "Copy", red text reads "Couldn't copy. The message is selected, so press Ctrl+C (Cmd+C on a Mac).", and the draft box is focused with its text selected. Click **Copy all**. Expect: "Couldn't copy. Copy each message from its box instead." (10)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **10.3** Get overlay results: reload the posting, click **Apply now**, then **Find friends**. Click **Copy**. Expect: "Copied", with the clipboard working inside the frame. Run the 10.2 snippet in the overlay console. Expect: the same two failure messages for **Copy** and **Copy all**. (10)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Copy works, but only through the `execCommand` fallback. `navigator.clipboard.writeText` is blocked by permissions policy inside the frame: `allow="clipboard-write"` covers the frame's dynamic URL, while the frame's document origin is the extension ID. Nothing left to check by hand.
- [ ] **10.4** In the overlay recruiter field, enter `https://example.com/recruiter`. Expect: "That doesn't look like a LinkedIn link, so it won't be included." Replace it with `https://www.linkedin.com/in/example-recruiter`. Expect: "Added to your emails." (23)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **10.5 [Blocker]** Nothing has opened on its own so far. Click **Open email** on one card. Expect: the button reads "Opened" for 2 seconds, and your mail app opens a draft to that friend's example.com address, with the subject and the draft plus the recruiter link as the body. If no mail app is set up, Windows asks which app to use. Nothing is sent. (26, 23)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: The mail app opening a draft (the run captured the mailto: URL instead of launching it).
- [ ] **10.6** Click **Open next email ({n} left)** repeatedly. Expect: one draft per click, the count going down, and then "All checked emails opened", greyed out but still focusable. Uncheck every card. Expect: "Open next email (0 left)", greyed out. (23, 26)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **10.7** Add `See www.example.com/apply` to a draft. Expect: "This draft has a link or email address in it. Check it before you send." appears under the box. Delete the text. Expect: the note disappears. (26)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.

## 11. Network and look

- [ ] **11.1 [Blocker]** In settings, open DevTools Network with **Preserve log** and reload the page. Expect: only `chrome-extension://<ID>/…` requests. Nothing goes to fonts.googleapis.com, fonts.gstatic.com, cdn.jsdelivr.net, or anywhere else. (29, 22)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **11.2 [Blocker]** Open the popup with **Inspect popup**, go to Network, and press Ctrl+R in DevTools. Expect: only `chrome-extension://` requests. (29)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **11.3 [Blocker]** In page DevTools Network on a confirmation page showing the prompt, expect requests only to kestrel-grid.localhost and `chrome-extension://…`: overlay.html, its CSS and JS, the fonts, and icon16.png. (29, 22, 31)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **11.4 [Blocker]** Look at the whole SW Network log since 4.8. Expect: every request is a POST to `api.anthropic.com/v1/messages`, one for each **Find friends** or **Try again** click you made. None appear during setup, unlock, lock, prompts, or saves. The filter `-domain:api.anthropic.com` shows nothing. (29, 6, P-01, P-06)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **11.5** In the popup, settings, and overlay, inspect a heading, open the Computed tab, and check Rendered Fonts. Expect: **Fraunces** for headings and **IBM Plex Sans** for body text. The toolbar icon is a teal tile with a white J. There are no gradients, blur, or emoji, the layouts are left-aligned, and corners are 4px or less. Take screenshots of the popup, settings, overlay, and toolbar icon. (22)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Still manual: Toolbar icon (teal tile, white J), overall look, and the report screenshots.

## 12. Reset and P3 conversion (erases data)

- [ ] **12.1** Make the vault unreadable. In the SW console, run:

  ```js
  globalThis.saved = (await chrome.storage.local.get('vault')).vault;
  await chrome.storage.local.set({ vault: { ...saved, v: 99 } });
  ```

  Reload settings. Expect: "Saved data can't be read", "Unable to unlock saved data", and **Erase and start fresh**. The popup shows "Saved data can't be read" with **Open settings**. In settings, click **Erase and start fresh**, then **Cancel**. Expect: focus goes back to that button, and `(await chrome.storage.local.get('vault')).vault.v` is still `99`. Restore with `await chrome.storage.local.set({ vault: saved })` and reload settings. Expect: unlocked again. (P-05, P-06, P-02)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **12.2 [Blocker]** Test Forgot passphrase:
  - Click **Lock now**, then **Forgot passphrase?**. Expect: a focused "Forgot your passphrase?" panel that lists the key and the friends list and says model settings, Auto-detect, and exported files aren't deleted.
  - Click **Cancel**. Expect: focus goes back to **Forgot passphrase?**, and the vault is unchanged.
  - Open the panel again and click **Erase saved data** without checking the box. Expect: "Check the box to confirm you want to erase your saved data." with focus on the checkbox.
  - Check the box and click **Erase saved data**. Expect: "Erasing saved data…", then "Create a passphrase" and "Saved data erased. Create a new passphrase to start fresh."

  In the SW console, `await chrome.storage.local.get(null)` shows no `vault` and no `friends`, `settings` without `apiKey`, and `autoDetect` unchanged. The popup shows "Set up Job Notifier". (P-08, P-05)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **12.3 [Blocker]** Seed unencrypted pre-encryption 2.0.0 data in the SW console. The key is a fake placeholder.

  ```js
  await chrome.storage.local.set({
    settings: { apiKey: 'sk-ant-placeholder', model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6 },
    friends: [{ name: 'Priya Shah', contact: 'priya.shah@example.com', skills: ['Go', 'PostgreSQL'], interests: ['climate'], level: 'Mid level', notify: true }],
  });
  ```

  Reload settings. Expect: "Encrypt existing saved data" with "Found a saved API key and 1 saved friend stored without encryption.", and no key or name on screen. The popup shows "Set up Job Notifier" and can't analyze. Close the settings tab and reopen it from **Options**. Expect: the same screen, and `await chrome.storage.local.get(['settings', 'friends'])` still returns the seeded values. (P-08)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **12.4** Click **Erase existing data instead**, then **Cancel**. Expect: focus goes back to that button and the data is intact. Do it again, check the box, and click **Erase saved data**. Expect: "Create a passphrase", and `await chrome.storage.local.get(['settings', 'friends'])` shows no `apiKey` and no `friends`. (P-08)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.
- [ ] **12.5 [Blocker]** Run the 12.3 seed again and reload settings. Enter `walkthrough-pass-1` twice and click **Encrypt saved data**. Expect: "Encrypting and verifying saved data…", then "Existing data encrypted and unlocked for this session.", with Friends showing Priya Shah and the key field filled and masked. Rerun the 3.10 snippet. Expect: `vault` is present, `settings` has no `apiKey`, there's no `friends` key, and the `includes` checks for `sk-ant-` and `Priya` are both `false`. (P-08, P-01)
  > Pre-checked in headless Chrome 157 and Edge 158: PASS. Nothing left to check by hand.

## 13. Screenshot 2 (`docs/assets/screenshot-2-popup.png`)

- [ ] **13.1** Get the state ready. The placeholder key from 12.5 is fine, because nothing is sent.
  - The window is 1280x800 from the launch flag.
  - Reload `posting.html` and scroll to the top.
  - Click the toolbar icon. Expect: "Job posting found", the text box filled, **Find friends** visible, and the footer "Unlocked for this session" with **Lock now**. Don't hover over or click inside the popup.
- [ ] **13.2** Press Win+Shift+S and choose **Rectangle**. The screen freezes with the popup still open. Drag exactly around the Chrome window, then save the snip, for example as `Pictures\Screenshots\popup-window.png`.
- [ ] **13.3** Convert it to 1280x800 24-bit RGB, which the store and `npm test` require. Run this from the repo root:

  ```powershell
  Add-Type -AssemblyName System.Drawing
  $src = New-Object System.Drawing.Bitmap "$HOME\Pictures\Screenshots\popup-window.png"
  $dst = New-Object System.Drawing.Bitmap 1280, 800, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($dst); $g.InterpolationMode = 'HighQualityBicubic'
  $g.DrawImage($src, 0, 0, 1280, 800); $g.Dispose(); $src.Dispose()
  $dst.Save("$PWD\docs\assets\screenshot-2-popup.png", [System.Drawing.Imaging.ImageFormat]::Png); $dst.Dispose()
  npm test
  ```

  Expect: the toolbar and popup are visible, and `npm test` passes, including "criterion 21: store assets are the required sizes, PNG without alpha". Don't commit; the lead does that.

## Report back

Send the team lead:

1. Your Chrome version (the first line of `chrome://version`), the zip's SHA-256 from Setup, and the extension ID.
2. This checklist with each step marked pass or **FAIL**, with one line on what happened for each failure. For a failure, include the step number, what you saw, and a screenshot of the window with the relevant DevTools panel showing.
3. The evidence screenshots: 1.2, 2.3, 3.1, 3.4 (both), 5.1, 6.1, 6.4, and 11.5.
4. Console output from 3.10, 5.2, 5.3, 5.5, 7.1 to 7.3, 8.1 (both pauses, including the `true`/`false` host value), 8.2 (whether the frame host differs from the ID), 8.5, and 12.5.
5. The new `docs/assets/screenshot-2-popup.png` and the `npm test` summary line.

Never paste your API key or passphrase, and check that no screenshot shows the key unmasked.
