# Site Ops Spec
Copy this file into the project as the source of truth for map, roles, social scores, profiles, and mod tools.

Last updated: 2026-09-13 (channels + layout picker: Excavation / Everyday)

---

## Goal

Discord-style **map channels for everyone** (pivot 2026-09-13). Keep profiles, scores, mods, presence, and object sheets on solo and channel maps.

- After Google Sign-In → **Channels** screen (list / create / join).
- **Close / Solo** → today’s basic solo map (SITE room).
- Open a channel → shared map for that channel (LIVE scoped per channel).
- Tip pins, meetup times, photos, games: later (not v1).
- You cannot change the map until you pick a role (clock-in).
- A role is a sub-profile for this shift.
- Likes and dislikes define the person.
- Object taps rate the object. Name taps open profile.
- Mods look like normal players until they turn tools on.
- Flag / report: all reports → L3+ swipe review queue; only mods auto-decide.

---

## 0. Channels (v1)

- Channel model: `id` (short code) + `name` + `members` (creator + joiners).
- Create → mint code, add self as member, open that map room (`CH-{id}` MQTT / localStorage).
- Join by code → add self, open room.
- List = channels this device knows (local directory).
- Solo map uses the existing SITE room (today’s ?v=44 experience).
- CHANNELS control on the map returns to the lobby without signing out.
- Deep link: `?ch=CODE`.

#
## Lobbies cream restyle (?v=59)

`#channelsGate` / `.channels-card` restyled to Chris’s cream Lobbies mock: serif title, tabs **Yours** (default) | **Public** | **Create**, soft green accents. Yours cards from `loadChannelDir()` (map thumb placeholder, name, “• Yours” pill, Code + monospace green, `n / 8`, Live). Public stays empty (no fake data). Create uses in-card name + Everyday/Excavation purpose → existing `createChannel` / purpose lock. Solo map + join-by-code remain in the footer. Maps still only via Lobbies (?v=58).

## Lobbies opt-in (?v=60)

Lobbies sheet opens **only** from the Lobbies button — never on cold open / refresh. Close (✕) returns to the previous Solo/channel map. Do not persist `mode:lobby`.

## Maps via Lobbies (?v=58)

Solo and channel maps are **not** listed in the left sidebar / everyday rail. Open them only through the **Lobbies** button (lobby screen: Solo / create / join / your channels). Everyday pin tools stay in the rail.

## Everyday mock chrome (?v=57)

When layout/purpose is **Everyday** (Solo map OR channel created with Everyday purpose), use the Chris mock chrome: transparent topbar (no haze), avatar + Search map: only, collapsed left › rail, short pin name + ▲▼ chips, blank bottom. Excavation purpose/layout keeps shift/truck bottom and excavation tools. Chrome is driven by `body.everyday-chrome` from layout id, not Solo-only.

## Layouts (extensible)

Layouts are **data** (`id`, `name`, tool list / HUD), not hard-coded forever. V1 presets:

1. **Excavation** — current OnPad toolset (machines, water, paths, Site Ops, clock-in).
2. **Everyday** — personal pins: House, Work, Friend, Family, Church, School, Gym, Restaurant, Coffee, Store, Grocery, Gas, Doctor, Pharmacy, Park, Trail, Meet, Parking, Other. Letter placeholders OK. Pins use object sheet (like/dislike/flag) + name; same tap rules.

Flow: Google → Channels → Solo or channel → **pick layout** (or remember last) → map.

Tool registry + layout presets so new pin types are additive. Channel custom layout editor later.

- **Solo default layout = Everyday** (excavation is opt-in via LAYOUT).
- Channel LIVE presence is scoped to `CH-{id}` only; LEAVE/CHANNELS drops presence.
- Top bar: address search (Nominatim) + driving directions (OSRM) + speed.
- Left rail: Discord-style channel switch + layout tools.
- **Solo = no bottom bar** (no Park/Switch/End / truck paths).
- Channel **purpose at create** locks layout + bottom chrome (Excavation → shift+truck; Everyday → blank bottom).
- Bottom HUD clears Safari chrome via `--bottom-ui` (safe-area + browser chrome pad).
- Cold open restores last Solo/channel (default Solo). **CHANNELS** badge is opt-in — not a forced lobby.
- Top bar: slim Maps-style search; DIR/speed under ···; signed-in avatar chip.

---

## 1. Clock in / role gate

### Arrive on site
- Map is view-only.
- No pins, paths, likes, parks, or edits.
- Player is off-map. Others do not see them.

### Clock-in sheet (required first)
Pick one role:

- Excavator
- Water truck
- Haul truck
- Spotter
- QA
- Other roles as added

Confirm role → shift starts.

### After role is picked
- Live location is published to others.
- Marker is the current role/machine.
- Label format: `chris johnson · Water truck`
- Map actions for that role unlock.
- Only one live role at a time.

---

## 2. Live, park, end shift

**Chris rule (2026-09-06):** Clock-in / Switch role is **operator shift state only** — it does **not** place a machine by itself.

