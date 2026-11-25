# Progress: public release (v2.0.0)

Spec: [docs/specs/public-release.md](docs/specs/public-release.md). Branch: `feat/public-release` (stacked on `chore/claude-test-hook`, PR #4).

## Done
- Spec with 38 acceptance criteria; all user decisions recorded (Decisions 1–20).
- Secret/history check: no API key ever committed (criterion 1).
- Design and Security sections; fonts downloaded with checksums (criterion 38).
- Tests: 82 in `test/core.test.js` and `test/release.test.js`.
- Engineer A: lib/core.js helpers, background.js, content.js (detection + iframe), manifest v2.0.0, CI update, friends.json removed.
- Engineer B: PRIVACY.md, LICENSE (MIT), README, DOCS.md, docs/store-listing.md, packaging script, .gitattributes.

## Next
- Engineer C: overlay.html/js/css, popup and settings restyle, friends form, auto-detect switch, icon SVGs. Started (ui.css, ui.js), interrupted by a usage limit.
- Engineer D: rasterize icons, make store screenshots and promo tile (criterion 21).
- Reviews: reviewer, designer (screenshots), security. Then qa full run, pm close-out and retro.
- Real-Chrome walkthrough (criterion 23 and the manual checks in the spec's handoff log), including whether `use_dynamic_url` breaks the overlay's sender check.

## Blocked
- Nothing blocked on the user. The real-Chrome walkthrough needs someone to load the extension unpacked in Chrome; the team can't do that from here.
