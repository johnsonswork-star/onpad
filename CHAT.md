# OnPad chat shell (?v=66)

Phone-first chat overlay: Global / Local / Lobby (disabled until CH-*) / **Inbox**.
Inbox lists direct messages **to you** (inbound `chat:dm:*`); reply in a selected thread.
Migrates/reads old `onpad:chat:chat:dm:*` keys; UI label is Inbox (not DM).
Uses `js/chat.js` + CSS in `css/app.css`. Chat toggle `#chatToggle` is fixed bottom-right (safe-area).
Local prefers `OnPadTown.id()` with `town:unknown` fallback.
Does not change World/lobby map layers.
