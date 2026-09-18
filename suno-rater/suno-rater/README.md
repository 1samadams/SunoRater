# Suno Rater

1-10 ratings (blue to red) and 256-char notes on Suno songs. Local only: `chrome.storage.local`, no server, no account, no network calls.

## Install (Chrome / Edge / Brave / Arc)
1. Unzip somewhere permanent.
2. `chrome://extensions` -> enable Developer mode -> Load unpacked -> pick this folder.
3. Refresh any open suno.com tabs.

Firefox: `about:debugging` -> This Firefox -> Load Temporary Add-on -> `manifest.json`. You may need to grant suno.com access under the extension's permissions. Temporary add-ons vanish on restart.

## Use
- A `+` badge appears after each song title. Click it, pick 1-10, type a note. Notes autosave.
- With the popover open: keys `1`-`9` rate, `0` = 10, `Esc` closes.
- Yellow dot on a badge = has a note. Hover the badge to read it without opening.
- On a `/song/<id>` page the badge floats bottom-right.
- Toolbar icon: every rated song, sorted by rating, searchable, min-rating filter, JSON export/import, CSV export. Use "Full tab" before Import (popups can close when the file picker opens).

## Sync across browsers and machines
First run asks where to keep your ratings file. Put `suno-ratings.json` inside a folder that Google Drive, OneDrive or Dropbox already syncs: "Create new file" on the first machine, "Use existing file" everywhere else. The choice is remembered. Edits merge per song, newest wins, deletions included. Open it any time from the "Sync" link in the rating popover.

- Needs a Chromium browser (Chrome, Edge, Brave, Arc). Firefox and Safari cannot write to a picked file, so use Export / Import there.
- If the browser asks for file permission again, choose "Allow on every visit".
- The extension and the userscript share the same file format and the same remembered file, so do not run both at once in one browser.
- The sync block in `content.js` is identical to the one in the userscript. Change one, paste into the other.

## How it hooks Suno
It looks for `a[href*="/song/<uuid>"]` links that contain text and inserts the badge right after them, re-scanning on DOM changes. It deliberately ignores Suno's class names, which change constantly. If badges land somewhere awkward or go missing after a Suno redesign, `scan()` in `content.js` is the only function that should need touching.

## Data
Key `s:<uuid>` -> `{ r: rating, n: note, t: title, u: updatedMs }`. Uninstalling the extension deletes storage, so Export first.
