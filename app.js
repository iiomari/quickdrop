// QuickDrop — peer-to-peer file/text transfer over WebRTC (PeerJS for signaling).
// Protocol (serialization "raw", ordered + reliable channel):
//   JSON strings for control: hello | text | file (meta) | end | ack
//   ArrayBuffer chunks between a "file" message and its "end".

const $ = (s) => document.querySelector(s);
const PREFIX = 'quickdrop-';
const ALPH = 'abcdefghjkmnpqrstuvwxyz23456789';
const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;

const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isMobile = isIOS || /Android/.test(ua);
const isMac = /Mac/.test(navigator.platform) && !isIOS;
const coarse = matchMedia('(pointer: coarse)');
const deviceName =
  /iPhone/.test(ua) ? 'iPhone' : isIOS ? 'iPad' : /Android/.test(ua) ? 'Android' :
  /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'جهاز';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let peer = null;
let myCode = null;
let conn = null;
let target = null;          // code we dialed (for reconnects)
let dialing = null;         // connection we're waiting on
let incoming = null;        // file currently being received
let sendQueue = [];
let sending = false;
let wakeLock = null;
let activeOut = null;       // item whose bytes are being sent right now
let outBatch = { total: 0, started: 0, bytes: 0, doneBytes: 0 };
let inBatch = { count: 0, last: 0 };
let unseen = 0;
let dragDepth = 0;
const items = new Map();
let seq = 0;

/* ---------- icons ---------- */

const ICON = {
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  download: '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  retry: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.5h.01"/>',
  share: '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M7 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  tablet: '<rect x="4.5" y="2.5" width="15" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
};
const icon = (k) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
const deviceIcon = (name) => icon(/iPhone|Android/.test(name) ? 'phone' : /iPad/.test(name) ? 'tablet' : 'laptop');

/* ---------- helpers ---------- */

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}
const ltr = (text) => h('bdi', { class: 'ltr' }, text);

function randCode() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((x) => ALPH[x % ALPH.length]).join('');
}
function cleanCode(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function fmtSize(n) {
  if (n < 1024) return Math.round(n) + ' B';
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
function fmtEta(s) {
  if (s < 60) return 'باقي ' + Math.max(1, Math.ceil(s)) + ' ث';
  if (s < 120) return 'باقي دقيقة تقريبًا';
  return 'باقي ' + Math.round(s / 60) + ' د';
}

// Status pill: state = idle | ready | connected | reconnecting | error
function setStatus(state, text) {
  $('#status').dataset.state = state;
  $('#statusText').textContent = text;
}

// Message line: tone = '' | 'error' | 'success' | 'loading'
function setMsg(el, content, tone = '') {
  el.textContent = '';
  if (tone && tone !== 'loading') el.dataset.tone = tone;
  else delete el.dataset.tone;
  if (!content) return;
  const lead = tone === 'loading'
    ? h('span', { class: 'spinner', 'aria-hidden': 'true' })
    : h('span', { html: icon(tone === 'success' ? 'check' : 'alert') }).firstChild;
  el.append(lead, h('span', null, content));
}

function sendCtl(obj) {
  if (conn && conn.open) conn.send(JSON.stringify(obj));
}

let toastTimer = 0;
function toast(iconKey, content) {
  const el = $('#toast');
  el.hidden = true;
  el.innerHTML = icon(iconKey);
  el.append(...[].concat(content));
  void el.offsetWidth;   // restart the slide-in
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

function flashDone(btn, label, iconKey) {
  btn.classList.add('is-done');
  btn.innerHTML = icon('check') + 'تم النسخ';
  setTimeout(() => {
    btn.classList.remove('is-done');
    btn.innerHTML = icon(iconKey) + label;
  }, 1500);
}

/* ---------- screens ---------- */

function show(screen) {
  for (const id of ['home', 'dial', 'session']) $('#' + id).hidden = id !== screen;
  const slot = screen === 'session' ? '#sessionHistory' : '#homeHistory';
  if ($('#history').parentElement !== $(slot)) $(slot).append($('#history'));
  scrollTo(0, 0);
}

function setTab(tab) {
  $('#tabs').dataset.active = tab;
  $('#tabRecv').setAttribute('aria-selected', tab === 'recv');
  $('#tabSend').setAttribute('aria-selected', tab === 'send');
  $('#paneRecv').hidden = tab !== 'recv';
  $('#paneSend').hidden = tab !== 'send';
}

function dialFail(text, title = 'ما تم الاتصال') {
  dialing = null;
  $('#dial').classList.add('is-failed');
  $('#dialTitle').textContent = title;
  setMsg($('#dialMsg'), text, 'error');
  $('#dialRetry').hidden = false;
}

/* ---------- code entry (6 boxes over one real input) ---------- */

const codeInput = $('#codeInput');
const otp = $('#otp');
const boxes = [...otp.querySelectorAll('.otp-box')];

function renderOtp() {
  const v = codeInput.value;
  boxes.forEach((b, i) => {
    b.textContent = v[i] || '';
    b.classList.toggle('is-active', i === Math.min(v.length, 5));
  });
}

function codeError(text) {
  setTab('send');
  show('home');
  setMsg($('#homeMsg'), text, 'error');
  otp.setAttribute('aria-invalid', 'true');
  codeInput.setAttribute('aria-invalid', 'true');
  otp.classList.remove('is-shake');
  void otp.offsetWidth;
  otp.classList.add('is-shake');
  codeInput.focus();
}

/* ---------- peer / connection ---------- */

function startPeer(code) {
  myCode = code;
  peer = new Peer(PREFIX + code, { debug: 1 });

  peer.on('open', () => {
    store.set('code', code);
    renderCode();
    if (!conn) setStatus('ready', 'جاهز');
    if (target && !conn) connectTo(target);
  });
  peer.on('connection', (c) => setupConn(c));
  peer.on('disconnected', () => { if (!conn) setStatus('reconnecting', 'إعادة الاتصال…'); });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      peer.destroy();
      startPeer(randCode());
    } else if (err.type === 'peer-unavailable') {
      dialFail('ما لقينا جهاز بهذا الرمز. تأكد منه وأن الموقع مفتوح على الجهاز الثاني.');
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      if (!conn) setStatus('error', 'مشكلة في الشبكة');
    } else {
      console.error(err);
      if (dialing) dialFail('ما قدرنا نتصل. جرّب مرة ثانية، والأفضل يكون الجهازين على نفس الواي فاي.');
    }
  });
}

