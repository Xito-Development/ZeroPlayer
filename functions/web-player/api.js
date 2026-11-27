/*
 * ZeroPlayer · mando por internet (https://zeroplayer.pages.dev/web-player/api)
 *
 * El móvil (la app) se conecta aquí y espera órdenes; el navegador (por ejemplo, el del Tesla) entra con el código
 * de 6 cifras que enseña el móvil. Solo se pasan mensajes de uno a otro: no se guarda música ni cuentas.
 * Base de datos: Cloudflare D1 "zeroplayer-relay" (binding DB, ver wrangler.toml).
 */

const PHONE_WAIT_IDLE = 25;   // s que el móvil espera órdenes si nadie mira
const PHONE_WAIT_VIEWER = 1;  // … si hay alguien mirando (el estado se refresca cada segundo)
const CALL_TIMEOUT = 15;      // s que el navegador espera la respuesta del móvil
const ONLINE = 35;            // s sin noticias del móvil para darlo por desconectado (espera como mucho 25 s)
const MAX_BODY = 262144;
const MAX_RESPONSE = 3145728;
const COOKIE = 'zp_t';

const now = () => Math.floor(Date.now() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const isHex = (s, len) => typeof s === 'string' && s.length === len && /^[0-9a-f]+$/i.test(s);
async function sha256(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }

class Fail extends Error { constructor(status, why) { super(why); this.status = status; } }
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', ...headers },
});

