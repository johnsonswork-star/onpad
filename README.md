# OnPad

Phone-first jobsite map for excavation crews (dozers, excavators, water trucks, dump trucks). Drop pads/roads/piles on satellite, call water or cleanup, stake a **dig pad** from the dozer’s GPS, and draw **haul paths** so trucks know where to drive.

No login, no invite codes, no CAD, no payments. One static page — open the link and see the pad.

**Source:** [https://github.com/johnsonswork-star/onpad](https://github.com/johnsonswork-star/onpad)

**Live:** [https://johnsonswork-star.github.io/onpad/](https://johnsonswork-star.github.io/onpad/)

## Open on a phone

Open the live URL (or serve this folder over HTTPS). GPS needs HTTPS (or localhost).

```bash
python3 -m http.server 8080
```

Add to home screen (PWA) after it is on HTTPS.

## How to use

1. Allow GPS. The yellow machine marker is **this phone**. Big top bar = **who you are** (Dozer / Excavator / Water). Tap it for **Profile** (optional name; Operators vs Site crew dropdowns; role-aware Continue — no login). GPS + LIVE sit under that identity bar. **No job code** — everyone on the Pages URL shares one open site.
2. **Left rail (Machine):** starts closed on phone (edge chevron). Place Dozer / Excavator / Water. Calls: Light / Heavy / Clean. Dozer stakeout: **Pin**, **Undo**, **Cut**.
3. **Right rail (Site):** Pad / Road / Pile, Map style, Here (recenter).
4. **Bottom truck bar:** fat **TRUCK PATHS** handle. Open it → **Start** a haul route, tap the map to drop points, **Done** to save, **In** / **Out** to tag follow-road. Paths sync live with the site.
5. **Dig-a-pad (Dozer):** walk corners → **Pin** → **Cut** publishes a DIG polygon.

v1 GPS is **this phone**, standing in for the dozer’s Trimble. Hook: `PositionSource.attachTrimble(feed)` in `js/app.js`.

## Sync

- State is saved in `localStorage` for the shared site room.
- Created features carry a profile stamp: `by` / `userId`, `byName`, `byRole`, `stampedAt` (Profile & Settings). Soft-lock after 30s. No login / report / ban UI yet.
- **Live (best-effort):** MQTT room `onpad/v1/SITE` on public brokers. Badge **LIVE** / **SOLO**. Obscure room, not private.

## GitHub Pages

Deploys from **main** `/` (static HTML, `.nojekyll`). Push to `main` updates the live site. Assets are cache-bumped (`?v=19`, service worker `onpad-v19`).


## Profile stamp API (App Builder)

Settings owns the Profile sheet progress meter (Name · Role · Ready). Map permanence is **App Builder’s** job.

Features stamped via `stamp()` / `OnPadAccount.stamp(obj)` carry:

- `by` / `userId` — anonymous local account id
- `byName` / `byRole` — display name + role at stamp time
- `stampedAt` — epoch ms (Builder: soft-lock / permanence after **30s**)

Live registry: `state.profiles[userId] = { userId, name, role, u }` (synced in slim MQTT state; merge keeps newest `u`).

```js
window.OnPadAccount = {
  userId: () => /* local id */,
  profile: () => ({ userId, name, role }),
  stamp: (obj) => /* mutates + returns obj */,
  lookup: (userId) => /* from state.profiles or feature byName fallback */,
  profileLabel: (userIdOrFeature) => /* "Name · Role" or truncated id */,
  STAMP_LOCK_MS: 30000 // documented constant — Builder implements the 30s lock
};
```

Do **not** rebuild map tools here. Builder: tap-to-see-who chip + 30s soft-lock using `stampedAt` + `STAMP_LOCK_MS`.

## Stack

Plain HTML / CSS / JS. Leaflet + Esri World Imagery. MQTT for optional live. PWA manifest + service worker.

## Icons

**Frozen.** Keep the current in-app glyphs. Do not copy or inline `/workspace/onpad-icons/` (or `img/`) until Chris picks a set.
