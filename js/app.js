/* OnPad v1 — jobsite map for dozer / excavator / water truck */
(() => {
  'use strict';

  const VERSION = 1;
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
  let state = emptyState(jobCode());
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

  function emptyState(code) {
    return {
      v: VERSION,
      job: code,
      surfaces: [],
      requests: [],
      digPads: [],
      stakeDraft: { pins: [], u: 0 },
      machines: {},
      u: now()
    };
  }

  function storageKey(code) { return 'onpad:job:' + code; }

  function persist() {
    state.u = now();
    try {
      localStorage.setItem(storageKey(state.job), JSON.stringify(state));
      localStorage.setItem('onpad:activeJob', state.job);
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
        if (s && s.v === VERSION) return s;
      }
    } catch (e) { /* ignore */ }
    return fallback || emptyState(code);
  }

  function slimState() {
    return {
      v: state.v,
      job: state.job,
      surfaces: state.surfaces,
      requests: state.requests,
      digPads: state.digPads,
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
    if (!remote || remote.v !== VERSION || remote.job !== state.job) return;
    applyingRemote = true;
    state.surfaces = mergeById(state.surfaces, remote.surfaces);
    state.requests = mergeById(state.requests, remote.requests);
    state.digPads = mergeById(state.digPads, remote.digPads);
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
    u.searchParams.set('job', state.job);
    const snap = encodeSnap();
    u.hash = snap ? ('s=' + snap) : '';
    return u.toString();
  }

  /* MQTT sync — public brokers, job code is the room. No API keys. */
  function topic() { return 'onpad/v1/' + state.job; }
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
    job() {
      document.getElementById('jobCodeLabel').textContent = state.job;
      document.getElementById('jobHuge').textContent = state.job;
    },
    role() {
      const btn = document.getElementById('roleBtn');
      btn.className = 'chip role-chip role-' + role;
      document.getElementById('roleLabel').textContent = ROLE_LABEL[role];
      document.getElementById('stakeRow').style.display = role === 'dozer' ? 'flex' : 'none';
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
    }
  };

  function openSheet(id) { document.getElementById(id).hidden = false; }
  function closeSheet(id) { document.getElementById(id).hidden = true; }

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
    return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20,
      maxNativeZoom: 19,
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
    if (btn) btn.textContent = kind === 'sat' ? 'MAP' : 'SAT';
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
    try { map.invalidateSize(true); } catch (e) {}
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
      stake: L.layerGroup().addTo(map),
      dig: L.layerGroup().addTo(map),
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

    ['topbar', 'dock', 'selectedBar', 'recenterBtn', 'basemapBtn'].forEach((id) => {
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
    select(null);
  }

  /* surfaces */
  let editLock = false;
  const surfacePaths = {};

  function placeSurface(type, latlng) {
    const d = DEFAULTS[type];
    const item = {
      id: uid(),
      type,
      lat: latlng.lat,
      lng: latlng.lng,
      w: d.w || 0,
      l: d.l || 0,
      r: d.r || 0,
      rot: d.rot || 0,
      u: now()
    };
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
    state.requests.push({
      id: uid(),
      kind,
      lat: latlng.lat,
      lng: latlng.lng,
      u: now()
    });
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
    pins.push({ lat: pos.lat, lng: pos.lng, accM: pos.accM, t: now() });
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
    state.digPads.push({
      id: uid(),
      corners: pins.map((p) => ({ lat: p.lat, lng: p.lng })),
      cutFt,
      status: 'ready',
      u: now()
    });
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
    drawDigPads();
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
    drawStake();
    drawDigPads();
    drawMachines();
    if (selected) select(selected);
    else document.getElementById('selectedBar').hidden = true;
  }

  /* events */
  function bind() {
    document.getElementById('jobBtn').addEventListener('click', () => openSheet('jobSheet'));
    document.getElementById('roleBtn').addEventListener('click', () => openSheet('roleSheet'));
    document.getElementById('basemapBtn').addEventListener('click', () => {
      setBasemap(activeBasemap === 'sat' ? 'street' : 'sat');
    });
    document.getElementById('recenterBtn').addEventListener('click', () => {
      const pos = PositionSource.getLatLng();
      if (pos) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 18));
      else ui.toast('No GPS yet');
    });
    document.querySelectorAll('.tool[data-tool]').forEach((b) => {
      b.addEventListener('click', () => {
        const t = b.getAttribute('data-tool');
        if (t === 'corner-pin') { dropCornerPin(); return; }
        placeTool = placeTool === t ? null : t;
        ui.tools();
        if (placeTool) select(null);
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
        closeSheet('roleSheet');
        persist();
      });
    });
    document.getElementById('newJobBtn').addEventListener('click', () => {
      switchJob(jobCode(), emptyState);
      closeSheet('jobSheet');
      ui.toast('New job ' + state.job);
    });
    document.getElementById('joinJobBtn').addEventListener('click', () => {
      closeSheet('jobSheet');
      document.getElementById('joinInput').value = '';
      openSheet('joinSheet');
      document.getElementById('joinInput').focus();
    });
    document.getElementById('joinGoBtn').addEventListener('click', () => {
      const code = (document.getElementById('joinInput').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (code.length < 3) { ui.toast('Enter a job code'); return; }
      switchJob(code);
      closeSheet('joinSheet');
      ui.toast('Joined ' + state.job);
    });
    document.getElementById('copyJobBtn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(state.job); ui.toast('Copied ' + state.job); }
      catch (e) { ui.toast(state.job); }
    });
    document.getElementById('shareJobBtn').addEventListener('click', async () => {
      const url = shareUrl();
      try {
        if (navigator.share) await navigator.share({ title: 'OnPad ' + state.job, url, text: 'Job ' + state.job });
        else { await navigator.clipboard.writeText(url); ui.toast('Link copied'); }
      } catch (e) {
        try { await navigator.clipboard.writeText(url); ui.toast('Link copied'); }
        catch (e2) { ui.toast(url); }
      }
    });
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
    state.job = code;
    selected = null;
    placeTool = null;
    machineMarkers = {};
    accCircle = null;
    const u = new URL(location.href);
    u.searchParams.set('job', code);
    history.replaceState(null, '', u.pathname + u.search);
    persist();
    retopic();
  }

  function bootFromUrl() {
    const u = new URL(location.href);
    const q = (u.searchParams.get('job') || '').toUpperCase();
    const hash = (u.hash || '').replace(/^#/, '');
    let snap = null;
    if (hash.startsWith('s=')) snap = decodeSnap(hash.slice(2));
    const last = localStorage.getItem('onpad:activeJob');
    let code = q || (snap && snap.job) || last || jobCode();
    state = loadJob(code, emptyState(code));
    if (snap && snap.job === code) applyRemote(snap);
    else if (snap && !q) {
      state = snap;
      state.job = snap.job || code;
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
      const hasStuff = state.surfaces.length || state.digPads.length || (state.stakeDraft.pins || []).length;
      if (!hasStuff || map.getZoom() < 12) map.setView([pos.lat, pos.lng], 18);
    }
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
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