async function readBody(req, max = MAX_BODY) {
  const t = await req.text();
  if (t.length > max) throw new Fail(413, 'too_big');
  try { const j = JSON.parse(t || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

async function salt(db) {
  let r = await db.prepare('SELECT v FROM meta WHERE k = ?').bind('salt').first();
  if (r) return r.v;
  await db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('salt', hex(32)).run();
  return (await db.prepare('SELECT v FROM meta WHERE k = ?').bind('salt').first()).v;
}
const codeHash = async (db, code) => (await sha256((await salt(db)) + ':' + code)).slice(0, 40);

/** Límite de intentos por dirección. */
async function limit(db, req, what, max, windowS) {
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const k = what + ':' + (await sha256(ip + 'zp')).slice(0, 24) + ':' + Math.floor(now() / windowS);
  const r = await db.prepare('INSERT INTO rate (k, n, t) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n').bind(k, now()).first();
  if (r && r.n > max) throw new Fail(429, 'slow_down');
}

async function cleanup(db) {
  if (Math.random() > 0.02) return;
  const t = now();
  await db.batch([
    db.prepare('DELETE FROM reqs WHERE t < ?').bind(t - 120),
    db.prepare('DELETE FROM res WHERE t < ?').bind(t - 120),
    db.prepare('DELETE FROM art WHERE t < ?').bind(t - 86400),
    db.prepare('DELETE FROM rate WHERE t < ?').bind(t - 7200),
    db.prepare('DELETE FROM captcha WHERE t < ?').bind(t - 600),
    db.prepare('DELETE FROM tokens WHERE COALESCE(NULLIF(used, 0), created) < ?').bind(t - 90 * 86400),
    db.prepare('DELETE FROM tokens WHERE sid IN (SELECT sid FROM sessions WHERE seen < ?)').bind(t - 60 * 86400),
    db.prepare('DELETE FROM sessions WHERE seen < ?').bind(t - 60 * 86400),
  ]);
}

/** El móvil se identifica con su secreto; la sesión es su huella (el secreto no se guarda). */
async function phone(db, b, extra = '') {
  if (!isHex(b.secret, 64)) throw new Fail(400, 'secret');
  const sid = (await sha256(b.secret)).slice(0, 32);
  const s = await db.prepare('SELECT * FROM sessions WHERE sid = ?').bind(sid).first();
  if (!s) throw new Fail(404, 'register');
  return { sid, s };
}

/** Nombre corto del navegador y del sistema, para que el móvil sepa quién se ha conectado. */
function describeUa(ua) {
  const b = /Tesla/i.test(ua) ? 'Tesla' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const o = /Tesla|QtCarBrowser/i.test(ua) ? 'coche' : /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return (b + (o ? ' · ' + o : '')).slice(0, 60);
}

function cookieToken(req) {
  const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)zp_t=([0-9a-f]{32})/);
  return m ? m[1] : '';
}

async function viewer(db, req, token) {
  const t = isHex(token, 32) ? token : cookieToken(req);
  if (!isHex(t, 32)) throw new Fail(401, 'pair');
  const r = await db.prepare('SELECT s.*, k.used AS tused FROM tokens k JOIN sessions s ON s.sid = k.sid WHERE k.token = ?').bind(t).first();
  if (!r) throw new Fail(401, 'pair');
  // Marca que hay alguien mirando (como mucho una vez cada 5 s, para escribir poco) y cuándo se usó este navegador.
  const w = [];
  if (now() - (r.viewer || 0) > 5) w.push(db.prepare('UPDATE sessions SET viewer = ? WHERE sid = ?').bind(now(), r.sid));
  if (now() - (r.tused || 0) > 3600) w.push(db.prepare('UPDATE tokens SET used = ? WHERE token = ?').bind(now(), t));
  if (w.length) await db.batch(w);
  return r;
}

const online = s => now() - (s.seen || 0) < ONLINE;

/** Pasa una petición del navegador al móvil y espera su respuesta. */
async function tunnel(db, s, path, body) {
  if (!online(s)) throw new Fail(503, 'offline');
  const id = hex(8);
  await db.prepare('INSERT INTO reqs (id, sid, path, body, t) VALUES (?, ?, ?, ?, ?)').bind(id, s.sid, path, body == null ? null : JSON.stringify(body), now()).run();
  const end = Date.now() + CALL_TIMEOUT * 1000;
  let wait = 60;
  while (Date.now() < end) {
    await sleep(wait); wait = Math.min(250, wait + 40);
    const r = await db.prepare('SELECT * FROM res WHERE id = ?').bind(id).first();
    if (r) { await db.prepare('DELETE FROM res WHERE id = ?').bind(id).run(); return r; }
  }
  await db.prepare('DELETE FROM reqs WHERE id = ?').bind(id).run();
  throw new Fail(504, 'timeout');
}

function b64ToBytes(b64) { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

// ------------------------------------------------------------ Captcha propio (cifras deformadas en SVG, de un solo uso)
const GLYPHS = {
  0: [[[.2, 0], [.8, 0], [1, .2], [1, .8], [.8, 1], [.2, 1], [0, .8], [0, .2], [.2, 0]]],
  1: [[[.25, .2], [.6, 0], [.6, 1]], [[.25, 1], [.95, 1]]],
  2: [[[0, .2], [.2, 0], [.8, 0], [1, .2], [1, .4], [0, 1], [1, 1]]],
  3: [[[0, 0], [1, 0], [.45, .42], [.8, .48], [1, .7], [.8, 1], [.2, 1], [0, .85]]],
  4: [[[.7, 1], [.7, 0], [0, .7], [1, .7]]],
  5: [[[1, 0], [.1, 0], [0, .45], [.7, .4], [1, .6], [1, .8], [.8, 1], [0, 1]]],
  6: [[[.9, 0], [.3, .1], [0, .5], [0, .85], [.2, 1], [.8, 1], [1, .8], [1, .62], [.8, .45], [.2, .45], [0, .6]]],
  7: [[[0, 0], [1, 0], [.4, 1]], [[.3, .5], [.85, .5]]],
  8: [[[.5, .45], [.15, .35], [.15, .1], [.35, 0], [.65, 0], [.85, .1], [.85, .35], [.5, .45], [.1, .6], [0, .85], [.25, 1], [.75, 1], [1, .85], [.9, .6], [.5, .45]]],
  9: [[[1, .5], [.8, .58], [.2, .58], [0, .4], [0, .15], [.2, 0], [.8, 0], [1, .15], [1, .5], [.8, .9], [.3, 1]]],
};
function captchaSvg(text) {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const W = 220, H = 80;
  let g = '';
  for (let i = 0; i < 7; i++) g += `<path d="M${rnd(0, W)} ${rnd(0, H)} Q ${rnd(0, W)} ${rnd(0, H)} ${rnd(0, W)} ${rnd(0, H)}" stroke="hsl(${rnd(0, 360) | 0},70%,65%)" stroke-width="${rnd(1, 2.5).toFixed(1)}" fill="none" opacity=".7"/>`;
  for (let i = 0; i < 40; i++) g += `<circle cx="${rnd(0, W).toFixed(0)}" cy="${rnd(0, H).toFixed(0)}" r="${rnd(.5, 2).toFixed(1)}" fill="#fff" opacity="${rnd(.2, .6).toFixed(2)}"/>`;
  // Cifras dibujadas a trazos (no como texto, para que un programa no las lea directamente del SVG).
  [...text].forEach((ch, i) => {
    const w = rnd(22, 30), h = rnd(36, 44), x0 = 24 + i * 46 + rnd(-5, 5), y0 = 20 + rnd(-6, 6);
    const cx = x0 + w / 2, cy = y0 + h / 2, r = rnd(-22, 22);
    const d = GLYPHS[ch].map(st => 'M' + st.map(([u, v]) => `${(x0 + u * w + rnd(-2, 2)).toFixed(1)} ${(y0 + v * h + rnd(-2, 2)).toFixed(1)}`).join(' L')).join(' ');
    g += `<path d="${d}" transform="rotate(${r.toFixed(0)} ${cx.toFixed(0)} ${cy.toFixed(0)})" stroke="hsl(${rnd(120, 200) | 0},80%,${rnd(65, 85) | 0}%)" stroke-width="${rnd(3.5, 5).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  });
  for (let i = 0; i < 3; i++) g += `<line x1="0" y1="${rnd(10, H - 10)}" x2="${W}" y2="${rnd(10, H - 10)}" stroke="#fff" stroke-width="1.5" opacity=".45"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="100%" height="100%" rx="14" fill="#16161a"/>${g}</svg>`;
}
async function checkCaptcha(db, id, answer) {
  if (!isHex(String(id || ''), 16)) return false;
  const r = await db.prepare('DELETE FROM captcha WHERE id = ? RETURNING h, t').bind(id).first();
  if (!r || now() - r.t > 600) return false;
  return r.h === await sha256((await salt(db)) + ':cap:' + String(answer || '').replace(/\D/g, ''));
}

/** Solo desde nuestra propia página (o la app): otra web no puede usar la cookie para dar órdenes. */
function sameOrigin(req, url) {
  const o = req.headers.get('Origin');
  if (o && o !== url.origin) throw new Fail(403, 'origin');
}

const actions = {
  // ------------------------------------------------------------ Móvil
  async register(db, req) {
    const b = await readBody(req);
    if (!isHex(b.secret, 64)) throw new Fail(400, 'secret');
    const sid = (await sha256(b.secret)).slice(0, 32);
    const name = String(b.name || '').slice(0, 60);
    let s = await db.prepare('SELECT sid FROM sessions WHERE sid = ?').bind(sid).first();
    if (s) {
      await db.prepare('UPDATE sessions SET seen = ?, name = ? WHERE sid = ?').bind(now(), name, sid).run();
      // El código no se guarda tal cual: si el móvil no lo recuerda, se le da uno nuevo.
      if (/^\d{6}$/.test(String(b.code || '')) && (await db.prepare('SELECT 1 FROM sessions WHERE sid = ? AND code_h = ?').bind(sid, await codeHash(db, b.code)).first())) return json({ code: b.code });
    } else {
      await limit(db, req, 'register', 20, 3600);
    }
    for (let i = 0; i < 20; i++) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const h = await codeHash(db, code);
      if (await db.prepare('SELECT 1 FROM sessions WHERE code_h = ?').bind(h).first()) continue;
      if (s) await db.prepare('UPDATE sessions SET code_h = ? WHERE sid = ?').bind(h, sid).run();
      else await db.prepare('INSERT INTO sessions (sid, code_h, name, created, seen) VALUES (?, ?, ?, ?, ?)').bind(sid, h, name, now(), now()).run();
      return json({ code });
    }
    throw new Fail(503, 'busy');
  },

  async unregister(db, req) {
    const { sid } = await phone(db, await readBody(req));
    await db.batch([db.prepare('DELETE FROM tokens WHERE sid = ?').bind(sid), db.prepare('DELETE FROM reqs WHERE sid = ?').bind(sid), db.prepare('DELETE FROM sessions WHERE sid = ?').bind(sid)]);
    return json({ ok: true });
  },

  /** El móvil manda su estado y espera órdenes. */
  async pull(db, req) {
    const b = await readBody(req);
    const { sid, s } = await phone(db, b);
    const state = b.state && typeof b.state === 'object' ? JSON.stringify(b.state) : null;
    await db.prepare('UPDATE sessions SET seen = ?, wake = 0' + (state ? ', state = ?, state_at = ?' : '') + ' WHERE sid = ?')
      .bind(...(state ? [now(), state, now(), sid] : [now(), sid])).run();
    const watching = now() - (s.viewer || 0) < 20;
    const end = Date.now() + (watching ? PHONE_WAIT_VIEWER : PHONE_WAIT_IDLE) * 1000;
    let reqs = [];
    for (;;) {
      const r = await db.prepare('SELECT id, path, body, t FROM reqs WHERE sid = ?').bind(sid).all();
      if (r.results.length) {
        await db.batch(r.results.map(x => db.prepare('DELETE FROM reqs WHERE id = ?').bind(x.id)));
        reqs = r.results.filter(x => now() - x.t < CALL_TIMEOUT).map(x => ({ id: x.id, path: x.path, body: x.body == null ? null : JSON.parse(x.body) }));
        if (reqs.length) break;
      }
      if (Date.now() >= end) break;
      await sleep(watching ? 150 : 500);
      // Si aparece alguien mirando mientras se espera, se contesta antes para refrescar el estado.
      if (!watching) { const v = await db.prepare('SELECT viewer FROM sessions WHERE sid = ?').bind(sid).first(); if (v && now() - v.viewer < 3) break; }
    }
    const last = await db.prepare('SELECT MAX(created) AS c, COUNT(*) AS n FROM tokens WHERE sid = ?').bind(sid).first();
    return json({ reqs, viewer: watching, devices: last?.n || 0, lastPair: last?.c || 0 });
  },

  /** Respuestas del móvil a las peticiones del navegador. */
  async push(db, req) {
    const b = await readBody(req, MAX_RESPONSE);
    await phone(db, b);
    const rs = Array.isArray(b.responses) ? b.responses : [];
    const st = rs.filter(r => isHex(r.id, 16)).map(r => db.prepare('INSERT OR REPLACE INTO res (id, status, type, body, b64, t) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(r.id, Number(r.status) || 200, String(r.type || ''), r.body == null ? null : String(r.body), r.b64 == null ? null : String(r.b64), now()));
    if (st.length) await db.batch(st);
    return json({ ok: true });
  },

  /** Navegadores emparejados con este móvil (para verlos y quitarlos desde Ajustes). */
  async devices(db, req) {
    const { sid } = await phone(db, await readBody(req));
    const r = await db.prepare('SELECT substr(token, 1, 8) AS id, ua, created, used FROM tokens WHERE sid = ? ORDER BY created DESC').bind(sid).all();
    return json({ items: r.results });
  },

  async revoke(db, req) {
    const b = await readBody(req);
    const { sid } = await phone(db, b);
    const id = String(b.id || '');
    if (id === 'all') await db.prepare('DELETE FROM tokens WHERE sid = ?').bind(sid).run();
    else if (isHex(id, 8)) await db.prepare('DELETE FROM tokens WHERE sid = ? AND substr(token, 1, 8) = ?').bind(sid, id).run();
    return json({ ok: true });
  },

  /** El móvil (con la app cerrada) pregunta de vez en cuando si alguien ha pedido encenderlo desde la web. */
  async wakecheck(db, req) {
    const { s } = await phone(db, await readBody(req));
    return json({ wake: now() - (s.wake || 0) < 30 * 60 });
  },

  // ------------------------------------------------------------ Navegador
  /** Captcha nuevo para la pantalla de emparejar. */
  async captcha(db, req) {
    await limit(db, req, 'captcha', 40, 600);
    const text = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
    const id = hex(8);
    await db.prepare('INSERT INTO captcha (id, h, t) VALUES (?, ?, ?)').bind(id, await sha256((await salt(db)) + ':cap:' + text), now()).run();
    return json({ id, svg: captchaSvg(text) });
  },

  async pair(db, req) {
    await limit(db, req, 'pair', 12, 600);
    // Freno general: si alguien prueba códigos a lo loco desde muchas direcciones, se cierra un rato para todos.
    const g = await db.prepare("INSERT INTO rate (k, n, t) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n").bind('pairall:' + Math.floor(now() / 3600), now()).first();
    if (g && g.n > 400) throw new Fail(429, 'slow_down');
    const b = await readBody(req);
    if (!(await checkCaptcha(db, b.cid, b.cans))) throw new Fail(403, 'captcha');
    const code = String(b.code || '').replace(/\D/g, '');
    if (code.length !== 6) throw new Fail(400, 'code');
    const s = await db.prepare('SELECT sid, name FROM sessions WHERE code_h = ?').bind(await codeHash(db, code)).first();
    if (!s) throw new Fail(404, 'code');
    const token = hex(16);
    const ua = describeUa(req.headers.get('User-Agent') || '');
    await db.prepare('INSERT INTO tokens (token, sid, created, used, ua) VALUES (?, ?, ?, ?, ?)').bind(token, s.sid, now(), now(), ua).run();
    // Cookie de un año: el navegador se queda emparejado con este móvil.
    return json({ token, device: s.name || 'ZeroPlayer' }, 200, { 'Set-Cookie': `${COOKIE}=${token}; Path=/web-player; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax` });
  },

  async forget(db, req) {
    const b = await readBody(req);
    const t = isHex(b.t, 32) ? b.t : cookieToken(req);
    if (t) await db.prepare('DELETE FROM tokens WHERE token = ?').bind(t).run();
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/web-player; Max-Age=0; Secure; HttpOnly; SameSite=Lax` });
  },

  /** Pedir que el móvil encienda el mando (lo mira cada pocos minutos aunque la app esté cerrada). */
  async wake(db, req) {
    const b = await readBody(req);
    const s = await viewer(db, req, b.t);
    await db.prepare('UPDATE sessions SET wake = ? WHERE sid = ?').bind(now(), s.sid).run();
    return json({ ok: true });
  },

  async call(db, req) {
    const b = await readBody(req);
    const s = await viewer(db, req, b.t);
    const path = String(b.path || '');
    if (!path.startsWith('/api/') || path.length > 2000) throw new Fail(400, 'path');
    if (path === '/api/check') return json({ ok: true, online: online(s), seen: s.seen, device: s.name || 'ZeroPlayer', token: isHex(b.t, 32) ? undefined : cookieToken(req), waking: now() - (s.wake || 0) < 30 * 60 });
    // El estado sale de aquí (el móvil lo manda cada segundo mientras alguien mira).
    if (path === '/api/state') {
      if (!online(s)) return json({ error: 'offline', seen: s.seen, device: s.name || 'ZeroPlayer', waking: now() - (s.wake || 0) < 30 * 60 }, 503);
      // Mientras el móvil se entera de que hay alguien mirando (hasta 3 s), vale el último estado.
      if (s.state && now() - s.state_at < 30) { const x = JSON.parse(s.state); x.age = now() - s.state_at; return json(x); }
    }
    const r = await tunnel(db, s, path, b.body ?? null);
    const headers = { 'Content-Type': r.type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    return new Response(r.b64 != null ? b64ToBytes(r.b64) : (r.body ?? ''), { status: r.status || 200, headers });
  },

  /** Carátulas de las canciones del móvil (se guardan un día). */
  async art(db, req, url) {
    const s = await viewer(db, req, url.searchParams.get('t') || '');
    const p = url.searchParams.get('p') || '';
    if (!p.startsWith('/api/art') || p.length > 300) throw new Fail(400, 'path');
    const k = s.sid + ':' + (await sha256(p)).slice(0, 24);
    let row = await db.prepare('SELECT b64 FROM art WHERE k = ? AND t > ?').bind(k, now() - 86400).first();
    if (!row) {
      const r = await tunnel(db, s, p, null);
      if (r.status !== 200 || !r.b64) return new Response(null, { status: 404 });
      if (r.b64.length < 1500000) await db.prepare('INSERT OR REPLACE INTO art (k, b64, t) VALUES (?, ?, ?)').bind(k, r.b64, now()).run();
      row = { b64: r.b64 };
    }
    return new Response(b64ToBytes(row.b64), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
  },
};

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const a = url.searchParams.get('a') || '';
  const fn = Object.prototype.hasOwnProperty.call(actions, a) ? actions[a] : null;
  if (!fn) return json({ error: 'unknown' }, 404);
  if (!env.DB) return json({ error: 'no_db' }, 500);
  if (a !== 'art' && request.method !== 'POST') return json({ error: 'method' }, 405);
  try {
    if (['pair', 'forget', 'wake', 'call', 'art', 'captcha'].includes(a)) sameOrigin(request, url);
    const res = await fn(env.DB, request, url);
    try { await cleanup(env.DB); } catch {}
    return res;
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, e.status);
    return json({ error: 'server' }, 500);
  }
}