### Operate a machine (explicit)
To run equipment you must either:
- **Take over** an existing logged machine on the map (same role type), or
- **Place new machine** when a real unit isn’t logged yet (intentional, named).

### Park machine (stay on shift)
- Parks **only** the machine you are currently operating (if any).
- Does **not** spawn a new unit.
- Operator stays live and may Switch role.
- Parked unit has no live pulse.
- Label: `Water Truck 1 · parked` plus owner name.

### Switch role
- Changes shift role / live label only.
- Does **not** auto-create equipment.
- If you were operating a machine that doesn’t match the new role, it is parked first.

### End shift
- Park current operated machine **if any**.
- Hide live location.
- Operator leaves the map.
- Parked machines stay.

### Multi-role example
1. Start shift as Water truck → live as operator (no machine spawned).
2. Take over `Water Truck 1` (or Place new).
3. Park → `Water Truck 1` stays on map.
4. Switch role → Excavator (no spawn).
5. Take over / Place excavator → operate.
6. End shift → park current if any; operator hidden.

### What others see

| State           | On map                         | Location shared |
|-----------------|--------------------------------|-----------------|
| No role         | Nothing                        | No              |
| On shift        | Live marker for current role   | Yes             |
| Operating unit  | Live operator; unit not double-pinned | Yes      |
| Parked machine  | Static equipment pin           | No              |
| Shift ended     | Parked machines only           | No              |

---

## 3. Map edit rules

- No role → view-only.
- On shift → only actions that role can do.
- Every placed or parked machine belongs to a shift and an owner.
- Do not allow anonymous stickers that stay forever with no owner.

---

## 4. Tap targets

Never send an equipment tap to the operator profile by default.

| Tap                         | Opens                                      |
|-----------------------------|--------------------------------------------|
| Machine / object marker     | Object sheet (like / dislike)              |
| Object card body            | Object sheet                               |
| Player name or avatar       | Profile                                    |
| Player score on pin / row   | Profile                                    |
| Close / handle / swipe down | Dismiss sheet                              |

Profile is an option on the object sheet, not the default destination.

---

## 5. Object sheet (like / dislike)

Keep it uncrowded. Three primary actions only.

### Top
- Full object title: `Water Truck 1`
- Subline: last known time or distance
- Small owner avatar + name on the right → tap opens profile

### Bottom row
- Like
- Dislike
- Flag

### Under the row
- Object score: `8 likes · 1 dislike`
- Owner score: `chris johnson  ▲24 ▼3`

### Not on the main row
- Close via sheet handle, swipe down, or corner ×
- Share, details, mod actions behind `⋯`
- Do not use a large `+LIKES` button

---

## 6. Social scores define the person

A like or dislike on an object updates three things:

1. Object score
2. Owner public score
3. Owner profile history

### Score format
Show everywhere a person appears:

`▲ 24  ▼ 3`

Optional net next to it: `+21`

Score must be readable on:

- Map marker labels
- Nearby / player list rows
- Object sheets
- Profile header

Score is higher contrast than role labels.

### Map weight
- High net score: brighter ring / stronger badge
- Heavy dislikes: muted or warning-tint ring
- Example label: `Peer Bravo  +6`

### Profile header (first thing on the page)
- Large net score
- Like count and dislike count
- Recent rated objects (`Water Truck 1 · +8 / −1`)
- Trend: last 24h vs all-time

Then bio, hours, machines, notes.

---

## 7. Reports & L3 review queue

Flag on an object (orders, machines, paths, etc.) enters moderation.

### Chris rule (final — 2026-09-06)

1. **ALL** Flag reports (any reporter level, including L3+) go to the **Tinder-style review queue** for L3+ reviewers.
2. **ONLY mods** (`myIsMod()`) may auto-decide / auto-remove / punish without the queue.
3. **L3+ reporters do NOT auto-remove.** Level never grants instant delete on Flag.

### Who reports

| Actor | Immediate effect |
|-------|------------------|
| **Anyone** (any level, including L3+) | Object stays; report enters the **L3+ Tinder-style review queue**. |
| **Mod** (`myIsMod()`) | May **auto-decide** — instant remove and/or punish without the queue. |

`canAutoDeleteReport` / “L3 Flag deletes” — gone. Use `myIsMod()` only.

### Review queue (L3+ only)

- Accessible only to users at **L3+**. Profile owns the L3 gate.
- **Tinder-style / swipe card UI** — one report at a time. Not KEEP/DROP vote counters alone.
- Card shows: reported object preview, reporter, reason/context, owner.
- Reviewer actions:
  - **Agree (violation)** → choose a **punishment** from Site Ops §10 (Warn / Mute / Tool restrict / Movement restrict / Kick / Temp ban / Ban). Apply + log on the player’s public restriction record. Object may also be removed.
  - **Disagree / Dismiss** → clear from queue; object stays unless separately removed.
