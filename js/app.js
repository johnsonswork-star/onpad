/* OnPad — open jobsite map for dozer / excavator / water / truck */
(() => {
  'use strict';

  const VERSION = 1;
  const SHARED_SITE = 'SITE'; /* one shared live room for the Pages URL — no job codes */
  const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const M_PER_DEG = 111320;
  const FT_PER_M = 3.28084;
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  const DEFAULTS = {
    pad: { w: 24, l: 18, rot: 0 },
    road: { w: 8, l: 50, rot: 90 },
    pile: { r: 8 }
  };
  const ROLES = ['dozer', 'excavator', 'water'];
  const ROLE_LABEL = { dozer: 'Dozer', excavator: 'Excavator', water: 'Water' };

  /* ------------------------------------------------------------------ */
  /* Position source                                                      */
  /* v1 uses THIS PHONE's GPS as a stand-in for the dozer's Trimble      */
  /* survey-grade receiver. Stakeout (corner pins) and the machine       */
  /* marker always read through PositionSource.getLatLng().              */
  /*                                                                     */
  /* Hook for later: PositionSource.attachTrimble(feed) — pass an object */
  /* { watch(cb), getLatLng() } from a real Trimble client. Do not fake  */
  /* a Trimble API. Phone GPS remains the v1 source until that exists.   */
  /* ------------------------------------------------------------------ */
  const PositionSource = {
    kind: 'phone-gps', // later: 'trimble'
    lat: null,
    lng: null,
    accM: null,
    heading: null,
    t: 0,
    _watchId: null,
    _listeners: [],
    getLatLng() {
      if (this.lat == null) return null;
      return { lat: this.lat, lng: this.lng, accM: this.accM, heading: this.heading, t: this.t };
    },
    on(fn) { this._listeners.push(fn); },
    _emit() {
      const pos = this.getLatLng();
      this._listeners.forEach((fn) => fn(pos));
    },
    attachTrimble(feed) {
      /* Real Trimble feed goes here later. feed.watch(cb) should call
         cb({ lat, lng, accM, heading }) with survey-grade positions. */
      if (!feed || typeof feed.watch !== 'function') return;
      this.kind = 'trimble';
      if (this._watchId != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }
      feed.watch((p) => {
        if (!p) return;
        this.lat = p.lat; this.lng = p.lng;
        this.accM = p.accM != null ? p.accM : 0.02;
        this.heading = p.heading != null ? p.heading : this.heading;
        this.t = Date.now();
        this._emit();
      });
    },
    startPhoneGps() {
      if (!navigator.geolocation) {
        ui.toast('No GPS on this device');
        return;
      }
      if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        ui.toast('GPS needs HTTPS');
      }
      const opts = { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 };
      const onOk = (g) => {
        this.lat = g.coords.latitude;
        this.lng = g.coords.longitude;
        this.accM = g.coords.accuracy;
        this.heading = g.coords.heading;
        this.t = Date.now();
        this._emit();
      };
      const onErr = () => ui.gps(null);
      this._watchId = navigator.geolocation.watchPosition(onOk, onErr, opts);
    }
  };

  /* geo */
  function mPerDegLng(lat) { return M_PER_DEG * Math.cos((lat * Math.PI) / 180); }
  function toXY(latlng, origin) {
    return {
      x: (latlng.lng - origin.lng) * mPerDegLng(origin.lat),
      y: (latlng.lat - origin.lat) * M_PER_DEG
    };
  }
  function fromXY(xy, origin) {
    return L.latLng(
      origin.lat + xy.y / M_PER_DEG,
      origin.lng + xy.x / mPerDegLng(origin.lat)
    );
  }
  function rotXY(x, y, deg) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    return { x: x * c - y * s, y: x * s + y * c };
  }
  function distM(a, b) {
    const xy = toXY(b, a);
    return Math.hypot(xy.x, xy.y);
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function jobCode() {
    let s = '';
    for (let i = 0; i < 4; i++) s += CHARSET[(Math.random() * CHARSET.length) | 0];
    return s;
  }
  function now() { return Date.now(); }

  /* Account stamp — anonymous local id for later abuse attribution (no login UI). */
  function localUserId() {
    try {
      let id = localStorage.getItem('onpad:userId');
      if (!id) {
        id = 'anon-' + uid();
        localStorage.setItem('onpad:userId', id);
      }
      return id;
    } catch (e) {
      return 'anon-' + uid();
    }
  }
  function stamp(obj) {
    const id = localUserId();
    obj.by = id;
    obj.userId = id;
    return obj;
  }

  /* Optional display name. Rename keeps the SAME auto-minted userId. */
  function displayName() {
    try {
      return (localStorage.getItem('onpad:displayName') || '').trim();
    } catch (e) {
      return '';
    }
  }
  function setDisplayName(name) {
    const v = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    try {
      if (v) localStorage.setItem('onpad:displayName', v);
      else localStorage.removeItem('onpad:displayName');
    } catch (e) { /* quota / private mode */ }
    return v;
  }
  function truncUserId(id) {
    if (!id) return '';
    if (id.length <= 12) return id;
    return id.slice(0, 6) + '\u2026' + id.slice(-4);
  }

  /* Ban hook only — majority-report ban UI comes later.
     Reserved: localStorage 'onpad:banned' === '1'  OR  account.accessOk === false.
     Do NOT gate the map this pass. Do NOT build ban UI. */
  const account = {
    get accessOk() {
      try {
        return localStorage.getItem('onpad:banned') !== '1';
      } catch (e) {
        return true;
      }
    }
  };

  function rectCorners(s) {
    const origin = { lat: s.lat, lng: s.lng };
    const hw = s.w / 2, hl = s.l / 2;
    const pts = [
      [-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]
    ].map(([x, y]) => {
      const r = rotXY(x, y, s.rot);
      return fromXY(r, origin);
    });
    return pts;
  }
  function rectHandle(s, which) {
    const origin = { lat: s.lat, lng: s.lng };
    let x = 0, y = 0;
    if (which === 'e') x = s.w / 2;
    if (which === 'n') y = s.l / 2;
    if (which === 'rot') y = s.l / 2 + Math.max(8, s.l * 0.18);
    const r = rotXY(x, y, s.rot);
    return fromXY(r, origin);
  }
  function centroid(latlngs) {
    let lat = 0, lng = 0;
    latlngs.forEach((p) => { lat += p.lat; lng += p.lng; });
    return L.latLng(lat / latlngs.length, lng / latlngs.length);
  }

  /* state */
  let state = emptyState(SHARED_SITE);
  let role = localStorage.getItem('onpad:role') || 'dozer';
  let placeTool = null;
  let selected = null; // { kind, id }
  let map, layers, handleGroup, machineMarkers = {}, myMarker, accCircle;
  let mqttClient = null;
  let mqttAlive = false;
  let pubTimer = null;
  let applyingRemote = false;
  let didFly = false;
  let lastLocalView = null;
  let pathDraft = null;
  let pathTagPending = null;

  function emptyState(code) {
    return {
      v: VERSION,
      job: code || SHARED_SITE,
      surfaces: [],
      requests: [],
      digPads: [],
      fleet: [],
      paths: [],
      stakeDraft: { pins: [], u: 0 },
      machines: {},
      u: now()
    };
  }

  function storageKey(code) { return 'onpad:job:' + code; }

  function persist() {
    state.u = now();
    state.job = SHARED_SITE;
    try {
      localStorage.setItem(storageKey(SHARED_SITE), JSON.stringify(state));
      localStorage.setItem('onpad:activeJob', SHARED_SITE);
      localStorage.setItem('onpad:role', role);
    } catch (e) { /* quota */ }
    schedulePub();
    renderAll();
  }

  function loadJob(code, fallback) {
    try {
      const raw = localStorage.getItem(storageKey(code));
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.v === VERSION) {
          if (!Array.isArray(s.fleet)) s.fleet = [];
          if (!Array.isArray(s.paths)) s.paths = [];
          return s;
        }
      }
    } catch (e) { /* ignore */ }
    return fallback || emptyState(code);
  }

  function slimState() {
    return {
      v: state.v,
      job: SHARED_SITE,
      surfaces: state.surfaces,
      requests: state.requests,
      digPads: state.digPads,
      fleet: state.fleet || [],
      paths: state.paths || [],
      stakeDraft: state.stakeDraft,
      machines: state.machines,
      u: state.u
    };
  }

  function mergeById(localArr, remoteArr) {
    const map = new Map();
    (localArr || []).forEach((x) => map.set(x.id, x));
    (remoteArr || []).forEach((x) => {
      const cur = map.get(x.id);
      if (!cur || (x.u || 0) >= (cur.u || 0)) map.set(x.id, x);
    });
    return [...map.values()];
  }

  function applyRemote(remote) {
    if (!remote || remote.v !== VERSION) return;
    applyingRemote = true;
    state.job = SHARED_SITE;
    state.surfaces = mergeById(state.surfaces, remote.surfaces);
    state.requests = mergeById(state.requests, remote.requests);
    state.digPads = mergeById(state.digPads, remote.digPads);
    state.fleet = mergeById(state.fleet || [], remote.fleet || []);
    state.paths = mergeById(state.paths || [], remote.paths || []);
    const ru = (remote.stakeDraft && remote.stakeDraft.u) || 0;
    const lu = (state.stakeDraft && state.stakeDraft.u) || 0;
    if (ru >= lu) state.stakeDraft = remote.stakeDraft || { pins: [], u: 0 };
    const machines = Object.assign({}, state.machines);
    Object.keys(remote.machines || {}).forEach((k) => {
      const r = remote.machines[k];
      const l = machines[k];
      if (!l || (r && r.t >= l.t)) machines[k] = r;
    });
    state.machines = machines;
    try { localStorage.setItem(storageKey(state.job), JSON.stringify(state)); } catch (e) {}
    applyingRemote = false;
    renderAll();
  }

  /* URL snapshot */
  function encodeSnap() {
    try {
      const json = JSON.stringify(slimState());
      return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) { return ''; }
  }
  function decodeSnap(s) {
    try {
      const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
      const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) { return null; }
  }
  function shareUrl() {
    const u = new URL(location.href);
    u.searchParams.delete('job');
    u.hash = '';
    return u.toString();
  }

  /* MQTT sync — public brokers; shared site room (hidden). No API keys. */
  function topic() { return 'onpad/v1/' + SHARED_SITE; }
  function schedulePub() {
    if (applyingRemote) return;
    clearTimeout(pubTimer);
    pubTimer = setTimeout(publish, 280);
  }
  function publish() {
    if (!mqttClient || !mqttAlive) return;
    try {
      mqttClient.publish(topic(), JSON.stringify(slimState()), { qos: 0, retain: true });
    } catch (e) { /* ignore */ }
  }
  function connectMqtt(i) {
    if (typeof mqtt === 'undefined') {
      ui.sync('local');
      return;
    }
    const idx = i || 0;
    if (idx >= BROKERS.length) {
      ui.sync('local');
      return;
    }
    ui.sync('wait');
    try {
      if (mqttClient) {
        try { mqttClient.end(true); } catch (e) {}
        mqttClient = null;
      }
      const c = mqtt.connect(BROKERS[idx], {
        clientId: 'onpad-' + role + '-' + Math.random().toString(36).slice(2, 8),
        reconnectPeriod: 5000,
        connectTimeout: 8000,
        clean: true,
        keepalive: 30
      });
      mqttClient = c;
      c.on('connect', () => {
        mqttAlive = true;
        ui.sync('live');
        c.subscribe(topic(), { qos: 0 });
        publish();
      });
      c.on('message', (_t, buf) => {
        try {
          const remote = JSON.parse(buf.toString());
          applyRemote(remote);
        } catch (e) { /* ignore */ }
      });
      c.on('close', () => {
        mqttAlive = false;
        ui.sync('wait');
      });
      c.on('error', () => {
        mqttAlive = false;
        try { c.end(true); } catch (e) {}
        if (mqttClient === c) connectMqtt(idx + 1);
      });
    } catch (e) {
      connectMqtt(idx + 1);
    }
  }
  function retopic() {
    mqttAlive = false;
    connectMqtt(0);
  }

  /* UI helpers */
  const ui = {
    toast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.hidden = false;
      clearTimeout(this._t);
      this._t = setTimeout(() => { el.hidden = true; }, 2200);
    },
    gps(pos) {
      const el = document.getElementById('gpsBadge');
      if (!pos) {
        el.className = 'badge gps-off';
        el.textContent = 'GPS';
        return;
      }
      const ft = Math.round(pos.accM * FT_PER_M);
      el.textContent = '±' + ft + 'ft';
      el.className = 'badge ' + (pos.accM > 12 ? 'gps-weak' : 'gps-on');
    },
    sync(mode) {
      const el = document.getElementById('syncBadge');
      if (mode === 'live') { el.className = 'badge sync-live'; el.textContent = 'LIVE'; }
      else if (mode === 'wait') { el.className = 'badge sync-wait'; el.textContent = 'SYNC'; }
      else { el.className = 'badge sync-local'; el.textContent = 'SOLO'; }
    },
    job() { /* open site — no job chip in HUD */ },
    pathHint(msg) {
      const el = document.getElementById('pathHint');
      if (el) el.textContent = msg || 'Start a path, tap the map to drop haul points';
    },
    role() {
      const btn = document.getElementById('roleBtn');
      const name = displayName();
      btn.className = 'identity role-' + role + (name ? ' named' : '');
      const kicker = btn.querySelector('.identity-kicker');
      const sub = btn.querySelector('.identity-sub');
      document.getElementById('roleLabel').textContent = ROLE_LABEL[role];
      if (name) {
        if (kicker) kicker.textContent = name;
        if (sub) sub.textContent = '';
      } else {
        if (kicker) kicker.textContent = "I'M THE";
        if (sub) sub.textContent = 'OPERATOR';
      }
      const stake = document.getElementById('stakeRow');
      if (stake) stake.style.display = role === 'dozer' ? 'flex' : 'none';
      document.body.classList.remove('role-dozer', 'role-excavator', 'role-water');
      document.body.classList.add('role-' + role);
      const ico = document.getElementById('roleIcon');
      if (ico) ico.innerHTML = roleSvg(role);
    },
    pinCount() {
      const n = (state.stakeDraft.pins || []).length;
      document.getElementById('pinCount').textContent = String(n);
      document.getElementById('cutBtn').disabled = n < 3;
      document.getElementById('undoPinBtn').disabled = n < 1;
    },
    tools() {
      document.querySelectorAll('.tool[data-tool]').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-tool') === placeTool);
      });
      const drawing = placeTool === 'path-draw' || placeTool === 'path-point' || !!pathDraft;
      const ps = document.getElementById('pathStartBtn');
      const pp = document.getElementById('pathPointBtn');
      if (ps) ps.classList.toggle('active', placeTool === 'path-draw' || (!!pathDraft && placeTool !== 'path-point'));
      if (pp) pp.classList.toggle('active', placeTool === 'path-point');
    }
  };

  function openSheet(id) {
    if (id === 'roleSheet') syncProfileSheet();
    document.getElementById(id).hidden = false;
  }
  function closeSheet(id) { document.getElementById(id).hidden = true; }

  function syncProfileSheet() {
    const name = displayName();
    const input = document.getElementById('displayNameInput');
    if (input && document.activeElement !== input) input.value = name;
    const btn = document.getElementById('continueAsBtn');
    if (btn) btn.textContent = 'Continue as ' + (name || 'Guest');
    const chip = document.getElementById('userIdChip');
    if (chip) {
      const id = localUserId();
      chip.textContent = truncUserId(id);
      chip.setAttribute('title', id);
    }
    document.querySelectorAll('.role-pick').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-role') === role);
    });
  }

  /* SVG bits */
  const SVG = {
    shovel: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M14 2h4v14l6 10a8 8 0 1 1-16 0l6-10z" fill="currentColor"/></svg>',
    drop: '<svg viewBox="0 0 32 32"><path d="M16 2s10 12 10 18a10 10 0 1 1-20 0C6 14 16 2 16 2z" fill="currentColor"/></svg>',
    mist: '<svg viewBox="0 0 32 32"><path d="M12 8c0-4 4-8 4-8s4 4 4 8a4 4 0 1 1-8 0z" fill="currentColor"/><circle cx="7" cy="24" r="3" fill="currentColor"/><circle cx="16" cy="28" r="2.2" fill="currentColor"/><circle cx="25" cy="24" r="3" fill="currentColor"/></svg>',
    blade: '<svg viewBox="0 0 32 32"><path d="M4 20h24l-3 6H7z" fill="currentColor"/><path d="M7 18l3-8h12l3 8" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
    dozer: '<svg viewBox="0 0 32 32"><rect x="4" y="10" width="20" height="10" fill="currentColor"/><rect x="2" y="16" width="10" height="5" fill="currentColor"/><circle cx="10" cy="24" r="4" fill="#1c1814" stroke="currentColor" stroke-width="2"/><circle cx="22" cy="24" r="4" fill="#1c1814" stroke="currentColor" stroke-width="2"/></svg>',
    excavator: '<svg viewBox="0 0 32 32"><rect x="6" y="12" width="14" height="8" fill="currentColor"/><path d="M20 14l10-8-2 8-6 3" fill="currentColor"/><circle cx="12" cy="24" r="4" fill="#1c1814" stroke="currentColor" stroke-width="2"/></svg>',
    water: '<svg viewBox="0 0 32 32"><rect x="2" y="12" width="10" height="8" fill="currentColor"/><ellipse cx="20" cy="16" rx="9" ry="6" fill="currentColor"/><circle cx="8" cy="24" r="4" fill="#1c1814" stroke="currentColor" stroke-width="2"/><circle cx="22" cy="24" r="4" fill="#1c1814" stroke="currentColor" stroke-width="2"/></svg>'
  };

  /* map + layers */
  let satLayer, streetLayer, activeBasemap = 'sat';
  let tileFailCount = 0;

  function makeSatLayer() {
    return L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20,
      maxNativeZoom: 19,
      crossOrigin: true,
      attribution: 'Tiles © Esri — Esri, Maxar, Earthstar Geographics'
    });
  }
  function makeStreetLayer() {
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    });
  }
  function setBasemap(kind) {
    if (!map) return;
    if (satLayer) map.removeLayer(satLayer);
    if (streetLayer) map.removeLayer(streetLayer);
    activeBasemap = kind;
    if (kind === 'street') {
      streetLayer = makeStreetLayer();
      streetLayer.addTo(map);
      streetLayer.bringToBack();
    } else {
      satLayer = makeSatLayer();
      satLayer.on('tileerror', onTileError);
      satLayer.addTo(map);
      satLayer.bringToBack();
    }
    const btn = document.getElementById('basemapBtn');
    if (btn) {
      const span = btn.querySelector('span:not(.tool-text-only)');
      // keep icon; optional tiny label
      const lab = btn.querySelector('span:last-of-type');
      if (lab && !lab.querySelector('svg')) lab.textContent = kind === 'sat' ? 'Map' : 'Sat';
      btn.setAttribute('aria-label', kind === 'sat' ? 'Switch to street map' : 'Switch to satellite');
    }
    try { localStorage.setItem('onpad:basemap', kind); } catch (e) {}
  }
  function onTileError() {
    tileFailCount += 1;
    if (tileFailCount >= 6 && activeBasemap === 'sat') {
      tileFailCount = 0;
      ui.toast('Satellite blocked — switching to street map');
      setBasemap('street');
    }
  }
  function refreshMapSize() {
    if (!map) return;
    try {
      const el = document.getElementById('map');
      const vv = window.visualViewport;
      const w = Math.round((vv && vv.width) || window.innerWidth || document.documentElement.clientWidth);
      const h = Math.round((vv && vv.height) || window.innerHeight || document.documentElement.clientHeight);
      if (el && w > 0 && h > 0) {
        el.style.width = w + 'px';
        el.style.height = h + 'px';
      }
      map.invalidateSize(true);
    } catch (e) {}
  }

  function initMap() {
    if (typeof L === 'undefined') {
      throw new Error('Map library failed to load. Check your connection and hard-refresh.');
    }
    map = L.map('map', {
      zoomControl: false,
      attributionControl: true
    });

    let prefer = 'sat';
    try { prefer = localStorage.getItem('onpad:basemap') || 'sat'; } catch (e) {}
    setBasemap(prefer);

    layers = {
      surfaces: L.layerGroup().addTo(map),
      requests: L.layerGroup().addTo(map),
      paths: L.layerGroup().addTo(map),
      stake: L.layerGroup().addTo(map),
      dig: L.layerGroup().addTo(map),
      fleet: L.layerGroup().addTo(map),
      machines: L.layerGroup().addTo(map)
    };
    handleGroup = L.layerGroup().addTo(map);

    const saved = lastLocalView;
    // Blue Ridge, TX area so the map shows real dirt before GPS locks
    if (saved && saved.lat != null) map.setView([saved.lat, saved.lng], saved.zoom || 14);
    else map.setView([33.30, -96.40], 14);

    map.on('click', onMapClick);
    map.on('moveend', () => {
      const c = map.getCenter();
      lastLocalView = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
      try { localStorage.setItem('onpad:view', JSON.stringify(lastLocalView)); } catch (e) {}
    });

    ['topbar', 'leftRail', 'rightRail', 'selectedBar', 'truckBar'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) L.DomEvent.disableClickPropagation(el);
    });

    setTimeout(refreshMapSize, 100);
    setTimeout(refreshMapSize, 500);
    window.addEventListener('resize', refreshMapSize);
    window.addEventListener('orientationchange', () => setTimeout(refreshMapSize, 250));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') setTimeout(refreshMapSize, 100);
    });
  }

  function onMapClick(e) {
    if (placeTool === 'path-draw' || placeTool === 'path-point') {
      addPathPoint(e.latlng);
      return;
    }
    if (placeTool === 'pad' || placeTool === 'road' || placeTool === 'pile') {
      placeSurface(placeTool, e.latlng);
      placeTool = null;
      ui.tools();
      return;
    }
    if (placeTool === 'water-light' || placeTool === 'water-heavy' || placeTool === 'cleanup') {
      placeRequest(placeTool, e.latlng);
      return;
    }
    if (placeTool === 'place-dozer' || placeTool === 'place-excavator' || placeTool === 'place-water') {
      const kind = placeTool === 'place-excavator' ? 'excavator' : (placeTool === 'place-water' ? 'water' : 'dozer');
      placeFleet(kind, e.latlng);
      placeTool = null;
      ui.tools();
      return;
    }
    select(null);
  }

  /* surfaces */
  let editLock = false;
  const surfacePaths = {};

  function placeSurface(type, latlng) {
    const d = DEFAULTS[type];
    const item = stamp({
      id: uid(),
      type,
      lat: latlng.lat,
      lng: latlng.lng,
      w: d.w || 0,
      l: d.l || 0,
      r: d.r || 0,
      rot: d.rot || 0,
      u: now()
    });
    state.surfaces.push(item);
    persist();
    select({ kind: 'surface', id: item.id });
  }

  function surfaceStyle(type, on) {
    if (type === 'pad') {
      return { color: on ? '#ffe08a' : '#e0b84d', weight: on ? 5 : 3, fillColor: '#c48a48', fillOpacity: 0.38 };
    }
    if (type === 'road') {
      return { color: on ? '#e8e0d0' : '#b8b0a0', weight: on ? 5 : 3, fillColor: '#5a5854', fillOpacity: 0.42 };
    }
    return { color: on ? '#ffc090' : '#e09050', weight: on ? 5 : 3, fillColor: '#b45a28', fillOpacity: 0.4 };
  }

  function updateSurfacePath(s) {
    const rec = surfacePaths[s.id];
    if (!rec) return;
    if (s.type === 'pile') {
      rec.path.setLatLng([s.lat, s.lng]);
      rec.path.setRadius(s.r);
    } else {
      rec.path.setLatLngs(rectCorners(s));
    }
  }

  function drawSurfaces() {
    if (editLock) {
      state.surfaces.forEach((s) => { if (!s.gone) updateSurfacePath(s); });
      return;
    }
    layers.surfaces.clearLayers();
    handleGroup.clearLayers();
    Object.keys(surfacePaths).forEach((k) => { delete surfacePaths[k]; });
    state.surfaces.forEach((s) => {
      if (s.gone) return;
      const on = selected && selected.kind === 'surface' && selected.id === s.id;
      let path;
      if (s.type === 'pile') {
        path = L.circle([s.lat, s.lng], Object.assign({
          radius: s.r, interactive: true
        }, surfaceStyle('pile', on)));
      } else {
        path = L.polygon(rectCorners(s), Object.assign({ interactive: true }, surfaceStyle(s.type, on)));
      }
      path.addTo(layers.surfaces);
      surfacePaths[s.id] = { path };
      wirePath(path, { kind: 'surface', id: s.id }, s);
      if (on) {
        if (s.type === 'pile') pileHandles(s);
        else rectHandles(s);
      }
    });
  }

  function wirePath(path, sel, item) {
    path.on('click', (e) => {
      L.DomEvent.stop(e);
      select(sel);
    });
    let dragging = false, startLL, orig;
    path.on('mousedown', (e) => {
      if (!selected || selected.id !== sel.id) return;
      L.DomEvent.stop(e);
      map.dragging.disable();
      dragging = true;
      editLock = true;
      startLL = e.latlng;
      orig = { lat: item.lat, lng: item.lng };
    });
    const move = (e) => {
      if (!dragging) return;
      item.lat = orig.lat + (e.latlng.lat - startLL.lat);
      item.lng = orig.lng + (e.latlng.lng - startLL.lng);
      item.u = now();
      updateSurfacePath(item);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      editLock = false;
      map.dragging.enable();
      persist();
    };
    map.on('mousemove', move);
    map.on('mouseup', up);
    path.on('remove', () => {
      map.off('mousemove', move);
      map.off('mouseup', up);
    });
  }

  function makeHandle(latlng, cls, onDrag) {
    const m = L.marker(latlng, {
      draggable: true,
      zIndexOffset: 1200,
      icon: L.divIcon({ className: 'handle-icon ' + (cls || ''), iconSize: [44, 44], iconAnchor: [22, 22] })
    }).addTo(handleGroup);
    m.on('dragstart', () => { map.dragging.disable(); editLock = true; });
    m.on('drag', () => onDrag(m.getLatLng()));
    m.on('dragend', () => { editLock = false; map.dragging.enable(); persist(); });
    return m;
  }

  function rectHandles(s) {
    makeHandle(rectHandle(s, 'e'), '', (ll) => {
      const origin = { lat: s.lat, lng: s.lng };
      const xy = toXY(ll, origin);
      const local = rotXY(xy.x, xy.y, -s.rot);
      s.w = Math.max(4, Math.abs(local.x) * 2);
      s.u = now();
      updateSurfacePath(s);
    });
    makeHandle(rectHandle(s, 'n'), '', (ll) => {
      const origin = { lat: s.lat, lng: s.lng };
      const xy = toXY(ll, origin);
      const local = rotXY(xy.x, xy.y, -s.rot);
      s.l = Math.max(4, Math.abs(local.y) * 2);
      s.u = now();
      updateSurfacePath(s);
    });
    makeHandle(rectHandle(s, 'rot'), 'rotate', (ll) => {
      const origin = { lat: s.lat, lng: s.lng };
      const xy = toXY(ll, origin);
      s.rot = (Math.atan2(xy.x, xy.y) * 180) / Math.PI;
      s.u = now();
      updateSurfacePath(s);
    });
  }

  function pileHandles(s) {
    const origin = { lat: s.lat, lng: s.lng };
    const edge = fromXY({ x: s.r, y: 0 }, origin);
    makeHandle(edge, 'radius', (ll) => {
      s.r = Math.max(2, distM(origin, ll));
      s.u = now();
      updateSurfacePath(s);
    });
  }

  /* requests */
  function placeRequest(kind, latlng) {
    state.requests.push(stamp({
      id: uid(),
      kind,
      lat: latlng.lat,
      lng: latlng.lng,
      u: now()
    }));
    persist();
  }

  function reqIcon(kind) {
    const cls = kind === 'cleanup' ? 'req-cleanup' : (kind === 'water-heavy' ? 'req-heavy' : 'req-light');
    const svg = kind === 'cleanup' ? SVG.blade : (kind === 'water-heavy' ? SVG.drop : SVG.mist);
    return L.divIcon({
      className: '',
      html: '<div class="req-icon ' + cls + '">' + svg + '</div>',
      iconSize: [56, 56],
      iconAnchor: [28, 28]
    });
  }

  function drawRequests() {
    layers.requests.clearLayers();
    state.requests.forEach((r) => {
      if (r.gone) return;
      const m = L.marker([r.lat, r.lng], { icon: reqIcon(r.kind), draggable: true, zIndexOffset: 400 });
      m.addTo(layers.requests);
      m.on('click', (e) => { L.DomEvent.stop(e); select({ kind: 'request', id: r.id }); });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        r.lat = ll.lat; r.lng = ll.lng; r.u = now();
        persist();
      });
    });
  }

  /* stakeout */
  function dropCornerPin() {
    const pos = PositionSource.getLatLng();
    if (!pos) {
      ui.toast('Need GPS for pin');
      return;
    }
    const pins = state.stakeDraft.pins.slice();
    pins.push(stamp({ lat: pos.lat, lng: pos.lng, accM: pos.accM, t: now() }));
    state.stakeDraft = { pins, u: now() };
    persist();
    const n = pins.length;
    const acc = Math.round((pos.accM || 0) * FT_PER_M);
    ui.toast('PIN ' + n + (n >= 4 ? '' : '/' + Math.max(4, n)) + '  ±' + acc + 'ft');
    map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 18), { animate: true });
  }

  function undoPin() {
    const pins = state.stakeDraft.pins.slice();
    if (!pins.length) return;
    pins.pop();
    state.stakeDraft = { pins, u: now() };
    persist();
  }

  function commitDigPad(cutFt) {
    const pins = state.stakeDraft.pins || [];
    if (pins.length < 3) {
      ui.toast('Need 3+ pins');
      return;
    }
    state.digPads.push(stamp({
      id: uid(),
      corners: pins.map((p) => ({ lat: p.lat, lng: p.lng })),
      cutFt,
      status: 'ready',
      u: now()
    }));
    state.stakeDraft = { pins: [], u: now() };
    persist();
    ui.toast('DIG  ' + cutFt + ' ft');
    select({ kind: 'dig', id: state.digPads[state.digPads.length - 1].id });
  }

  function pinDiv() {
    return L.divIcon({
      className: '',
      iconSize: [40, 52],
      iconAnchor: [20, 52],
      html: '<div class="pin-icon"><svg viewBox="0 0 40 52"><path d="M20 0C9 0 2 8 2 18c0 12 18 34 18 34s18-22 18-34C38 8 31 0 20 0z" fill="#f5d547" stroke="#111" stroke-width="3"/><circle cx="20" cy="18" r="6" fill="#1c1814"/></svg></div>'
    });
  }

  function drawStake() {
    layers.stake.clearLayers();
    const pins = state.stakeDraft.pins || [];
    if (pins.length >= 2) {
      L.polygon(pins.map((p) => [p.lat, p.lng]), {
        color: '#f5d547',
        weight: 3,
        dashArray: '6 8',
        fillColor: '#f5d547',
        fillOpacity: 0.12,
        interactive: false
      }).addTo(layers.stake);
    }
    pins.forEach((p, i) => {
      L.marker([p.lat, p.lng], { icon: pinDiv(), interactive: false, zIndexOffset: 600 })
        .addTo(layers.stake)
        .bindTooltip(String(i + 1), { permanent: true, direction: 'right', className: 'surface-label', offset: [10, -20] });
    });
  }

  function drawDigPads() {
    layers.dig.clearLayers();
    state.digPads.forEach((d) => {
      if (d.gone) return;
      const on = selected && selected.kind === 'dig' && selected.id === d.id;
      const cols = {
        ready: { color: '#ff6a2a', fill: '#ff6a2a' },
        started: { color: '#f5d547', fill: '#f5d547' },
        done: { color: '#4a8a28', fill: '#4a8a28' }
      }[d.status] || { color: '#ff6a2a', fill: '#ff6a2a' };
      const latlngs = d.corners.map((c) => [c.lat, c.lng]);
      const poly = L.polygon(latlngs, {
        color: cols.color,
        weight: on ? 6 : 4,
        fillColor: cols.fill,
        fillOpacity: d.status === 'done' ? 0.18 : 0.4,
        interactive: true
      }).addTo(layers.dig);
      poly.on('click', (e) => { L.DomEvent.stop(e); select({ kind: 'dig', id: d.id }); });
      const mid = centroid(d.corners.map((c) => L.latLng(c.lat, c.lng)));
      const html = '<div class="dig-badge ' + d.status + '">' + SVG.shovel + '<span>' + fmtCut(d.cutFt) + '</span></div>';
      L.marker(mid, {
        icon: L.divIcon({ className: '', html, iconSize: [90, 40], iconAnchor: [45, 20] }),
        interactive: false,
        zIndexOffset: 500
      }).addTo(layers.dig);
    });
  }

  function fmtCut(n) {
    const x = Number(n);
    if (!isFinite(x)) return '—';
    return (Math.round(x * 10) / 10) + '′';
  }



  /* haul paths — truck bar */
  // pathDraft / pathTagPending declared with state above

  function ensurePaths() {
    if (!Array.isArray(state.paths)) state.paths = [];
  }

  function startPathDraft() {
    ensurePaths();
    if (pathDraft && !pathDraft.gone) {
      placeTool = 'path-draw';
      ui.tools();
      ui.pathHint(pathDraft.pts.length
        ? ('Points: ' + pathDraft.pts.length + ' · tap more or Done')
        : 'Tap map to drop haul points · Done when finished');
      openTruckBar(true);
      return;
    }
    pathDraft = stamp({ id: uid(), pts: [], tag: pathTagPending || null, u: now(), draft: true });
    state.paths.push(pathDraft);
    placeTool = 'path-draw';
    ui.tools();
    ui.pathHint('Tap map to drop haul points · Done when finished');
    ui.toast('Path started — tap map');
    openTruckBar(true);
    persist();
  }

  function addPathPoint(latlng) {
    if (!pathDraft) startPathDraft();
    pathDraft.pts.push({ lat: latlng.lat, lng: latlng.lng });
    pathDraft.u = now();
    persist();
    ui.pathHint('Points: ' + pathDraft.pts.length + ' · tap more or Done');
  }

  function undoPathPoint() {
    if (pathDraft && pathDraft.pts.length) {
      pathDraft.pts.pop();
      pathDraft.u = now();
      persist();
      ui.pathHint(pathDraft.pts.length ? ('Points: ' + pathDraft.pts.length) : 'Tap map to drop haul points');
      return;
    }
    ensurePaths();
    // undo last committed path point / remove last path if empty undo
    const live = state.paths.filter((p) => !p.gone);
    if (!live.length) { ui.toast('No path points'); return; }
    const last = live[live.length - 1];
    if (last.pts && last.pts.length > 2) {
      last.pts = last.pts.slice(0, -1);
      last.u = now();
      persist();
      ui.toast('Point removed');
    } else {
      last.gone = true;
      last.u = now();
      persist();
      ui.toast('Path cleared');
    }
  }

  function finishPath() {
    if (!pathDraft || pathDraft.pts.length < 2) {
      ui.toast('Need 2+ points');
      return;
    }
    ensurePaths();
    if (pathTagPending) pathDraft.tag = pathTagPending;
    pathDraft.draft = false;
    pathDraft.u = now();
    pathDraft = null;
    placeTool = null;
    ui.tools();
    ui.pathHint('Path saved · Start another or Clear');
    persist();
    ui.toast('Haul path saved');
  }

  function clearPaths() {
    ensurePaths();
    if (pathDraft) {
      pathDraft.gone = true;
      pathDraft.u = now();
      pathDraft = null;
      placeTool = null;
      ui.tools();
      persist();
      ui.pathHint('Draft cleared');
      ui.toast('Draft cleared');
      return;
    }
    const live = state.paths.filter((p) => !p.gone);
    if (!live.length) { ui.toast('No paths'); return; }
    if (selected && selected.kind === 'path') {
      const p = findById(state.paths, selected.id);
      if (p) { p.gone = true; p.u = now(); selected = null; persist(); ui.toast('Path removed'); return; }
    }
    live.forEach((p) => { p.gone = true; p.u = now(); });
    persist();
    ui.pathHint('All paths cleared');
    ui.toast('Paths cleared');
  }

  function setPathTag(tag) {
    pathTagPending = pathTagPending === tag ? null : tag;
    document.querySelectorAll('.tool-path-tag').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-path-tag') === pathTagPending);
    });
    if (pathDraft) {
      pathDraft.tag = pathTagPending;
      drawPaths();
    } else if (selected && selected.kind === 'path') {
      const p = findById(state.paths, selected.id);
      if (p) {
        p.tag = pathTagPending;
        p.u = now();
        persist();
      }
    }
    ui.toast(pathTagPending === 'in' ? 'Tag: ROAD IN' : pathTagPending === 'out' ? 'Tag: ROAD OUT' : 'Tag cleared');
    ui.pathHint(pathTagPending === 'in' ? 'Next path = follow road IN' : pathTagPending === 'out' ? 'Next path = follow road OUT' : 'Start a path, tap the map to drop haul points');
  }

  function pathStyle(tag, on, draft) {
    let color = '#f5d547';
    if (tag === 'in') color = '#6ec8ff';
    if (tag === 'out') color = '#ff9a4a';
    return {
      color,
      weight: on || draft ? 10 : 8,
      opacity: draft ? 0.75 : 0.95,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: draft ? '10 12' : null
    };
  }

  function drawPaths() {
    if (!layers || !layers.paths) return;
    layers.paths.clearLayers();
    ensurePaths();
    (state.paths || []).forEach((p) => {
      if (p.gone || !p.pts || p.pts.length < 1) return;
      const on = selected && selected.kind === 'path' && selected.id === p.id;
      const draft = !!(p.draft || (pathDraft && p.id === pathDraft.id));
      const latlngs = p.pts.map((pt) => [pt.lat, pt.lng]);
      if (latlngs.length >= 2) {
        const style = pathStyle(p.tag, on, draft);
        L.polyline(latlngs, {
          color: '#111',
          weight: (style.weight || 8) + 6,
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false
        }).addTo(layers.paths);
        const line = L.polyline(latlngs, Object.assign({ interactive: !draft }, style));
        line.addTo(layers.paths);
        if (!draft) {
          line.on('click', (e) => { L.DomEvent.stop(e); select({ kind: 'path', id: p.id }); });
        }
      }
      // vertices
      p.pts.forEach((pt, i) => {
        const isEnd = i === 0 || i === p.pts.length - 1;
        L.circleMarker([pt.lat, pt.lng], {
          radius: isEnd ? 8 : 5,
          color: '#111',
          weight: 2,
          fillColor: p.tag === 'in' ? '#6ec8ff' : p.tag === 'out' ? '#ff9a4a' : '#f5d547',
          fillOpacity: 1,
          interactive: false
        }).addTo(layers.paths);
      });
      if (!draft && p.tag && latlngs.length >= 2) {
        const mid = latlngs[(latlngs.length / 2) | 0];
        L.marker(mid, {
          interactive: false,
          icon: L.divIcon({
            className: '',
            html: '<div class="path-tag-label">' + (p.tag === 'in' ? 'IN' : 'OUT') + '</div>',
            iconSize: [48, 24],
            iconAnchor: [24, 12]
          })
        }).addTo(layers.paths);
      }
    });
  }

  /* fleet — manually placed machine markers (not GPS "me") */
  function placeFleet(kind, latlng) {
    if (!state.fleet) state.fleet = [];
    const item = stamp({
      id: uid(),
      role: kind,
      lat: latlng.lat,
      lng: latlng.lng,
      u: now()
    });
    state.fleet.push(item);
    persist();
    select({ kind: 'fleet', id: item.id });
    ui.toast((ROLE_LABEL[kind] || kind) + ' placed');
  }

  function fleetIcon(r, on) {
    const color = r === 'excavator' ? '#e07030' : (r === 'water' ? '#3a9ad9' : '#f0c040');
    return L.divIcon({
      className: '',
      iconSize: [52, 52],
      iconAnchor: [26, 26],
      html: '<div class="fleet-wrap"><div class="fleet-body" style="color:' + color + ';' + (on ? 'outline:3px solid #f5d547;outline-offset:3px;' : '') + '">' + roleSvg(r) + '</div></div>'
    });
  }

  function drawFleet() {
    if (!layers || !layers.fleet) return;
    layers.fleet.clearLayers();
    (state.fleet || []).forEach((f) => {
      if (f.gone || f.lat == null) return;
      const on = selected && selected.kind === 'fleet' && selected.id === f.id;
      const m = L.marker([f.lat, f.lng], {
        icon: fleetIcon(f.role, on),
        zIndexOffset: 700,
        draggable: true
      }).addTo(layers.fleet);
      m.on('click', (e) => { L.DomEvent.stop(e); select({ kind: 'fleet', id: f.id }); });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        f.lat = ll.lat; f.lng = ll.lng; f.u = now();
        persist();
      });
    });
  }

  /* machines */
  function roleSvg(r) {
    if (r === 'excavator') return SVG.excavator;
    if (r === 'water') return SVG.water;
    return SVG.dozer;
  }
  function machineIcon(r, me) {
    const color = r === 'excavator' ? '#e07030' : (r === 'water' ? '#3a9ad9' : '#f0c040');
    return L.divIcon({
      className: '',
      iconSize: [56, 56],
      iconAnchor: [28, 28],
      html: '<div class="machine-wrap"><div class="machine-body' + (me ? ' machine-me' : '') + '" style="color:' + color + ';background:' + color + '">' + roleSvg(r) + '</div></div>'
    });
  }

  function drawMachines() {
    const pos = PositionSource.getLatLng();
    if (pos) {
      state.machines[role] = { lat: pos.lat, lng: pos.lng, hdg: pos.heading, t: pos.t, accM: pos.accM };
    }
    Object.keys(machineMarkers).forEach((k) => {
      if (!state.machines[k]) {
        layers.machines.removeLayer(machineMarkers[k]);
        delete machineMarkers[k];
      }
    });
    Object.keys(state.machines).forEach((r) => {
      const m = state.machines[r];
      if (!m || m.lat == null) return;
      const me = r === role;
      if (!machineMarkers[r]) {
        machineMarkers[r] = L.marker([m.lat, m.lng], {
          icon: machineIcon(r, me),
          zIndexOffset: 800,
          interactive: false
        }).addTo(layers.machines);
      } else {
        machineMarkers[r].setLatLng([m.lat, m.lng]);
        machineMarkers[r].setIcon(machineIcon(r, me));
      }
      if (m.hdg != null && !isNaN(m.hdg)) {
        const el = machineMarkers[r].getElement();
        if (el) {
          const body = el.querySelector('.machine-body');
          if (body) body.style.transform = 'rotate(' + m.hdg + 'deg)';
        }
      }
    });
    if (pos) {
      if (!accCircle) {
        accCircle = L.circle([pos.lat, pos.lng], {
          radius: pos.accM || 8,
          color: '#f5d547',
          weight: 1,
          dashArray: '4 6',
          fillOpacity: 0.05,
          interactive: false
        }).addTo(layers.machines);
      } else {
        accCircle.setLatLng([pos.lat, pos.lng]);
        accCircle.setRadius(pos.accM || 8);
      }
    }
  }

  /* selection bar */
  function findById(arr, id) { return arr.find((x) => x.id === id && !x.gone); }

  function select(sel) {
    selected = sel;
    drawSurfaces();
    drawRequests();
    drawPaths();
    drawDigPads();
    drawFleet();
    const bar = document.getElementById('selectedBar');
    const meta = document.getElementById('selectedMeta');
    const acts = document.getElementById('selectedActions');
    if (!sel) { bar.hidden = true; return; }
    bar.hidden = false;
    acts.innerHTML = '';
    if (sel.kind === 'surface') {
      const s = findById(state.surfaces, sel.id);
      if (!s) { bar.hidden = true; return; }
      meta.innerHTML = (s.type === 'pad' ? 'PAD' : s.type === 'road' ? 'ROAD' : 'PILE');
      acts.appendChild(killBtn(() => removeItem(state.surfaces, s)));
    } else if (sel.kind === 'request') {
      const r = findById(state.requests, sel.id);
      if (!r) { bar.hidden = true; return; }
      const label = r.kind === 'cleanup' ? 'CLEAN' : (r.kind === 'water-heavy' ? 'HEAVY' : 'LIGHT');
      meta.innerHTML = (r.kind === 'cleanup' ? SVG.blade : SVG.drop) + '<span>' + label + '</span>';
      acts.appendChild(actBtn('✓', 'ok', () => removeItem(state.requests, r)));
      acts.appendChild(killBtn(() => removeItem(state.requests, r)));
    } else if (sel.kind === 'dig') {
      const d = findById(state.digPads, sel.id);
      if (!d) { bar.hidden = true; return; }
      meta.innerHTML = SVG.shovel + '<span>' + fmtCut(d.cutFt) + '</span>';
      if (d.status !== 'started' && d.status !== 'done') {
        acts.appendChild(actBtn('▶', 'dig', () => { d.status = 'started'; d.u = now(); persist(); select(sel); }));
      }
      if (d.status !== 'done') {
        acts.appendChild(actBtn('✓', 'ok', () => { d.status = 'done'; d.u = now(); persist(); select(sel); }));
      }
      if (role === 'dozer') acts.appendChild(killBtn(() => removeItem(state.digPads, d)));
    } else if (sel.kind === 'fleet') {
      const f = findById(state.fleet || [], sel.id);
      if (!f) { bar.hidden = true; return; }
      meta.innerHTML = roleSvg(f.role) + '<span>' + (ROLE_LABEL[f.role] || f.role).toUpperCase() + '</span>';
      acts.appendChild(killBtn(() => removeItem(state.fleet, f)));
    } else if (sel.kind === 'path') {
      const p = findById(state.paths || [], sel.id);
      if (!p) { bar.hidden = true; return; }
      const tag = p.tag === 'in' ? ' IN' : p.tag === 'out' ? ' OUT' : '';
      meta.innerHTML = '<span>HAUL' + tag + ' · ' + (p.pts || []).length + ' pts</span>';
      acts.appendChild(killBtn(() => removeItem(state.paths, p)));
    }
  }

  function actBtn(label, cls, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act ' + cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }
  function killBtn(fn) { return actBtn('✕', 'kill', fn); }

  function removeItem(arr, item) {
    item.gone = true;
    item.u = now();
    selected = null;
    persist();
  }

  function renderAll() {
    ui.job();
    ui.role();
    ui.pinCount();
    ui.tools();
    if (!map) return;
    drawSurfaces();
    drawRequests();
    drawPaths();
    drawStake();
    drawDigPads();
    drawFleet();
    drawMachines();
    if (selected) select(selected);
    else document.getElementById('selectedBar').hidden = true;
  }

  /* events */
  function syncRailBody() {
    const left = document.getElementById('leftRail');
    const right = document.getElementById('rightRail');
    const truck = document.getElementById('truckBar');
    document.body.classList.toggle('rails-left-open', !!(left && left.classList.contains('open')));
    document.body.classList.toggle('rails-right-open', !!(right && right.classList.contains('open')));
    document.body.classList.toggle('truck-open', !!(truck && truck.classList.contains('open')));
    const lh = document.getElementById('leftRailHandle');
    const rh = document.getElementById('rightRailHandle');
    const th = document.getElementById('truckBarHandle');
    if (lh && left) {
      const open = left.classList.contains('open');
      lh.textContent = open ? '‹' : '›';
      lh.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (rh && right) {
      const open = right.classList.contains('open');
      rh.textContent = open ? '›' : '‹';
      rh.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (th && truck) {
      const open = truck.classList.contains('open');
      th.setAttribute('aria-expanded', open ? 'true' : 'false');
      const chev = document.getElementById('truckHandleChevron');
      if (chev) chev.textContent = open ? '▼' : '▲';
    }
    setTimeout(refreshMapSize, 240);
  }

  function openTruckBar(forceOpen) {
    const el = document.getElementById('truckBar');
    if (!el) return;
    if (forceOpen) el.classList.add('open');
    else el.classList.toggle('open');
    try { localStorage.setItem('onpad:rail:truckBar', el.classList.contains('open') ? '1' : '0'); } catch (e) {}
    syncRailBody();
  }

  function toggleRail(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('open');
    try { localStorage.setItem('onpad:rail:' + id, el.classList.contains('open') ? '1' : '0'); } catch (e) {}
    syncRailBody();
  }

  /* Wide = existing 720px tablet breakpoint, excluding short landscape cab */
  function railsDefaultOpen() {
    try {
      const wide = window.matchMedia('(min-width: 720px)').matches;
      const cabLandscape = window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
      return wide && !cabLandscape;
    } catch (e) {
      return false;
    }
  }

  function restoreRails() {
    const preferOpen = railsDefaultOpen();
    ['leftRail', 'rightRail'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const v = localStorage.getItem('onpad:rail:' + id);
        if (v === '0') el.classList.remove('open');
        else if (v === '1') el.classList.add('open');
        else if (preferOpen) el.classList.add('open');
        // else: leave closed (HTML/CSS phone default — no FOUC of open rails)
      } catch (e) {
        if (preferOpen) el.classList.add('open');
      }
    });
    const truck = document.getElementById('truckBar');
    if (truck) {
      try {
        const v = localStorage.getItem('onpad:rail:truckBar');
        // default collapsed; only open if user previously opened
        if (v === '1') truck.classList.add('open');
        else truck.classList.remove('open');
      } catch (e) {
        truck.classList.remove('open');
      }
    }
    syncRailBody();
  }

  function bind() {
    document.getElementById('roleBtn').addEventListener('click', () => openSheet('roleSheet'));
    const truckHandle = document.getElementById('truckBarHandle');
    if (truckHandle) truckHandle.addEventListener('click', () => openTruckBar());
    const pathStart = document.getElementById('pathStartBtn');
    if (pathStart) pathStart.addEventListener('click', () => startPathDraft());
    const pathPoint = document.getElementById('pathPointBtn');
    if (pathPoint) pathPoint.addEventListener('click', () => {
      if (!pathDraft) startPathDraft();
      else { placeTool = 'path-point'; ui.tools(); ui.toast('Tap map to drop a point'); }
    });
    const pathDone = document.getElementById('pathDoneBtn');
    if (pathDone) pathDone.addEventListener('click', finishPath);
    const pathUndo = document.getElementById('pathUndoBtn');
    if (pathUndo) pathUndo.addEventListener('click', undoPathPoint);
    const pathClear = document.getElementById('pathClearBtn');
    if (pathClear) pathClear.addEventListener('click', clearPaths);
    document.querySelectorAll('.tool-path-tag').forEach((b) => {
      b.addEventListener('click', () => setPathTag(b.getAttribute('data-path-tag')));
    });
    document.getElementById('basemapBtn').addEventListener('click', () => {
      setBasemap(activeBasemap === 'sat' ? 'street' : 'sat');
    });
    document.getElementById('recenterBtn').addEventListener('click', () => {
      const pos = PositionSource.getLatLng();
      if (pos) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 18));
      else ui.toast('No GPS yet');
    });
    document.getElementById('leftRailHandle').addEventListener('click', () => toggleRail('leftRail'));
    document.getElementById('rightRailHandle').addEventListener('click', () => toggleRail('rightRail'));
    restoreRails();
    document.querySelectorAll('.tool[data-tool]').forEach((b) => {
      b.addEventListener('click', () => {
        const t = b.getAttribute('data-tool');
        if (t === 'corner-pin') { dropCornerPin(); return; }
        /* path tools have dedicated handlers — don't toggle here */
        if (t === 'path-draw' || t === 'path-point') return;
        placeTool = placeTool === t ? null : t;
        ui.tools();
        if (placeTool) {
          select(null);
          const tip = {
            'place-dozer': 'Tap map to put a dozer',
            'place-excavator': 'Tap map to put an excavator',
            'place-water': 'Tap map to put a water truck',
            pad: 'Tap map to put a pad',
            road: 'Tap map to put a road',
            pile: 'Tap map to put a pile',
            'water-light': 'Tap map for light spray',
            'water-heavy': 'Tap map for heavy water',
            cleanup: 'Tap map for cleanup',
            'path-draw': 'Tap map to drop haul points',
            'path-point': 'Tap map to drop a point'
          };
          if (tip[placeTool]) ui.toast(tip[placeTool]);
        }
      });
    });
    document.getElementById('undoPinBtn').addEventListener('click', undoPin);
    document.getElementById('cutBtn').addEventListener('click', () => {
      if ((state.stakeDraft.pins || []).length < 3) { ui.toast('Need 3+ pins'); return; }
      document.getElementById('cutHint').textContent =
        state.stakeDraft.pins.length + ' corners · cut (ft)';
      openSheet('cutSheet');
    });
    document.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => closeSheet(b.getAttribute('data-close')));
    });
    document.querySelectorAll('.sheet').forEach((sh) => {
      sh.addEventListener('click', (e) => { if (e.target === sh) sh.hidden = true; });
    });
    document.querySelectorAll('.role-pick').forEach((b) => {
      b.addEventListener('click', () => {
        role = b.getAttribute('data-role');
        localStorage.setItem('onpad:role', role);
        syncProfileSheet();
        persist();
      });
    });
    const nameInput = document.getElementById('displayNameInput');
    if (nameInput) {
      const saveName = () => {
        setDisplayName(nameInput.value);
        nameInput.value = displayName();
        syncProfileSheet();
        ui.role();
      };
      nameInput.addEventListener('input', () => {
        setDisplayName(nameInput.value);
        const btn = document.getElementById('continueAsBtn');
        const n = displayName();
        if (btn) btn.textContent = 'Continue as ' + (n || 'Guest');
        ui.role();
      });
      nameInput.addEventListener('change', saveName);
      nameInput.addEventListener('blur', saveName);
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          nameInput.blur();
        }
      });
    }
    const continueBtn = document.getElementById('continueAsBtn');
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        if (nameInput) setDisplayName(nameInput.value);
        syncProfileSheet();
        ui.role();
        closeSheet('roleSheet');
      });
    }
    /* job/join sheets removed — open shared site */
    document.querySelectorAll('.cut-chip').forEach((b) => {
      b.addEventListener('click', () => {
        document.getElementById('cutInput').value = b.getAttribute('data-cut');
        document.querySelectorAll('.cut-chip').forEach((x) => x.classList.toggle('on', x === b));
      });
    });
    document.getElementById('cutGoBtn').addEventListener('click', () => {
      const n = parseFloat(document.getElementById('cutInput').value);
      if (!isFinite(n) || n < 0) { ui.toast('Enter cut (ft)'); return; }
      closeSheet('cutSheet');
      commitDigPad(Math.round(n * 10) / 10);
    });
  }

  function switchJob(code, factory) {
    persist();
    state = factory ? factory(code) : loadJob(code, emptyState(code));
    state.job = code || SHARED_SITE;
    selected = null;
    placeTool = null;
    pathDraft = null;
    if (!Array.isArray(state.fleet)) state.fleet = [];
    if (!Array.isArray(state.paths)) state.paths = [];
    machineMarkers = {};
    accCircle = null;
    const u = new URL(location.href);
    u.searchParams.delete('job');
    history.replaceState(null, '', u.pathname + u.search);
    persist();
    retopic();
  }

  function bootFromUrl() {
    /* Open site: everyone on this Pages URL shares one pad (SITE).
       Job codes are gone — MQTT room stays hidden behind SHARED_SITE. */
    const u = new URL(location.href);
    const hash = (u.hash || '').replace(/^#/, '');
    let snap = null;
    if (hash.startsWith('s=')) snap = decodeSnap(hash.slice(2));
    const code = SHARED_SITE;
    state = loadJob(code, emptyState(code));
    state.job = code;
    if (!Array.isArray(state.paths)) state.paths = [];
    if (snap) applyRemote(Object.assign({}, snap, { job: code, v: VERSION }));
    /* strip legacy job codes / snapshots from the URL so drivers see a clean link */
    if (u.searchParams.has('job') || u.hash) {
      u.searchParams.delete('job');
      history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : ''));
    }
    try {
      lastLocalView = JSON.parse(localStorage.getItem('onpad:view') || 'null');
    } catch (e) { lastLocalView = null; }
  }

  function onPos(pos) {
    ui.gps(pos);
    if (!pos) return;
    drawMachines();
    schedulePub();
    if (!didFly) {
      didFly = true;
      const hasStuff = state.surfaces.length || state.digPads.length || (state.stakeDraft.pins || []).length || ((state.paths || []).some((x) => !x.gone && x.pts && x.pts.length));
      if (!hasStuff || map.getZoom() < 12) map.setView([pos.lat, pos.lng], 18);
    }
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    // Drop any old SW that intercepted map tiles (blank black map)
    navigator.serviceWorker.getRegistrations().then((regs) => {
      const waiting = regs.map((r) => r.unregister());
      return Promise.all(waiting);
    }).then(() => caches.keys()).then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('onpad-') && k !== 'onpad-v11').map((k) => caches.delete(k)))
    ).then(() => navigator.serviceWorker.register('sw.js?v=11')).catch(() => {});
  }

  function showBootError(msg) {
    const el = document.getElementById('bootError');
    if (!el) {
      alert(msg);
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function boot() {
    try {
      bootFromUrl();
      localUserId(); /* auto-mint anonymous id; rename never replaces it */
      ui.job();
      ui.role();
      initMap();
      bind();
      renderAll();
      PositionSource.on(onPos);
      PositionSource.startPhoneGps();
      try { connectMqtt(0); } catch (e) { ui.sync('local'); }
      registerSw();
      document.getElementById('roleIcon').innerHTML = roleSvg(role);
    } catch (err) {
      console.error(err);
      showBootError('OnPad failed to start: ' + (err && err.message ? err.message : String(err)));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
