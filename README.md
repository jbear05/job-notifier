# Job Notifier

Job Notifier is a Chrome extension for passing job postings to friends. Open it on a posting, and Claude scores how well the job fits each friend on your list, then drafts a short message to each good match. You review and edit every draft, then open it in your own email app or copy it.

It runs on your own Anthropic API key. There is no Job Notifier server and no account to create.

## Install

Install **Job Notifier** from the Chrome Web Store. After it installs, the settings page opens in a new tab.

To build it from source instead, see [Development](#development).

## Set up

You need an Anthropic API key and at least one friend on your list.

### 1. Get an Anthropic API key

1. Sign in to the [Claude Console](https://platform.claude.com/) (create an Anthropic account if you don't have one).
2. Add credit under **Billing**. The API is prepaid and separate from any Claude.ai subscription.
3. Open [API keys](https://platform.claude.com/settings/keys), create a key, and copy it. It starts with `sk-ant-`.
4. In Job Notifier's settings, paste it into **Anthropic API key**, pick a model, and click **Save**.

**What it costs.** Job Notifier is free. Each time you click **Find friends**, it sends one request to Anthropic, and Anthropic bills that request to your account at its [API prices](https://platform.claude.com/docs/en/about-claude/pricing). The cost depends on the model, the length of the posting (up to 8,000 characters are sent), and how many friends are included. Settings offers Claude Haiku 5.5 (the default and lowest cost), Claude Sonnet 5.5, and Claude Opus 5.5. Haiku is usually enough for matching. Opening the popup or browsing never costs anything.

Your key is stored unencrypted in your Chrome profile. To cap what it can ever cost, set a [spend limit](https://platform.claude.com/settings/spend-limits) in the Claude Console.

### 2. Add friends

In settings, under **Friends**, click **Add friend** and fill in:

- **Name** (required).
- **Email**, used only to address the draft. It's never sent to Claude.
- **Skills** and **Interests**, separated by commas, for example `Python, React, REST APIs`.
- **Level**, for example internship, new grad, or senior.
- **Include in matching**. Clear it to skip someone for now without removing them.

Each change saves right away. Use **Edit** and **Remove** on a row to change it.

**Import JSON** and **Export JSON** move your list between browsers or back it up. The file is a JSON array in this format:

```json
[
  {
    "name": "Priya Shah",
    "contact": "priya.shah@example.com",
    "skills": ["Go", "PostgreSQL", "distributed systems"],
    "interests": ["climate", "infrastructure"],
    "level": "Mid level",
    "notify": true
  }
]
```

`contact` is the email address (or `""`), and `notify: false` excludes that friend. Imports are limited to 1 MB and 500 friends, and other fields are dropped. If your list already has friends, you choose whether to add to it or replace it. A file that fails to import leaves your list unchanged. Exports include email addresses, so keep the file private.

## Use it

### From the toolbar

1. Open a job posting and click the Job Notifier toolbar button.
2. The popup shows the posting's text. Check it, or paste the posting yourself if the page couldn't be read.
3. Click **Find friends**. After a few seconds you'll see the job summary and a card for each friend who scored at or above your match threshold.
4. Edit any draft. Then use **Open email** to open it in your email app (you still press Send there) or **Copy** to copy it.

With two or more matches, **Open next email** opens the checked drafts one per click, since browsers allow only one new email window per click. **Copy all** copies every checked draft as one block. If you have the recruiter's LinkedIn for the role, paste it in the recruiter field and it's added to each email. That link stays in the browser and isn't sent to Claude.

### Auto-detect (optional)

Auto-detect is **off** until you turn it on. When it's on, Job Notifier notices when you apply to a posting you just viewed and asks whether to find friends for it.

- Turn it on with the **Auto-detect** switch in the popup, or **Ask me to find friends after I apply to a job** in settings. Chrome then asks you to allow access to all sites, because applications happen on many different sites. If you decline, auto-detect stays off.
- With it on, Job Notifier reads the visible text of pages you open, in your browser, to spot job postings and application confirmations.
- When a confirmation page ("Application submitted", "Thanks for applying") follows a posting you viewed in the same tab, or in the tab that opened it, within the last 30 minutes, a **Find friends for this job?** panel appears. It names the posting's title and site.
- Nothing is sent to Claude until you click **Find friends**. **Not now**, **Close**, or Escape dismisses the panel, and it won't ask again for that posting.
- Turning it off stops all page reading and gives back the all-sites access. Chrome asks again if you turn it back on.

## Privacy

- Your key, settings, and friends are stored only in this browser (`chrome.storage.local`). With auto-detect on, postings you view (text, title, and the site's hostname) are kept in memory until you close that tab or Chrome.
- Data leaves your browser only when you click **Find friends**, and only to Anthropic: the posting text (up to 8,000 characters) and each included friend's name, skills, interests, and level. Friends' email addresses and recruiter links are never sent.
- There are no analytics and no developer server.

The full policy is in [PRIVACY.md](PRIVACY.md).

## Permissions

| Permission | Why Job Notifier needs it |
|---|---|
| `activeTab` | Reads the posting on the tab where you clicked the toolbar button, and only that tab. |
| `scripting` | Runs the page-reading script on that tab, and registers the auto-detect script when you turn auto-detect on. |
| `storage` | Saves your settings, key, and friends in this browser, and postings you view in memory until you close that tab or Chrome. |
| `clipboardWrite` | Lets **Copy** and **Copy all** put drafts on your clipboard. |
| `https://api.anthropic.com/*` | Sends the analysis request to Anthropic's API with your key. It's the only server Job Notifier contacts. |
| `https://*/*` and `http://*/*` (optional) | Requested only when you turn on auto-detect, to spot postings and confirmations on job sites. Removed when you turn it off. |

## Troubleshooting

**The popup says it couldn't read the page.** Reload the tab and open Job Notifier again. Or paste the posting text into the box.

**The popup says Chrome doesn't let extensions read this page.** Chrome blocks extensions on pages such as `chrome://` pages, the Chrome Web Store, and its PDF viewer. Paste the posting text instead.

**The popup says this doesn't look like a job posting.** Some sites show the posting in a frame or a layout Job Notifier doesn't recognize. Paste the posting text.

**Auto-detect didn't ask after I applied.**
- Check that auto-detect is on in the popup.
- The posting has to be open in the same tab as the confirmation, or in the tab that opened it, within 30 minutes.
- Pages that were already open when you turned auto-detect on need a reload.
- Confirmations shown inside an embedded frame or only as an image aren't detected.
- Each posting is offered once. If you clicked **Not now**, use the toolbar button instead.

**Auto-detect turned itself off.** Site access was removed in Chrome's extension settings. Turn the switch on again and allow access when Chrome asks.

**"Your API key wasn't accepted."** The key was deleted, revoked, or mistyped. Create a new key in the Claude Console and paste it in settings.

**"Your Anthropic account is out of credit."** Add credit on the Claude Console's billing page, then try again. If you set a spend limit and reached it, raise the limit or wait for the next month.

**"This key can't make that request" or "The selected model isn't available."** Check the key's workspace in the Claude Console, or pick another model in settings.

**"Too many requests right now" or "Anthropic's API is busy."** Wait a minute and click **Try again**.

**"Can't reach Anthropic."** Check your connection. Some work networks and VPNs block `api.anthropic.com`.

**No strong matches.** No included friend scored at or above your match threshold. Lower it under **More options** in settings, or add more skills and interests to your friends.

## Removing your data

- **Everything:** remove Job Notifier on `chrome://extensions`, or right-click its toolbar button and choose **Remove from Chrome**. Chrome deletes everything it stored.
- **Only your API key:** in settings, clear the key field and click **Save**. Revoke the key in the Claude Console too if you no longer need it.
- **Friends:** click **Remove** on each one in settings.
- **Recent postings:** close the tab, or close Chrome.

## Development

Job Notifier has no build step and no runtime dependencies. Node 22 runs the tests.

To run it from a clone, go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the repository folder.

```sh
npm test                                    # unit tests and release checks
npm run check --script-shell=bash           # syntax check every script
npm run package --script-shell=bash         # build dist/job-notifier-<version>.zip
```

`--script-shell=bash` is needed on Windows; elsewhere `npm run check` and `npm run package` work as is.

`npm run package` uses `git archive`, so the zip holds **committed files only**. Commit your changes first. `.gitattributes` keeps tests, docs, CI, and tooling out of the zip; it holds the manifest, scripts, pages, styles, `lib/`, `icons/`, `fonts/`, and `LICENSE`. Upload that zip to the Chrome Web Store.

CI on GitHub runs the same checks on every push and pull request. [DOCS.md](DOCS.md) explains the architecture, storage, and request format. The Web Store listing text is in [docs/store-listing.md](docs/store-listing.md).

## License

[MIT](LICENSE)
