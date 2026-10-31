(() => {
  const CFG = window.FUEL_CONFIG, P = window.FuelParse;
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  /* ---------- locations ---------- */
  function fillLocations() {
    const all = [...new Set([...store.get('locs', []), ...CFG.knownLocations])];
    $('locs').innerHTML = all.map((l) => `<option value="${l.replace(/"/g, '&quot;')}">`).join('');
    return all;
  }
  let known = fillLocations();

  /* ---------- OCR engine ---------- */
  const base = new URL('vendor/', location.href).href;
  let workerP = null, onProgress = () => {};
  function getWorker() {
    if (!workerP) {
      workerP = Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: true,
        logger: (m) => { if (m.status === 'recognizing text') onProgress(m.progress); },
      }).catch((e) => { workerP = null; throw e; });
    }
    return workerP;
  }
  async function bitmapOf(file) { return createImageBitmap(file, { imageOrientation: 'from-image' }); }
  function canvasOf(bmp, sx, sy, sw, sh, outW, contrast) {
    const scale = outW / sw, c = document.createElement('canvas');
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const img = x.getImageData(0, 0, c.width, c.height), d = img.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g; if (g < lo) lo = g; if (g > hi) hi = g;
    }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      let v = ((d[i] - lo) * 255) / span;
      if (contrast) v = Math.max(0, Math.min(255, contrast * v - 60));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    x.putImageData(img, 0, 0);
    return c;
  }

  async function readReceipt(file) {
    const w = await getWorker(), bmp = await bitmapOf(file);
    const outW = Math.min(2000, bmp.width);
    let best = null;
    const passes = [{ psm: '4', contrast: 0 }, { psm: '6', contrast: 1.6 }, { psm: '4', contrast: 1.6 }];
    for (let i = 0; i < passes.length; i++) {
      const p = passes[i];
      onProgress = (f) => setBar((i + f) / passes.length);
      await w.setParameters({ tessedit_pageseg_mode: p.psm, tessedit_char_whitelist: '' });
      const cv = canvasOf(bmp, 0, 0, bmp.width, bmp.height, outW, p.contrast);
      const r = await w.recognize(cv);
      console.debug('receipt pass', i, JSON.stringify(r.data.text));
      const o = P.parseReceipt(r.data.text, known);
      o._score = P.scoreReceipt(o);
      if (!best || o._score > best._score) best = o;
      if (best._score >= 8) break;
    }
    bmp.close && bmp.close();
    return best;
  }

  async function readDash(file) {
    const w = await getWorker(), bmp = await bitmapOf(file);
    await w.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789.kmKM ' });
    const W = bmp.width, H = bmp.height, vals = [];
    const stage1 = [], stage2 = [];
    for (const fx of [0.37, 0.41]) for (const fy of [0.55, 0.57]) for (const [fw, fh] of [[0.2, 0.1], [0.25, 0.12]]) stage1.push([fx, fy, fw, fh]);
    for (const fx of [0.3, 0.34, 0.39, 0.44, 0.48]) for (const fy of [0.45, 0.5, 0.53, 0.59, 0.63, 0.68]) for (const [fw, fh] of [[0.22, 0.11], [0.3, 0.14]]) stage2.push([fx, fy, fw, fh]);
    const all = stage1.concat(stage2);
    let done = 0, result = null;
    for (const [fx, fy, fw, fh] of all) {
      const sw = Math.round(W * fw), sh = Math.round(H * fh);
      const sx = Math.min(W - sw, Math.round(W * fx)), sy = Math.min(H - sh, Math.round(H * fy));
      const cv = canvasOf(bmp, sx, sy, sw, sh, Math.min(1400, sw * 4), 0);
      const r = await w.recognize(cv);
      vals.push(P.parseTrip(r.data.text));
      done++; setBar(done / all.length);
      const v = P.voteTrip(vals);
      if (done === stage1.length || done > stage1.length) { if (v && v.votes >= 3) { result = v; break; } }
    }
    bmp.close && bmp.close();
    return result || P.voteTrip(vals);
  }

  /* ---------- UI state ---------- */
  const files = { receipt: null, dash: null };
  const status = (msg, cls) => { const s = $('status'); s.textContent = msg; s.className = 'status' + (cls ? ' ' + cls : ''); };
  function setBar(f) { $('bar').hidden = f == null; if (f != null) $('barfill').style.width = Math.round(f * 100) + '%'; }
  function showTile(kind, file) {
    const img = $('img-' + kind), tile = $('tile-' + kind);
    img.src = URL.createObjectURL(file); img.hidden = false; tile.classList.add('has');
  }
  const tick = (kind, ok) => { const t = $('tile-' + kind).querySelector('.tick'); t.hidden = !ok; };

  function today() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
  $('date').value = today();

  function setField(id, v) { if (v != null && v !== '' && !Number.isNaN(v)) $(id).value = v; }

  let busy = Promise.resolve();
  function run(job) { busy = busy.then(job, job); return busy; }

  async function handle(kind, file) {
    files[kind] = file; showTile(kind, file); tick(kind, false);
    await run(async () => {
      try {
        if (kind === 'receipt') {
          status('Reading receipt...'); setBar(0);
          const o = await readReceipt(file);
          setField('date', o.date); setField('location', o.location);
          setField('price', o.price); setField('litres', o.litres); setField('amount', o.amount);
          const got = ['date', 'location', 'price', 'litres', 'amount'].filter((k) => o[k]).length;
          tick('receipt', got >= 4);
          const extra = o.notes && o.notes.length ? ' ' + o.notes.join('. ') + '.' : '';
          status((got === 5 ? 'Receipt read. Check the numbers below.' : 'Receipt partly read. Fill in what is missing.') + extra, got === 5 && !extra ? 'ok' : 'err');
        } else {
          status('Reading trip meter...'); setBar(0);
          const v = await readDash(file);
          if (v) { setField('trip', v.value); tick('dash', true); status(`Trip A read: ${v.value} km. Check it against the photo.`, 'ok'); }
          else status('Could not read the trip meter. Type it in.', 'err');
        }
      } catch (e) {
        console.error(e); status('Photo reading failed (' + (e.message || e) + '). Type the numbers in.', 'err');
      } finally { setBar(null); validate(); }
    });
  }
  $('in-receipt').addEventListener('change', (e) => e.target.files[0] && handle('receipt', e.target.files[0]));
  $('in-dash').addEventListener('change', (e) => e.target.files[0] && handle('dash', e.target.files[0]));

  /* ---------- validation ---------- */
  const val = (id) => parseFloat($(id).value.replace(',', '.'));
  function validate() {
    const w = [], price = val('price'), litres = val('litres'), amount = val('amount'), trip = val('trip');
    ['price', 'litres', 'amount', 'trip'].forEach((i) => $(i).classList.remove('flag'));
    if (price && litres && amount && Math.abs(price * litres - amount) > 0.06) {
      w.push(`Price x volume = $${(price * litres).toFixed(2)} but amount is $${amount.toFixed(2)}.`);
      ['price', 'litres', 'amount'].forEach((i) => $(i).classList.add('flag'));
    }
    if (litres > CFG.tankLitres + 1) { w.push(`${litres} L is more than the ${CFG.tankLitres} L tank.`); $('litres').classList.add('flag'); }
    if (price && (price < 1 || price > 4)) { w.push('Price looks off (expected $1-$4 per litre).'); $('price').classList.add('flag'); }
    if (trip && litres && trip / litres < 4) { w.push(`Trip A ${trip} km on ${litres} L looks too low. Is it the right trip meter?`); $('trip').classList.add('flag'); }
    $('warn').hidden = !w.length; $('warn').innerHTML = w.map((x) => `<div>${x}</div>`).join('');
    return w;
  }
  ['price', 'litres', 'amount', 'trip'].forEach((i) => $(i).addEventListener('input', validate));

  /* ---------- sending ---------- */
  function buildBody(d) {
    const e = CFG.entries, p = new URLSearchParams(), [y, m, dd] = d.date.split('-').map(Number);
    p.set(e.date + '_year', y); p.set(e.date + '_month', m); p.set(e.date + '_day', dd);
    p.set(e.location, d.location); p.set(e.price, d.price); p.set(e.amount, d.amount);
    p.set(e.litres, d.litres); p.set(e.range, d.trip); p.set(e.remarks, d.notfull ? 'Not full' : '');
    return p.toString();
  }
  async function post(item) {
    // The form replies without CORS headers, so the answer is opaque. A resolved request means Google received it.
    await fetch(CFG.formResponseUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: item.body });
  }
  let flushing = false;
  async function flush() {
    if (flushing) return; flushing = true;
    try {
      const q = store.get('queue', []);
      while (q.length) {
        try { await post(q[0]); } catch { break; }
        const sent = q.shift(); store.set('queue', q);
        const h = store.get('history', []); const row = h.find((x) => x.id === sent.id); if (row) row.sent = true; store.set('history', h);
      }
    } finally { flushing = false; renderRecent(); }
  }
  function renderRecent() {
    const h = store.get('history', []).slice(0, 6);
    $('recent-card').hidden = !h.length;
    $('recent').innerHTML = h.map((x) => `<li><span>${x.date} &middot; ${x.location} &middot; $${Number(x.amount).toFixed(2)}</span><span class="s ${x.sent ? '' : 'q'}">${x.sent ? 'SENT' : 'QUEUED'}</span></li>`).join('');
  }

  $('f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = { date: $('date').value, location: $('location').value.trim(), price: val('price'), amount: val('amount'), litres: val('litres'), trip: val('trip'), notfull: $('notfull').checked };
    if (!d.date || !d.location || [d.price, d.amount, d.litres, d.trip].some((n) => !(n > 0))) { status('Fill in every number first.', 'err'); return; }
    const warns = validate();
    if (warns.length && !confirm('Some numbers look off:\n\n' + warns.join('\n') + '\n\nLog it anyway?')) return;
    const hist = store.get('history', []);
    if (hist.some((x) => x.date === d.date && x.amount === d.amount && x.litres === d.litres) && !confirm('This looks like a fill-up you already logged. Log it again?')) return;
    const id = Date.now();
    const item = { id, body: buildBody(d) };
    store.set('queue', [...store.get('queue', []), item]);
    store.set('history', [{ id, ...d, sent: false }, ...hist].slice(0, 30));
    store.set('locs', [...new Set([d.location, ...store.get('locs', [])])].slice(0, 80)); known = fillLocations();
    $('save').disabled = true;
    await flush();
    $('save').disabled = false;
    const queued = store.get('queue', []).length;
    status(queued ? 'Saved on your phone. It will send when you are back online.' : 'Logged to your sheet. Trip A went on the previous fill-up row.', queued ? 'err' : 'ok');
    resetForm();
  });
  function resetForm() {
    ['location', 'price', 'litres', 'amount', 'trip'].forEach((i) => ($(i).value = ''));
    $('date').value = today(); $('notfull').checked = false;
    ['receipt', 'dash'].forEach((k) => { $('img-' + k).hidden = true; $('tile-' + k).classList.remove('has'); tick(k, false); $('in-' + k).value = ''; files[k] = null; });
    validate(); scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- online state, SW, install ---------- */
  const net = () => { $('net').textContent = navigator.onLine ? 'online' : 'offline'; $('net').classList.toggle('off', !navigator.onLine); if (navigator.onLine) flush(); };
  addEventListener('online', net); addEventListener('offline', net); net(); renderRecent();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Warm the OCR engine in the background so the first photo is quick.
  setTimeout(() => getWorker().catch(() => {}), 1500);

  window.__fuel = { readReceipt, readDash, buildBody };
})();
