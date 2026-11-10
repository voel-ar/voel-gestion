/* VOËL Gestión · platform.js
   Reemplaza el almacenamiento del artifact de Claude (claude.use("db" | "user" | "downloads"))
   por Supabase, sin cambiar nombres de colecciones ni la forma de los documentos.
   Tabla public.docs: col text, id text, data jsonb, updated_at timestamptz, updated_by uuid (clave col+id).
   Tabla public.miembros: user_id uuid, nombre text, rol 'dueño'|'equipo', ids_anteriores text[].
   La clave de abajo es la clave PÚBLICA (anon) de Supabase: es segura en el navegador; los permisos los aplica la base. */
(function(){
"use strict";
const SUPABASE_URL = "https://davfkrkhpparubvnslhc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhdmZrcmtocHBhcnVidm5zbGhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQzMzMyODAsImV4cCI6MjEwOTkwOTI4MH0.jqEeh4UJxHz_i1xwehMep9hXvsjV2UUYXkzm8sdbt3Y";
const APP_VERSION = "2026.11.10-3";
const REFRESH_MS = 30000;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "voel-gestion-auth" },
  realtime: { params: { eventsPerSecond: 10 } }
});

/* ---------- caché local y suscriptores ---------- */
const cache = new Map();            // col -> Map(id -> data)
const colSubs = new Map();          // col -> Set(fn)
const docSubs = new Map();          // "col/id" -> Set(fn)
const loadedCols = new Set();
let session = null, member = null, members = [];
const colMap = c => { if (!cache.has(c)) cache.set(c, new Map()); return cache.get(c); };
const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
const snapDoc = (id, data) => ({ id, exists: data !== undefined, data: () => clone(data), metadata: { hasPendingWrites: false, fromCache: false } });
function notifyCol(c){
  const subs = colSubs.get(c); if (!subs) return;
  const docs = [...colMap(c).entries()].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([id,d]) => snapDoc(id, d));
  const snap = { docs, size: docs.length, empty: !docs.length, docChanges: () => [] };
  subs.forEach(fn => { try { fn(snap); } catch(e){ console.error(e); } });
}
function notifyDoc(c, id){
  const subs = docSubs.get(c + "/" + id); if (!subs) return;
  const s = snapDoc(id, colMap(c).get(id));
  subs.forEach(fn => { try { fn(s); } catch(e){ console.error(e); } });
}
const pendingNotify = new Set(); let notifyT = 0;
function queue(c, id){ pendingNotify.add(c + "\u0000" + (id ?? "")); if (!notifyT) notifyT = setTimeout(flush, 0); }
function flush(){ notifyT = 0; const cols = new Set();
  pendingNotify.forEach(k => { const [c, id] = k.split("\u0000"); cols.add(c); if (id) notifyDoc(c, id); });
  pendingNotify.clear(); cols.forEach(notifyCol); }
function applyRow(row){ if (!row || !row.col) return false;
  const m = colMap(row.col), old = m.get(row.id), nd = row.data || {};
  if (old !== undefined && JSON.stringify(old) === JSON.stringify(nd)) return false;
  m.set(row.id, nd); queue(row.col, row.id); return true; }
const tomb = new Map();              // "col/id" -> hora de borrado local (evita que un aviso viejo lo reviva)
function removeRow(c, id){ const m = colMap(c); if (!m.has(id)) return false; m.delete(id); queue(c, id); return true; }

/* ---------- carga completa (al entrar, al volver, al recuperar internet y cada 30 s) ---------- */
let refreshing = null;
async function refreshAll(){
  if (!session) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const rows = []; let from = 0; const page = 1000;
    for (;;) {
      const { data, error } = await sb.from("docs").select("col,id,data").range(from, from + page - 1);
      if (error) { console.error(error); setStatus("off"); return; }
      rows.push(...data); if (data.length < page) break; from += page;
    }
    const seen = new Map();
    rows.forEach(r => { if (!seen.has(r.col)) seen.set(r.col, new Set()); seen.get(r.col).add(r.id); applyRow(r); });
    cache.forEach((m, c) => { const keep = seen.get(c) || new Set(); [...m.keys()].forEach(id => { if (!keep.has(id)) removeRow(c, id); }); });
    loadedCols.add("*"); setStatus("on");
    flush(); colSubs.forEach((_, c) => notifyCol(c));
  })().finally(() => { refreshing = null; });
  return refreshing;
}
let channel = null;
function startRealtime(){
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("docs-voel")
    .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
      if (p.eventType === "DELETE") { const o = p.old || {}; if (o.col) removeRow(o.col, o.id); else refreshAll(); }
      else { const n = p.new || {}, t = tomb.get(n.col + "/" + n.id); if (t && Date.now() - t < 15000) return; applyRow(n); }
    })
    .subscribe(st => { if (st === "SUBSCRIBED") refreshAll(); });
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshAll(); });
window.addEventListener("online", () => { refreshAll(); startRealtime(); });
window.addEventListener("offline", () => setStatus("off"));
setInterval(() => { if (document.visibilityState === "visible") refreshAll(); }, REFRESH_MS);

