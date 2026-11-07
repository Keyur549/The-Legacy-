// ધ લેગસી · સત્સંગ યુનો બિંગો — real-time backend (Node + Express + Socket.IO)
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 40000, perMessageDeflate: false });
process.on('uncaughtException', e => console.error('uncaughtException:', e && e.stack || e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

const HOST_ID = process.env.HOST_ID || 'admin';
const HOST_PW = process.env.HOST_PW || 'gyan2026';

// ---------- static files (flat upload or public/) ----------
const OK_EXT = ['.html', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp3', '.m4a', '.ogg', '.wav'];
app.get('/health', (req, res) => res.type('text').send('ok'));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  let rel; try { rel = decodeURIComponent(req.path); } catch (e) { return next(); }
  if (rel.includes('..')) return next();
  const base = path.basename(rel);
  if (!OK_EXT.includes(path.extname(base).toLowerCase())) return next();
  for (const f of [path.join(__dirname, 'public', rel), path.join(__dirname, base)]) {
    try { if (fs.statSync(f).isFile()) return res.sendFile(f); } catch (e) {}
  }
  next();
});
app.get('/', (req, res) => res.redirect('/player.html' + (req.query.code ? '?code=' + encodeURIComponent(req.query.code) : '')));
app.get(['/host', '/admin'], (req, res) => res.redirect('/host.html'));

// ---------- game constants ----------
const PHASE_LEN = 9;
const FAST = !!process.env.LG_FAST;   // test mode only
const ANNOUNCE_MS = FAST ? 200 : 4500;
const SANT_SEC = FAST ? 2 : 40, KRAM_SEC = FAST ? 2 : 40;
const MIN_Q = FAST ? 1 : 10;
const CARD_N = 25;
const UNO_CARDS = ['wild', 'plus2', 'reverse', 'skip', 'seva'];
const LINES = (() => {
  const L = [];
  for (let r = 0; r < 5; r++) L.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
  for (let c = 0; c < 5; c++) L.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
  L.push([0, 6, 12, 18, 24]); L.push([4, 8, 12, 16, 20]);
  return L;
})();
const LEVELS = [{ k: 'l1', n: 1, t: '1 લાઇન' }, { k: 'l2', n: 2, t: '2 લાઇન' }, { k: 'fh', n: 99, t: 'ફુલ હાઉસ' }];
const PH_DEF = ['ભક્તિ', 'જ્ઞાન', 'સેવા', 'સંસ્કાર'];
const GT_DEF = 'ધ લેગસી';
const GS_DEF = 'સત્સંગ યુનો બિંગો';

const rooms = {};
const rnd = n => Math.floor(Math.random() * n);
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function randCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do { s = ''; for (let i = 0; i < 5; i++) s += c[rnd(c.length)]; } while (rooms[s]); return s; }
function randTok() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
function clean(t, d, n) { t = String(t == null ? '' : t).trim().slice(0, n || 40); return t || d; }

// ---------- question file ----------
// normal:  પ્રશ્ન::જવાબ          [img:file.jpg] optional
// sant:    [sant][img:sant1.jpg] આ સંત કોણ?::જવાબ     (photo starts blurred, clears with time)
// kram:    [kram] પ્રસંગોને ક્રમમાં ગોઠવો::પહેલો|બીજો|ત્રીજો|ચોથો   (correct order)
function parseQA(text) {
  const qs = []; let bad = 0;
  String(text || '').split(/\r?\n/).forEach(line => {
    line = line.trim(); if (!line) return;
    const i = line.lastIndexOf('::'); if (i < 1) { bad++; return; }
    let q = line.slice(0, i).trim(), a = line.slice(i + 2).trim(); if (!a) { bad++; return; }
    let type = 'n', img = null, m;
    if (/\[sant\]/i.test(q)) { type = 's'; q = q.replace(/\[sant\]/ig, ''); }
    if (/\[kram\]/i.test(q)) { type = 'k'; q = q.replace(/\[kram\]/ig, ''); }
    if ((m = q.match(/\[img:([^\]]+)\]/i))) { img = m[1].trim(); q = q.replace(m[0], ''); }
    q = q.trim();
    const o = { q, a, type, img };
    if (type === 'k') { o.items = a.split('|').map(s => s.trim()).filter(Boolean); if (o.items.length < 2) { bad++; return; } }
    qs.push(o);
  });
  return { questions: qs.slice(0, PHASE_LEN * 4), bad };
}