// Keep the signaling socket alive (it drops when the phone sleeps or the network flips).
setInterval(() => {
  if (peer && peer.disconnected && !peer.destroyed) peer.reconnect();
}, 4000);

function connectTo(raw) {
  const code = cleanCode(raw);
  if (code.length !== 6) return codeError('الرمز لازم يكون 6 خانات.');
  if (code === myCode) return codeError('هذا رمز جهازك نفسه. اكتب رمز الجهاز الثاني.');
  if (dialing && dialing.peer === PREFIX + code) return;   // already dialing this code
  target = code;
  codeInput.value = code.toUpperCase();
  renderOtp();
  codeInput.removeAttribute('aria-invalid');
  otp.removeAttribute('aria-invalid');
  setMsg($('#homeMsg'), '');
  codeInput.blur();

  $('#dial').classList.remove('is-failed');
  $('#dialTitle').textContent = 'جارٍ الاتصال…';
  $('#dialCode').textContent = code.toUpperCase();
  setMsg($('#dialMsg'), '');
  $('#dialRetry').hidden = true;
  show('dial');

  if (!peer || !peer.open) return;   // peer 'open' dials the target
  const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
  dialing = c;
  setupConn(c);
  setTimeout(() => {
    if (dialing === c && !c.open) dialFail('ما قدرنا نتصل. جرّب مرة ثانية، والأفضل يكون الجهازين على نفس الواي فاي.');
  }, 20000);
}

function setupConn(c) {
  c.on('open', () => {
    const old = conn;
    conn = c;
    if (old && old !== c) old.close();
    if (dialing === c) dialing = null;
    incoming = null;
    if (c.dataChannel) c.dataChannel.bufferedAmountLowThreshold = 1 << 20;
    sendCtl({ t: 'hello', name: deviceName });
    setPeerName('…');
    show('session');
    setStatus('connected', 'متصل');
    keepAwake(true);
    refreshList();
    pump();
  });
  c.on('data', (d) => { if (c === conn) onData(d); });
  c.on('close', () => onClosed(c));
  c.on('error', (e) => { console.warn(e); onClosed(c); });
  c.on('iceStateChanged', (s) => { if (s === 'failed' || s === 'closed') onClosed(c); });
}

