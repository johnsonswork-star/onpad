# OnPad

Phone-first jobsite map for excavation crews (dozers, excavators, water trucks). Drop pads/roads/piles on satellite, call water or cleanup, and stake a **dig pad** from the dozer’s GPS so the excavator knows where to cut.

No login, no CAD, no payments. One static page.

**Source:** [https://github.com/johnsonswork-star/onpad](https://github.com/johnsonswork-star/onpad)

This repo is **private**. GitHub Pages will not serve it until the repo is public (or the account has GitHub Pro). There is no live URL yet.

## Open on a phone

Until Pages is on, serve it from a laptop on the same Wi‑Fi, then open the laptop’s address on the phone. GPS **will not** work on `file://`.

From this folder:

```bash
python3 -m http.server 8080
```

On the laptop: `http://localhost:8080`

On the phone (same Wi‑Fi): `http://HOST_LAN_IP:8080`  
GPS still needs **HTTPS** (or localhost). For a real cab test, make the repo public and enable Pages (below), or put the folder behind any HTTPS host.

Add to home screen (PWA): Share / Add to Home Screen after it is on HTTPS.

## How to use

1. Allow GPS. The yellow machine marker is **this phone**. Big top bar = **who you are** (Dozer / Excavator / Water). Tap it to switch role. Job code + GPS + LIVE sit under that identity bar.
2. **Left rail (Machine):** tuck away with the handle. Place a Dozer / Excavator / Water truck marker (tap tool, tap map). Calls: Light / Heavy / Clean. Dozer stakeout: **Pin** (GPS corner), **Undo**, **Cut**.
3. **Right rail (Site):** Pad / Road / Pile (tap tool, tap map), plus MAP style and Here (recenter). Fat yellow handles on surfaces: edge = size, square = rotate. Drag to move.
4. **Dig-a-pad stakeout (Dozer):** walk/drive to a pad corner and tap **Pin** (current GPS, not a map tap). Repeat (4 corners normal; 3+ enough). **Cut** publishes a high-contrast **DIG** polygon with shovel + depth.
5. **Excavator:** tap the dig pad → ▶ started, ✓ done.
6. **Job code** (under identity): shout to the other phone. **Join** / **Share link** as before.

v1 GPS is **this phone**, standing in for the dozer’s Trimble. Code hook: `PositionSource.attachTrimble(feed)` in `js/app.js`. Do not fake a Trimble API.

## Two-phone sync

- **Always:** job state is saved in `localStorage` under the job code.
- **Share link:** URL `?job=CODE` plus a `#s=` snapshot so the other phone can restore without a server of yours.
- **Live (best-effort):** both phones on the same job code publish to a public MQTT room (`onpad/v1/CODE` on EMQX / HiveMQ). No API keys. Badge **LIVE** = connected, **SOLO** = this phone only (broker blocked or offline). The room is obscure, not private — treat job data as jobsite-only.

If sync is down, both operators still work solo; share the link or re-join the code later.

## GitHub Pages

Static site (`index.html` at the repo root). After the repo is **public**, enable Pages from **main** `/` (legacy / static HTML, no Jekyll — `.nojekyll` is in the repo):

```bash
gh api -X POST repos/johnsonswork-star/onpad/pages -f build_type=legacy -F source[branch]=main -F source[path]=/
```

Then the phone URL is:

`https://johnsonswork-star.github.io/onpad/`

Private-repo Pages needs GitHub Pro. For a free HTTPS + GPS URL, make the repo public — same idea as Worldseed.

If Pages was already enabled, a push to `main` is enough.

## Limits

| Topic | v1 |
| --- | --- |
| GPS | Needs HTTPS (or localhost). Phone GPS is **not** survey-grade; Trimble feed is a later hook. |
| GitHub Pages | Repo is private — Pages will not work until public (or Pro). |
| Sync | LIVE uses a public MQTT broker. If it fails, SOLO + share link still work. |
| Accuracy | Corner pins use the phone’s reported accuracy (`±ft` on the GPS badge). |

## Stack

Plain HTML / CSS / JS. [Leaflet](https://leafletjs.com/) + Esri World Imagery tiles (no API key). MQTT from a CDN for optional live rooms. PWA manifest + service worker.