// ---------- players ----------
function newPlayer(r, name, zone, avatar) {
  const ans = shuffle([...new Set(r.questions.filter(q => q.type !== 'k').map(q => q.a))]).slice(0, CARD_N);
  let k = 0; while (ans.length < CARD_N) ans.push('✦' + (++k));
  const card = shuffle(ans);
  const col = shuffle(Array.from({ length: CARD_N }, (_, i) => i % 4));
  return {
    baseName: name, zone, avatar: avatar || '', token: randTok(), joinedAt: Date.now(),
    card, col, marks: {}, cardUse: {}, hand: {}, kram: {}, claims: [], giftsIn: 0, unoOpen: 0, unoUsed: 0
  };
}
const nameOk = s => /\S/.test(s || '');

function phaseOfPos(pos) { return Math.floor(pos / PHASE_LEN); }
function curPos(r) { return r.usedIdx.length - 1; }
function qLocked(r, qi) { return !(qi === r.curIdx && r.status === 'question'); }

function okCells(r, p) {
  const s = new Set();
  for (const k of Object.keys(p.marks)) {
    const qi = +k, m = p.marks[k], q = r.questions[qi];
    if (!q || q.type === 'k' || !qLocked(r, qi)) continue;
    if (p.cardUse[qi] === 'skip') continue;
    if (p.card[m.ci] === q.a) s.add(m.ci);
  }
  return s;
}
function linesDone(set) { return LINES.filter(L => L.every(c => set.has(c))).length; }
function markedCells(p) { return new Set(Object.values(p.marks).map(m => m.ci)); }

function unoEligible(p) {
  const s = markedCells(p);
  return LINES.some(L => L.filter(c => s.has(c)).length === 4);
}

// full score (server only; shown to players only after reveal)
function score(r, p, speedKram) {
  const o = { correct: 0, wrong: 0, colorPts: 0, cardPts: 0, santPts: 0, kramPts: 0, giftPts: 0, claimPts: 0, unoPts: 0, net: 0, validClaims: 0, perQ: {} };
  r.usedIdx.forEach((qi, pos) => {
    const q = r.questions[qi], ph = phaseOfPos(pos);
    if (q.type === 'k') {
      const kr = p.kram[qi];
      if (kr) {
        const ok = kr.order.every((v, i) => v === i);
        if (ok) { o.kramPts += 2; const rk = (speedKram[qi] || []).indexOf(p.baseName + '|' + p.joinedAt); if (rk >= 0) o.kramPts += [3, 2, 1][rk]; }
        o.perQ[qi] = ok ? 'g' : 'r';
      }
      return;
    }
    const m = p.marks[qi]; if (!m) return;
    const use = p.cardUse[qi];
    if (use === 'skip') { o.perQ[qi] = 's'; return; }
    const ok = p.card[m.ci] === q.a;
    if (ok) {
      o.correct++; o.perQ[qi] = 'g';
      if (use === 'wild' || p.col[m.ci] === ph) o.colorPts += 1;
      if (use === 'plus2') o.cardPts += 2;
      if (q.type === 's') { const f = (m.ts - r.qStart[qi]) / (r.qEnd[qi] - r.qStart[qi]); o.santPts += f < 0.34 ? 3 : f < 0.67 ? 2 : 1; }
    } else {
      o.wrong++; o.perQ[qi] = 'r';
      if (use === 'plus2') o.cardPts -= 2;
    }
  });
  o.giftPts = 2 * (p.giftsIn || 0);
  // claims
  let unoPend = false, unoBonusGiven = false;
  p.claims.forEach(c => {
    if (c.valid) { o.validClaims++; if (c.uno && !unoBonusGiven) { o.unoPts += 2; unoBonusGiven = true; } }
    else o.claimPts -= c.uno ? 2 : 1;
  });
  o.net = o.correct - o.wrong + o.colorPts + o.cardPts + o.santPts + o.kramPts + o.giftPts + o.claimPts + o.unoPts;
  o.beads = o.correct + 2 * o.validClaims;
  return o;
}

