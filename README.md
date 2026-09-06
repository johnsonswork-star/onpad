# OnPad

Phone-first jobsite map for excavation crews (dozers, excavators, water trucks, dump trucks). Drop pads/roads/piles on satellite, call water or cleanup, stake a **dig pad** from the dozer’s GPS, and draw **haul paths** so trucks know where to drive.

Google Sign-In is **required** (browser GIS). No invite codes, no CAD, no payments. One static page — sign in, then use the pad.

**Source:** [https://github.com/johnsonswork-star/onpad](https://github.com/johnsonswork-star/onpad)

**Live:** [https://johnsonswork-star.github.io/onpad/](https://johnsonswork-star.github.io/onpad/)

## Open on a phone

Open the live URL (or serve this folder over HTTPS). GPS needs HTTPS (or localhost).

```bash
python3 -m http.server 8080
```

Add to home screen (PWA) after it is on HTTPS.

## How to use

1. **Sign in with Google** (required gate). Allow GPS. The yellow machine marker is **this phone**. Big top bar = **who you are** (Dozer / Excavator / Water). Tap it for **Profile** (display name; Operators vs Site crew; Sign out; role-aware Continue). GPS + LIVE sit under that identity bar. **No job code** — everyone on the Pages URL shares one open site.
2. **Left rail (Machine):** starts closed on phone (edge chevron). Place Dozer / Excavator / Water. Calls: Light / Heavy / Clean. Dozer stakeout: **Pin**, **Undo**, **Cut**.
3. **Right rail (Site):** Pad / Road / Pile, Map style, Here (recenter).
4. **Bottom truck bar:** fat **TRUCK PATHS** handle. Open it → **Start** a haul route, tap the map to drop points, **Done** to save, **In** / **Out** to tag follow-road. Paths sync live with the site.
5. **Dig-a-pad (Dozer):** walk corners → **Pin** → **Cut** publishes a DIG polygon.

v1 GPS is **this phone**, standing in for the dozer’s Trimble. Hook: `PositionSource.attachTrimble(feed)` in `js/app.js`.

## Sync

- State is saved in `localStorage` for the shared site room.
- Created features carry a profile stamp: `by` / `userId`, `byName`, `byRole`, `stampedAt` (Profile & Settings). Soft-lock after 30s. `userId` / `by` is the Google JWT `sub`. `byName` uses display name or Google name. Sign-out returns to the auth gate (anon id kept for stamp history). No ban UI yet.
- **Live (best-effort):** MQTT room `onpad/v1/SITE` on public brokers. Badge **LIVE** / **SOLO**. Obscure room, not private.

## GitHub Pages

Deploys from **main** `/` (static HTML, `.nojekyll`). Push to `main` updates the live site. Assets are cache-bumped (`?v=32`, service worker `onpad-v32`).


## Profile stamp API (App Builder)

Settings owns the Profile sheet progress meter (Name · Role · Ready). Map permanence is **App Builder’s** job.

Features stamped via `stamp()` / `OnPadAccount.stamp(obj)` carry:

- `by` / `userId` — Google JWT `sub` when signed in, else anonymous local id
- `byName` / `byRole` — display name (or Google / email local-part / Operator) + role at stamp time
- `stampedAt` — epoch ms (Builder: soft-lock / permanence after **30s**)

Live registry: `state.profiles[userId] = { userId, name, role, u }` (synced in slim MQTT state; merge keeps newest `u`).

```js
window.OnPadAccount = {
  userId: () => /* Google sub when signed in, else anon local id */,
  profile: () => ({ userId, name, role }),
  stamp: (obj) => /* mutates + returns obj; byName always set */,
  lookup: (userId) => /* from state.profiles or feature byName fallback */,
  profileLabel: (userIdOrFeature) => /* "Name · Role" or truncated id */,
  signedIn: () => /* true when onpad:googleSub set */,
  signOut: () => /* clear google* keys; keep anon id + map stamps */,
  likesReceived: (userId) => /* unique by+featureId likes on that user's stamps */,
  dislikesReceived: (userId) => /* unique by+featureId dislikes on that user's stamps */,
  openProfile: (userIdOrHint) => /* string userId or {userId,name?,byName?,role?,byRole?,lat?,lng?} */,
  setNearbyUsers: (rows) => /* Builder nearby+LIVE; normalizes byName→name, byRole→role; caches presence hints */,
  level: (userId) => /* 1 | 2 | 3 */,
  myLevel: () => /* level(localUserId()) */,
  getLevel: () => /* alias of myLevel */,
  recordLike: (featureId, targetUserId) => /* idempotent per by+featureId */,
  canAutoDeleteReport: (reporterId) => /* true when level(reporter) >= 3 */,
  isBoardVoter: (userId) => /* signed-in or has userId */,
  STAMP_LOCK_MS: 30000,
  LEVEL_L2_MIN: 1000,
  LEVEL_L3_MIN: 5000
};
```

Do **not** rebuild map tools here. Builder: tap-to-see-who chip + 30s soft-lock + map like/dislike/report (cache **v=27**). Profile social ladder is **?v=32**.

## Social credit levels

Levels come from **likes received** on the user’s stamped actions (`feature.userId || feature.by`).

| Level | Likes received |
|-------|----------------|
| L1 | 0–999 |
| L2 | 1,000–4,999 |
| L3 | 5,000+ |

**Report routing:** reporter `level >= 3` → auto-delete eligible (`canAutoDeleteReport`); below L3 → review board. Board voters v1 = any signed-in user / has `userId` (`isBoardVoter`).

**Feature reaction shape** (Builder-locked; one entry per voter; toggle removes):

```js
likes: [{ by: userId, at: ms }]
dislikes: [{ by, at }]
reports: [{ by, at }]
modVotes: [{ by, at, vote: 'keep'|'delete' }]
```

Profile also syncs `state.likes = [{ id, featureId, targetUserId, by, at }]` in slim MQTT state (`mergeById`). `likesReceived` counts unique `by|featureId` from feature `likes[]` plus the registry.

**Stamps:** `byName = displayName() || googleName() || emailLocalPart || 'Operator'`. After Google sign-in, empty display name is seeded from Google name, then email local-part.


## Google Sign-In

Browser-only [Google Identity Services](https://developers.google.com/identity/gsi/web). A full-screen gate blocks the map until signed in. OAuth **Web client ID** is embedded in the page (no client secret, no server). Authorized JavaScript origin: `https://johnsonswork-star.github.io`. Stamps / `OnPadAccount.userId()` use the Google JWT `sub`. Sign-out clears `onpad:google*` keys and shows the gate again — map stamps remain.

## Stack

Plain HTML / CSS / JS. Leaflet + Esri World Imagery. MQTT for optional live. PWA manifest + service worker.

## Icons

**Frozen.** Keep the current in-app glyphs. Do not copy or inline `/workspace/onpad-icons/` (or `img/`) until Chris picks a set.
