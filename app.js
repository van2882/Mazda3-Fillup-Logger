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

  /* Dashboard: light text on a dark screen, anywhere in the photo.
     1) read the whole photo (inverted) to find the TRIP A / km line,
     2) re-read that line close up several ways and vote,
     3) if nothing found, scan overlapping tiles. */
  function otsu(g, n) {
    const h = new Uint32Array(256); for (let i = 0; i < n; i++) h[g[i]]++;
    let tot = 0; for (let i = 0; i < 256; i++) tot += i * h[i];
    let wB = 0, sB = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) { wB += h[t]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += t * h[t];
      const mB = sB / wB, mF = (tot - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; th = t; } }
    return th;
  }
  function dashCanvas(bmp, sx, sy, sw, sh, outW, mode) {
    const scale = outW / sw, c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    if (mode === 'soft') x.filter = `blur(${Math.max(1, Math.round(outW / 1100))}px)`;
    if (mode === 'local') x.filter = 'blur(2px)'; // calms sensor grain before the local threshold
    x.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const img = x.getImageData(0, 0, c.width, c.height), d = img.data, n = d.length / 4;
    const g = new Uint8ClampedArray(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); g[i] = v; hist[v]++; } // max channel keeps coloured LCD text bright
    // 2nd and 98th percentile stretch
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
    acc = 0; for (; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) g[i] = ((g[i] - lo) * 255) / span;
    // Text is the minority: light text pulls the bright tail further from the median than the dark tail
    const pct = (q) => { let v = 0; for (let a = 0; v < 255 && (a += hist[v]) < n * q; v++); return v; };
    const med = pct(0.5), invert = pct(0.995) - med > med - pct(0.005); // light text -> make it dark on white for OCR
    if (mode === 'local') { // subtract the local background (beats glare and uneven light), then Otsu
      const cw = c.width, ch = c.height, r = Math.max(15, Math.round(Math.max(cw, ch) / 12)), I = new Float64Array((cw + 1) * (ch + 1));
      for (let y = 0; y < ch; y++) { let row = 0; for (let xx = 0; xx < cw; xx++) { row += g[y * cw + xx]; I[(y + 1) * (cw + 1) + xx + 1] = I[y * (cw + 1) + xx + 1] + row; } }
      const diff = new Uint8ClampedArray(n);
      for (let y = 0; y < ch; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(ch, y + r + 1);
        for (let xx = 0; xx < cw; xx++) {
          const x0 = Math.max(0, xx - r), x1 = Math.min(cw, xx + r + 1);
          const mean = (I[y1 * (cw + 1) + x1] - I[y0 * (cw + 1) + x1] - I[y1 * (cw + 1) + x0] + I[y0 * (cw + 1) + x0]) / ((y1 - y0) * (x1 - x0));
          const v = g[y * cw + xx]; diff[y * cw + xx] = (invert ? v - mean : mean - v) * 3;
        }
      }
      const th = otsu(diff, n), lim = Math.max(th, 40);
      for (let i = 0; i < n; i++) { const v = diff[i] > lim ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
      x.putImageData(img, 0, 0);
      return c;
    }
    let th = -1;
    if (mode === 'bin' || mode === 'soft') th = otsu(g, n);
    for (let i = 0; i < n; i++) {
      let v = g[i]; if (th >= 0) v = v > th ? 255 : 0; if (invert) v = 255 - v;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    }
    x.putImageData(img, 0, 0);
    return c;
  }
  const DASH_CHARS = '0123456789.,kmKMTRIPAODtripaod ';
  async function ocrDash(w, cv, psm, whitelist) {
    await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist ? DASH_CHARS : '' });
    const r = await w.recognize(cv);
    return r.data;
  }
  function linesOf(data) {
    if (data.lines && data.lines.length) return data.lines;
    return (data.text || '').split('\n').map((text) => ({ text, confidence: data.confidence, bbox: null }));
  }

  async function readDash(file, focus) {
    const w = await getWorker(), bmp = await bitmapOf(file);
    const W = bmp.width, H = bmp.height, cands = [], expect = { litres: val('litres') };
    const add = (text, conf, weight) => {
      const f = Math.max(0.3, Math.min(1, (conf || 50) / 90)) * (weight || 1);
      for (const c of P.parseDash(text)) if (c.kind === 'trip') cands.push({ ...c, w: c.w * f });
    };
    // Close-up re-read of one line, several preprocessings; returns trip found
    async function closeUp(sx, sy, sw, sh) {
      if (budget-- <= 0 || Date.now() > deadline) return;
      sx = Math.max(0, Math.round(sx)); sy = Math.max(0, Math.round(sy));
      sw = Math.round(Math.min(W - sx, sw)); sh = Math.round(Math.min(H - sy, sh));
      if (sw < 8 || sh < 8) return;
      const outW = Math.max(300, Math.min(1600, Math.round(sw * (90 / sh)))); // ~90px tall line
      for (const [mode, psm] of [['stretch', '7'], ['local', '7'], ['soft', '7'], ['stretch', '6']]) {
        const d = await ocrDash(w, dashCanvas(bmp, sx, sy, sw, sh, outW, mode), psm, true);
        console.debug('dash close-up', mode, psm, JSON.stringify(d.text));
        add(d.text, d.confidence, 1.5);
        if (strong()) break;
      }
    }
    // Read a region with sparse layout, then close-up the lines that look like a trip (nearest first if `dist` given)
    async function scan(sx, sy, sw, sh, mode, dist) {
      const outW = Math.min(2000, Math.round(sw * 1.6)), k = sw / outW;
      const d = await ocrDash(w, dashCanvas(bmp, sx, sy, sw, sh, outW, mode), '11', true);
      console.debug('dash scan', mode, JSON.stringify(d.text));
      const hits = [];
      for (const l of linesOf(d)) {
        const before = cands.length; add(l.text, l.confidence, 1);
        if (cands.length > before && l.bbox) hits.push({ x0: sx + l.bbox.x0 * k, y0: sy + l.bbox.y0 * k, x1: sx + l.bbox.x1 * k, y1: sy + l.bbox.y1 * k });
      }
      if (dist) hits.sort((a, b) => dist(a) - dist(b));
      for (const h of hits.slice(0, 2)) {
        const lh = h.y1 - h.y0;
        await closeUp(h.x0 - lh * 1.5, h.y0 - lh * 0.45, h.x1 - h.x0 + lh * 3, lh * 1.9);
        if (strong()) return;
      }
    }
    // Stop once one value clearly leads (enough weight and at least 2/3 of all weight)
    const strong = () => { const v = P.pickTrip(cands, expect); return v && v.votes >= 6 && v.votes >= v.total * 0.66 ? v : null; };
    const deadline = Date.now() + 25000; // give up and let the user tap the number instead
    let budget = 5; // max close-ups per photo (each is 4 reads) so a bad photo can't take minutes

    try {
      if (focus) { // user tapped the number: scan a band around the tap, then zoom on the line found
        budget = 3;
        const bw = W * 0.5, bh = H * 0.16, bx = Math.max(0, focus.x * W - bw / 2), by = Math.max(0, focus.y * H - bh / 2);
        for (const mode of ['local', 'soft']) {
          await scan(bx, by, Math.min(bw, W - bx), Math.min(bh, H - by), mode, (l) => Math.abs((l.y0 + l.y1) / 2 - focus.y * H));
          setBar(mode === 'local' ? 0.5 : 1);
          if (strong()) break;
        }
        return P.pickTrip(cands, expect);
      }
      // 1) whole photo
      const fullW = Math.min(2200, W), sc = W / fullW;
      onProgress = (f) => setBar(f * 0.3);
      let full = await ocrDash(w, dashCanvas(bmp, 0, 0, W, H, fullW, 'soft'), '11', false);
      console.debug('dash full soft', JSON.stringify(full.text));
      if (!linesOf(full).some((l) => P.parseDash(l.text).some((c) => c.kind === 'trip' && c.w >= 3))) {
        onProgress = (f) => setBar(0.15 + f * 0.15);
        const alt = await ocrDash(w, dashCanvas(bmp, 0, 0, W, H, fullW, 'local'), '11', false);
        console.debug('dash full local', JSON.stringify(alt.text));
        full = { ...alt, lines: [...linesOf(full), ...linesOf(alt)] };
      }
      onProgress = () => {};
      const lines = linesOf(full).filter((l) => l.bbox && P.parseDash(l.text).some((c) => c.kind === 'trip'))
        .sort((a, b) => Math.max(...P.parseDash(b.text).map((c) => c.w)) - Math.max(...P.parseDash(a.text).map((c) => c.w)));
      linesOf(full).forEach((l) => add(l.text, l.confidence, 1));
      // 2) close-ups of the best lines (also the line just above: "TRIP A" is sometimes on its own row)
      let i = 0;
      for (const l of lines.slice(0, 3)) {
        const { x0, y0, x1, y1 } = l.bbox, lh = (y1 - y0) * sc, lw = (x1 - x0) * sc;
        await closeUp(x0 * sc - lh * 1.5, y0 * sc - lh * 0.45, lw + lh * 3, lh * 1.9);
        setBar(0.3 + (++i / 3) * 0.4);
        if (strong()) break;
      }
      // 3) tiles, if the full read found nothing convincing
      if (!strong()) {
        const tiles = [];
        for (const fy of [0, 0.25, 0.5, 0.75]) for (const fx of [0, 0.3, 0.6]) tiles.push([fx, fy, 0.4, 0.3]);
        for (let t = 0; t < tiles.length && Date.now() < deadline; t++) {
          const [fx, fy, fw, fh] = tiles[t];
          await scan(W * fx, H * fy, W * fw, H * fh, 'local');
          setBar(0.7 + ((t + 1) / tiles.length) * 0.3);
          if (strong()) break;
        }
      }
      return P.pickTrip(cands, expect);
    } finally { bmp.close && bmp.close(); }
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
          showDashResult(await readDash(file));
        }
      } catch (e) {
        console.error(e); status('Photo reading failed (' + (e.message || e) + '). Type the numbers in.', 'err');
      } finally { setBar(null); validate(); }
    });
  }
  function showDashResult(v) {
    $('aim').hidden = !files.dash;
    if (!v) { status('Could not read the trip meter. Tap Trip A on the photo, or type it in.', 'err'); return; }
    setField('trip', v.value);
    const sure = v.votes >= 4 && v.votes >= v.total * 0.66;
    tick('dash', sure);
    status(sure ? `Trip A read: ${v.value} km. Check it against the photo.` : `Trip A might be ${v.value} km, but the photo was hard to read. Check it, or tap the number on the photo.`, sure ? 'ok' : 'err');
  }
  // Manual aim: user taps the number, we read just that area
  $('aim').addEventListener('click', () => { if (!files.dash) return; $('aim-img').src = $('img-dash').src; $('aimer').showModal(); });
  $('aim-cancel').addEventListener('click', () => $('aimer').close());
  $('aim-img').addEventListener('click', (ev) => {
    const im = ev.currentTarget, r = im.getBoundingClientRect();
    // object-fit: contain -> work out where the picture actually sits inside the element
    const k = Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight), pw = im.naturalWidth * k, ph = im.naturalHeight * k;
    const fx = (ev.clientX - r.left - (r.width - pw) / 2) / pw, fy = (ev.clientY - r.top - (r.height - ph) / 2) / ph;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
    $('aimer').close();
    const file = files.dash;
    run(async () => {
      try { status('Reading the spot you tapped...'); setBar(0); showDashResult(await readDash(file, { x: fx, y: fy })); }
      catch (e) { console.error(e); status('Photo reading failed. Type the number in.', 'err'); }
      finally { setBar(null); validate(); }
    });
  });
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
    $('aim').hidden = true;
    ['receipt', 'dash'].forEach((k) => { $('img-' + k).hidden = true; $('tile-' + k).classList.remove('has'); tick(k, false); $('in-' + k).value = ''; files[k] = null; });
    validate(); scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- online state, SW, install ---------- */
  const net = () => { $('net').textContent = navigator.onLine ? 'online' : 'offline'; $('net').classList.toggle('off', !navigator.onLine); if (navigator.onLine) flush(); };
  addEventListener('online', net); addEventListener('offline', net); net(); renderRecent();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Warm the OCR engine in the background so the first photo is quick.
  setTimeout(() => getWorker().catch(() => {}), 1500);

  window.__fuel = { readReceipt, readDash, buildBody, dashCanvas, bitmapOf };
})();