function onClosed(c) {
  if (c !== conn) return;
  conn = null;
  if (incoming) failItem(incoming.item);
  incoming = null;
  for (const job of sendQueue) failItem(job.item);
  sendQueue = [];
  for (const it of items.values()) if (it.dir === 'out' && !it.finished) failItem(it);
  activeOut = null;
  setDragging(false);
  dragDepth = 0;
  if (peer && peer.open) setStatus('ready', 'جاهز');
  else setStatus('reconnecting', 'إعادة الاتصال…');
  keepAwake(false);
  if (target) {
    show('dial');
    dialFail('انقطع الاتصال. اضغط «اتصال» عشان تحاول مرة ثانية.', 'انقطع الاتصال');
  } else {
    show('home');
  }
  refreshList();
}

function leave() {
  target = null;
  if (dialing) { const d = dialing; dialing = null; d.close(); }
  if (conn) { const c = conn; c.close(); onClosed(c); }
  show('home');
  if (location.search) history.replaceState(null, '', location.pathname);
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  unseen = 0;
  document.title = 'QuickDrop';
  if (peer && peer.disconnected && !peer.destroyed) peer.reconnect();
  if (conn) keepAwake(true);
  else if (target && peer && peer.open && !dialing) connectTo(target);
});

function setPeerName(name) {
  $('#peerName').textContent = name;
  $('#overlayPeer').textContent = name;
  $('#peerAvatar').innerHTML = deviceIcon(name);
  $('#overlayAvatar').innerHTML = deviceIcon(name);
}

/* ---------- receiving ---------- */

function onData(d) {
  if (typeof d === 'string') {
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'hello') {
      setPeerName(String(m.name || 'جهاز').slice(0, 40));
    } else if (m.t === 'text') {
      const it = addItem({ dir: 'in', kind: 'text', text: String(m.text) });
      finishItem(it);
      announce(it);
    } else if (m.t === 'file') {
      if (incoming) failItem(incoming.item);
      const it = addItem({ dir: 'in', kind: 'file', name: String(m.name || 'file'), size: +m.size || 0, mime: String(m.mime || '') });
      incoming = { id: m.id, parts: [], got: 0, item: it };
      if (Date.now() - inBatch.last > 3000) inBatch.count = 0;
      inBatch.count++;
      inBatch.last = Date.now();
      if (it.size === 0) progress(it, 1);
      updateSummary();
    } else if (m.t === 'end' && incoming && incoming.id === m.id) {
      const { parts, item } = incoming;
      incoming = null;
      inBatch.last = Date.now();
      item.blob = new Blob(parts, { type: item.mime || 'application/octet-stream' });
      item.url = URL.createObjectURL(item.blob);
      finishItem(item);
      sendCtl({ t: 'ack', id: m.id });
      if ($('#autoDl').checked) save(item);
      announce(item);
      updateSummary();
    } else if (m.t === 'ack') {
      const it = items.get(m.id);
      if (it) finishItem(it);
    }
  } else if (incoming) {
    incoming.parts.push(d);
    incoming.got += d.byteLength ?? d.size ?? 0;
    progress(incoming.item, incoming.item.size ? incoming.got / incoming.item.size : 1);
  }
}

// Let the user know something arrived when they can't see the list.
function announce(it) {
  if (document.hidden) {
    unseen++;
    document.title = '(' + unseen + ') QuickDrop';
  }
  const r = $('#history').getBoundingClientRect();
  if (r.top > innerHeight - 80 || r.bottom < 60) toast('download', ['وصل ', h('bdi', null, it.kind === 'text' ? 'نص' : it.name)]);
}

/* ---------- sending ---------- */

function queueFile(file, item) {
  outBatch.total++;
  outBatch.bytes += file.size;
  sendQueue.push({ kind: 'file', file, item });
}

function sendFiles(fileList) {
  for (const file of fileList) {
    const it = addItem({ dir: 'out', kind: 'file', name: file.name, size: file.size, mime: file.type, file });
    queueFile(file, it);
  }
  pump();
}

function sendText(text) {
  text = text.trim();
  if (!text) return;
  const it = addItem({ dir: 'out', kind: 'text', text });
  sendQueue.push({ kind: 'text', text, item: it });
  pump();
}

