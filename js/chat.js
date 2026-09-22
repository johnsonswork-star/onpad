/* OnPad chat shell draft — localStorage first; optional MQTT. Does not alter map/lobby architecture. */
(function () {
  'use strict';

  const LS_PREFIX = 'onpad:chat:';
  const DM_INDEX_KEY = 'onpad:chat:dm:index';
  const MAP_MODE_KEY = 'onpad:mapMode';
  const TOWN_STUB = 'town:unknown';
  const MAX_MSGS = 200;
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];

  let open = false;
  let tab = 'global'; /* global | local | lobby | dm */
  let dmPeer = null; /* peer id when in DM thread */
  let mqttClient = null;
  let mqttAlive = false;
  let mqttTopic = '';
  let pollTimer = null;
  let lastLocalChannelKey = null;

  function $(id) { return document.getElementById(id); }

  function displayName() {
    try {
      const acc = window.OnPadAccount;
      if (acc && typeof acc.profile === 'function') {
        const p = acc.profile();
        if (p && p.name && String(p.name).trim()) return String(p.name).trim().slice(0, 80);
      }
    } catch (e) { /* ignore */ }
    try {
      const n = (localStorage.getItem('onpad:displayName') ||
        localStorage.getItem('onpad:googleName') || '').trim();
      if (n) return n.slice(0, 80);
    } catch (e2) { /* ignore */ }
    return 'You';
  }

  function userId() {
    try {
      const acc = window.OnPadAccount;
      if (acc && typeof acc.userId === 'function') {
        const id = acc.userId();
        if (id) return String(id);
      }
    } catch (e) { /* ignore */ }
    try {
      let id = localStorage.getItem('onpad:userId');
      if (!id) {
        id = 'u-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('onpad:userId', id);
      }
      return id;
    } catch (e2) {
      return 'anon';
    }
  }

  /** Read map mode the same way app.js persists it. */
  function readMapMode() {
    try {
      const saved = JSON.parse(localStorage.getItem(MAP_MODE_KEY) || 'null');
      if (saved && saved.mode === 'channel' && saved.id) {
        const id = String(saved.id).toUpperCase().replace(/^CH-/, '');
        return { mode: 'channel', id: id, room: 'CH-' + id };
      }
    } catch (e) { /* ignore */ }
    return { mode: 'solo', id: '', room: 'SITE' };
  }

  function townId() {
    /* Prefer App Builder hook; map unknown → town:unknown, grid id → town:{id}. */
    let raw = 'unknown';
    try {
      if (window.OnPadTown && typeof OnPadTown.id === 'function') {
        const t = OnPadTown.id();
        if (t != null && String(t).trim()) raw = String(t).trim();
      }
    } catch (e) { /* ignore */ }
    if (raw === 'unknown') return TOWN_STUB; /* town:unknown */
    if (raw.indexOf('town:') === 0) return raw;
    return 'town:' + raw;
  }

  function channelKeyForTab(t) {
    if (t === 'global') return 'chat:global';
    if (t === 'local') return 'chat:local:' + townId();
    if (t === 'lobby') {
      const m = readMapMode();
      if (m.mode === 'channel' && m.room) return 'chat:lobby:' + m.room;
      return null;
    }
    if (t === 'dm') {
      if (!dmPeer) return null;
      return dmChannelKey(userId(), dmPeer);
    }
    return null;
  }

  function dmChannelKey(a, b) {
    const x = String(a || '');
    const y = String(b || '');
    const pair = [x, y].sort().join(':');
    return 'chat:dm:' + pair;
  }

  function storageKey(channelKey) {
    return LS_PREFIX + channelKey;
  }

  function loadMessages(channelKey) {
    if (!channelKey) return [];
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey(channelKey)) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return [];
    }
  }

  function saveMessages(channelKey, list) {
    if (!channelKey) return;
    try {
      const trimmed = (list || []).slice(-MAX_MSGS);
      localStorage.setItem(storageKey(channelKey), JSON.stringify(trimmed));
    } catch (e) { /* ignore quota */ }
  }

  function loadDmIndex() {
    try {
      const raw = JSON.parse(localStorage.getItem(DM_INDEX_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return [];
    }
  }

  function saveDmIndex(list) {
    try {
      localStorage.setItem(DM_INDEX_KEY, JSON.stringify(list || []));
    } catch (e) { /* ignore */ }
  }

  function touchDmPeer(peerId, peerName) {
    const id = String(peerId || '').trim();
    if (!id) return;
    const name = String(peerName || id).trim().slice(0, 80);
    let list = loadDmIndex().filter((r) => r && r.id !== id);
    list.unshift({ id: id, name: name, at: Date.now() });
    saveDmIndex(list.slice(0, 50));
  }

  function formatTime(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function lobbyActive() {
    return readMapMode().mode === 'channel';
  }

  function setOpen(v) {
    open = !!v;
    const shell = $('chatShell');
    const toggle = $('chatToggle');
    if (shell) shell.hidden = !open;
    if (toggle) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.classList.toggle('is-open', open);
      toggle.title = open ? 'Hide chat' : 'Show chat';
    }
    if (open) {
      refreshLobbyTabState();
      render();
      retopicMqtt();
    }
  }

  function setTab(next) {
    if (next === 'lobby' && !lobbyActive()) return;
    tab = next;
    if (tab !== 'dm') dmPeer = null;
    document.querySelectorAll('.chat-tab').forEach((btn) => {
      const on = btn.getAttribute('data-chat-tab') === tab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const dmList = $('chatDmList');
    const msgs = $('chatMessages');
    const compose = $('chatCompose');
    const back = $('chatDmBack');
    if (tab === 'dm' && !dmPeer) {
      if (dmList) dmList.hidden = false;
      if (msgs) msgs.hidden = true;
      if (compose) compose.hidden = true;
      if (back) back.hidden = true;
    } else {
      if (dmList) dmList.hidden = true;
      if (msgs) msgs.hidden = false;
      if (compose) compose.hidden = false;
      if (back) back.hidden = !(tab === 'dm' && dmPeer);
    }
    updateChannelLabel();
    render();
    retopicMqtt();
    if (tab === 'local') lastLocalChannelKey = channelKeyForTab('local');
    else lastLocalChannelKey = null;
  }

  function refreshLobbyTabState() {
    const btn = document.querySelector('.chat-tab[data-chat-tab="lobby"]');
    const active = lobbyActive();
    if (btn) {
      btn.disabled = !active;
      btn.setAttribute('aria-disabled', active ? 'false' : 'true');
      btn.classList.toggle('is-disabled', !active);
      btn.title = active
        ? ('Lobby ' + readMapMode().room)
        : 'Lobby chat — join a CH-* channel first (disabled on Solo SITE)';
    }
    if (!active && tab === 'lobby') setTab('global');
    updateChannelLabel();
    refreshLocalTownIfNeeded();
  }

  /** Re-read OnPadTown.id() while on Local / after map-mode polls so GPS town moves update the room. */
  function refreshLocalTownIfNeeded() {
    if (tab !== 'local') {
      lastLocalChannelKey = null;
      return;
    }
    const key = channelKeyForTab('local');
    if (key === lastLocalChannelKey) return;
    lastLocalChannelKey = key;
    updateChannelLabel();
    renderMessages();
    retopicMqtt();
  }

  function updateChannelLabel() {
    const el = $('chatChannelLabel');
    if (!el) return;
    const key = channelKeyForTab(tab);
    if (tab === 'dm' && !dmPeer) {
      el.textContent = 'DMs';
      return;
    }
    el.textContent = key || '—';
  }

  function renderMessages() {
    const host = $('chatMessages');
    if (!host) return;
    const key = channelKeyForTab(tab);
    host.innerHTML = '';
    if (!key) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = tab === 'lobby'
        ? 'Join a lobby (CH-*) to chat here.'
        : 'No channel.';
      host.appendChild(empty);
      return;
    }
    const list = loadMessages(key);
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = 'No messages yet. Say something.';
      host.appendChild(empty);
      return;
    }
    const me = userId();
    list.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'chat-msg' + (m.uid === me ? ' chat-msg-mine' : '');
      const meta = document.createElement('div');
      meta.className = 'chat-msg-meta';
      const who = document.createElement('span');
      who.className = 'chat-msg-who';
      who.textContent = m.name || 'You';
      const when = document.createElement('span');
      when.className = 'chat-msg-time';
      when.textContent = formatTime(m.ts);
      meta.appendChild(who);
      meta.appendChild(when);
      const body = document.createElement('div');
      body.className = 'chat-msg-body';
      body.textContent = m.text || '';
      row.appendChild(meta);
      row.appendChild(body);
      host.appendChild(row);
    });
    host.scrollTop = host.scrollHeight;
  }

  function renderDmList() {
    const host = $('chatDmList');
    if (!host) return;
    host.innerHTML = '';
    const list = loadDmIndex();
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = 'No DMs yet. v1 stub — start a thread below.';
      host.appendChild(empty);
    } else {
      list.forEach((r) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-dm-row';
        btn.textContent = r.name || r.id;
        btn.addEventListener('click', () => {
          dmPeer = r.id;
          setTab('dm');
        });
        host.appendChild(btn);
      });
    }
    const starter = document.createElement('div');
    starter.className = 'chat-dm-start';
    const input = document.createElement('input');
    input.className = 'chat-dm-peer-input';
    input.type = 'text';
    input.placeholder = 'Peer id (stub)';
    input.autocomplete = 'off';
    input.setAttribute('enterkeyhint', 'go');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'chat-dm-start-btn';
    go.textContent = 'Open';
    const openPeer = () => {
      const id = (input.value || '').trim();
      if (!id) return;
      touchDmPeer(id, id);
      dmPeer = id;
      setTab('dm');
    };
    go.addEventListener('click', openPeer);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); openPeer(); }
    });
    starter.appendChild(input);
    starter.appendChild(go);
    host.appendChild(starter);
  }

  function render() {
    refreshLobbyTabState();
    if (tab === 'dm' && !dmPeer) renderDmList();
    else renderMessages();
    updateChannelLabel();
  }

  function sendText(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const key = channelKeyForTab(tab);
    if (!key) return;
    const msg = {
      id: 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      uid: userId(),
      name: displayName(),
      text: t.slice(0, 500),
      ts: Date.now(),
      channel: key
    };
    const list = loadMessages(key);
    list.push(msg);
    saveMessages(key, list);
    if (tab === 'dm' && dmPeer) touchDmPeer(dmPeer, dmPeer);
    publishMqtt(msg);
    renderMessages();
  }

  /* ---- Optional MQTT (same public brokers as SITE/CH; best-effort) ---- */
  function mqttPath(channelKey) {
    return 'onpad/v1/' + String(channelKey || '').replace(/[^a-zA-Z0-9:_-]/g, '_');
  }

  function publishMqtt(msg) {
    if (!mqttClient || !mqttAlive || !mqttTopic) return;
    try {
      mqttClient.publish(mqttTopic, JSON.stringify(msg), { qos: 0, retain: false });
    } catch (e) { /* ignore */ }
  }

  function onMqttMessage(_topic, buf) {
    try {
      const msg = JSON.parse(buf.toString());
      if (!msg || !msg.id || !msg.channel || !msg.text) return;
      if (msg.uid === userId()) return; /* already stored locally */
      const list = loadMessages(msg.channel);
      if (list.some((m) => m.id === msg.id)) return;
      list.push({
        id: String(msg.id),
        uid: String(msg.uid || ''),
        name: String(msg.name || 'Operator').slice(0, 80),
        text: String(msg.text).slice(0, 500),
        ts: Number(msg.ts) || Date.now(),
        channel: String(msg.channel)
      });
      saveMessages(msg.channel, list);
      if (channelKeyForTab(tab) === msg.channel) renderMessages();
    } catch (e) { /* ignore */ }
  }

  function connectMqtt(i) {
    if (typeof mqtt === 'undefined') return;
    const idx = i || 0;
    if (idx >= BROKERS.length) return;
    const key = channelKeyForTab(tab);
    if (!key) return;
    const want = mqttPath(key);
    try {
      if (mqttClient) {
        try { mqttClient.end(true); } catch (e) {}
        mqttClient = null;
      }
      mqttAlive = false;
      mqttTopic = want;
      const c = mqtt.connect(BROKERS[idx], {
        clientId: 'onpad-chat-' + Math.random().toString(36).slice(2, 8),
        reconnectPeriod: 8000,
        connectTimeout: 8000,
        clean: true,
        keepalive: 30
      });
      mqttClient = c;
      c.on('connect', () => {
        mqttAlive = true;
        try { c.subscribe(want, { qos: 0 }); } catch (e) { /* ignore */ }
      });
      c.on('message', onMqttMessage);
      c.on('close', () => { mqttAlive = false; });
      c.on('error', () => {
        mqttAlive = false;
        try { c.end(true); } catch (e) {}
        if (mqttClient === c) connectMqtt(idx + 1);
      });
    } catch (e) {
      connectMqtt(idx + 1);
    }
  }

  function retopicMqtt() {
    if (!open) return;
    const key = channelKeyForTab(tab);
    if (!key) {
      if (mqttClient) {
        try { mqttClient.end(true); } catch (e) {}
        mqttClient = null;
      }
      mqttAlive = false;
      mqttTopic = '';
      return;
    }
    const want = mqttPath(key);
    if (mqttAlive && mqttTopic === want) return;
    connectMqtt(0);
  }

  function wireUi() {
    const toggle = $('chatToggle');
    const hide = $('chatHideBtn');
    const form = $('chatCompose');
    const input = $('chatInput');
    const back = $('chatDmBack');

    if (toggle) {
      toggle.addEventListener('click', () => setOpen(!open));
    }
    if (hide) {
      hide.addEventListener('click', () => setOpen(false));
    }
    document.querySelectorAll('.chat-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-chat-tab');
        if (t) setTab(t);
      });
    });
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input) return;
        sendText(input.value);
        input.value = '';
        input.focus();
      });
    }
    if (back) {
      back.addEventListener('click', () => {
        dmPeer = null;
        setTab('dm');
      });
    }
  }

  function startPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      refreshLobbyTabState();
    }, 1200);
    window.addEventListener('storage', (e) => {
      if (e.key === MAP_MODE_KEY) refreshLobbyTabState();
      if (e.key && e.key.indexOf(LS_PREFIX) === 0) render();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshLobbyTabState();
    });
  }

  function init() {
    if (!$('chatShell') || !$('chatToggle')) return;
    wireUi();
    setOpen(false); /* default collapsed — map stays clear */
    setTab('global');
    refreshLobbyTabState();
    startPoll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Light debug surface for App Builder / local checks */
  window.OnPadChat = {
    channelKeyForTab: channelKeyForTab,
    readMapMode: readMapMode,
    townId: townId,
    open: () => setOpen(true),
    close: () => setOpen(false),
    setTab: setTab
  };
})();