function speedKramMap(r) {
  const out = {};
  r.usedIdx.forEach(qi => {
    const q = r.questions[qi]; if (q.type !== 'k') return;
    const list = [];
    for (const p of Object.values(r.players)) { const kr = p.kram[qi]; if (kr && kr.order.every((v, i) => v === i)) list.push({ id: p.baseName + '|' + p.joinedAt, ts: kr.ts, j: p.joinedAt }); }
    list.sort((a, b) => a.ts - b.ts || a.j - b.j);
    out[qi] = list.slice(0, 3).map(x => x.id);
  });
  return out;
}

// live (hidden-number) mandir level per zone: average of correct answers + 4 x valid claims
function zoneStats(r) {
  const z = {};
  for (const p of Object.values(r.players)) { (z[p.zone || '—'] = z[p.zone || '—'] || []).push(p); }
  return z;
}
function mandirLive(r) {
  const z = zoneStats(r), out = [];
  const sk = speedKramMap(r);
  for (const [zone, ps] of Object.entries(z)) {
    let sum = 0;
    ps.forEach(p => { const s = score(r, p, sk); sum += s.correct + 4 * s.validClaims; });
    const avg = sum / ps.length;
    out.push({ zone, n: ps.length, avg, level: Math.min(10, Math.floor(avg / 2)) });
  }
  return out.sort((a, b) => a.zone.localeCompare(b.zone, 'gu'));
}

// ---------- winners ----------
function computeReveal(r) {
  const sk = speedKramMap(r);
  const res = {};
  const P = Object.entries(r.players);
  P.forEach(([k, p]) => { res[k] = score(r, p, sk); });
  const rank = P.map(([k, p]) => k).sort((a, b) => res[b].net - res[a].net || res[b].correct - res[a].correct || r.players[a].joinedAt - r.players[b].joinedAt);
  rank.forEach((k, i) => { res[k].rank = i + 1; });
  const winners = [];
  LEVELS.forEach(L => {
    let best = null;
    P.forEach(([k, p]) => p.claims.forEach(c => { if (c.valid && c.k === L.k && (!best || c.ts < best.ts || (c.ts === best.ts && p.joinedAt < r.players[best.k].joinedAt))) best = { k, ts: c.ts }; }));
    winners.push({ id: L.k, title: L.t + ' વિજેતા', name: best ? best.k : null, zone: best ? r.players[best.k].zone : '', extra: best ? '⏱ ' + (((best.ts - (r.startedAt || best.ts)) / 1000) | 0) + ' સે (ગેમ શરૂથી)' : 'કોઈ નહીં' });
  });
  // zone avg score + mandir
  const z = zoneStats(r); let za = null, zm = null; const mz = [];
  Object.entries(z).forEach(([zone, ps]) => {
    const avg = ps.reduce((s, p) => s + res[Object.keys(r.players).find(k => r.players[k] === p)].net, 0) / ps.length;
    const mv = ps.reduce((s, p) => { const x = res[Object.keys(r.players).find(k => r.players[k] === p)]; return s + x.correct + 4 * x.validClaims; }, 0) / ps.length;
    mz.push({ zone, n: ps.length, avg: +avg.toFixed(2), mandir: +mv.toFixed(2) });
    if (!za || avg > za.v) za = { zone, v: avg }; if (!zm || mv > zm.v) zm = { zone, v: mv };
  });
  winners.push({ id: 'zone', title: 'ઝોન વિજેતા', name: za ? za.zone : null, zone: '', extra: za ? 'સરેરાશ સ્કોર ' + za.v.toFixed(1) : '' });
  winners.push({ id: 'mandir', title: 'મંદિર નિર્માણ વિજેતા', name: zm ? zm.zone : null, zone: '', extra: zm ? 'મંદિર પોઇન્ટ ' + zm.v.toFixed(1) : '' });
  [3, 2, 1].forEach(n => { const k = rank[n - 1]; winners.push({ id: 'r' + n, title: ['', '🥇 ચેમ્પિયન', '🥈 બીજો', '🥉 ત્રીજો'][n], name: k || null, zone: k ? r.players[k].zone : '', extra: k ? 'સ્કોર ' + res[k].net : '' }); });
  r.reveal = { res, rank, winners, zones: mz };
}

