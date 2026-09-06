# Site Ops Spec
Copy this file into the project as the source of truth for map, roles, social scores, profiles, and mod tools.

Last updated: 2026-09-06 (all reports→L3 queue; mod-only auto-decide; Send-to-Grok cancelled)

---

## Goal

A live job-site map where:

- You cannot change the map until you pick a role.
- A role is a sub-profile for this shift (the machine you are running).
- Likes and dislikes define the person.
- Object taps rate the object. Name taps open profile.
- Mods look like normal players until they turn tools on.
- Flag / report: all reports → L3+ swipe review queue; only mods auto-decide (instant remove/punish).

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

Park and end shift are different.

### Park machine (stay on shift)
Use when one person runs many roles.

- Drop a parked unit at current location.
- Operator stays live and may pick another role.
- Parked unit has no live pulse.
- Label: `Water Truck 1 · parked` plus owner name.

### End shift
- Park the current machine at current location (if not already parked).
- Hide live location.
- Operator leaves the map.
- Parked machines stay.

### Multi-role example
1. Pick Water truck → go live.
2. Park water truck.
3. Pick Excavator → live marker switches.
4. Park excavator.
5. End shift → operator hidden, both machines remain parked.

### What others see

| State           | On map                         | Location shared |
|-----------------|--------------------------------|-----------------|
| No role         | Nothing                        | No              |
| On shift        | Live marker for current role   | Yes             |
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

**Chris override 2026-09-06:** L3+ no longer auto-removes. All reports go to the queue unless a **mod** auto-decides.

### Who reports

| Actor | Immediate effect |
|-------|------------------|
| **Anyone** (any level) | Object stays up; report enters the **L3+ Tinder-style review queue**. |
| **Mod** (`myIsMod()`) | May **auto-decide** — instant remove and/or punish without the queue (mod tools / Flag as mod). |

Do **not** use reporter L3 / `canAutoDeleteReport` for auto-remove. Drop that path. Auto-decide = `myIsMod()` only.

### Review queue (L3+ only)

- Accessible only to users at **L3+**. Profile owns the L3 gate.
- **Tinder-style / swipe card UI** — one report at a time. Not KEEP/DROP vote counters alone.
- Card shows: reported object preview, reporter, reason/context, owner.
- Reviewer actions:
  - **Agree (violation)** → choose a **punishment** from Site Ops §10 (Warn / Mute / Tool restrict / Movement restrict / Kick / Temp ban / Ban). Apply + log on the player’s public restriction record. Object may also be removed.
  - **Disagree / Dismiss** → clear from queue; object stays unless separately removed.
- Mods can still auto-decide outside the queue; L3+ non-mods review cards only.
- Profile owns: L3 gate helpers, punishment record / restriction history API.
- App Builder owns: map Flag entry, queue card UI, `myIsMod()` auto-decide wiring.
- Fold full swipe UI into **P2/P4** after clock-in P1 (`?v=36`). Bump `?v=` as needed; coordinate with Profile (`?v=37+`).

### Deprecated

- L3+ reporter auto-remove / `canAutoDeleteReport` — **removed**.
- Old multi-vote KEEP/DROP review board — superseded by the swipe queue.
- **`Send selected to Grok Bot` / Cos handoff is CANCELLED** — dropped for now. Do not implement.

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

- `Park machine`
- `Switch role`
- `End shift`

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
- Report: every Flag → L3+ swipe queue; auto-decide only if `myIsMod()` (no L3 `canAutoDeleteReport`).
- Punishments write to the player’s public restriction record (Profile API).
- Do **not** implement Send-to-Grok / Cos handoff (cancelled).
- Mod tools default off on launch (shared screen / locked phone).

---

## 13. Acceptance checks

- Cannot edit map before picking a role.
- Live pin appears only after start shift.
- Park leaves machine, operator can switch role.
- End shift hides operator and leaves machine.
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
| P1 Clock-in / park / end | App Builder | Shipped `?v=36` |
| P2 Object sheet tap targets | App Builder | Machine→object sheet; name→profile |
| P3 Scores ▲▼ | Profile helpers + map display | Likely `?v=37+` |
| P4 Mod stealth + L3 swipe report queue | Map UI Builder; L3 gate + punishment record Profile | After P1; bump `?v=` as needed |
| P5 Send to Grok Bot | — | **CANCELLED** |