- L3+ non-mods review cards only. Mods may auto-decide outside the queue.
- Profile owns: L3 gate helpers, punishment record / restriction history API.
- App Builder owns: map Flag entry, queue card UI, `myIsMod()` auto-decide wiring.
- Fold full swipe UI into **P2/P4** after clock-in P1 (`?v=36`). Bump `?v=` as needed; coordinate with Profile (`?v=39`); next map after that `?v=40+`.

### Cancelled / removed

- Old KEEP/DROP multi-vote board — replaced by swipe queue.
- **`Send selected to Grok Bot` / Cos handoff** — CANCELLED. Do not implement.

---

## 8. Nearby / player list

List is for nearby / live / parked owners (browse + open profile). No Cos / Grok Bot export.

Each row:

- Avatar + display name (tap → profile)
- Role and state: live / parked / off shift
- Social score `▲ ▼`
- Distance or last seen

No multi-select send action.

---

## 9. Profiles

Clickable from list, marker name, object owner, and score.

Profile shows:

- Score first
- Join date, hours, current shift
- Machines owned / parked
- Like-dislike history
- Restriction history (visible record)
- Mod notes (mod tools on only)

---

## 10. Mod tools

Mods use the same default display as everyone else.

### Default
- Same marker, score, profile, like/dislike
- No staff badge on the public map
- No restriction buttons visible

### Unlock
One control on the mod’s own bar:

`Mod tools` → tap on for this session → tap off to hide

While off:

- App behaves as a normal player
- Object tap → rate object
- Name tap → profile

While on:

- Player rows and profiles gain: Warn, Mute, Tool restrict, Movement restrict, Kick, Temp ban, Ban
- Object sheets gain: restrict owner, remove object
- L3+ get the **report review queue** (swipe cards) even if tools are off — queue is level-gated
- Mods (`myIsMod`) may auto-decide (remove/punish) without the queue
- Thin private chip only the mod sees: `Tools on`

Restrictions write to the player’s public record. The buttons that apply them stay behind the click.

### Restriction set

| Action            | Effect                                      |
|-------------------|---------------------------------------------|
| Warn              | Visible warning, logged                     |
| Mute              | No chat / voice                             |
| Tool restrict     | Cannot use role tools                       |
| Movement restrict | Area lock or speed cap                      |
| Kick              | Remove from session                         |
| Temp ban          | 1h / 24h / 7d                               |
| Ban               | Permanent, with reason                      |

Do not make profile the punishment screen. Profile stays social. Restrictions are an overlay after tools are on.

---

## 11. Button labels

Clock-in sheet:

- `Pick your role`
- `Start shift`

On shift bar:

- `Park machine` (only if operating)
- `Switch role` (no spawn)
- `End shift`

Object / fleet sheet:

- `Take over` (same role type, on shift)

Park confirm:

- `Park here and stay on shift`

End shift confirm:

- `Park current machine and hide my location`

Object sheet overflow:

- `Profile`
- `Details`
- Mod-only items if tools on

Nearby list:

- Open profile only (no Send to Grok)

L3+ review queue cards:

- `Agree` → pick punishment (§10)
- `Dismiss`

Mod bar:

- `Mod tools`

---

## 12. Implementation notes

- Live location publishes only after a role is confirmed.
- Ending shift always parks first, then unpublishes location.
- Parked machines keep owner ID so likes still attach to the person.
- Score on owner updates even if the machine is parked and the owner is off-map.
- Report: every Flag (including L3+ reporters) → L3+ swipe queue; auto-decide only if `myIsMod()`.
- Punishments write to the player’s public restriction record (Profile API).
- Do **not** implement Send-to-Grok / Cos handoff (cancelled).
- Mod tools default off on launch (shared screen / locked phone).

---

## 13. Acceptance checks

- Cannot edit map before picking a role.
- Live pin appears only after start shift.
- Switch role does not spawn a machine.
- Park only parks the operated machine (Take over / Place new first).
- End shift hides operator; parks current operated machine if any.
- Tap truck opens like/dislike, not profile.
- Tap name opens profile.
- Object sheet has three primary buttons only.
- Score visible on pin, list, sheet, and profile header.
- Like/dislike updates object + owner + history.
- Mod looks normal until `Mod tools` is tapped.
- Every Flag enters L3+ swipe review queue unless a mod auto-decides.
- Agree on a queue card requires a §10 punishment; Dismiss clears the report.
- L3+ non-mods never auto-remove from Flag alone.
- No Send-to-Grok action.

---

## 14. Phasing (App Builder + Profile)

| Phase | Owner | Notes |
|-------|-------|-------|
| P1 Clock-in / park / end | App Builder | Shipped `?v=36`; report rule on `?v=38` |
| P2 Object sheet tap targets | App Builder | Machine→object sheet; name→profile |
| P3 Scores ▲▼ | Map markers + nearby | Shipped `?v=53` |
| P4 Mod stealth + L3 swipe report queue | Map UI Builder; L3 gate + punishment record Profile | After Profile `?v=39`; map `?v=40+` |
| P5 Send to Grok Bot | — | **CANCELLED** |