// ---------- state for clients ----------
function qPublic(r, host) {
  if (r.curIdx == null) return null;
  const q = r.questions[r.curIdx];
  const o = { text: q.q, img: q.img, type: q.type, start: r.qStart[r.curIdx], end: r.qEnd[r.curIdx] };
  if (q.type === 'k') o.items = (r.kramDisp[r.curIdx] || []).map(i => ({ i, t: q.items[i] }));
  if (host) o.ans = q.a;
  return o;
}
function baseState(r) {
  const pos = curPos(r);
  return {
    code: r.code, status: r.status, gTitle: r.gTitle, gSub: r.gSub, phaseNames: r.phaseNames, total: r.questions.length,
    usedN: r.usedIdx.length, curIdx: r.curIdx, pos, phase: pos >= 0 ? phaseOfPos(pos) : 0, nextPhase: phaseOfPos(r.usedIdx.length), now: Date.now(),
    announceEnd: r.announceEnd || 0, timerEnd: r.timerEnd || 0, unoTs: r.unoTs || 0, unoN: r.unoN || 0, qSec: r.qSec,
    nPlayers: Object.keys(r.players).length, answered: answeredCount(r), qType: r.curIdx != null ? r.questions[r.curIdx].type : null,
    mandir: (r.status === 'revealed') ? undefined : mandirLive(r).map(m => ({ zone: m.zone, n: m.n, level: m.level })),
    revStep: r.revStep || 0
  };
}
function answeredCount(r) {
  if (r.curIdx == null) return 0;
  const q = r.questions[r.curIdx]; let n = 0;
  for (const p of Object.values(r.players)) if (q.type === 'k' ? p.kram[r.curIdx] : p.marks[r.curIdx]) n++;
  return n;
}
function stateFor(r, info, cache) {
  const s = Object.assign({}, cache.base);
  s.role = info.role;
  const showQ = r.status === 'question' || r.status === 'locked';
  if (info.role === 'host') {
    s.q = showQ ? qPublic(r, true) : null; s.hostQ = r.curIdx != null ? qPublic(r, true) : null;
    s.players = cache.players; s.questions = r.questions.map(q => ({ q: q.q, a: q.a, type: q.type }));
  } else if (info.role === 'pj') {
    s.q = showQ ? qPublic(r, false) : null; s.players = cache.players;
  } else {
    s.q = showQ ? qPublic(r, false) : null;
    const p = r.players[info.key];
    if (p) {
      const marks = {}; for (const k of Object.keys(p.marks)) marks[k] = p.marks[k].ci;
      s.you = {
        key: info.key, name: p.baseName, zone: p.zone, avatar: p.avatar, card: p.card, col: p.col, marks, cardUse: p.cardUse, hand: p.hand,
        kram: Object.keys(p.kram).reduce((a, k) => { a[k] = true; return a; }, {}),
        claims: p.claims.map(c => ({ k: c.k })), uno: p.unoOpen > 0, unoEligible: unoEligible(p), unoUsed: p.unoUsed,
        mates: Object.entries(r.players).filter(([k, x]) => k !== info.key && x.zone === p.zone).map(([k, x]) => k)
      };
      if (r.reveal) {
        const rs = r.reveal.res[info.key];
        s.you.result = rs; s.you.total = r.reveal.rank.length;
      }
    }
    if (r.reveal) s.winners = r.reveal.winners.slice(0, r.revStep || 0), s.zones = r.reveal.zones;
  }
  if (info.role !== 'player' && r.reveal) { s.winners = r.reveal.winners.slice(0, r.revStep || 0); s.zones = r.reveal.zones; s.allWinners = info.role === 'host' ? r.reveal.winners : undefined; s.rank = r.reveal.rank.slice(0, 10).map(k => ({ name: k, zone: r.players[k].zone, net: r.reveal.res[k].net })); }
  return s;
}
function bc(code) {
  const r = rooms[code]; if (!r || r._bc) return;
  r._bc = setTimeout(() => {
    r._bc = null;
    const online = new Set([...r.socks.values()].filter(i => i.key).map(i => i.key));
    const cache = { base: baseState(r), players: Object.entries(r.players).map(([k, p]) => ({ name: k, zone: p.zone, avatar: p.avatar, online: online.has(k) || !!p.bot, bot: !!p.bot })) };
    for (const [id, info] of r.socks) {
      const s = io.sockets.sockets.get(id); if (!s) { r.socks.delete(id); continue; }
      try { s.emit('state', stateFor(r, info, cache)); } catch (e) { console.error(e); }
    }
  }, 60);
}