async function pump() {
  if (sending || !conn || !conn.open) return;
  sending = true;
  try {
    while (sendQueue.length && conn && conn.open) {
      const job = sendQueue.shift();
      if (job.kind === 'text') {
        sendCtl({ t: 'text', text: job.text });
        finishItem(job.item);
      } else {
        await sendFile(conn, job);
      }
    }
  } catch (e) {
    console.warn('send stopped:', e);
  } finally {
    sending = false;
    activeOut = null;
    if (!sendQueue.length) outBatch = { total: 0, started: 0, bytes: 0, doneBytes: 0 };
    updateSummary();
  }
}

async function sendFile(c, { file, item }) {
  activeOut = item;
  outBatch.started++;
  const max = c.peerConnection && c.peerConnection.sctp && c.peerConnection.sctp.maxMessageSize;
  const size = max && isFinite(max) && max >= 16384 ? Math.min(CHUNK, max) : CHUNK;
  c.send(JSON.stringify({ t: 'file', id: item.id, name: file.name, size: file.size, mime: file.type }));
  for (let off = 0; off < file.size; off += size) {
    if (c !== conn || !c.open) throw new Error('connection closed');
    await drain(c);
    c.send(await file.slice(off, off + size).arrayBuffer());
    progress(item, Math.min(1, (off + size) / file.size));
  }
  c.send(JSON.stringify({ t: 'end', id: item.id }));
  progress(item, 1);
  outBatch.doneBytes += file.size;
  activeOut = null;
  if (!item.finished) setItemState(item, 'waiting');
  updateSummary();
}

// Wait until the data channel's send buffer has room, so big videos don't blow memory.
function drain(c) {
  const dc = c.dataChannel;
  if (!dc || dc.bufferedAmount < HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearInterval(t); dc.removeEventListener('bufferedamountlow', done); resolve(); };
    const t = setInterval(() => {
      if (dc.bufferedAmount < HIGH_WATER / 2 || dc.readyState !== 'open') done();
    }, 50);
    dc.addEventListener('bufferedamountlow', done);
  });
}

/* ---------- transfer rows ---------- */

const STATE_TEXT = {
  queued: 'في الانتظار',
  waiting: 'بانتظار التأكيد…',
  received: 'وصل',
  sent: 'تم الإرسال',
  failed: 'فشل',
};
const STATE_CLASS = { active: 'st-active', waiting: 'st-active', received: 'st-done', sent: 'st-done', failed: 'st-fail' };
const RING_C = 2 * Math.PI * 13;

function makeRing() {
  return h('div', {
    class: 'ring', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'تقدم النقل',
    html: `<svg viewBox="0 0 32 32" aria-hidden="true"><circle class="track" cx="16" cy="16" r="13"/><circle class="fill" cx="16" cy="16" r="13" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/></svg>`,
  });
}

