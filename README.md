# Job Notifier

A Chrome extension that detects when you apply to a job and drafts a message to share it with the right group of friends.

## What it does

You sort your friends into groups you make yourself, like Software, Cyber, Law or Health. When you submit a job application, a popup suggests the group that fits the job and drafts a short message. Switch groups with one tap, untick anyone you want to skip, and open one email to the whole group.

## Features

- Auto-detects job application confirmation pages across major job boards, including when the confirmation is on a different site than the posting
- Create, rename and delete your own friend groups; a friend can be in several groups
- Claude suggests the group that fits the job and drafts one short message for it
- One tap to switch groups; one email to the group with everyone in Bcc
- Optionally add the recruiter's LinkedIn for the role, and it's included in the email (kept local, never sent to Claude)
- Toggle auto-detection on/off from the extension popup
- Manual mode: paste any job posting text to run the analysis yourself

## Setup

1. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select this folder. Nothing needs to be built or generated first.
2. The settings page opens automatically. Paste an Anthropic API key (create one at [console.anthropic.com](https://console.anthropic.com/settings/keys)), make a few groups, add your friends and tap the groups each one belongs in, then click **Save**. You can reopen settings from the gear icon in the popup.

If you used an older version with a JSON friends list, everyone is moved into an **Everyone** group the first time the new version runs, so nobody is lost. Rename it or split people into new groups whenever you like. Anyone who had `"notify": false` is kept but left out of every group.

Your key, groups and friends are stored only in Chrome's extension storage on your machine. Claude only sees the job posting and your group names. Your friends' names and emails never leave the browser.

## Usage

**Auto mode (default):** Browse to a job posting, apply normally, and the overlay appears on the confirmation page. Each posting is analyzed at most once.

**Manual mode:** Click the extension icon. If the page is a job posting, its text is pre-filled; otherwise paste the text. Click **Draft a message**. Opening the popup by itself never calls Claude.

**Toggle:** Use the switch in the popup header to turn auto-detection on or off.

## Development

```sh
npm test        # unit tests for detection, prompt building, and response parsing
npm run check   # syntax check every script
```

The same checks run on GitHub for every push and pull request.

## Supported job boards

Auto-detection works on any site that shows a text confirmation after applying — including LinkedIn, Greenhouse, Lever, Workday, Indeed, and most ATS platforms. If a site isn't detected, use manual mode. Confirmations shown inside an embedded iframe aren't detected yet.