// ---------- game flow ----------
function startAnnounce(r) {
  const next = r.usedIdx.length;
  if (next >= r.questions.length) { r.status = 'ended'; bc(r.code); return; }
  r.curIdx = next; r.usedIdx.push(next);
  const q = r.questions[next];
  r.status = 'announce'; r.announceEnd = Date.now() + (next % PHASE_LEN === 0 ? ANNOUNCE_MS + (FAST ? 0 : 1500) : ANNOUNCE_MS); r.timerEnd = 0;
  if (q.type === 'k') { let d; do { d = shuffle(q.items.map((_, i) => i)); } while (d.every((v, i) => v === i) && d.length > 1); r.kramDisp[next] = d; }
  bc(r.code);
  clearTimeout(r._t); r._t = setTimeout(() => beginQuestion(r), r.announceEnd - Date.now());
}
function beginQuestion(r) {
  if (r.status !== 'announce') return;
  const q = r.questions[r.curIdx];
  const sec = q.type === 's' ? Math.max(r.qSec, SANT_SEC) : q.type === 'k' ? Math.max(r.qSec, KRAM_SEC) : r.qSec;
  r.status = 'question'; r.qStart[r.curIdx] = Date.now(); r.qEnd[r.curIdx] = Date.now() + sec * 1000; r.timerEnd = r.qEnd[r.curIdx];
  bc(r.code);
  botsAnswer(r);
  clearTimeout(r._t); r._t = setTimeout(() => lockQuestion(r), sec * 1000 + 100);
}
function lockQuestion(r) {
  if (r.status !== 'question') return;
  clearTimeout(r._t);
  r.status = 'locked'; r.timerEnd = 0; r.qEnd[r.curIdx] = Math.min(r.qEnd[r.curIdx], Date.now());
  botsClaim(r);
  if (r.usedIdx.length < r.questions.length && r.usedIdx.length % PHASE_LEN === 0) r.status = 'phasebreak';
  bc(r.code);
}

// ---------- bots (testing) ----------
const BOT_ZONES = ['અમદાવાદ', 'સુરત', 'રાજકોટ', 'વડોદરા'];
function botsAnswer(r) {
  const q = r.questions[r.curIdx], qi = r.curIdx;
  for (const [k, p] of Object.entries(r.players)) {
    if (!p.bot || !r.botsPlay) continue;
    setTimeout(() => {
      if (r.status !== 'question' || r.curIdx !== qi) return;
      if (q.type === 'k') { const ok = Math.random() < 0.6; const o = ok ? q.items.map((_, i) => i) : shuffle(q.items.map((_, i) => i)); p.kram[qi] = { order: o, ts: Date.now() }; }
      else {
        const used = markedCells(p); let ci = Math.random() < 0.7 ? p.card.indexOf(q.a) : rnd(CARD_N);
        if (ci < 0 || used.has(ci)) { const free = p.card.map((_, i) => i).filter(i => !used.has(i)); ci = free[rnd(free.length)]; }
        if (ci != null) p.marks[qi] = { ci, ts: Date.now() };
        if (Math.random() < 0.15) { const c = UNO_CARDS[rnd(3)]; if (p.hand[c] == null && !p.cardUse[qi]) { p.hand[c] = qi; p.cardUse[qi] = c; } }
      }
      bc(r.code);
    }, FAST ? 100 + rnd(600) : 800 + rnd(6000));
  }
}
function botsClaim(r) {
  for (const p of Object.values(r.players)) {
    if (!p.bot || !r.botsPlay) continue;
    for (const L of LEVELS) { if (!p.claims.find(c => c.k === L.k) && Math.random() < 0.7) tryClaim(r, p, L.k, true); }
  }
}