/* ---------- escrituras ---------- */
function dbError(error){ const e = new Error(error && error.message || "Error de base de datos");
  e.code = (error && (error.code === "42501" || /row-level security|permission/i.test(error.message || ""))) ? "invalid_argument" : "unavailable"; return e; }
async function writeDoc(c, id, data){
  tomb.delete(c + "/" + id);
  const prev = colMap(c).get(id);
  applyRow({ col: c, id, data }); flush();
  const { error } = await sb.from("docs").upsert({ col: c, id, data, updated_by: session && session.user.id }, { onConflict: "col,id" });
  if (error) { if (prev === undefined) removeRow(c, id); else applyRow({ col: c, id, data: prev }); flush(); throw dbError(error); }
}
async function deleteDoc(c, id){
  const prev = colMap(c).get(id);
  tomb.set(c + "/" + id, Date.now());
  removeRow(c, id); flush();
  const { error } = await sb.from("docs").delete().eq("col", c).eq("id", id);
  if (error) { if (prev !== undefined) applyRow({ col: c, id, data: prev }); flush(); throw dbError(error); }
}
const rid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : Math.random().toString(36).slice(2) + Date.now().toString(36));

/* ---------- API compatible con el artifact ---------- */
function docRef(c, id){
  return {
    id, path: c + "/" + id,
    async get(){ if (!loadedCols.has("*")) await refreshAll(); return snapDoc(id, colMap(c).get(id)); },
    async set(data){ await writeDoc(c, id, clone(data)); },
    async update(patch){ const cur = colMap(c).get(id); if (cur === undefined) { const e = new Error("No existe el documento"); e.code = "invalid_argument"; throw e; }
      await writeDoc(c, id, Object.assign({}, clone(cur), clone(patch))); },
    async delete(){ await deleteDoc(c, id); },
    collection(sub){ return colRef(c + "/" + id + "/" + sub); },
    onSnapshot(next, err){ const k = c + "/" + id; if (!docSubs.has(k)) docSubs.set(k, new Set()); docSubs.get(k).add(next);
      if (loadedCols.has("*")) setTimeout(() => next(snapDoc(id, colMap(c).get(id))), 0);
      return () => docSubs.get(k).delete(next); }
  };
}
function colRef(c){
  const q = {
    path: c,
    doc(id){ return docRef(c, id || rid()); },
    limit(){ return q; }, where(){ return q; }, orderBy(){ return q; },
    async add(data){ const r = docRef(c, rid()); await r.set(data); return r; },
    async get(){ if (!loadedCols.has("*")) await refreshAll(); const docs = [...colMap(c).entries()].map(([id,d]) => snapDoc(id, d)); return { docs, size: docs.length, empty: !docs.length }; },
    onSnapshot(next, err){ if (!colSubs.has(c)) colSubs.set(c, new Set()); colSubs.get(c).add(next);
      if (loadedCols.has("*")) setTimeout(() => notifyCol(c), 0);
      return () => colSubs.get(c).delete(next); }
  };
  return q;
}
const db = {
  doc(p){ const i = p.lastIndexOf("/"); return docRef(p.slice(0, i), p.slice(i + 1)); },
  collection(p){ return colRef(p); }
};
function nameFor(id){
  if (!id) return "";
  const m = members.find(x => x.user_id === id || (x.ids_anteriores || []).includes(id));
  return m ? (m.nombre || "") : "";
}
const isDueno = () => !!member && member.rol === "dueño";
const user = {
  async isOwner(){ return isDueno(); },
  async canEdit(){ return isDueno(); },
  async can(){ return member ? true : false; },
  async id(){ return session ? session.user.id : null; },
  async name(){ return member ? member.nombre || "" : ""; },
  async me(){ return { id: session ? session.user.id : null, name: member ? member.nombre || "" : "", avatarUrl: "", color: "#2F3A34", email: session ? session.user.email : null, isOwner: isDueno(), canEdit: isDueno() }; },
  async profiles(ids){ const out = {}; [].concat(ids || []).forEach(id => { out[id] = { id, name: nameFor(id), avatarUrl: "", color: "#2F3A34", email: null, isMe: !!session && id === session.user.id, guest: false }; }); return out; },
  async search(){ return []; }
};
const downloads = {
  async save({ filename, data }){
    const blob = data instanceof Blob ? data : new Blob([data], { type: /\.pdf$/i.test(filename) ? "application/pdf" : /\.xlsx$/i.test(filename) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { status: "saved" };
  }
};

/* ---------- arranque: sesión y membresía ---------- */
let readyResolve; const ready = new Promise(r => readyResolve = r);
window.claude = { use: async (name) => { await ready; return name === "db" ? db : name === "user" ? user : name === "downloads" ? downloads : null; } };
window.VOEL_PLATFORM = {
  version: APP_VERSION,
  async logout(){ await sb.auth.signOut(); location.reload(); },
  refresh: refreshAll
};
function setStatus(s){ document.documentElement.dataset.conn = s; }

const L = { root: null };
function loginUI(msg, mode){
  if (!L.root) { L.root = document.createElement("div"); L.root.id = "login"; document.body.appendChild(L.root); }
  const recovery = mode === "recovery";
  L.root.innerHTML = `<form class="lg-card" autocomplete="on">
    <div class="lg-brand"><b>VOËL</b><span>Gestión mayorista</span></div>
    ${recovery ? `<p class="lg-p">Elegí tu nueva contraseña.</p>
      <label for="lg-pass">Nueva contraseña</label><input id="lg-pass" name="password" type="password" autocomplete="new-password" minlength="8" required>`
    : `<label for="lg-email">Email</label><input id="lg-email" name="email" type="email" autocomplete="username" inputmode="email" required>
      <label for="lg-pass">Contraseña</label><input id="lg-pass" name="password" type="password" autocomplete="current-password" required>`}
    <div class="lg-msg" role="alert">${msg || ""}</div>
    <button type="submit" class="lg-btn">${recovery ? "Guardar contraseña" : "Entrar"}</button>
    ${recovery ? "" : `<button type="button" class="lg-link" id="lg-forgot">Olvidé mi contraseña</button>`}
    <p class="lg-foot">Acceso solo para el equipo de VOËL · v${APP_VERSION}</p></form>`;
  L.root.hidden = false;
  const f = L.root.querySelector("form"), out = L.root.querySelector(".lg-msg");
  f.addEventListener("submit", async e => {
    e.preventDefault(); out.textContent = "Un momento…";
    if (recovery) { const { error } = await sb.auth.updateUser({ password: f.password.value }); out.textContent = error ? "No se pudo guardar: " + error.message : "Listo. Ya podés usar la app."; if (!error) setTimeout(() => location.replace(location.pathname), 900); return; }
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) out.textContent = /invalid/i.test(error.message) ? "Email o contraseña incorrectos." : "No se pudo entrar: " + error.message;
  });
  const fg = L.root.querySelector("#lg-forgot");
  if (fg) fg.addEventListener("click", async () => {
    const email = f.email.value.trim(); if (!email) { out.textContent = "Escribí tu email y tocá de nuevo «Olvidé mi contraseña»."; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    out.textContent = error ? "No se pudo enviar: " + error.message : "Si el email está autorizado, te llega un link para cambiar la contraseña.";
  });
  const first = L.root.querySelector("input"); if (first) setTimeout(() => first.focus(), 50);
}
async function afterLogin(s){
  session = s;
  const { data, error } = await sb.from("miembros").select("user_id,nombre,rol,ids_anteriores");
  if (error) { loginUI("No se pudo verificar tu acceso. Revisá tu conexión y probá de nuevo."); return; }
  members = data || [];
  member = members.find(m => m.user_id === s.user.id) || null;
  if (!member) { await sb.auth.signOut(); loginUI("Tu usuario no está autorizado en VOËL. Pedile acceso a Kevin."); return; }
  if (L.root) L.root.hidden = true;
  await refreshAll(); startRealtime(); readyResolve();
}
sb.auth.onAuthStateChange((ev, s) => {
  if (ev === "PASSWORD_RECOVERY") { session = s; loginUI("", "recovery"); return; }
  if (ev === "SIGNED_IN" && s && !session) afterLogin(s);
  if (ev === "SIGNED_OUT") { session = null; }
  if (ev === "TOKEN_REFRESHED" && s) session = s;
});
(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session && !/type=recovery/.test(location.hash)) afterLogin(data.session); else if (!/type=recovery/.test(location.hash)) loginUI("");
})();

/* ---------- service worker (instalable y actualizable) ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then(reg => {
      reg.addEventListener("updatefound", () => { const w = reg.installing; if (!w) return;
        w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(); }); });
      setInterval(() => reg.update(), 60 * 60 * 1000);
    }).catch(console.error);
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (reloaded) return; reloaded = true; location.reload(); });
  });
}
function showUpdate(){
  const b = document.createElement("button"); b.className = "upd-bar"; b.textContent = "Hay una versión nueva de la app · Tocá para actualizar";
  b.onclick = () => navigator.serviceWorker.getRegistration().then(r => { if (r && r.waiting) r.waiting.postMessage("skipWaiting"); else location.reload(); });
  document.body.appendChild(b);
}
})();