function addItem(o) {
  const it = { id: Date.now().toString(36) + '-' + seq++, finished: false, state: 'queued', pct: -1, bytes: 0, samples: [], shownAt: 0, speed: 0, ...o };
  const isText = it.kind === 'text';
  const isVideo = !isText && /^video\//.test(it.mime);

  it.thumb = h('div', { class: 'thumb' + (isText ? ' thumb--text' : '') },
    isText ? 'نص' : ((/\.([^.]{1,5})$/.exec(it.name) || [])[1] || 'FILE'));

  let main;
  if (isText) {
    main = h('p', { class: 'item-text', onclick: () => main.classList.toggle('is-expanded') }, it.text);
  } else {
    main = h('p', { class: 'item-name', title: it.name }, h('bdi', null, it.name));
  }
  it.meta = h('p', { class: 'item-meta' });
  it.trail = h('div', { class: 'item-trail' });
  it.li = h('li', { class: 'item' + (isVideo ? ' item--video' : '') },
    it.thumb, h('div', { class: 'item-body' }, main, it.meta), it.trail);

  if (!isText) {
    it.ring = makeRing();
    it.fill = it.ring.querySelector('.fill');
    it.trail.append(it.ring);
  }

  $('#items').prepend(it.li);
  items.set(it.id, it);
  renderMeta(it);
  refreshList();

  // On a phone, bring a new arrival into view unless the user is typing.
  if (it.dir === 'in' && coarse.matches && document.activeElement !== $('#textInput')) {
    it.li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  // Outgoing images/videos get a preview straight from the local file.
  if (it.file && /^(image|video)\//.test(it.mime)) setPreview(it, URL.createObjectURL(it.file));
  return it;
}

function renderMeta(it) {
  const sep = () => h('span', { class: 'sep' }, '·');
  const parts = [h('span', null, it.dir === 'in' ? '↓ مستلم' : '↑ مرسل')];
  if (it.kind === 'file') parts.push(sep(), h('bdi', null, fmtSize(it.size)));
  const text = it.state === 'active' ? it.pct + '%' : STATE_TEXT[it.state];
  parts.push(sep(), h('span', { class: STATE_CLASS[it.state] || '' }, text));
  if (it.state === 'active' && it.speed > 0) {
    parts.push(sep(), h('bdi', null, fmtSize(it.speed) + '/s'), sep(), h('span', null, fmtEta((it.size - it.bytes) / it.speed)));
  }
  it.meta.replaceChildren(...parts);
  if (it.ring) it.ring.classList.toggle('is-waiting', it.state === 'waiting');
}

function setItemState(it, state) {
  it.state = state;
  renderMeta(it);
}

function setPreview(it, url) {
  const el = document.createElement(it.mime.startsWith('video/') ? 'video' : 'img');
  el.src = url;
  if (el.tagName === 'VIDEO') { el.muted = true; el.playsInline = true; el.preload = 'metadata'; }
  else el.alt = '';
  const label = it.thumb.textContent;
  el.onerror = () => { it.thumb.textContent = label; };
  it.thumb.textContent = '';
  it.thumb.append(el);
}

// Speed = bytes moved over the last 3 seconds; text refreshes at most every 500ms.
function progress(it, frac) {
  if (it.finished) return;
  const now = performance.now();
  it.bytes = frac * it.size;
  it.samples.push({ t: now, b: it.bytes });
  while (it.samples.length > 2 && now - it.samples[1].t > 3000) it.samples.shift();
  const pct = Math.floor(frac * 100);
  if (pct !== it.pct) {
    it.pct = pct;
    it.fill.style.strokeDashoffset = RING_C * (1 - pct / 100);
    it.ring.setAttribute('aria-valuenow', pct);
  }
  if (it.state === 'queued' || now - it.shownAt >= 500 || frac >= 1) {
    const first = it.samples[0];
    const dt = (now - first.t) / 1000;
    it.speed = dt >= 0.3 ? (it.bytes - first.b) / dt : 0;
    it.shownAt = now;
    setItemState(it, 'active');
    updateSummary();
  }
}

function finishItem(it) {
  if (it.finished) return;
  it.finished = true;
  if (it.ring) it.ring.remove();
  setItemState(it, it.dir === 'in' ? 'received' : 'sent');

  if (it.kind === 'text') {
    addButton(it, 'copy', 'نسخ', async (btn) => {
      try { await navigator.clipboard.writeText(it.text); flashDone(btn, 'نسخ', 'copy'); } catch {}
    });
    if (/^https?:\/\/\S+$/.test(it.text)) addButton(it, 'open', 'فتح', () => window.open(it.text, '_blank', 'noopener'));
  } else if (it.dir === 'in') {
    if (/^(image|video)\//.test(it.mime)) setPreview(it, it.url);
    if (isIOS) addButton(it, 'share', 'حفظ', () => save(it, true));
    else addButton(it, 'download', 'تنزيل', () => save(it, true));
  } else {
    it.trail.append(h('span', { class: 'st-done', html: icon('check'), 'aria-hidden': 'true' }));
  }
  refreshList();
}

function failItem(it) {
  if (it.finished) return;
  it.finished = true;
  if (it.ring) it.ring.remove();
  it.li.classList.add('is-failed');
  setItemState(it, 'failed');
  if (it.dir === 'out' && it.file) {
    it.retryBtn = addButton(it, 'retry', 'إعادة الإرسال', () => retry(it), true);
    it.retryBtn.hidden = !conn;
  }
}

// A failed outgoing file goes back in the queue; the sender still holds the File.
function retry(it) {
  if (!conn || !it.file) return;
  it.retryBtn.remove();
  it.retryBtn = null;
  it.finished = false;
  it.li.classList.remove('is-failed');
  Object.assign(it, { pct: -1, bytes: 0, samples: [], shownAt: 0, speed: 0 });
  it.fill.style.strokeDashoffset = RING_C;
  it.ring.setAttribute('aria-valuenow', '0');
  it.trail.replaceChildren(it.ring);
  setItemState(it, 'queued');
  queueFile(it.file, it);
  pump();
}

function addButton(it, iconKey, label, onClick, plain = false) {
  const b = h('button', { type: 'button', class: 'capsule' + (plain ? ' capsule--plain' : ''), html: icon(iconKey) + label });
  b.addEventListener('click', () => onClick(b));
  it.trail.append(b);
  return b;
}

async function save(it, fromClick = false) {
  if (!it.url) return;
  // On iPhone the share sheet offers "Save Image/Video" straight to Photos.
  if (isIOS && fromClick && navigator.canShare) {
    const f = new File([it.blob], it.name, { type: it.blob.type });
    if (navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
  }
  const a = document.createElement('a');
  a.href = it.url;
  a.download = it.name;
  document.body.append(a);
  a.click();
  a.remove();
}

/* ---------- list ---------- */

function refreshList() {
  const n = items.size;
  $('#history').hidden = !n && !conn;
  $('#empty').hidden = n > 0;
  $('#count').hidden = !n;
  $('#count').textContent = n;
  $('#drop').classList.toggle('is-compact', n > 0);
  let received = 0;
  for (const it of items.values()) {
    if (it.dir === 'in' && it.url) received++;
    if (it.retryBtn) it.retryBtn.hidden = !conn;
  }
  $('#dlAll').hidden = received < 2;
}

function updateSummary() {
  const el = $('#summary');
  let parts = null;
  if (activeOut && !activeOut.finished) {
    const it = activeOut;
    parts = ['يرسل ' + outBatch.started + ' من ' + outBatch.total];
    if (it.speed > 0) {
      const left = outBatch.bytes - outBatch.doneBytes - it.bytes;
      parts.push(' · ', ltr(fmtSize(it.speed) + '/s'), ' · ' + fmtEta(left / it.speed));
    }
  } else if (incoming && !incoming.item.finished) {
    const it = incoming.item;
    parts = ['يستقبل ' + inBatch.count];
    if (it.speed > 0) parts.push(' · ', ltr(fmtSize(it.speed) + '/s'), ' · ' + fmtEta((it.size - it.bytes) / it.speed));
  }
  el.hidden = !parts;
  el.replaceChildren(...(parts || []));
}

/* ---------- wiring ---------- */

function shareUrl() {
  return location.origin + location.pathname + '?to=' + myCode;
}

function renderCode() {
  const code = myCode.toUpperCase();
  const box = $('#myCode');
  box.replaceChildren(h('span', null, code.slice(0, 3)), h('span', null, code.slice(3)));
  box.setAttribute('aria-label', 'رمز هذا الجهاز: ' + code.split('').join(' '));
  const qr = $('#qr');
  qr.textContent = '';
  if (window.QRCode) {
    new QRCode(qr, { text: shareUrl(), width: 192, height: 192, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
  }
}

$('#myDevice').textContent = deviceName;
$('#myDeviceIcon').innerHTML = deviceIcon(deviceName);
$('#dialAvatar').innerHTML = icon('laptop');

const copyLink = $('#copyLink');
copyLink.innerHTML = icon('link') + 'نسخ الرابط';
copyLink.addEventListener('click', async () => {
  if (!myCode) return;
  try {
    await navigator.clipboard.writeText(shareUrl());
    flashDone(copyLink, 'نسخ الرابط', 'link');
    toast('check', 'تم النسخ');
  } catch {}
});

// Tabs: a phone usually types/scans, a computer usually shows the code.
$('#tabRecv').addEventListener('click', () => setTab('recv'));
$('#tabSend').addEventListener('click', () => { setTab('send'); codeInput.focus(); });
setTab(coarse.matches ? 'send' : 'recv');

codeInput.addEventListener('input', () => {
  const v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (codeInput.value !== v) codeInput.value = v;
  codeInput.removeAttribute('aria-invalid');
  otp.removeAttribute('aria-invalid');
  renderOtp();
  if (v.length === 6) connectTo(v);
  else if ($('#homeMsg').dataset.tone === 'error') setMsg($('#homeMsg'), '');
});
codeInput.addEventListener('focus', () => { otp.classList.add('is-focused'); renderOtp(); });
codeInput.addEventListener('blur', () => otp.classList.remove('is-focused'));
$('#connectForm').addEventListener('submit', (e) => { e.preventDefault(); connectTo(codeInput.value); });

$('#dialRetry').addEventListener('click', () => { if (target) connectTo(target); });
$('#dialCancel').addEventListener('click', leave);
$('#leaveBtn').addEventListener('click', leave);

// Drop target (the hero card) + page-wide drag and paste
const dropBtn = $('#drop');
const kbd = (t) => h('kbd', null, t);
const defaultHint = () => (coarse.matches
  ? 'من الصور أو الملفات'
  : ['أو اسحبها وأفلتها هنا، أو الصقها بـ ', h('span', { class: 'ltr' }, kbd(isMac ? '⌘' : 'Ctrl'), ' ', kbd('V'))]);
$('#dropHint').replaceChildren(...[].concat(defaultHint()));
coarse.addEventListener('change', () => { if (!dragDepth) $('#dropHint').replaceChildren(...[].concat(defaultHint())); });
dropBtn.addEventListener('click', () => $('#fileInput').click());
$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { sendFiles(e.target.files); e.target.value = ''; });

function setDragging(on) {
  $('#dropOverlay').hidden = !on;
  dropBtn.classList.toggle('is-dragover', on);
  $('#dropTitle').replaceChildren(...(on
    ? ['أفلت للإرسال إلى ', h('bdi', null, $('#peerName').textContent)]
    : ['اختر صورًا أو فيديوهات أو ملفات']));
  $('#dropHint').replaceChildren(...[].concat(on ? 'الملفات تنرسل بنفس جودتها' : defaultHint()));
}
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!conn || !hasFiles(e)) return;
  e.preventDefault();
  if (dragDepth++ === 0) setDragging(true);
});
document.addEventListener('dragover', (e) => { if (conn && hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', (e) => {
  if (!conn || !hasFiles(e) || !dragDepth) return;
  if (--dragDepth === 0) setDragging(false);
});
document.addEventListener('drop', (e) => {
  if (!conn || !hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  if (e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
});
document.addEventListener('paste', (e) => {
  if (!conn || e.target === $('#textInput')) return;
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) { e.preventDefault(); sendFiles(files); }
  else {
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (text) { e.preventDefault(); sendText(text); }
  }
});

// iPhone notice: open the first time, collapsed after «فهمت».
const tip = $('#iosTip');
if (isIOS) {
  tip.hidden = false;
  tip.open = store.get('qd.iosTipSeen') !== '1';
}
$('#tipOk').addEventListener('click', () => { tip.open = false; store.set('qd.iosTipSeen', '1'); });

// Composer
const textInput = $('#textInput');
const sendBtn = $('#sendBtn');
const autoGrow = !CSS.supports('field-sizing', 'content');
function syncComposer() {
  sendBtn.disabled = !textInput.value.trim();
  if (autoGrow) {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 140) + 'px';
  }
}
textInput.addEventListener('input', syncComposer);
$('#textForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendText(textInput.value);
  textInput.value = '';
  syncComposer();
  textInput.focus();
});
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse.matches) {
    e.preventDefault();
    if (!sendBtn.disabled) $('#textForm').requestSubmit();
  }
});

// List tools
const autoDl = $('#autoDl');
autoDl.checked = (store.get('autoDl') ?? (isMobile ? '0' : '1')) === '1';
autoDl.addEventListener('change', () => store.set('autoDl', autoDl.checked ? '1' : '0'));
$('#dlAll').addEventListener('click', () => {
  let i = 0;
  for (const it of items.values()) if (it.dir === 'in' && it.url) setTimeout(() => save(it), 250 * i++);
});

/* ---------- boot ---------- */

renderOtp();
show('home');
if (!window.Peer) {
  setStatus('error', 'تعذّر التحميل');
  setTab('send');
  setMsg($('#homeMsg'), 'ما قدرنا نحمّل أداة الاتصال. تأكد من الإنترنت وحدّث الصفحة.', 'error');
} else {
  const saved = cleanCode(store.get('code'));
  const to = cleanCode(new URLSearchParams(location.search).get('to'));
  startPeer(saved.length === 6 && saved !== to ? saved : randCode());
  if (to) connectTo(to);
}