function tryClaim(r, p, k, quiet) {
  const L = LEVELS.find(x => x.k === k); if (!L) return false;
  if (p.claims.find(c => c.k === k && c.valid)) return false;
  const ok = okCells(r, p);
  let valid;
  if (k === 'fh') valid = ok.size >= CARD_N; else valid = linesDone(ok) >= L.n;
  p.claims.push({ k, ts: Date.now(), valid, uno: p.unoOpen > 0 });
  if (p.unoOpen > 0) p.unoOpen = 0;
  return valid;
}

// ---------- sockets ----------
function hostRoom(socket, code) { const r = rooms[code]; if (!r) return null; const info = r.socks.get(socket.id); return info && info.role === 'host' ? r : null; }
function playerOf(socket, code) {
  const r = rooms[code]; if (!r) return {};
  const info = r.socks.get(socket.id); if (!info || info.role !== 'player') return { r };
  return { r, p: r.players[info.key], key: info.key };
}
io.on('connection', socket => {
  socket.on('time:sync', (x, cb) => { if (typeof cb === 'function') cb(Date.now()); });

  socket.on('host:login', ({ id, pw }, cb) => { cb && cb({ ok: id === HOST_ID && pw === HOST_PW }); });

  socket.on('host:create', ({ hostName, maxPlayers, qaText, phaseNames, gTitle, gSub, qSec }, cb) => {
    const parsed = parseQA(qaText);
    if (parsed.questions.length < 1) { cb && cb({ ok: false, error: 'પ્રશ્નો વાંચી શકાયા નહિ. "પ્રશ્ન::જવાબ" ફોર્મેટ વાપરો.' }); return; }
    const code = randCode();
    const names = PH_DEF.map((d, i) => clean(phaseNames && phaseNames[i], d, 30));
    const r = rooms[code] = {
      code, hostName: clean(hostName, 'Host', 40), maxPlayers: maxPlayers || null, status: 'lobby', questions: parsed.questions,
      usedIdx: [], curIdx: null, qStart: {}, qEnd: {}, kramDisp: {}, players: {}, socks: new Map(), hostToken: randTok(),
      phaseNames: names, gTitle: clean(gTitle, GT_DEF), gSub: clean(gSub, GS_DEF), qSec: Math.min(120, Math.max(MIN_Q, +qSec || 30)),
      createdAt: Date.now(), unoTs: 0, unoN: 0, revStep: 0, reveal: null, botsPlay: true
    };
    r.socks.set(socket.id, { role: 'host' }); socket.join(code);
    cb && cb({ ok: true, code, token: r.hostToken, parseInfo: { count: parsed.questions.length, bad: parsed.bad } });
    bc(code);
  });

  socket.on('subscribe', ({ code, role, key, token, hostToken }, cb) => {
    const r = rooms[code]; if (!r) { cb && cb({ ok: false, error: 'Room મળ્યો નહિ.' }); return; }
    if (role === 'host') { if (hostToken !== r.hostToken) { cb && cb({ ok: false, error: 'Host ઓળખાયા નહિ.' }); return; } r.socks.set(socket.id, { role: 'host' }); }
    else if (role === 'pj') r.socks.set(socket.id, { role: 'pj' });
    else { const p = r.players[key]; if (!p || p.token !== token) { cb && cb({ ok: false, error: 'ફરી જોડાઓ.' }); return; } r.socks.set(socket.id, { role: 'player', key }); }
    socket.join(code); cb && cb({ ok: true }); bc(code);
  });
  socket.on('disconnect', () => { for (const r of Object.values(rooms)) if (r.socks.delete(socket.id)) bc(r.code); });

  // ---- host controls ----
  socket.on('host:start', ({ code }) => { const r = hostRoom(socket, code); if (!r || r.status !== 'lobby') return; r.startedAt = Date.now(); r.status = 'ready'; bc(code); });
  socket.on('host:next', ({ code }) => {
    const r = hostRoom(socket, code); if (!r) return;
    if (!['ready', 'locked', 'phasebreak'].includes(r.status)) return;
    startAnnounce(r);
  });
  socket.on('host:skipTimer', ({ code }) => { const r = hostRoom(socket, code); if (r) lockQuestion(r); });
  socket.on('host:setQSec', ({ code, sec }) => { const r = hostRoom(socket, code); if (!r) return; r.qSec = Math.min(120, Math.max(MIN_Q, +sec || 30)); bc(code); });
  socket.on('host:setNames', ({ code, gTitle, gSub, phaseNames }) => {
    const r = hostRoom(socket, code); if (!r) return;
    r.gTitle = clean(gTitle, GT_DEF); r.gSub = clean(gSub, GS_DEF);
    r.phaseNames = PH_DEF.map((d, i) => clean(phaseNames && phaseNames[i], d, 30)); bc(code);
  });
  socket.on('host:reveal', ({ code }) => {
    const r = hostRoom(socket, code); if (!r) return;
    if (!['locked', 'phasebreak', 'ended'].includes(r.status)) return;
    clearTimeout(r._t); computeReveal(r); r.status = 'revealed'; r.revStep = 0; bc(code);
  });
  socket.on('host:nextWinner', ({ code }) => { const r = hostRoom(socket, code); if (!r || !r.reveal) return; if (r.revStep < r.reveal.winners.length) r.revStep++; bc(code); });
  socket.on('host:kick', ({ code, name }) => { const r = hostRoom(socket, code); if (!r) return; delete r.players[name]; bc(code); });
  socket.on('host:addBots', ({ code, n }, cb) => {
    const r = hostRoom(socket, code); if (!r) return;
    n = Math.min(60, Math.max(1, +n || 8));
    for (let i = 0; i < n; i++) {
      let k = 'Bot' + (Object.keys(r.players).length + 1); while (r.players[k]) k += 'x';
      const p = newPlayer(r, k, BOT_ZONES[i % 4], ['🦁', '🐯', '🐼', '🦊'][i % 4]); p.bot = true; r.players[k] = p;
    }
    cb && cb({ ok: true }); bc(code);
  });
  socket.on('host:clearBots', ({ code }) => { const r = hostRoom(socket, code); if (!r) return; for (const k of Object.keys(r.players)) if (r.players[k].bot) delete r.players[k]; bc(code); });

  // ---- player ----
  socket.on('player:join', ({ code, name, zone, avatar, token }, cb) => {
    const r = rooms[code]; if (!r) { cb && cb({ ok: false, error: 'Room કોડ મળ્યો નહિ.' }); return; }
    name = clean(name, '', 24); zone = clean(zone, '', 24);
    if (token) { const k = Object.keys(r.players).find(x => r.players[x].token === token); if (k) { r.socks.set(socket.id, { role: 'player', key: k }); socket.join(code); cb && cb({ ok: true, key: k, token, resumed: true }); bc(code); return; } }
    if (!nameOk(name)) { cb && cb({ ok: false, error: 'નામ લખો.' }); return; }
    if (!nameOk(zone)) { cb && cb({ ok: false, error: 'ઝોન લખો.' }); return; }
    const norm = x => x.trim().toLowerCase();
    const dup = Object.keys(r.players).find(k => norm(r.players[k].baseName) === norm(name) && norm(r.players[k].zone) === norm(zone) && !r.players[k].bot);
    if (dup) {
      const online = [...r.socks.values()].some(i => i.key === dup);
      if (online) { cb && cb({ ok: false, error: 'આ નામ + ઝોન વાળા Player હમણાં ઓનલાઇન છે. નામ બદલો.' }); return; }
      r.socks.set(socket.id, { role: 'player', key: dup }); socket.join(code); cb && cb({ ok: true, key: dup, token: r.players[dup].token, resumed: true }); bc(code); return;
    }
    if (r.maxPlayers && Object.keys(r.players).length >= r.maxPlayers) { cb && cb({ ok: false, error: 'Room ભરાઈ ગયો છે.' }); return; }
    if (r.status !== 'lobby' && r.status !== 'ready' && r.status !== 'phasebreak' && r.status !== 'locked' && r.status !== 'announce' && r.status !== 'question') { cb && cb({ ok: false, error: 'ગેમ પૂરી થઈ ગઈ છે.' }); return; }
    let key = name; if (r.players[key]) { let n = 2; while (r.players[name + ' (' + n + ')']) n++; key = name + ' (' + n + ')'; }
    const p = newPlayer(r, name, zone, avatar); r.players[key] = p;
    r.socks.set(socket.id, { role: 'player', key }); socket.join(code);
    cb && cb({ ok: true, key, token: p.token }); bc(code);
  });

  socket.on('player:mark', ({ code, ci }) => {
    const { r, p } = playerOf(socket, code); if (!p) return;
    ci = +ci; if (!(ci >= 0 && ci < CARD_N) || r.status !== 'question') return;
    const q = r.questions[r.curIdx], qi = r.curIdx; if (q.type === 'k') return;
    if (p.cardUse[qi] === 'skip') return;
    const prev = p.marks[qi];
    const usedElse = Object.keys(p.marks).some(k => +k !== qi && p.marks[k].ci === ci);
    if (usedElse) return;
    if (prev) { if (p.cardUse[qi] === 'reverse' && !prev.changed && prev.ci !== ci) { p.marks[qi] = { ci, ts: Date.now(), changed: true }; } else return; }
    else p.marks[qi] = { ci, ts: Date.now() };
    bc(code);
  });
  socket.on('player:kram', ({ code, order }) => {
    const { r, p } = playerOf(socket, code); if (!p) return;
    const q = r.questions[r.curIdx]; if (r.status !== 'question' || !q || q.type !== 'k' || p.kram[r.curIdx]) return;
    if (!Array.isArray(order) || order.length !== q.items.length || new Set(order).size !== order.length || !order.every(v => v >= 0 && v < q.items.length)) return;
    p.kram[r.curIdx] = { order: order.map(Number), ts: Date.now() }; bc(code);
  });
  socket.on('player:useCard', ({ code, card, target }, cb) => {
    const { r, p } = playerOf(socket, code); if (!p) return;
    const qi = r.curIdx;
    const fail = m => cb && cb({ ok: false, error: m });
    if (r.status !== 'question') return fail('હમણાં કાર્ડ વાપરી શકાય નહિ.');
    if (!UNO_CARDS.includes(card)) return fail('ખોટું કાર્ડ.');
    if (r.questions[qi].type === 'k') return fail('આ પ્રશ્નમાં કાર્ડ નહિ ચાલે.');
    if (p.hand[card] != null) return fail('આ કાર્ડ પહેલાં વપરાઈ ગયું.');
    if (p.cardUse[qi]) return fail('એક પ્રશ્નમાં એક જ કાર્ડ.');
    if (card === 'skip' && p.marks[qi]) return fail('જવાબ આપ્યા પહેલાં જ સ્કિપ વાપરો.');
    if (card === 'seva') {
      const t = r.players[target];
      if (!t || t === p || t.zone !== p.zone) return fail('તમારા ઝોનનો સાથી પસંદ કરો.');
      t.giftsIn = (t.giftsIn || 0) + 1;
    }
    p.hand[card] = qi; p.cardUse[qi] = card;
    cb && cb({ ok: true }); bc(code);
  });
  socket.on('player:uno', ({ code }, cb) => {
    const { r, p } = playerOf(socket, code); if (!p) return;
    if (!unoEligible(p) || p.unoUsed >= 3 || p.unoOpen > 0) { cb && cb({ ok: false }); return; }
    p.unoOpen = 1; p.unoUsed++; r.unoTs = Date.now(); r.unoN = (r.unoN || 0) + 1; cb && cb({ ok: true }); bc(code);
  });
  socket.on('player:claim', ({ code, k }, cb) => {
    const { r, p } = playerOf(socket, code); if (!p) return;
    if (!['question', 'locked', 'phasebreak', 'ended', 'ready'].includes(r.status)) return;
    if (p.claims.find(c => c.k === k && c.valid)) { cb && cb({ ok: false }); return; }
    tryClaim(r, p, k); cb && cb({ ok: true }); bc(code);   // result is hidden until the reveal
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('The Legacy server running on port ' + PORT));
