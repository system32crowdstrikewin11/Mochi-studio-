# Mochi Studio — Update Notes

Checklist for applying a new version drop (v22 onward) and keeping our customizations.
The version drops from the shared folder do **not** include the custom bits below, so they must be re-applied every time.

---

## 1. Source of truth

New versions arrive at:

```
~/storage/shared/aemulator/mochi-studio
```

If that folder is missing, do not guess — get the new path from the person providing the update.

---

## 2. Update routine

### 2.1 Stop the running server

```bash
ps -A -o pid,args | grep "server.js" | grep -v grep
kill <PID>
```

### 2.2 Back up the current version (keep `.git` out of the archive)

```bash
cd ~
tar -czf mochi-studio-v<CURRENT>-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  --exclude='mochi-studio/.git' mochi-studio
```

### 2.3 Replace files, preserving git history

```bash
SRC=~/storage/shared/aemulator/mochi-studio
DST=~/mochi-studio

# delete everything except .git
find "$DST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

# copy the new drop
cp -a "$SRC"/. "$DST"/

# never ship python bytecode
rm -rf "$DST/__pycache__"

ls -A "$DST"
```

### 2.4 Syntax check

```bash
cd ~/mochi-studio
node --check server.js
for f in js/*.js; do node --check "$f" || echo "FAIL: $f"; done
```

---

## 3. Customizations that must be re-applied

These are ours, not the drop's. Re-add them after every copy.

### 3.1 Discord / Open Graph link preview — `index.html`

Insert in `<head>` right after the `<title>` line:

```html
  <!-- Link previews (Discord, Slack, iMessage, X/Twitter, etc.) -->
  <meta name="description" content="Paint squishy zones on any image, then poke, pinch, tilt your phone, and record your own mochi. Runs entirely in your browser — free, no install." />
  <link rel="canonical" href="https://system32crowdstrikewin11.github.io/Mochi-studio-/" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Mochi Studio" />
  <meta property="og:title" content="Mochi Studio — Squishy Artwork & Motion Physics" />
  <meta property="og:description" content="Paint squishy zones on any image, then poke, pinch, tilt your phone, and record your own mochi. Runs entirely in your browser — free, no install." />
  <meta property="og:url" content="https://system32crowdstrikewin11.github.io/Mochi-studio-/" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="Mochi Studio — Squishy Artwork & Motion Physics" />
  <meta name="twitter:description" content="Paint squishy zones on any image, then poke, pinch, tilt your phone, and record your own mochi. Runs entirely in your browser — free, no install." />
```

Note: `theme-color` (#fff6f8) is already in the drop and gives the Discord embed its pink stripe.

### 3.2 Settings → “View source on GitHub” — `index.html`

Add just before the closing `</div>` of `.sheet-body` (after the Record section):

```html
        <!-- About / Source Code -->
        <div class="sheet-section">
          <div class="section-title">About</div>
          <a class="pill-btn outline small-pill source-link"
             href="https://github.com/system32crowdstrikewin11/Mochi-studio-"
             target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>
            <span>View source on GitHub</span>
          </a>
        </div>
```

### 3.3 Styles for the source link — `css/styles.css`

Add right after the `.pill-btn.small-pill { … }` block:

```css
/* Settings → source code link */
.source-link {
  gap: 7px;
  text-decoration: none;
  font-weight: 700;
}

.source-link:hover {
  background: var(--soft-pink);
}

.source-link svg {
  flex: 0 0 auto;
}
```

### 3.4 README live link + credits — `README.md`

After the intro paragraph (before “## Run on Localhost…”), add:

```md
## ▶ Try it live

**[Launch Mochi Studio →](https://system32crowdstrikewin11.github.io/Mochi-studio-/)**

No install needed — runs entirely in your browser. Phone motion sensors work over HTTPS, so you can try tilt & shake right on your phone.
```

At the very end of the file, add:

```md
## Credits

- Inspired by [もちほっぺ・メーカー (Moti Hoppe Maker)](https://sabanogames.com/entertainments/moti_hoppe_maker/) by SABANO GAMES — huge thanks for the original squishy-cheek inspiration!
- All code, built-in sample artwork, physics, and audio in this project are original and made from scratch.
```

Keep the version number in the README title (`# Mochi Studio vXX`) from the drop.

---

## 4. Commit, push, deploy

```bash
cd ~/mochi-studio
git add -A
git commit -m "Mochi Studio v<XX> (live link + credits; keep Discord embed + source link)"
git push origin main
```

GitHub Pages auto-builds from `main` / root. Our customizations ride along with the push.

---

## 5. Start + verify

### Local

```bash
node server.js 25565
```

Check:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:25565/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:25565/css/styles.css
curl -s http://localhost:25565/ | grep -c "View source on GitHub"   # expect 1
```

### GitHub Pages

```bash
gh api repos/system32crowdstrikewin11/Mochi-studio-/pages/builds/latest --jq '.status'
# wait until "built"

curl -s https://system32crowdstrikewin11.github.io/Mochi-studio-/ | grep -o "View source on GitHub"
curl -s https://system32crowdstrikewin11.github.io/Mochi-studio-/ | grep -o "og:title"
```

---

## 6. Notes / gotchas

- `.git` must survive the copy step — never delete the whole folder blindly.
- Exclude `__pycache__` (it appears when `server.py` has been run).
- The CSS/JS links carry a `?v=XX` cache-buster; leave whatever the new drop uses.
- Discord caches embeds; append `?v=2` to the URL to force a refresh when testing.
- Origin: `https://github.com/system32crowdstrikewin11/Mochi-studio-`
- Live: `https://system32crowdstrikewin11.github.io/Mochi-studio-/`
- GitHub Pages source: branch `main`, path `/` (legacy build).
