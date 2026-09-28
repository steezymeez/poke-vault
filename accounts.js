/* Poké Vault accounts (v1): sign in with an email link, then get your own Rare Candy,
   cards and wishlist. Data lives in Supabase; row-level security means each user can only
   ever touch their own rows. Prices stay owner-only for now. */
window.Accounts = (() => {
  const CFG = window.SB_CFG || {};
  let sb = null, cache = null;   // cache = { owned: Map(card_id -> qty), wish: Set, synced: Map(card_id -> "v|note") }
  const enabled = () => !!(CFG.url && CFG.key);

  async function client() {
    if (sb || !enabled()) return sb;
    if (!window.supabase) await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
    sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { flowType: "pkce", persistSession: true, detectSessionInUrl: true } });
    return sb;
  }

  // ---------- sign in / out ----------
  function open() {
    if (!enabled()) { toast("Accounts aren't switched on yet."); return; }
    $("#dlg").innerHTML = `<button class="x" aria-label="Close" id="xbtn">×</button><form class="form" id="sbf">
      <h3>Your own Poké Vault</h3>
      <p class="muted" style="margin:0;font-size:13.5px">Sign in to get your own Rare Candy, binder and wishlist. We'll email you a sign-in link (no password).</p>
      <label>Email<input id="sbmail" type="email" autocomplete="email" required placeholder="you@example.com"></label>
      <div class="err" id="sberr"></div>
      <button class="btn primary" type="submit" style="padding:11px">Email me a sign-in link</button></form>`;
    $("#dlg").showModal(); $("#xbtn").onclick = () => $("#dlg").close();
    $("#sbf").onsubmit = async e => {
      e.preventDefault(); const email = $("#sbmail").value.trim(), c = await client();
      const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) { $("#sberr").textContent = error.message; return; }
      $("#sbf").innerHTML = `<h3>Check your email</h3><p style="margin:0">We sent a sign-in link to <b>${esc(email)}</b>. Open it on this device and you'll land right back here, signed in.</p>`;
    };
  }
  async function signOut() {
    const c = await client(); if (c) await c.auth.signOut();
    USER = null; GUEST = false; D = null; cache = null; document.body.classList.remove("guest", "user"); lockScreen();
  }

  // ---------- load a signed-in user ----------
  async function resume() {
    if (!enabled()) return false;
    const c = await client(); const { data } = await c.auth.getSession();
    if (!data.session) return false;
    // drop the ?code= left by the sign-in link
    if (location.search.includes("code=")) history.replaceState(null, "", location.pathname + location.hash);
    await load(data.session.user); return true;
  }
  async function load(u) {
    const c = await client(); await candyStartData();
    const [p, s, o, w] = await Promise.all([
      c.from("profiles").select("display_name").eq("id", u.id).maybeSingle(),
      c.from("swipes").select("card_id,v,note,t"), c.from("owned").select("card_id,qty,added"), c.from("wishlist").select("card_id")]);
    USER = { id: u.id, email: u.email, name: p.data?.display_name || (u.email || "").split("@")[0] };
    GUEST = true;   // read-only for everything owner-only (prices, show mode, relay)
    document.body.classList.add("user");
    cache = { owned: new Map((o.data || []).map(r => [r.card_id, r.qty])), wish: new Set((w.data || []).map(r => r.card_id)), synced: new Map() };
    const sw = (s.data || []).map(r => ({ id: r.card_id, v: r.v, note: r.note || undefined, t: Date.parse(r.t) })).sort((a, b) => a.t - b.t);
    sw.forEach(x => cache.synced.set(x.id, x.v + "|" + (x.note || "")));
    store.set("pv.rc.u." + u.id, JSON.stringify({ sw, sent: sw.length }));
    D = buildData(); render();
  }
  // the user's cards shaped like Steven's items, so the existing views just work (no prices)
  function buildData() {
    const items = [...cache.owned].map(([id, qty]) => {
      const c = CP && CP.byId[id]; if (!c) return null; const o = c.o, num = String(o.id).split("-").pop();
      return { id: "c_" + id, card_id: id, cat: "loose", name: o.name, set: o.setName, number: num, rarity: o.kind, qty, img: rcImg(o), price: null };
    }).filter(Boolean);
    return { items, user: true, updated: new Date().toISOString(), history: [], alerts: [], listing_alerts: [], buylist: [], deals: [], targets: [], goals: [], pulse: [] };
  }

  // ---------- Rare Candy sync: push what changed since the last sync ----------
  let pending = null;
  function syncSwipes(s) {
    if (!USER) return; clearTimeout(pending);
    pending = setTimeout(async () => {
      const c = await client(), now = new Map(s.sw.map(x => [x.id, x])), up = [], del = [];
      for (const [id, x] of now) { const k = x.v + "|" + (x.note || ""); if (cache.synced.get(id) !== k) up.push({ user_id: USER.id, card_id: id, v: x.v, note: x.note || null, t: new Date(x.t || Date.now()).toISOString() }); }
      for (const id of cache.synced.keys()) if (!now.has(id)) del.push(id);
      if (up.length) { const { error } = await c.from("swipes").upsert(up); if (!error) up.forEach(r => cache.synced.set(r.card_id, r.v + "|" + (r.note || ""))); }
      if (del.length) { const { error } = await c.from("swipes").delete().in("card_id", del); if (!error) del.forEach(id => cache.synced.delete(id)); }
    }, 600);
  }

  // ---------- owned / wishlist ----------
  async function setOwned(id, qty) {
    const c = await client();
    if (qty > 0) { await c.from("owned").upsert({ user_id: USER.id, card_id: id, qty }); cache.owned.set(id, qty); }
    else { await c.from("owned").delete().eq("card_id", id); cache.owned.delete(id); }
    D = buildData(); render();
  }
  async function toggleWish(id) {
    const c = await client();
    if (cache.wish.has(id)) { await c.from("wishlist").delete().eq("card_id", id); cache.wish.delete(id); }
    else { await c.from("wishlist").upsert({ user_id: USER.id, card_id: id }); cache.wish.add(id); }
    render();
  }
  // search the card pool and add cards: shown at the top of Collection for signed-in users
  let q = "";
  function managerHTML() {
    if (!USER || !CP) return "";
    const hits = q.length >= 2 ? CP.list.filter(c => (c.o.name + " " + (c.o.setName || "")).toLowerCase().includes(q.toLowerCase())).slice(0, 24) : [];
    const wish = [...cache.wish].map(id => CP.byId[id]).filter(Boolean);
    const card = c => { const id = c.id, n = cache.owned.get(id) || 0;
      return `<div class="linecard ${n ? "own" : cache.wish.has(id) ? "like" : ""}"><img loading="lazy" src="${rcImg(c.o)}" alt="${esc(c.o.name)}"><span>${esc(c.o.name)}</span><small class="muted">${esc(c.o.setName || "")}</small>
        <span style="display:flex;gap:4px;flex-wrap:wrap"><button class="btn" data-own="${esc(id)}" data-n="${n + 1}">${n ? `Have ${n} · +1` : "I have it"}</button>${n ? `<button class="btn" data-own="${esc(id)}" data-n="${n - 1}">−</button>` : ""}<button class="btn" data-wish="${esc(id)}">${cache.wish.has(id) ? "♥ Wanted" : "♡ Want"}</button></span></div>`; };
    return `<div class="card fc" style="margin-bottom:12px"><div class="planhead"><b style="font-size:17px">Add cards</b><span class="muted">${cache.owned.size} owned · ${cache.wish.size} wanted</span></div>
      <input id="acq" type="search" placeholder="Search 5,000 cards: name or set (e.g. Pikachu, 151)" value="${esc(q)}" style="width:100%;margin:8px 0">
      ${hits.length ? `<div class="tpage">${hits.map(card).join("")}</div>` : q.length >= 2 ? `<p class="muted">No cards match.</p>` : ""}
      ${wish.length ? `<div class="eyebrow" style="margin-top:12px">Your wishlist</div><div class="tpage">${wish.map(card).join("")}</div>` : ""}</div>`;
  }
  function wireManager() {
    const i = $("#acq"); if (i) { i.oninput = () => { q = i.value; const pos = i.selectionStart; rerenderManager(); const j = $("#acq"); j.focus(); j.setSelectionRange(pos, pos); }; }
    document.querySelectorAll("[data-own]").forEach(b => b.onclick = () => setOwned(b.dataset.own, +b.dataset.n));
    document.querySelectorAll("[data-wish]").forEach(b => b.onclick = () => toggleWish(b.dataset.wish));
  }
  function rerenderManager() { const el = $("#acmgr"); if (el) { el.innerHTML = managerHTML(); wireManager(); } }

  return { enabled, open, resume, signOut, syncSwipes, managerHTML, wireManager };
})();
