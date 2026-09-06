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
  const MACHINE_ROLES = ['dozer', 'excavator', 'water'];
  const CREW_ROLES = ['survey', 'foreman', 'geology', 'mechanic', 'trucker', 'laborer', 'fuel'];
  const ROLES = MACHINE_ROLES.concat(CREW_ROLES);
  const ROLE_LABEL = {
    dozer: 'Dozer', excavator: 'Excavator', water: 'Water',
    survey: 'Survey', foreman: 'Foreman', geology: 'Geology',
    mechanic: 'Mechanic', trucker: 'Trucker', laborer: 'Laborer', fuel: 'Fuel truck'
  };
  const ROLE_LETTER = { survey: 'S', foreman: 'F', geology: 'G', mechanic: 'M', trucker: 'T', laborer: 'L', fuel: 'FT' };
  function isMachineRole(r) { return MACHINE_ROLES.indexOf(r) >= 0; }
  function isKnownRole(r) { return ROLES.indexOf(r) >= 0; }
  function continueAsLabel(name) {
    if (name) return 'Continue as ' + name;
    if (role === 'trucker') return 'Continue as truck driver';
    if (role === 'fuel') return 'Continue as fuel truck';
    if (isMachineRole(role)) return 'Continue as ' + role + ' operator';
    return 'Continue as ' + role;
  }

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

  /* Account stamp — Google JWT sub when signed in, else anon local id.
     Majority-report bans later target Google sub; keep anon id across sign-out. */
  const GOOGLE_CLIENT_ID = '264054781775-mgh1qesr84ioucojr7mopqknnnj05csr.apps.googleusercontent.com';
  let googleBtnRendered = false;

  function googleSub() {
    try { return localStorage.getItem('onpad:googleSub') || ''; } catch (e) { return ''; }
  }
  function googleSignedIn() { return !!googleSub(); }
  function googleName() {
    try { return (localStorage.getItem('onpad:googleName') || '').trim(); } catch (e) { return ''; }
  }
  function googleEmail() {
    try { return (localStorage.getItem('onpad:googleEmail') || '').trim(); } catch (e) { return ''; }
  }

  function ensureAnonUserId() {
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

  function localUserId() {
    const sub = googleSub();
    if (sub) return sub;
    return ensureAnonUserId();
  }

  function decodeJwtPayload(credential) {
    try {
      const parts = String(credential || '').split('.');
      if (parts.length < 2) return null;
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const raw = atob(b64);
      const json = decodeURIComponent(Array.prototype.map.call(raw, (c) =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
      ).join(''));
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function applyGoogleCredential(credential) {
    const payload = decodeJwtPayload(credential);
    if (!payload || !payload.sub) {
      ui.toast('Google sign-in failed');
      return;
    }
    ensureAnonUserId(); /* keep anon id for sign-out fallback; do not delete stamps */
    try {
      localStorage.setItem('onpad:googleSub', String(payload.sub));
      if (payload.name) localStorage.setItem('onpad:googleName', String(payload.name).slice(0, 80));
      else localStorage.removeItem('onpad:googleName');
      if (payload.email) localStorage.setItem('onpad:googleEmail', String(payload.email).slice(0, 120));
      else localStorage.removeItem('onpad:googleEmail');
      /* Founder: persist sub when confirmed founder Google email signs in (case-insensitive). */
      try {
        const em = String(payload.email || '').trim().toLowerCase();
        if (em === FOUNDER_EMAIL && payload.sub) {
          localStorage.setItem('onpad:founderSub', String(payload.sub));
        }
      } catch (e) {}
      if (payload.picture) localStorage.setItem('onpad:googlePicture', String(payload.picture).slice(0, 500));
      else localStorage.removeItem('onpad:googlePicture');
      if (!displayName() && payload.name) setDisplayName(payload.name);
      if (!displayName() && payload.email) {
        const local = String(payload.email).split('@')[0].replace(/\s+/g, ' ').trim().slice(0, 32);
        if (local) setDisplayName(local);
      }
      localStorage.setItem('onpad:profileReady', '1');
    } catch (e) { /* quota / private mode */ }
    publishLocalProfile();
    syncProfileSheet();
    persist();
    ui.role();
    syncAuthGate();
    ui.toast('Signed in with Google');
  }

  function signOutGoogle() {
    try {
      localStorage.removeItem('onpad:googleSub');
      localStorage.removeItem('onpad:googleName');
      localStorage.removeItem('onpad:googleEmail');
      localStorage.removeItem('onpad:googlePicture');
    } catch (e) {}
    try {
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.disableAutoSelect();
      }
    } catch (e) {}
    googleBtnRendered = false;
    publishLocalProfile();
    syncProfileSheet();
    persist();
    ui.role();
    syncAuthGate();
    ui.toast('Signed out');
  }

  function activeGoogleHost() {
    const gate = document.getElementById('authGate');
    const gateHost = document.getElementById('authGateGoogleBtn');
    if (gate && !gate.hidden && gateHost) return gateHost;
    return document.getElementById('googleSignInBtn');
  }

  function gisButtonPresent(host) {
    const el = host || activeGoogleHost();
    if (!el || el.hidden) return false;
    return !!el.querySelector('iframe, div[role="button"], div[aria-labelledby]');
  }

  function syncGoogleFallback() {
    const inGoogle = googleSignedIn();
    ['googleSignInFallback', 'authGateGoogleFallback'].forEach((id) => {
      const fallback = document.getElementById(id);
      if (!fallback) return;
      const hostId = id === 'authGateGoogleFallback' ? 'authGateGoogleBtn' : 'googleSignInBtn';
      const host = document.getElementById(hostId);
      const show = !inGoogle && !gisButtonPresent(host);
      fallback.hidden = !show;
    });
  }

  function syncAuthGate() {
    const gate = document.getElementById('authGate');
    const inGoogle = googleSignedIn();
    if (gate) gate.hidden = inGoogle;
    document.body.classList.toggle('auth-gated', !inGoogle);
    if (!inGoogle) {
      try { closeSheet('roleSheet'); } catch (e) { /* ignore */ }
      googleBtnRendered = false;
      /* Unhide first, then GIS renderButton so host width is real on phones. */
      requestAnimationFrame(() => {
        requestAnimationFrame(() => initGoogleSignIn(true));
      });
    }
  }

  function syncGoogleAuthUi() {
    const host = document.getElementById('googleSignInBtn');
    const signed = document.getElementById('googleSignedIn');
    const chip = document.getElementById('googleUserChip');
    const inGoogle = googleSignedIn();
    if (host) host.hidden = inGoogle;
    if (signed) signed.hidden = !inGoogle;
    if (chip && inGoogle) {
      const n = googleName() || displayName() || 'Google';
      const em = googleEmail();
      chip.textContent = '';
      const nameEl = document.createElement('span');
      nameEl.textContent = n;
      chip.appendChild(nameEl);
      if (em) {
        const emEl = document.createElement('span');
        emEl.className = 'google-email';
        emEl.textContent = em;
        chip.appendChild(emEl);
      }
      chip.setAttribute('title', em ? (n + ' <' + em + '>') : n);
    }
    syncGoogleFallback();
    if (!inGoogle) initGoogleSignIn(false);
  }

  function initGoogleSignIn(forceRerender) {
    if (googleSignedIn()) return;
    const host = activeGoogleHost();
    if (!host) return;
    if (forceRerender) {
      host.innerHTML = '';
      const other = document.getElementById(host.id === 'authGateGoogleBtn' ? 'googleSignInBtn' : 'authGateGoogleBtn');
      if (other) other.innerHTML = '';
      googleBtnRendered = false;
      syncGoogleFallback();
    }
    function tryRender() {
      if (!(window.google && google.accounts && google.accounts.id)) return false;
      const h = activeGoogleHost();
      if (!h) return false;
      try {
        google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp) => {
            if (resp && resp.credential) applyGoogleCredential(resp.credential);
          },
          auto_select: false,
          cancel_on_tap_outside: true
        });
        /* Unhide gate first so GIS host width is real (same phone fix as Profile sheet). */
        if (!googleBtnRendered || forceRerender || !h.querySelector('iframe, div[role="button"]')) {
          h.innerHTML = '';
          const w = Math.max(240, Math.min(400, Math.floor(h.getBoundingClientRect().width || h.parentElement && h.parentElement.clientWidth || 320)));
          google.accounts.id.renderButton(h, {
            type: 'standard',
            theme: 'filled_black',
            size: 'large',
            text: 'signin_with',
            shape: 'rectangular',
            logo_alignment: 'left',
            width: w
          });
          googleBtnRendered = true;
          syncGoogleFallback();
        }
        return true;
      } catch (e) {
        console.warn('GIS init', e);
        return false;
      }
    }
    if (tryRender()) return;
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      if (tryRender() || n > 60) clearInterval(t);
    }, 100);
  }
  function stampCore(obj) {
    const id = localUserId();
    obj.by = id;
    obj.userId = id;
    obj.byName = stampByName();
    obj.byRole = role || '';
    obj.stampedAt = Date.now();
    return obj;
  }
  function stamp(obj) {
    /* Prefer Profile's OnPadAccount API when present (Google later). */
    try {
      if (window.OnPadAccount && typeof window.OnPadAccount.stamp === 'function'
          && window.OnPadAccount.stamp !== stamp) {
        return window.OnPadAccount.stamp(obj);
      }
    } catch (e) { /* fall through */ }
    return stampCore(obj);
  }

  /* Display name (Google name used when empty). Rename keeps the SAME userId. */
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
  function emailLocalPart() {
    const em = googleEmail();
    if (!em) return '';
    const at = em.indexOf('@');
    return (at >= 0 ? em.slice(0, at) : em).replace(/\s+/g, ' ').trim().slice(0, 32);
  }
  /* Prefer display → Google name → email local-part; 'Operator' last resort for stamps. */
  function stampByName() {
    return displayName() || googleName() || emailLocalPart() || 'Operator';
  }
  function ensureDisplayNameSeeded() {
    if (displayName()) return displayName();
    if (googleName()) return setDisplayName(googleName());
    const local = emailLocalPart();
    if (local) return setDisplayName(local);
    return '';
  }
  function truncUserId(id) {
    if (!id) return '';
    if (id.length <= 12) return id;
    return id.slice(0, 6) + '\u2026' + id.slice(-4);
  }

  /* Soft-lock: no edit/delete after 30s from stamp (live path drafts exempt). */
  const STAMP_LOCK_MS = 30000;
  function stampLockMs() {
    try {
      const n = window.OnPadAccount && window.OnPadAccount.STAMP_LOCK_MS;
      if (typeof n === 'number' && n > 0) return n;
    } catch (e) {}
    return STAMP_LOCK_MS;
  }
  let softLockToastAt = 0;
  function isSoftLocked(item) {
    if (!item || item.draft) return false;
    if (pathDraft && item.id === pathDraft.id) return false;
    const t0 = item.stampedAt || 0;
    return (now() - t0) >= stampLockMs();
  }
  function softLockToast() {
    const t0 = now();
    if (t0 - softLockToastAt < 2500) return;
    softLockToastAt = t0;
    ui.toast('Locked after 30s');
  }
  function placerLabel(item) {
    try {
      if (window.OnPadAccount && typeof window.OnPadAccount.profileLabel === 'function') {
        const label = window.OnPadAccount.profileLabel(item);
        if (label) return label;
      }
    } catch (e) { /* fall through */ }
    if (!item) return '';
    const name = String(item.byName || '').trim();
    const rawRole = String(item.byRole || '').trim();
    const roleDisp = rawRole ? (ROLE_LABEL[rawRole] || rawRole) : '';
    if (name && roleDisp) return name + ' · ' + roleDisp;
    if (roleDisp) return roleDisp;
    return truncUserId(item.userId || item.by || '');
  }
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function metaWithPlacer(titleHtml, item) {
    const who = placerLabel(item);
    const uid = item ? (item.userId || item.by || '') : '';
    const placer = who
      ? ('<button type="button" class="selected-placer placer-link" data-user-id="' +
         escHtml(uid) + '" title="View profile">' + escHtml(who) + '</button>')
      : '';
    return '<div class="selected-meta-text"><div class="selected-title">' + titleHtml +
      '</div>' + placer + '</div>';
  }

  function openUserProfile(userId) {
    const id = String(userId || '').trim();
    if (!id) return false;
    try {
      if (window.OnPadAccount && typeof window.OnPadAccount.openProfile === 'function') {
        const ok = window.OnPadAccount.openProfile(id);
        if (ok === false) {
          ui.toast('Profile unavailable');
          return false;
        }
        return true;
      }
    } catch (e) {}
    ui.toast('Profile sheet coming soon');
    return false;
  }

  function wirePlacerProfileClicks(root) {
    if (!root) return;
    root.querySelectorAll('.placer-link, .placer-chip[data-user-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openUserProfile(el.getAttribute('data-user-id'));
      });
    });
  }

  function collectNearbyUsers() {
    if (!map) return [];
    const b = map.getBounds();
    if (!b) return [];
    const byId = new Map();
    function consider(item) {
      if (!item || item.gone || item.lat == null || item.lng == null) return;
      try {
        if (!b.contains([item.lat, item.lng])) return;
      } catch (e) { return; }
      const id = item.userId || item.by || '';
      if (!id) return;
      const name = (item.byName || item.name || '').trim();
      const roleKey = item.byRole || item.role || '';
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, {
          userId: id,
          name: name,
          role: roleKey,
          lat: item.lat,
          lng: item.lng
        });
      }
    }
    (state.surfaces || []).forEach(consider);
    (state.requests || []).forEach(consider);
    (state.digPads || []).forEach(consider);
    (state.fleet || []).forEach(consider);
    (state.paths || []).forEach(consider);
    /* Live GPS / presence (keyed by userId) */
    Object.keys(state.machines || {}).forEach((k) => {
      const m = state.machines[k];
      if (!m) return;
      const id = m.userId || m.by || (isKnownRole(k) ? '' : k);
      if (!id && !isKnownRole(k)) return;
      consider({
        userId: id || '',
        by: id || '',
        byName: m.byName || (lookupProfile(id) || {}).name || '',
        byRole: m.byRole || m.role || (isKnownRole(k) ? k : ''),
        role: m.role || m.byRole || (isKnownRole(k) ? k : ''),
        lat: m.lat,
        lng: m.lng,
        gone: false
      });
    });
    return [...byId.values()];
  }

  function pushNearbyUsers() {
    const rows = collectNearbyUsers();
    try {
      if (window.OnPadAccount && typeof window.OnPadAccount.setNearbyUsers === 'function') {
        window.OnPadAccount.setNearbyUsers(rows);
      }
    } catch (e) {}
    try {
      if (window.OnPadAccount) window.OnPadAccount.nearbyUsers = () => collectNearbyUsers();
    } catch (e2) {}
    const btn = document.getElementById('nearbyBtn');
    if (btn) {
      btn.hidden = false;
      btn.textContent = 'NEARBY ' + rows.length;
      btn.setAttribute('data-count', String(rows.length));
    }
    return rows;
  }

  function showNearbySheet() {
    const rows = pushNearbyUsers();
    let panel = document.getElementById('nearbyPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'nearbyPanel';
      panel.className = 'nearby-panel';
      panel.hidden = true;
      document.body.appendChild(panel);
    }
    if (!rows.length) {
      panel.innerHTML = '<div class="nearby-head">Nearby users</div><div class="nearby-empty">No users in view</div>';
      panel.hidden = false;
      return;
    }
    panel.innerHTML = '<div class="nearby-head">Nearby · ' + rows.length +
      ' <button type="button" class="nearby-close" id="nearbyClose">✕</button></div><ul class="nearby-list"></ul>';
    const ul = panel.querySelector('.nearby-list');
    rows.forEach((r) => {
      const li = document.createElement('li');
      const label = (r.name || truncUserId(r.userId)) +
        (r.role ? (' · ' + (ROLE_LABEL[r.role] || r.role)) : '');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nearby-user';
      b.textContent = label;
      b.addEventListener('click', () => {
        panel.hidden = true;
        openUserProfile(r.userId);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    const close = panel.querySelector('#nearbyClose');
    if (close) close.addEventListener('click', () => { panel.hidden = true; });
    panel.hidden = false;
  }
  function lockNoteEl() {
    const note = document.createElement('span');
    note.className = 'lock-note';
    note.textContent = 'Locked';
    return note;
  }
  /* myIsMod / isMod / founder roster: defined with OnPadAccount founder/mods API below. */

  function appendKillOrLock(acts, item, onKill) {
    /* Own stamps, or mods (myIsMod) may delete any item. */
    const mod = myIsMod();
    if (!isOwnStamp(item) && !mod) return;
    if (!mod && isSoftLocked(item)) acts.appendChild(lockNoteEl());
    else acts.appendChild(killBtn(onKill));
  }

  function isOwnStamp(item) {
    if (!item) return false;
    const me = currentUserId();
    if (!me) return false;
    const owner = item.userId || item.by || '';
    return !!(owner && owner === me);
  }

  function currentUserId() {
    try {
      if (window.OnPadAccount && typeof window.OnPadAccount.userId === 'function') {
        const id = window.OnPadAccount.userId();
        if (id) return id;
      }
    } catch (e) {}
    return localUserId();
  }

  /* Levels — prefer Profile OnPadAccount (?v=32+). Stub: L1 unless localStorage override.
     Cutoffs (Chris): L1 0–999, L2 1k–4999, L3 5000+ likes received. */
  function levelFromLikes(n) {
    const x = Number(n) || 0;
    if (x >= 5000) return 3;
    if (x >= 1000) return 2;
    return 1;
  }
  function stubLevel(userId) {
    const id = userId || currentUserId();
    try {
      const raw = localStorage.getItem('onpad:level:' + id);
      if (raw != null && raw !== '') {
        const n = parseInt(raw, 10);
        if (n >= 1) return n;
      }
      const likes = parseInt(localStorage.getItem('onpad:likesReceived:' + id) || '0', 10) || 0;
      return levelFromLikes(likes);
    } catch (e) {
      return 1;
    }
  }
  function myLevel() {
    try {
      if (window.OnPadAccount) {
        if (typeof window.OnPadAccount.myLevel === 'function') {
          const n = window.OnPadAccount.myLevel();
          if (typeof n === 'number' && n >= 1) return n;
        }
        if (typeof window.OnPadAccount.getLevel === 'function') {
          const n = window.OnPadAccount.getLevel();
          if (typeof n === 'number' && n >= 1) return n;
        }
        if (typeof window.OnPadAccount.level === 'function') {
          const n = window.OnPadAccount.level(currentUserId());
          if (typeof n === 'number' && n >= 1) return n;
        }
      }
    } catch (e) {}
    return stubLevel(currentUserId());
  }
  function userLevel(userId) {
    try {
      if (window.OnPadAccount && typeof window.OnPadAccount.level === 'function') {
        const n = window.OnPadAccount.level(userId);
        if (typeof n === 'number' && n >= 1) return n;
      }
    } catch (e) {}
    return stubLevel(userId);
  }
  function canAutoDeleteReport(reporterId) {
    try {
      if (window.OnPadAccount && typeof window.OnPadAccount.canAutoDeleteReport === 'function') {
        return !!window.OnPadAccount.canAutoDeleteReport(reporterId || currentUserId());
      }
    } catch (e) {}
    return userLevel(reporterId || currentUserId()) >= 3;
  }
  function isBoardVoter(userId) {
    try {
      if (window.OnPadAccount && typeof window.OnPadAccount.isBoardVoter === 'function') {
        return !!window.OnPadAccount.isBoardVoter(userId || currentUserId());
      }
    } catch (e) {}
    /* v1: any signed-in user */
    return googleSignedIn() || !!(userId || currentUserId());
  }

  function ensureVoteArr(item, key) {
    if (!item[key] || !Array.isArray(item[key])) item[key] = [];
    return item[key];
  }
  function voteIndex(arr, by) {
    return (arr || []).findIndex((v) => v && v.by === by);
  }
  function mergeVoteArr(a, b) {
    const map = new Map();
    (a || []).forEach((v) => { if (v && v.by) map.set(v.by, v); });
    (b || []).forEach((v) => {
      if (!v || !v.by) return;
      const cur = map.get(v.by);
      if (!cur || (v.at || 0) >= (cur.at || 0)) map.set(v.by, v);
    });
    return [...map.values()];
  }
  function mergeSocial(from, onto) {
    if (!from || !onto) return onto;
    onto.likes = mergeVoteArr(onto.likes, from.likes);
    onto.dislikes = mergeVoteArr(onto.dislikes, from.dislikes);
    onto.reports = mergeVoteArr(onto.reports, from.reports);
    onto.modVotes = mergeVoteArr(onto.modVotes, from.modVotes);
    onto.grantedLikes = mergeVoteArr(onto.grantedLikes, from.grantedLikes);
    return onto;
  }
  function likeDisplayCount(item) {
    const base = (item && item.likes) ? item.likes.length : 0;
    let g = 0;
    ((item && item.grantedLikes) || []).forEach((v) => { g += Math.max(0, Number(v && v.n) || 0); });
    return base + g;
  }
  function modGrantLikes(item) {
    if (!item || item.gone) return;
    if (!myIsMod()) { ui.toast('Mods only'); return; }
    const me = currentUserId();
    if (!me) { ui.toast('Sign in'); return; }
    let raw = '10';
    try { raw = window.prompt('Grant how many likes to owner?', '10') || ''; } catch (e) { raw = ''; }
    const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
    if (!n || n < 1) { ui.toast('Enter a positive number'); return; }
    const target = ownerIdOf(item);
    let ok = false;
    try {
      if (window.OnPadAccount && typeof window.OnPadAccount.grantLikes === 'function') {
        ok = !!window.OnPadAccount.grantLikes(item.id, target, n);
      } else if (window.OnPadAccount && typeof window.OnPadAccount.recordLike === 'function') {
        /* Fallback until Profile grantLikes lands — bump tally n times via direct storage if recordLike is idempotent */
        try {
          const k = 'onpad:likesReceived:' + target;
          const cur = parseInt(localStorage.getItem(k) || '0', 10) || 0;
          localStorage.setItem(k, String(cur + n));
          ok = true;
        } catch (e2) { ok = false; }
      }
    } catch (e) { ok = false; }
    const grants = ensureVoteArr(item, 'grantedLikes');
    const gi = voteIndex(grants, me);
    if (gi >= 0) grants[gi] = { by: me, at: Date.now(), n: (Number(grants[gi].n) || 0) + n };
    else grants.push({ by: me, at: Date.now(), n: n });
    item.u = now();
    persist();
    ui.toast('Granted +' + n + ' likes' + (ok ? '' : ' (local)'));
  }
  function ownerIdOf(item) {
    return (item && (item.userId || item.by)) || '';
  }
  function toggleLike(item) {
    if (!item || item.gone) return;
    const me = currentUserId();
    if (!me) { ui.toast('Sign in to like'); return; }
    const likes = ensureVoteArr(item, 'likes');
    const dislikes = ensureVoteArr(item, 'dislikes');
    const di = voteIndex(dislikes, me);
    if (di >= 0) dislikes.splice(di, 1);
    const i = voteIndex(likes, me);
    if (i >= 0) {
      likes.splice(i, 1);
    } else {
      likes.push({ by: me, at: Date.now() });
      try {
        if (window.OnPadAccount && typeof window.OnPadAccount.recordLike === 'function') {
          window.OnPadAccount.recordLike(item.id, ownerIdOf(item));
        } else {
          const oid = ownerIdOf(item);
          if (oid) {
            const k = 'onpad:likesReceived:' + oid;
            const n = (parseInt(localStorage.getItem(k) || '0', 10) || 0) + 1;
            localStorage.setItem(k, String(n));
          }
        }
      } catch (e) {}
    }
    item.u = now();
    persist();
  }
  function toggleDislike(item) {
    if (!item || item.gone) return;
    const me = currentUserId();
    if (!me) { ui.toast('Sign in to dislike'); return; }
    const likes = ensureVoteArr(item, 'likes');
    const dislikes = ensureVoteArr(item, 'dislikes');
    const li = voteIndex(likes, me);
    if (li >= 0) likes.splice(li, 1);
    const i = voteIndex(dislikes, me);
    if (i >= 0) dislikes.splice(i, 1);
    else dislikes.push({ by: me, at: Date.now() });
    item.u = now();
    persist();
  }
  function reportItem(arr, item) {
    if (!item || item.gone) return;
    const me = currentUserId();
    if (!me) { ui.toast('Sign in to report'); return; }
    const reports = ensureVoteArr(item, 'reports');
    if (voteIndex(reports, me) >= 0) {
      ui.toast('Already reported');
      return;
    }
    reports.push({ by: me, at: Date.now() });
    item.u = now();
    if (canAutoDeleteReport(me)) {
      ui.toast('Report accepted — removed (L3+)');
      forceRemove(arr, item);
      return;
    }
    persist();
    ui.toast('Reported — review board (need 3 votes)');
    select(selected);
  }
  function castModVote(arr, item, vote) {
    if (!item || item.gone) return;
    const me = currentUserId();
    if (!me || !isBoardVoter(me)) {
      ui.toast('Sign in to vote');
      return;
    }
    if (!(item.reports && item.reports.length)) {
      ui.toast('Nothing to review');
      return;
    }
    const votes = ensureVoteArr(item, 'modVotes');
    const i = voteIndex(votes, me);
    if (i >= 0) votes[i] = { by: me, at: Date.now(), vote: vote };
    else votes.push({ by: me, at: Date.now(), vote: vote });
    item.u = now();
    const del = votes.filter((v) => v.vote === 'delete').length;
    const keep = votes.filter((v) => v.vote === 'keep').length;
    if (votes.length >= 3) {
      if (del > keep) {
        ui.toast('Board: delete');
        forceRemove(arr, item);
        return;
      }
      if (keep > del) {
        item.reports = [];
        item.modVotes = [];
        item.u = now();
        persist();
        ui.toast('Board: keep');
        select(selected);
        return;
      }
    }
    persist();
    select(selected);
  }
  function appendSocialActions(acts, arr, item) {
    if (!item || item.gone) return;
    const me = currentUserId();
    const likes = item.likes || [];
    const dislikes = item.dislikes || [];
    const reports = item.reports || [];
    const liked = me && voteIndex(likes, me) >= 0;
    const disliked = me && voteIndex(dislikes, me) >= 0;
    const likeN = likeDisplayCount(item);
    const likeB = actBtn('👍' + (likeN ? ' ' + likeN : ''), liked ? 'social on' : 'social', () => {
      toggleLike(item);
      select(selected);
    });
    const disB = actBtn('👎' + (dislikes.length ? ' ' + dislikes.length : ''), disliked ? 'social on' : 'social', () => {
      toggleDislike(item);
      select(selected);
    });
    const repB = actBtn('⚑' + (reports.length ? ' ' + reports.length : ''), 'social report', () => reportItem(arr, item));
    acts.appendChild(likeB);
    acts.appendChild(disB);
    acts.appendChild(repB);
    if (myIsMod()) {
      acts.appendChild(actBtn('+LIKES', 'social grant', () => {
        modGrantLikes(item);
        select(selected);
      }));
    }
    if (reports.length) {
      const votes = item.modVotes || [];
      const delN = votes.filter((v) => v.vote === 'delete').length;
      const keepN = votes.filter((v) => v.vote === 'keep').length;
      acts.appendChild(actBtn('KEEP ' + keepN, 'mod keep', () => castModVote(arr, item, 'keep')));
      acts.appendChild(actBtn('DROP ' + delN, 'mod drop', () => castModVote(arr, item, 'delete')));
    }
  }
  function preserveStamp(from, onto) {
    if (!from) return onto;
    if (!(from.userId || from.by)) return onto;
    onto.by = from.by;
    onto.userId = from.userId;
    onto.byName = from.byName != null ? from.byName : '';
    onto.byRole = from.byRole != null ? from.byRole : '';
    if (from.stampedAt != null) onto.stampedAt = from.stampedAt;
    if (from.claimedBy != null) onto.claimedBy = from.claimedBy;
    if (from.byClaimed != null) onto.byClaimed = from.byClaimed;
    if (from.claimedByName != null) onto.claimedByName = from.claimedByName;
    if (from.claimedByRole != null) onto.claimedByRole = from.claimedByRole;
    if (from.claimedAt != null) onto.claimedAt = from.claimedAt;
    if (from.status != null) onto.status = from.status;
    if (from.completedBy != null) onto.completedBy = from.completedBy;
    if (from.completedByName != null) onto.completedByName = from.completedByName;
    if (from.completedByRole != null) onto.completedByRole = from.completedByRole;
    if (from.completedAt != null) onto.completedAt = from.completedAt;
    mergeSocial(from, onto);
    if (from.name != null && onto.name == null) onto.name = from.name;
    return onto;
  }
  function earlierStamp(a, b) {
    const aT = a && a.stampedAt;
    const bT = b && b.stampedAt;
    if (aT && bT) return aT <= bT ? a : b;
    if (a && (a.userId || a.by)) return a;
    if (b && (b.userId || b.by)) return b;
    return a || b;
  }

  function profileReady() {
    try {
      return localStorage.getItem('onpad:profileReady') === '1';
    } catch (e) {
      return false;
    }
  }
  function markProfileReady() {
    try { localStorage.setItem('onpad:profileReady', '1'); } catch (e) { /* ignore */ }
  }

  function profileProgress() {
    const nameDone = !!displayName();
    const roleDone = isKnownRole(role);
    /* Signed-in with Google counts as Ready (also set onpad:profileReady on credential). */
    const readyDone = profileReady() || googleSignedIn();
    const steps = [
      { id: 'name', label: 'Name', done: nameDone },
      { id: 'role', label: 'Role', done: roleDone },
      { id: 'ready', label: 'Ready', done: readyDone }
    ];
    const done = steps.filter((s) => s.done).length;
    return { done, total: 3, steps, pct: Math.round((done / 3) * 100) };
  }

  function updateProfileProgress() {
    const p = profileProgress();
    const label = document.getElementById('profileProgressLabel');
    const pct = document.getElementById('profileProgressPct');
    const bar = document.getElementById('profileProgressBar');
    const fill = document.getElementById('profileProgressFill');
    const list = document.getElementById('profileProgressSteps');
    if (label) label.textContent = 'Profile ' + p.done + '/' + p.total;
    if (pct) pct.textContent = p.pct + '%';
    if (bar) bar.setAttribute('aria-valuenow', String(p.done));
    if (fill) fill.style.width = p.pct + '%';
    if (list) {
      list.querySelectorAll('[data-step]').forEach((li) => {
        const step = p.steps.find((s) => s.id === li.getAttribute('data-step'));
        li.classList.toggle('done', !!(step && step.done));
      });
    }
  }

  function ensureProfiles() {
    if (!state.profiles || typeof state.profiles !== 'object') state.profiles = {};
    return state.profiles;
  }

  function publishLocalProfile() {
    const id = localUserId();
    const profiles = ensureProfiles();
    profiles[id] = {
      userId: id,
      name: displayName() || googleName() || '',
      role: role,
      u: now()
    };
  }

  function mergeProfiles(localMap, remoteMap) {
    const out = Object.assign({}, localMap || {});
    Object.keys(remoteMap || {}).forEach((id) => {
      const r = remoteMap[id];
      if (!r || typeof r !== 'object') return;
      const cur = out[id];
      if (!cur || (r.u || 0) >= (cur.u || 0)) {
        out[id] = {
          userId: r.userId || id,
          name: r.name || '',
          role: r.role || '',
          u: r.u || 0
        };
      }
    });
    return out;
  }

  function lookupProfile(userId) {
    if (!userId) return null;
    const reg = state.profiles && state.profiles[userId];
    if (reg) {
      return {
        userId: reg.userId || userId,
        name: reg.name || '',
        role: reg.role || '',
        u: reg.u || 0
      };
    }
    /* Fallback: newest stamped feature fields for this id */
    let best = null;
    const bags = [state.surfaces, state.requests, state.digPads, state.fleet, state.paths];
    bags.forEach((arr) => {
      (arr || []).forEach((f) => {
        if (!f) return;
        const fid = f.userId || f.by;
        if (fid !== userId) return;
        const t = f.stampedAt || f.u || 0;
        if (!best || t >= (best.stampedAt || 0)) {
          best = {
            userId: userId,
            name: f.byName || '',
            role: f.byRole || '',
            stampedAt: t
          };
        }
      });
    });
    return best ? { userId: best.userId, name: best.name, role: best.role, u: best.stampedAt || 0 } : null;
  }

  function profileLabel(userIdOrFeature) {
    let id = '';
    let name = '';
    let roleKey = '';
    if (userIdOrFeature && typeof userIdOrFeature === 'object') {
      id = userIdOrFeature.userId || userIdOrFeature.by || '';
      name = userIdOrFeature.byName || userIdOrFeature.name || '';
      roleKey = userIdOrFeature.byRole || userIdOrFeature.role || '';
      const p = lookupProfile(id);
      if (p) {
        if (!name) name = p.name || '';
        if (!roleKey) roleKey = p.role || '';
      }
    } else {
      id = userIdOrFeature || '';
      const p = lookupProfile(id);
      if (p) {
        name = p.name || '';
        roleKey = p.role || '';
      }
    }
    const roleText = ROLE_LABEL[roleKey] || roleKey || '';
    if (name && roleText) return name + ' · ' + roleText;
    if (name) return name;
    if (roleText) return roleText;
    return truncUserId(id) || 'Unknown';
  }

  /* Ban hook only — majority-report ban UI comes later (target Google sub).
     Reserved: localStorage 'onpad:banned' === '1'  OR  account.accessOk === false.
     Do NOT gate the map this pass. Do NOT build ban UI. Open jobsite: anyone signed in can do everything. */
  const account = {
    get accessOk() {
      try {
        return localStorage.getItem('onpad:banned') !== '1';
      } catch (e) {
        return true;
      }
    }
  };

  /* ---- Founder / mods roster (Profile owns; Builder map mod UX is separate). ---- */
  const FOUNDER_EMAIL = 'johnsonswork@gmail.com';
  const GRANT_LIKES_MAX = 10000;

  function founderSubStored() {
    try { return localStorage.getItem('onpad:founderSub') || ''; } catch (e) { return ''; }
  }
  function ensureMods() {
    if (!Array.isArray(state.mods)) state.mods = [];
    return state.mods;
  }
  function normalizeEmail(em) {
    return String(em || '').trim().toLowerCase();
  }
  function isFounderEmail(em) {
    return normalizeEmail(em) === FOUNDER_EMAIL;
  }
  function isFounder(userId) {
    const id = userId == null || userId === '' ? localUserId() : String(userId);
    const stored = founderSubStored();
    if (stored && id === stored) return true;
    /* Self / current Google session: match confirmed founder email (case-insensitive). */
    const me = localUserId();
    if (id === me || id === googleSub()) {
      const em = googleEmail();
      if (isFounderEmail(em)) {
        const sub = googleSub();
        if (sub) {
          try { localStorage.setItem('onpad:founderSub', String(sub)); } catch (e) {}
        }
        return true;
      }
    }
    return false;
  }
  function modKey(m) {
    if (!m || typeof m !== 'object') return null;
    if (m.userId) return 'id:' + String(m.userId);
    if (m.email) return 'em:' + normalizeEmail(m.email);
    return null;
  }
  function mergeMods(localArr, remoteArr) {
    const map = new Map();
    function put(m) {
      if (!m || typeof m !== 'object') return;
      const k = modKey(m);
      if (!k) return;
      const cur = map.get(k);
      if (!cur || (m.u || 0) >= (cur.u || 0)) {
        map.set(k, {
          userId: m.userId ? String(m.userId) : undefined,
          email: m.email ? normalizeEmail(m.email) : undefined,
          u: m.u || 0
        });
      }
    }
    (localArr || []).forEach(put);
    (remoteArr || []).forEach(put);
    return [...map.values()];
  }
  function listMods() {
    return (ensureMods() || []).map((m) => ({
      userId: m.userId || undefined,
      email: m.email || undefined,
      u: m.u || 0
    }));
  }
  function modMatchesUser(m, userId) {
    if (!m || !userId) return false;
    if (m.userId && String(m.userId) === String(userId)) return true;
    if (m.email && String(userId) === localUserId()) {
      const em = normalizeEmail(googleEmail());
      if (em && em === normalizeEmail(m.email)) return true;
    }
    return false;
  }
  function isMod(userId) {
    const id = userId == null || userId === '' ? localUserId() : String(userId);
    if (!id) return false;
    if (isFounder(id)) return true;
    return (state.mods || []).some((m) => modMatchesUser(m, id));
  }
  function myIsMod() {
    return isMod(localUserId());
  }
  function parseModIdentity(userIdOrEmail) {
    const s = String(userIdOrEmail || '').trim();
    if (!s) return null;
    if (s.indexOf('@') >= 0) return { email: normalizeEmail(s) };
    return { userId: s };
  }
  function addMod(userIdOrEmail) {
    if (!isFounder()) {
      try { ui.toast('Founder only'); } catch (e) {}
      return false;
    }
    const ident = parseModIdentity(userIdOrEmail);
    if (!ident) return false;
    const mods = ensureMods();
    const entry = {
      userId: ident.userId || undefined,
      email: ident.email || undefined,
      u: now()
    };
    const k = modKey(entry);
    const next = mods.filter((m) => modKey(m) !== k);
    next.push(entry);
    state.mods = next;
    persist();
    try { syncModsUi(); } catch (e) {}
    try { ui.toast('Mod added'); } catch (e) {}
    return true;
  }
  function removeMod(userIdOrEmail) {
    if (!isFounder()) {
      try { ui.toast('Founder only'); } catch (e) {}
      return false;
    }
    const ident = parseModIdentity(userIdOrEmail);
    if (!ident) return false;
    const probe = { userId: ident.userId, email: ident.email, u: 0 };
    const k = modKey(probe);
    const mods = ensureMods();
    const before = mods.length;
    state.mods = mods.filter((m) => modKey(m) !== k);
    if (state.mods.length === before) return false;
    persist();
    try { syncModsUi(); } catch (e) {}
    try { ui.toast('Mod removed'); } catch (e) {}
    return true;
  }
  /* Nearby / LIVE presence rows fed by Builder (all signed-in may see list).
     Builder ?v=34+ may send {userId, byName, byRole/role, lat, lng, t} for live peers. */
  let nearbyUsers = [];
  let presenceHints = Object.create(null); /* userId → {userId, name, role, lat, lng, t} */
  let viewingUserId = null; /* null = own editable profile */

  function cachePresenceHint(row) {
    if (!row || typeof row !== 'object') return null;
    const userId = String(row.userId || '').trim();
    if (!userId) return null;
    const name = String(row.name || row.byName || '').trim().slice(0, 80);
    const role = String(row.role || row.byRole || '').trim().slice(0, 40);
    const lat = typeof row.lat === 'number' ? row.lat : null;
    const lng = typeof row.lng === 'number' ? row.lng : null;
    const t = typeof row.t === 'number' ? row.t : Date.now();
    const prev = presenceHints[userId];
    const next = {
      userId: userId,
      name: name || (prev && prev.name) || '',
      role: role || (prev && prev.role) || '',
      lat: lat != null ? lat : (prev ? prev.lat : null),
      lng: lng != null ? lng : (prev ? prev.lng : null),
      t: t
    };
    presenceHints[userId] = next;
    return next;
  }

  function setNearbyUsers(rows) {
    nearbyUsers = [];
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (!r || typeof r !== 'object') return;
      const hint = cachePresenceHint(r);
      if (!hint) return;
      nearbyUsers.push({
        userId: hint.userId,
        name: hint.name,
        role: hint.role,
        lat: hint.lat,
        lng: hint.lng
      });
    });
    try { syncNearbyUsersUi(); } catch (e) {}
    return nearbyUsers.slice();
  }

  /* Resolve display name for a userId: profiles → presence hint → nearby → stamp byName → trunc id. */
  function resolveProfileDisplay(userId) {
    const id = String(userId || '').trim();
    if (!id) return { name: '', role: '', roleLabel: '' };
    const reg = (state.profiles && state.profiles[id]) || null;
    const hint = presenceHints[id] || null;
    const near = nearbyUsers.find((u) => u.userId === id) || null;
    let name = String((reg && reg.name) || '').trim()
      || String((hint && hint.name) || '').trim()
      || String((near && near.name) || '').trim();
    let role = String((reg && reg.role) || '').trim()
      || String((hint && hint.role) || '').trim()
      || String((near && near.role) || '').trim();
    if (!name || !role) {
      /* stamp byName / byRole from newest feature owned by id (skip empty profiles registry) */
      let best = null;
      featureBags().forEach((arr) => {
        (arr || []).forEach((f) => {
          if (!f) return;
          const fid = f.userId || f.by;
          if (fid !== id) return;
          const t = f.stampedAt || f.u || 0;
          if (!best || t >= (best.t || 0)) {
            best = { name: f.byName || '', role: f.byRole || '', t: t };
          }
        });
      });
      if (best) {
        if (!name && best.name) name = String(best.name).trim();
        if (!role && best.role) role = String(best.role).trim();
      }
    }
    if (!name) name = truncUserId(id);
    const roleLabel = role ? (ROLE_LABEL[role] || role) : '';
    return { name: name, role: role, roleLabel: roleLabel };
  }

  /* Mods-only: grant n likes for featureId→target. Idempotent per featureId+target (no double-count). */
  function grantLikes(featureId, targetUserId, n) {
    if (!myIsMod()) {
      try { ui.toast('Mods only'); } catch (e) {}
      return false;
    }
    const fid = String(featureId || '').trim();
    const target = String(targetUserId || '').trim();
    if (!fid || !target) return false;
    let count = Math.floor(Number(n));
    if (!isFinite(count)) return false;
    count = Math.max(1, Math.min(GRANT_LIKES_MAX, count));
    const likes = ensureLikesRegistry();
    /* Idempotent: same featureId+target already granted → no double-count */
    if (likes.some((L) => L && L.grant && L.targetUserId === target && (L.grantRoot === fid || L.featureId === fid))) {
      try {
        localStorage.setItem('onpad:likesReceived:' + target, String(accountLikesReceived(target)));
      } catch (e) {}
      return true;
    }
    const by = localUserId() || 'mod-grant';
    const at = Date.now();
    for (let i = 0; i < count; i++) {
      /* Unique featureId keys so accountLikesReceived counts n; grantRoot pins idempotency. */
      const grantFid = fid + '#' + i;
      likes.push({
        id: 'like-' + uid(),
        featureId: grantFid,
        grantRoot: fid,
        targetUserId: target,
        by: by,
        at: at,
        grant: true
      });
    }
    const feat = findFeatureById(fid);
    if (feat) {
      ensureReactionArrays(feat);
      if (!feat.likes.some((L) => L && L.by === by && L.grant)) {
        feat.likes.push({ by: by, at: at, grant: true });
        feat.u = Math.max(feat.u || 0, at);
      }
    }
    try {
      localStorage.setItem('onpad:likesReceived:' + target, String(accountLikesReceived(target)));
    } catch (e) {}
    persist();
    try { updateSocialCreditUi(); } catch (e) {}
    try { syncViewedProfileUi(); } catch (e) {}
    return true;
  }

  function canOpenProfile(userId) {
    const id = String(userId || '').trim();
    if (!id) return false;
    if (id === localUserId()) return true;
    return googleSignedIn();
  }

  /* openProfile(userId) or openProfile({userId, name?, byName?, role?, byRole?, lat?, lng?, t?}).
     String form is enough when setNearbyUsers already cached LIVE presence hints. */
  function openProfile(userIdOrHint) {
    let id = '';
    if (userIdOrHint && typeof userIdOrHint === 'object') {
      cachePresenceHint(userIdOrHint);
      id = String(userIdOrHint.userId || '').trim();
    } else {
      id = String(userIdOrHint || '').trim();
    }
    if (!id) id = localUserId();
    if (!id) return false;
    if (!canOpenProfile(id)) return false;
    /* Missing unknown remote with no profile/nearby/self hint still opens (read-only stub). */
    viewingUserId = (id === localUserId()) ? null : id;
    try {
      openSheet('roleSheet');
      syncProfileSheet();
      syncViewedProfileUi();
    } catch (e) {
      return false;
    }
    return true;
  }

  function syncRoleBadgeUi() {
    const badge = document.getElementById('profileRoleBadge');
    if (!badge) return;
    const viewId = viewingUserId || localUserId();
    if (isFounder(viewId)) {
      badge.hidden = false;
      badge.textContent = 'Founder';
      badge.className = 'profile-role-badge is-founder';
      badge.setAttribute('title', 'OnPad founder');
    } else if (isMod(viewId)) {
      badge.hidden = false;
      badge.textContent = 'Mod';
      badge.className = 'profile-role-badge is-mod';
      badge.setAttribute('title', 'OnPad moderator');
    } else {
      badge.hidden = true;
      badge.textContent = '';
    }
  }

  function syncViewedProfileUi() {
    const viewingOther = !!(viewingUserId && viewingUserId !== localUserId());
    const editBlocks = document.querySelectorAll('[data-own-profile-only]');
    editBlocks.forEach((el) => { el.hidden = viewingOther; });
    const viewCard = document.getElementById('viewedProfileCard');
    if (viewCard) {
      viewCard.hidden = !viewingOther;
      if (viewingOther) {
        const disp = resolveProfileDisplay(viewingUserId);
        const likes = accountLikesReceived(viewingUserId);
        const dislikes = accountDislikesReceived(viewingUserId);
        const lv = accountLevel(viewingUserId);
        const nameEl = document.getElementById('viewedProfileName');
        const roleEl = document.getElementById('viewedProfileRole');
        const levelEl = document.getElementById('viewedProfileLevel');
        const idEl = document.getElementById('viewedProfileId');
        if (nameEl) nameEl.textContent = disp.name;
        if (roleEl) roleEl.textContent = disp.roleLabel ? ('Role · ' + disp.roleLabel) : 'Role · —';
        if (levelEl) {
          levelEl.textContent = 'Level L' + lv + ' · ' + likes + ' likes · ' + dislikes + ' dislikes';
          levelEl.setAttribute('title', 'L1 0–999 · L2 1,000–4,999 · L3 5,000+ likes received');
        }
        if (idEl) {
          idEl.textContent = truncUserId(viewingUserId);
          idEl.setAttribute('title', viewingUserId);
        }
        const back = document.getElementById('viewedProfileBack');
        if (back && !back._wired) {
          back._wired = true;
          back.addEventListener('click', () => {
            viewingUserId = null;
            syncProfileSheet();
            syncViewedProfileUi();
          });
        }
        /* Mod grant likes controls — mod-only */
        const grantWrap = document.getElementById('viewedGrantLikes');
        if (grantWrap) {
          grantWrap.hidden = !myIsMod();
        }
      }
    }
    syncRoleBadgeUi();
    syncModsUi();
    syncNearbyUsersUi();
  }

  function syncNearbyUsersUi() {
    const section = document.getElementById('nearbyUsersSection');
    if (!section) return;
    const show = googleSignedIn() && nearbyUsers.length > 0;
    section.hidden = !show;
    const list = document.getElementById('nearbyUsersList');
    if (!list) return;
    list.textContent = '';
    if (!show) return;
    nearbyUsers.forEach((u) => {
      const li = document.createElement('li');
      li.className = 'nearby-user-item';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fat nearby-user-btn';
      const roleDisp = u.role ? (ROLE_LABEL[u.role] || u.role) : '';
      const label = (u.name || truncUserId(u.userId)) + (roleDisp ? (' · ' + roleDisp) : '');
      btn.textContent = label;
      btn.setAttribute('title', u.userId);
      btn.addEventListener('click', () => { openProfile(u.userId); });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function syncModsUi() {
    syncRoleBadgeUi();
    const section = document.getElementById('modsSection');
    if (!section) return;
    /* Founder-only management on own profile */
    const founderOwn = isFounder() && !viewingUserId;
    section.hidden = !founderOwn;
    if (!founderOwn) return;
    const list = document.getElementById('modsList');
    if (list) {
      list.textContent = '';
      const mods = listMods();
      if (!mods.length) {
        const empty = document.createElement('li');
        empty.className = 'mods-empty';
        empty.textContent = 'No mods yet';
        list.appendChild(empty);
      } else {
        mods.forEach((m) => {
          const li = document.createElement('li');
          li.className = 'mods-item';
          const label = document.createElement('span');
          label.className = 'mods-label';
          label.textContent = m.userId || m.email || '?';
          label.setAttribute('title', m.userId || m.email || '');
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'fat mods-remove';
          rm.textContent = 'Remove';
          rm.setAttribute('data-mod', m.userId || m.email || '');
          rm.addEventListener('click', () => {
            removeMod(m.userId || m.email);
          });
          li.appendChild(label);
          li.appendChild(rm);
          list.appendChild(li);
        });
      }
    }
  }

  /* ---- Social credit (Profile owns ladder; Builder owns map like/report UI). ----
     Feature reaction shape (Builder-locked):
       likes: [{ by, at }], dislikes: [{ by, at }], reports: [{ by, at }],
       modVotes: [{ by, at, vote: 'keep'|'delete' }]
     One entry per voter; Builder toggle removes. Profile also keeps state.likes registry. */
  const LEVEL_L2_MIN = 1000;
  const LEVEL_L3_MIN = 5000;

  function featureBags() {
    return [state.surfaces, state.requests, state.digPads, state.fleet, state.paths];
  }
  function findFeatureById(featureId) {
    if (!featureId) return null;
    let found = null;
    featureBags().forEach((arr) => {
      (arr || []).forEach((f) => { if (f && f.id === featureId) found = f; });
    });
    return found;
  }
  function ensureReactionArrays(f) {
    if (!f || typeof f !== 'object') return f;
    if (!Array.isArray(f.likes)) f.likes = [];
    if (!Array.isArray(f.dislikes)) f.dislikes = [];
    if (!Array.isArray(f.reports)) f.reports = [];
    if (!Array.isArray(f.modVotes)) f.modVotes = [];
    return f;
  }
  function ensureLikesRegistry() {
    if (!Array.isArray(state.likes)) state.likes = [];
    return state.likes;
  }
  /* Unique like events on target's stamps: unique by+featureId (feature.likes + registry). */
  function accountLikesReceived(userId) {
    if (!userId) return 0;
    const keys = new Set();
    featureBags().forEach((arr) => {
      (arr || []).forEach((f) => {
        if (!f) return;
        const owner = f.userId || f.by;
        if (owner !== userId) return;
        const fid = f.id || '';
        (f.likes || []).forEach((L) => {
          if (L && L.by) keys.add(String(L.by) + '|' + fid);
        });
      });
    });
    (state.likes || []).forEach((L) => {
      if (!L || L.targetUserId !== userId || !L.by) return;
      keys.add(String(L.by) + '|' + String(L.featureId || ''));
    });
    return keys.size;
  }
  /* Unique dislike events on target's stamps: unique by+featureId from feature.dislikes[]. */
  function accountDislikesReceived(userId) {
    if (!userId) return 0;
    const keys = new Set();
    featureBags().forEach((arr) => {
      (arr || []).forEach((f) => {
        if (!f) return;
        const owner = f.userId || f.by;
        if (owner !== userId) return;
        const fid = f.id || '';
        (f.dislikes || []).forEach((D) => {
          if (D && D.by) keys.add(String(D.by) + '|' + fid);
        });
      });
    });
    return keys.size;
  }
  function accountLevel(userId) {
    const n = accountLikesReceived(userId);
    if (n >= LEVEL_L3_MIN) return 3;
    if (n >= LEVEL_L2_MIN) return 2;
    return 1;
  }
  /* Idempotent per caller by + featureId. Writes registry + denormalized feature.likes. */
  function accountRecordLike(featureId, targetUserId) {
    const by = localUserId();
    if (!by || !featureId) return false;
    const likes = ensureLikesRegistry();
    if (likes.some((L) => L && L.featureId === featureId && L.by === by)) return true;
    const feat = findFeatureById(featureId);
    const target = targetUserId || (feat ? (feat.userId || feat.by || '') : '') || '';
    const at = Date.now();
    likes.push({ id: 'like-' + uid(), featureId, targetUserId: target, by, at });
    if (feat) {
      ensureReactionArrays(feat);
      if (!feat.likes.some((L) => L && L.by === by)) feat.likes.push({ by, at });
      feat.u = Math.max(feat.u || 0, at);
    }
    /* Keep Builder stub counters in sync for older clients */
    try {
      if (target) {
        const k = 'onpad:likesReceived:' + target;
        localStorage.setItem(k, String(accountLikesReceived(target)));
      }
      localStorage.setItem('onpad:likeSeen:' + featureId + ':' + by, '1');
    } catch (e) {}
    persist();
    try { updateSocialCreditUi(); } catch (e) {}
    return true;
  }
  function updateSocialCreditUi() {
    const el = document.getElementById('socialCreditLevel');
    if (!el) return;
    const id = localUserId();
    const n = accountLikesReceived(id);
    const d = accountDislikesReceived(id);
    const lv = accountLevel(id);
    el.textContent = 'Level L' + lv + ' · ' + n + ' likes · ' + d + ' dislikes';
    el.setAttribute('title', 'L1 0–999 · L2 1,000–4,999 · L3 5,000+ likes received');
  }

  /* Global API for App Builder (map tap-chip + soft-lock + social credit). Settings owns progress UI. */
  window.OnPadAccount = {
    userId: () => localUserId(),
    profile: () => ({ userId: localUserId(), name: displayName() || googleName() || emailLocalPart() || '', role }),
    stamp: (obj) => stampCore(obj),
    lookup: (userId) => lookupProfile(userId),
    profileLabel: (userIdOrFeature) => profileLabel(userIdOrFeature),
    signedIn: () => googleSignedIn(),
    signOut: () => signOutGoogle(),
    likesReceived: (userId) => accountLikesReceived(userId),
    dislikesReceived: (userId) => accountDislikesReceived(userId),
    level: (userId) => accountLevel(userId),
    myLevel: () => accountLevel(localUserId()),
    getLevel: () => accountLevel(localUserId()),
    recordLike: (featureId, targetUserId) => accountRecordLike(featureId, targetUserId),
    canAutoDeleteReport: (reporterId) => accountLevel(reporterId || localUserId()) >= 3,
    isBoardVoter: (userId) => googleSignedIn() || !!(userId && String(userId)),
    isFounder: (userId) => isFounder(userId),
    isMod: (userId) => isMod(userId),
    myIsMod: () => myIsMod(),
    addMod: (userIdOrEmail) => addMod(userIdOrEmail),
    removeMod: (userIdOrEmail) => removeMod(userIdOrEmail),
    listMods: () => listMods(),
    grantLikes: (featureId, targetUserId, n) => grantLikes(featureId, targetUserId, n),
    openProfile: (userIdOrHint) => openProfile(userIdOrHint),
    setNearbyUsers: (rows) => setNearbyUsers(rows),
    get STAMP_LOCK_MS() { return STAMP_LOCK_MS; },
    get LEVEL_L2_MIN() { return LEVEL_L2_MIN; },
    get LEVEL_L3_MIN() { return LEVEL_L3_MIN; }
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
  if (!isKnownRole(role)) role = 'dozer';
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
  /* id -> u of last local drag; merge prefers this over stale MQTT echoes */
  const localDragWins = Object.create(null);

  function emptyState(code) {
    return {
      v: VERSION,
      job: code || SHARED_SITE,
      surfaces: [],
      requests: [],
      digPads: [],
      fleet: [],
      paths: [],
      likes: [],
      mods: [],
      stakeDraft: { pins: [], u: 0 },
      machines: {},
      profiles: {},
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
          if (!Array.isArray(s.likes)) s.likes = [];
          if (!Array.isArray(s.mods)) s.mods = [];
          if (!s.profiles || typeof s.profiles !== 'object') s.profiles = {};
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
      likes: state.likes || [],
      mods: state.mods || [],
      stakeDraft: state.stakeDraft,
      machines: state.machines,
      profiles: state.profiles || {},
      u: state.u
    };
  }

  function mergeById(localArr, remoteArr) {
    const map = new Map();
    (localArr || []).forEach((x) => map.set(x.id, x));
    (remoteArr || []).forEach((x) => {
      const cur = map.get(x.id);
      if (!cur) { map.set(x.id, x); return; }
      const dragU = localDragWins[x.id];
      /* Last local drag wins for that id unless remote is strictly newer than local */
      if (dragU != null && (cur.u || 0) >= dragU && (x.u || 0) <= (cur.u || 0)) return;
      /* Strict > so equal-u MQTT echo keeps local object (pathDraft / mid-edit refs) */
      if ((x.u || 0) > (cur.u || 0)) {
        const next = Object.assign({}, x);
        /* Never overwrite original placer identity (userId/by/stampedAt). */
        preserveStamp(earlierStamp(cur, x), next);
        mergeSocial(cur, next);
        map.set(x.id, next);
      } else {
        /* Equal or older remote — still union social votes for LIVE */
        mergeSocial(x, cur);
      }
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
    state.likes = mergeById(state.likes || [], remote.likes || []);
    state.mods = mergeMods(state.mods || [], remote.mods || []);
    state.profiles = mergeProfiles(state.profiles || {}, remote.profiles || {});
    rebindPathDraft();
    const ru = (remote.stakeDraft && remote.stakeDraft.u) || 0;
    const lu = (state.stakeDraft && state.stakeDraft.u) || 0;
    if (ru >= lu) state.stakeDraft = remote.stakeDraft || { pins: [], u: 0 };
    const machines = Object.assign({}, state.machines);
    Object.keys(remote.machines || {}).forEach((k) => {
      const r = remote.machines[k];
      if (!r) return;
      const id = r.userId || r.by || (isKnownRole(k) ? '' : k);
      const key = id || k;
      const next = Object.assign({}, r);
      if (id) { next.userId = id; next.by = id; }
      if (!next.role && isKnownRole(k)) next.role = k;
      if (!next.byRole) next.byRole = next.role || '';
      const l = machines[key];
      if (!l || (next.t || 0) >= (l.t || 0)) machines[key] = next;
      /* Drop legacy role-only key once we have userId presence for that role+user */
      if (id && isKnownRole(k) && machines[k] && k !== key) delete machines[k];
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
      /* ±accuracy pill hidden — Chris found it confusing next to LIVE */
      const el = document.getElementById('gpsBadge');
      if (!el) return;
      el.hidden = true;
      el.textContent = '';
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
      const inGoogle = googleSignedIn();
      btn.className = 'identity role-' + role + (name ? ' named' : '') + (inGoogle ? ' google-in' : ' google-out');
      const kicker = btn.querySelector('.identity-kicker');
      const sub = btn.querySelector('.identity-sub');
      document.getElementById('roleLabel').textContent = ROLE_LABEL[role] || role;
      if (name) {
        if (kicker) kicker.textContent = name;
        /* Named: keep role identity; when not signed in, hint via sub (CSS shows it for google-out) */
        if (sub) sub.textContent = inGoogle ? '' : 'TAP · SIGN IN';
      } else {
        if (kicker) kicker.textContent = "I'M THE";
        if (sub) {
          if (!inGoogle) sub.textContent = 'TAP · SIGN IN';
          else sub.textContent = isMachineRole(role) ? 'OPERATOR' : '';
        }
      }
      const stake = document.getElementById('stakeRow');
      if (stake) stake.style.display = role === 'dozer' ? 'flex' : 'none';
      ROLES.forEach((r) => document.body.classList.remove('role-' + r));
      document.body.classList.add('role-' + role);
      const ico = document.getElementById('roleIcon');
      if (ico) {
        if (isMachineRole(role)) ico.innerHTML = roleSvg(role);
        else ico.innerHTML = '<span class="role-letter" aria-hidden="true">' + (ROLE_LETTER[role] || '?') + '</span>';
      }
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
    const el = document.getElementById(id);
    if (!el) return;
    /* Unhide before GIS renderButton so host width is real (phones got ~0 when hidden). */
    el.hidden = false;
    if (id === 'roleSheet') {
      syncProfileSheet();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => initGoogleSignIn(true));
      });
    }
  }
  function closeSheet(id) { document.getElementById(id).hidden = true; }

  function syncProfileSheet() {
    const name = displayName();
    const input = document.getElementById('displayNameInput');
    if (input && document.activeElement !== input) input.value = name;
    const btn = document.getElementById('continueAsBtn');
    if (btn) btn.textContent = continueAsLabel(name);
    const chip = document.getElementById('userIdChip');
    if (chip) {
      const id = localUserId();
      chip.textContent = truncUserId(id);
      chip.setAttribute('title', id + (googleSignedIn() ? ' (Google)' : ' (anon)'));
    }
    const op = document.getElementById('opRoleSelect');
    const crew = document.getElementById('crewRoleSelect');
    if (op) {
      op.value = isMachineRole(role) ? role : '';
      op.classList.toggle('is-on', isMachineRole(role));
    }
    if (crew) {
      crew.value = isMachineRole(role) ? '' : role;
      crew.classList.toggle('is-on', !isMachineRole(role));
    }
    syncGoogleAuthUi();
    updateProfileProgress();
    ensureDisplayNameSeeded();
    updateSocialCreditUi();
    syncViewedProfileUi();
  }
  function applyRole(next) {
    if (!isKnownRole(next)) return;
    role = next;
    try { localStorage.setItem('onpad:role', role); } catch (e) {}
    publishLocalProfile();
    syncProfileSheet();
    persist();
    ui.role();
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
      attributionControl: true,
      markerZoomAnimation: false
    });
    try {
      if (map.zoomControl) map.removeControl(map.zoomControl);
    } catch (e) {}
    try {
      document.querySelectorAll('.leaflet-control-zoom').forEach((el) => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
    } catch (e) {}

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
      try { pushNearbyUsers(); } catch (e2) {}
    });
    map.on('zoomend', () => { try { pushNearbyUsers(); } catch (e) {} });

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
    if (placeTool === 'water-light' || placeTool === 'water-heavy' || placeTool === 'cleanup'
        || placeTool === 'move-dozer' || placeTool === 'move-excavator' || placeTool === 'move-water') {
      placeRequest(placeTool, e.latlng);
      placeTool = null;
      ui.tools();
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
    /* Finish placing → clear selection bar; tap the surface later to edit */
    select(null);
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
      if (on && !isSoftLocked(s)) {
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
      if (isSoftLocked(item)) { softLockToast(); return; }
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
      icon: L.divIcon({ className: 'handle-icon ' + (cls || ''), iconSize: [28, 28], iconAnchor: [14, 14] })
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
    const item = stamp({
      id: uid(),
      kind,
      lat: latlng.lat,
      lng: latlng.lng,
      u: now()
    });
    state.requests.push(item);
    persist();
    /* Show selection bar with CLAIM right away */
    select({ kind: 'request', id: item.id });
    ui.toast('Order placed — tap CLAIM or tap it again to claim');
  }

  function isOrderClaimed(r) {
    return !!(r && (r.claimedBy || r.byClaimed));
  }

  function claimStampOnto(r) {
    /* Claim identity — same style as place stamp; prefer OnPadAccount when present. */
    const tmp = stamp({});
    r.claimedBy = tmp.userId || tmp.by || '';
    r.byClaimed = r.claimedBy;
    r.claimedByName = (tmp.byName || stampByName()).trim();
    r.claimedByRole = tmp.byRole || role || '';
    r.claimedAt = tmp.stampedAt || Date.now();
    r.u = now();
    return r;
  }

  function claimOrder(r) {
    if (!r || r.gone) return;
    if (isOrderClaimed(r)) {
      ui.toast('Already claimed');
      return;
    }
    claimStampOnto(r);
    persist();
    select({ kind: 'request', id: r.id });
    const who = profileLabel({
      userId: r.claimedBy,
      byName: r.claimedByName,
      byRole: r.claimedByRole
    });
    ui.toast('Claimed · ' + who);
  }

  function isOrderDone(r) {
    return !!(r && (r.status === 'done' || r.completedAt));
  }

  function completeOrder(r) {
    /* ✓ = done log — KEEP ghost on map. Never hard-delete. */
    if (!r || r.gone) return;
    if (isOrderDone(r)) {
      ui.toast('Already done — still on map');
      select({ kind: 'request', id: r.id });
      return;
    }
    const tmp = stamp({});
    r.status = 'done';
    r.completedBy = tmp.userId || tmp.by || '';
    r.completedByName = tmp.byName || '';
    r.completedByRole = tmp.byRole || '';
    r.completedAt = tmp.stampedAt || Date.now();
    r.u = now();
    /* Ensure ghost look even if never claimed */
    if (!isOrderClaimed(r)) claimStampOnto(r);
    persist();
    select({ kind: 'request', id: r.id });
    ui.toast('Done — kept on map');
  }

  function orderLabel(r) {
    if (!r) return 'ORDER';
    if (r.kind === 'cleanup') return 'CLEAN';
    if (r.kind === 'water-heavy') return 'HEAVY';
    if (r.kind === 'water-light') return 'LIGHT';
    if (r.kind === 'move-dozer') return 'MOVE DOZER';
    if (r.kind === 'move-excavator') return 'MOVE EXCV';
    if (r.kind === 'move-water') return 'MOVE WATER';
    return String(r.kind || 'ORDER').toUpperCase();
  }

  function orderSvg(r) {
    if (!r) return SVG.drop;
    if (r.kind === 'cleanup') return SVG.blade;
    if (r.kind === 'move-dozer') return SVG.dozer;
    if (r.kind === 'move-excavator') return SVG.excavator;
    if (r.kind === 'move-water') return SVG.water;
    if (r.kind === 'water-heavy') return SVG.drop;
    return SVG.mist;
  }

  function reqIcon(kind, claimed, done) {
    let cls = 'req-light';
    let svg = SVG.mist;
    if (kind === 'cleanup') { cls = 'req-cleanup'; svg = SVG.blade; }
    else if (kind === 'water-heavy') { cls = 'req-heavy'; svg = SVG.drop; }
    else if (kind === 'water-light') { cls = 'req-light'; svg = SVG.mist; }
    else if (kind === 'move-dozer') { cls = 'req-move req-move-dozer'; svg = SVG.dozer; }
    else if (kind === 'move-excavator') { cls = 'req-move req-move-excavator'; svg = SVG.excavator; }
    else if (kind === 'move-water') { cls = 'req-move req-move-water'; svg = SVG.water; }
    const ghost = claimed || done;
    return L.divIcon({
      className: 'req-icon ' + cls + (ghost ? ' claimed' : '') + (done ? ' done' : ''),
      html: svg,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  }

  function drawRequests() {
    if (editLock) return;
    layers.requests.clearLayers();
    state.requests.forEach((r) => {
      if (r.gone) return;
      const locked = isSoftLocked(r);
      const claimed = isOrderClaimed(r);
      const done = isOrderDone(r);
      const m = L.marker([r.lat, r.lng], {
        icon: reqIcon(r.kind, claimed, done),
        draggable: !locked && !done,
        zIndexOffset: (claimed || done) ? 380 : 400
      });
      m.addTo(layers.requests);
      m.on('click', (e) => {
        L.DomEvent.stop(e);
        /* Second tap on an already-selected unclaimed order = claim */
        if (selected && selected.kind === 'request' && selected.id === r.id && !isOrderClaimed(r)) {
          claimOrder(r);
          return;
        }
        select({ kind: 'request', id: r.id });
      });
      if (locked) {
        m.on('dragstart', (e) => { L.DomEvent.stop(e); softLockToast(); });
      } else {
        wirePixelDrag(m, () => state.requests, r.id);
      }
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
      className: 'pin-icon',
      iconSize: [22, 28],
      iconAnchor: [11, 28],
      html: '<svg viewBox="0 0 40 52"><path d="M20 0C9 0 2 8 2 18c0 12 18 34 18 34s18-22 18-34C38 8 31 0 20 0z" fill="#f5d547" stroke="#111" stroke-width="3"/><circle cx="20" cy="18" r="6" fill="#1c1814"/></svg>'
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
      const html = SVG.shovel + '<span>' + fmtCut(d.cutFt) + '</span>';
      L.marker(mid, {
        icon: L.divIcon({ className: 'dig-badge ' + d.status, html, iconSize: [64, 28], iconAnchor: [32, 14] }),
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

  function rebindPathDraft() {
    if (!pathDraft || !pathDraft.id) return;
    ensurePaths();
    const cur = state.paths.find((p) => p.id === pathDraft.id && !p.gone);
    if (cur) pathDraft = cur;
    else if (pathDraft.gone) pathDraft = null;
  }

  function startPathDraft() {
    ensurePaths();
    rebindPathDraft();
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
    /* Don't persist empty draft — MQTT echo used to replace the object and orphan pathDraft */
  }

  function addPathPoint(latlng) {
    if (!pathDraft) startPathDraft();
    rebindPathDraft();
    if (!pathDraft) startPathDraft();
    pathDraft.pts.push({ lat: latlng.lat, lng: latlng.lng });
    pathDraft.u = now();
    persist();
    ui.pathHint('Points: ' + pathDraft.pts.length + ' · tap more or Done');
  }

  function undoPathPoint() {
    rebindPathDraft();
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
    rebindPathDraft();
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
    selected = null;
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
    rebindPathDraft();
    if (pathTagPending && !pathDraft) {
      /* OUT/IN alone should start a haul path — truck drivers expect the tool to "do something" */
      startPathDraft();
    }
    if (pathDraft) {
      pathDraft.tag = pathTagPending;
      pathDraft.u = now();
      /* draft may still be empty — only persist once it has points, else keep tag in memory */
      if (pathDraft.pts && pathDraft.pts.length) persist();
      else ui.tools();
    } else {
      const live = (state.paths || []).filter((p) => !p.gone);
      const p = live.length ? live[live.length - 1] : null;
      if (p && pathTagPending) {
        p.tag = pathTagPending;
        p.u = now();
        persist();
      }
    }
    ui.toast(pathTagPending === 'in' ? 'ROAD IN — tap map for path' : pathTagPending === 'out' ? 'ROAD OUT — tap map for path' : 'Tag cleared');
    ui.pathHint(pathTagPending === 'in' ? 'IN path: tap map to drop points' : pathTagPending === 'out' ? 'OUT path: tap map to drop points' : 'Start a path, tap the map to drop haul points');
  }

  function pathStyle(tag, on, draft) {
    let color = '#f5d547'; /* untagged = yellow solid */
    if (tag === 'in') color = '#6ec8ff'; /* IN solid cyan */
    if (tag === 'out') color = '#ff9a4a'; /* OUT orange dashed always */
    let dashArray = null;
    if (tag === 'out') dashArray = '16 10';
    if (draft) dashArray = '10 12'; /* draft stays dashed translucent */
    return {
      color,
      weight: 10,
      opacity: draft ? 0.75 : 0.95,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray
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
      // vertices — CSS-pixel Leaflet icons (do not scale with map zoom)
      p.pts.forEach((pt, i) => {
        const isEnd = i === 0 || i === p.pts.length - 1;
        L.marker([pt.lat, pt.lng], {
          icon: pathVertexIcon(p.tag, isEnd),
          interactive: false,
          keyboard: false,
          zIndexOffset: 350
        }).addTo(layers.paths);
      });
      if (!draft && p.tag && latlngs.length >= 2) {
        const mid = latlngs[(latlngs.length / 2) | 0];
        const tagCls = p.tag === 'in' ? ' tag-in' : ' tag-out';
        L.marker(mid, {
          interactive: false,
          icon: L.divIcon({
            className: 'path-tag-label' + tagCls,
            html: (p.tag === 'in' ? 'IN' : 'OUT'),
            iconSize: [52, 26],
            iconAnchor: [26, 13]
          })
        }).addTo(layers.paths);
      }
    });
  }

  function pathVertexIcon(tag, isEnd) {
    const size = isEnd ? 12 : 8;
    const cls = tag === 'in' ? ' tag-in' : tag === 'out' ? ' tag-out' : '';
    return L.divIcon({
      className: 'leaflet-div-icon path-vertex' + cls,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }

  function persistDragLatLng(arr, id, ll) {
    const item = findById(arr || [], id);
    if (!item) return null;
    item.lat = ll.lat;
    item.lng = ll.lng;
    item.u = now();
    localDragWins[id] = item.u;
    return item;
  }

  function wirePixelDrag(marker, getArr, id) {
    marker.on('dragstart', (e) => {
      const item = findById(getArr() || [], id);
      if (isSoftLocked(item)) {
        softLockToast();
        try { marker.setLatLng([item.lat, item.lng]); } catch (err) {}
        if (e && e.target && e.target.dragging) e.target.dragging.disable();
        return;
      }
      editLock = true;
      map.dragging.disable();
    });
    marker.on('drag', () => {
      const item = findById(getArr() || [], id);
      if (isSoftLocked(item)) return;
      persistDragLatLng(getArr(), id, marker.getLatLng());
    });
    marker.on('dragend', () => {
      const item = findById(getArr() || [], id);
      if (isSoftLocked(item)) {
        editLock = false;
        map.dragging.enable();
        try { marker.setLatLng([item.lat, item.lng]); } catch (err) {}
        return;
      }
      persistDragLatLng(getArr(), id, marker.getLatLng());
      editLock = false;
      map.dragging.enable();
      persist();
    });
  }

  /* fleet — manually placed machine markers (not GPS "me") */
  function placeFleet(kind, latlng) {
    if (!state.fleet) state.fleet = [];
    const def = ROLE_LABEL[kind] || kind;
    let name = '';
    try {
      name = (window.prompt('Name this ' + def + ' (required)', def) || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    } catch (e) { name = ''; }
    if (!name) {
      ui.toast('Name required — not placed');
      return;
    }
    const item = stamp({
      id: uid(),
      role: kind,
      name: name,
      lat: latlng.lat,
      lng: latlng.lng,
      u: now()
    });
    state.fleet.push(item);
    persist();
    select({ kind: 'fleet', id: item.id });
    ui.toast(name + ' last-known set — drag to move');
  }

  function presenceDisplayName(m) {
    if (!m) return 'Operator';
    const id = m.userId || m.by || '';
    const fromItem = String(m.byName || m.name || '').trim();
    if (fromItem) return fromItem;
    const p = lookupProfile(id);
    if (p && p.name) return p.name;
    const roleKey = m.byRole || m.role || '';
    if (roleKey) return ROLE_LABEL[roleKey] || roleKey;
    return truncUserId(id) || 'Operator';
  }

  function fleetIcon(f, on) {
    const r = (f && f.role) || 'dozer';
    const color = r === 'excavator' ? '#e07030' : (r === 'water' ? '#3a9ad9' : '#f0c040');
    const label = escHtml(presenceDisplayName(f));
    return L.divIcon({
      className: 'fleet-wrap has-name',
      iconSize: [88, 44],
      iconAnchor: [44, 14],
      html: '<div class="marker-stack">' +
        '<div class="fleet-body" style="color:' + color + ';' + (on ? 'outline:3px solid #f5d547;outline-offset:3px;' : '') + '">' + roleSvg(r) + '</div>' +
        '<div class="marker-name">' + label + '</div></div>'
    });
  }

  function drawFleet() {
    if (!layers || !layers.fleet) return;
    if (editLock) return; /* don't rebuild mid-drag from MQTT/renderAll — causes snap-back */
    layers.fleet.clearLayers();
    (state.fleet || []).forEach((f) => {
      if (f.gone || f.lat == null) return;
      const on = selected && selected.kind === 'fleet' && selected.id === f.id;
      /* Last-known stays until moved — always allow drag to update location */
      const m = L.marker([f.lat, f.lng], {
        icon: fleetIcon(f, on),
        zIndexOffset: 700,
        draggable: true
      }).addTo(layers.fleet);
      m.on('click', (e) => {
        L.DomEvent.stop(e);
        select({ kind: 'fleet', id: f.id });
        const uid = f.userId || f.by || '';
        if (uid) openUserProfile(uid);
      });
      wirePixelDrag(m, () => state.fleet, f.id);
    });
  }

  /* machines — live GPS presence keyed by userId */
  function roleSvg(r) {
    if (r === 'excavator') return SVG.excavator;
    if (r === 'water') return SVG.water;
    return SVG.dozer;
  }
  function machineIcon(m, me) {
    const r = (m && (m.role || m.byRole)) || 'dozer';
    const color = r === 'excavator' ? '#e07030' : (r === 'water' ? '#3a9ad9' : '#f0c040');
    const label = escHtml(presenceDisplayName(m));
    return L.divIcon({
      className: 'machine-wrap has-name',
      iconSize: [88, 46],
      iconAnchor: [44, 15],
      html: '<div class="marker-stack">' +
        '<div class="machine-body' + (me ? ' machine-me' : '') + '" style="color:' + color + ';background:' + color + '">' + roleSvg(r) + '</div>' +
        '<div class="marker-name">' + label + (me ? ' · YOU' : '') + '</div></div>'
    });
  }

  function writeLocalPresence(pos) {
    if (!pos || !isMachineRole(role)) return;
    const id = currentUserId();
    if (!id) return;
    const name = (displayName() || googleName() || '').trim();
    state.machines[id] = {
      lat: pos.lat,
      lng: pos.lng,
      hdg: pos.heading,
      t: pos.t || now(),
      accM: pos.accM,
      role: role,
      byRole: role,
      userId: id,
      by: id,
      byName: name
    };
    /* Drop legacy role-keyed self marker so we don't show two selves */
    if (state.machines[role] && !(state.machines[role].userId || state.machines[role].by)) {
      delete state.machines[role];
    }
  }

  function drawMachines() {
    const pos = PositionSource.getLatLng();
    writeLocalPresence(pos);
    Object.keys(machineMarkers).forEach((k) => {
      if (!state.machines[k]) {
        layers.machines.removeLayer(machineMarkers[k]);
        delete machineMarkers[k];
      }
    });
    const meId = currentUserId();
    Object.keys(state.machines).forEach((key) => {
      const m = state.machines[key];
      if (!m || m.lat == null) return;
      const uid = m.userId || m.by || (isKnownRole(key) ? '' : key);
      const me = !!(uid && meId && uid === meId) || (!uid && key === role);
      if (!machineMarkers[key]) {
        machineMarkers[key] = L.marker([m.lat, m.lng], {
          icon: machineIcon(m, me),
          zIndexOffset: me ? 850 : 800,
          interactive: true
        }).addTo(layers.machines);
        machineMarkers[key].on('click', (e) => {
          L.DomEvent.stop(e);
          const id = m.userId || m.by || uid;
          if (id) openUserProfile(id);
          else ui.toast(presenceDisplayName(m));
        });
      } else {
        machineMarkers[key].setLatLng([m.lat, m.lng]);
        machineMarkers[key].setIcon(machineIcon(m, me));
      }
      if (m.hdg != null && !isNaN(m.hdg)) {
        const el = machineMarkers[key].getElement();
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
    try { pushNearbyUsers(); } catch (e) {}
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
    if (!sel) {
      bar.hidden = true;
      meta.innerHTML = '';
      acts.innerHTML = '';
      return;
    }
    bar.hidden = false;
    acts.innerHTML = '';
    if (sel.kind === 'surface') {
      const s = findById(state.surfaces, sel.id);
      if (!s) { bar.hidden = true; return; }
      meta.innerHTML = metaWithPlacer(
        (s.type === 'pad' ? 'PAD' : s.type === 'road' ? 'ROAD' : 'PILE'), s
      );
      appendKillOrLock(acts, s, () => removeItem(state.surfaces, s));
    } else if (sel.kind === 'request') {
      const r = findById(state.requests, sel.id);
      if (!r) { bar.hidden = true; return; }
      const claimed = isOrderClaimed(r);
      const done = isOrderDone(r);
      let title = '<span>' + orderLabel(r)
        + (done ? ' · DONE' : (claimed ? ' · CLAIMED' : ''))
        + '</span>';
      meta.innerHTML = orderSvg(r) + metaWithPlacer(title, r);
      if (claimed) {
        const claimWho = profileLabel({
          userId: r.claimedBy || r.byClaimed,
          byName: r.claimedByName,
          byRole: r.claimedByRole
        });
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'placer-chip claimed-chip';
        chip.setAttribute('data-user-id', r.claimedBy || r.byClaimed || '');
        chip.textContent = 'Claimed by ' + claimWho;
        meta.appendChild(chip);
      }
      if (done) {
        const doneWho = (r.completedByName || '').trim()
          || (ROLE_LABEL[r.completedByRole] || r.completedByRole || '')
          || truncUserId(r.completedBy)
          || 'Done';
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'placer-chip done-chip';
        chip.setAttribute('data-user-id', r.completedBy || '');
        chip.textContent = 'Completed by ' + doneWho;
        meta.appendChild(chip);
      } else if (!claimed) {
        /* Claim stays available even after 30s soft-lock */
        acts.appendChild(actBtn('CLAIM', 'claim', () => claimOrder(r)));
      }
      if (!done) {
        /* ✓ = complete & KEEP ghost history — never delete */
        acts.appendChild(actBtn('✓', 'ok', () => completeOrder(r)));
      }
      appendSocialActions(acts, state.requests, r);
      appendKillOrLock(acts, r, () => removeItem(state.requests, r));
    } else if (sel.kind === 'dig') {
      const d = findById(state.digPads, sel.id);
      if (!d) { bar.hidden = true; return; }
      meta.innerHTML = SVG.shovel + metaWithPlacer('<span>' + fmtCut(d.cutFt) + '</span>', d);
      if (d.status !== 'started' && d.status !== 'done') {
        acts.appendChild(actBtn('▶', 'dig', () => { d.status = 'started'; d.u = now(); persist(); select(sel); }));
      }
      if (d.status !== 'done') {
        acts.appendChild(actBtn('✓', 'ok', () => { d.status = 'done'; d.u = now(); persist(); select(sel); }));
      }
      if (role === 'dozer') appendKillOrLock(acts, d, () => removeItem(state.digPads, d));
    } else if (sel.kind === 'fleet') {
      const f = findById(state.fleet || [], sel.id);
      if (!f) { bar.hidden = true; return; }
      const machineName = (f.name || ROLE_LABEL[f.role] || f.role || 'Machine').toUpperCase();
      meta.innerHTML = roleSvg(f.role) +
        metaWithPlacer('<span>' + machineName + ' · LAST KNOWN</span>', f);
      appendSocialActions(acts, state.fleet, f);
      appendKillOrLock(acts, f, () => removeItem(state.fleet, f));
    } else if (sel.kind === 'path') {
      const p = findById(state.paths || [], sel.id);
      if (!p) { bar.hidden = true; return; }
      const tag = p.tag === 'in' ? ' IN' : p.tag === 'out' ? ' OUT' : '';
      meta.innerHTML = metaWithPlacer(
        '<span>HAUL' + tag + ' · ' + (p.pts || []).length + ' pts</span>', p
      );
      appendKillOrLock(acts, p, () => removeItem(state.paths, p));
    }
    /* Claim/done chips — open that user's profile */
    meta.querySelectorAll('.placer-chip').forEach((chip) => {
      /* set data-user-id if claim/done handlers left text only — patched below too */
    });
    wirePlacerProfileClicks(meta);
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
    /* Ownership: owner or mod (myIsMod). Moderation paths call forceRemove. */
    if (!item._forceRemove && !isOwnStamp(item) && !myIsMod()) {
      ui.toast("Can't delete — not yours");
      return;
    }
    delete item._forceRemove;
    item.gone = true;
    item.u = now();
    selected = null;
    persist();
    select(null); /* X clears selection + hides bar (idle default) */
  }
  function forceRemove(arr, item) {
    if (!item) return;
    item._forceRemove = true;
    removeItem(arr, item);
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
    try { pushNearbyUsers(); } catch (e) {}
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
    document.getElementById('roleBtn').addEventListener('click', () => {
      viewingUserId = null;
      openSheet('roleSheet');
    });
    const nearbyBtn = document.getElementById('nearbyBtn');
    if (nearbyBtn) {
      nearbyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showNearbySheet();
      });
    }
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
        if (!placeTool) select(null);
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
            'move-dozer': 'Tap map — request dozer here',
            'move-excavator': 'Tap map — request excavator here',
            'move-water': 'Tap map — request water truck here',
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
    const opSelect = document.getElementById('opRoleSelect');
    const crewSelect = document.getElementById('crewRoleSelect');
    if (opSelect) {
      opSelect.addEventListener('change', () => {
        const v = opSelect.value;
        if (v) applyRole(v);
        else syncProfileSheet();
      });
    }
    if (crewSelect) {
      crewSelect.addEventListener('change', () => {
        const v = crewSelect.value;
        if (v) applyRole(v);
        else syncProfileSheet();
      });
    }
    const nameInput = document.getElementById('displayNameInput');
    if (nameInput) {
      const saveName = () => {
        setDisplayName(nameInput.value);
        nameInput.value = displayName();
        publishLocalProfile();
        syncProfileSheet();
        persist();
        ui.role();
      };
      nameInput.addEventListener('input', () => {
        setDisplayName(nameInput.value);
        const btn = document.getElementById('continueAsBtn');
        const n = displayName();
        if (btn) btn.textContent = continueAsLabel(n);
        updateProfileProgress();
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
        ensureDisplayNameSeeded();
        if (nameInput && !nameInput.value) nameInput.value = displayName();
        if (!displayName() && !googleName() && !emailLocalPart()) {
          ui.toast('Add your name so claims show who you are');
        }
        markProfileReady();
        publishLocalProfile();
        syncProfileSheet();
        persist();
        ui.role();
        closeSheet('roleSheet');
      });
    }
    const googleOut = document.getElementById('googleSignOutBtn');
    if (googleOut) {
      googleOut.addEventListener('click', () => signOutGoogle());
    }
    const modAddBtn = document.getElementById('modAddBtn');
    const modAddInput = document.getElementById('modAddInput');
    if (modAddBtn && modAddInput) {
      const doAdd = () => {
        const v = (modAddInput.value || '').trim();
        if (!v) { ui.toast('Enter user id or email'); return; }
        if (addMod(v)) modAddInput.value = '';
      };
      modAddBtn.addEventListener('click', doAdd);
      modAddInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doAdd(); }
      });
    }
    const grantBtn = document.getElementById('viewedGrantLikesBtn');
    const grantInput = document.getElementById('viewedGrantLikesN');
    if (grantBtn) {
      grantBtn.addEventListener('click', () => {
        if (!viewingUserId || !myIsMod()) return;
        const n = grantInput ? grantInput.value : 1;
        const fid = 'mod-grant-' + viewingUserId + '-' + Date.now();
        if (grantLikes(fid, viewingUserId, n)) ui.toast('Granted likes');
      });
    }
    function promptGoogleSignIn() {
      if (googleSignedIn()) {
        syncGoogleAuthUi();
        syncAuthGate();
        return;
      }
      const gisReady = !!(window.google && google.accounts && google.accounts.id);
      if (!gisReady) {
        ui.toast('Loading Google…');
        initGoogleSignIn(true);
        return;
      }
      initGoogleSignIn(true);
      try {
        google.accounts.id.prompt();
      } catch (e) { /* renderButton is the primary path */ }
    }
    const googleFb = document.getElementById('googleSignInFallback');
    if (googleFb) googleFb.addEventListener('click', promptGoogleSignIn);
    const authGateFb = document.getElementById('authGateGoogleFallback');
    if (authGateFb) authGateFb.addEventListener('click', promptGoogleSignIn);
    initGoogleSignIn(false);
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
    if (!Array.isArray(state.likes)) state.likes = [];
    if (!Array.isArray(state.mods)) state.mods = [];
    if (!state.profiles || typeof state.profiles !== 'object') state.profiles = {};
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
    if (!Array.isArray(state.likes)) state.likes = [];
    if (!Array.isArray(state.mods)) state.mods = [];
    if (!state.profiles || typeof state.profiles !== 'object') state.profiles = {};
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
      Promise.all(keys.filter((k) => k.startsWith('onpad-') && k !== 'onpad-v35').map((k) => caches.delete(k)))
    ).then(() => navigator.serviceWorker.register('sw.js?v=35')).catch(() => {});
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
      localUserId(); /* mint anon id; Google sub preferred when signed in */
      if (!state.profiles || typeof state.profiles !== 'object') state.profiles = {};
      if (!Array.isArray(state.likes)) state.likes = [];
      ensureDisplayNameSeeded();
      publishLocalProfile();
      persist();
      updateProfileProgress();
      updateSocialCreditUi();
      ui.job();
      ui.role();
      initMap();
      bind();
      renderAll();
      syncAuthGate();
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
