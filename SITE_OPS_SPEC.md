# Site Ops Spec
Copy this file into the project as the source of truth for map, roles, social scores, profiles, and mod tools.

Last updated: 2026-09-06

---

## Goal

A live job-site map where:

- You cannot change the map until you pick a role.
- A role is a sub-profile for this shift (the machine you are running).
- Likes and dislikes define the person.
- Object taps rate the object. Name taps open profile.
- Mods look like normal players until they turn tools on.
- Staff can send a player list to Grok Bot and apply restrictions.

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

## 7. Player list (Grok Bot + mods)

List is for nearby / live / parked owners.

Each row:

- Avatar + display name (tap → profile)
- Role and state: live / parked / off shift
- Social score `▲ ▼`
- Distance or last seen
- Checkbox for multi-select

Action on the list:

- `Send selected to Grok Bot`

Payload includes:

- Player IDs and names
- Scores and current restrictions
- Role / live / parked state
- Optional reason
- Timestamp and map context

---

## 8. Profiles

Clickable from list, marker name, object owner, and score.

Profile shows:

- Score first
- Join date, hours, current shift
- Machines owned / parked
- Like-dislike history
- Restriction history (visible record)
- Mod notes (mod tools on only)

---

## 9. Mod tools

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

## 10. Button labels

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

List:

- `Send selected to Grok Bot`

Mod bar:

- `Mod tools`

---

## 11. Implementation notes

- Live location publishes only after a role is confirmed.
- Ending shift always parks first, then unpublishes location.
- Parked machines keep owner ID so likes still attach to the person.
- Score on owner updates even if the machine is parked and the owner is off-map.
- Grok Bot list is a snapshot, not an auto-ban.
- Mod tools default off on launch (shared screen / locked phone).

---

## 12. Acceptance checks

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
- Selected players can be sent to Grok Bot.
