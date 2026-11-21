/* Pure parsing helpers: shared by the app and the node tests. */
(function (root) {
  const BRANDS = [
    [/7[\s-]*eleven|\b711\b/i, '711'],
    [/\bshell\b|reddy express/i, 'Shell'],
    [/\bbp\b/i, 'BP'],
    [/ampol|\bcaltex\b/i, null],   // resolved below
    [/\beg\s*(ampol|fuel)?\b/i, 'EG'],
    [/mobil/i, 'Mobil'],
    [/united/i, 'United'],
    [/coles express/i, 'Coles Express'],
    [/liberty/i, 'Liberty'],
    [/puma/i, 'Puma'],
  ];

  function brandOf(text) {
    if (/ampol/i.test(text)) return 'Ampol';
    if (/caltex/i.test(text)) return 'Caltex';
    for (const [re, name] of BRANDS) if (name && re.test(text)) return name;
    return '';
  }

  const num = (s) => parseFloat(String(s).replace(/[, ]/g, ''));
  const r2 = (n) => Math.round(n * 100) / 100;

  function fixDigits(s) { // common OCR confusions inside numeric tokens
    return s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5');
  }

  function parseDate(text) {
    const m = text.match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(20\d{2}|\d{2})\b/);
    if (!m) return '';
    let [_, d, mo, y] = m; d = +d; mo = +mo; y = +y; if (y < 100) y += 2000;
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function parseLocation(text, known) {
    const brand = brandOf(text);
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    let suburb = '';
    // "1320 - Rockbank" style (7-Eleven store number - suburb)
    for (const l of lines) {
      const m = l.match(/^\d{3,5}\s*[-–—]\s*([A-Za-z][A-Za-z .'()]+)$/);
      if (m) { suburb = m[1].trim(); break; }
    }
    // Known-location match: brand + a suburb word that appears on the receipt
    if (known && known.length) {
      const low = text.toLowerCase();
      let best = '', bestScore = 0;
      for (const k of known) {
        const kl = k.toLowerCase();
        const kb = brandOf(k);
        const words = kl.replace(/^(711|shell|bp|ampol|caltex|eg|mobil|united)\s*/i, '').split(/\s+/).filter((w) => w.length > 2);
        if (!words.length) continue;
        const hit = words.filter((w) => low.includes(w)).length;
        let score = hit / words.length;
        if (kb && kb === brand) score += 0.5;
        if (hit && score > bestScore) { best = k.trim(); bestScore = score; }
      }
      if (best && bestScore >= 1) return best;
    }
    if (brand && suburb) return `${brand} ${suburb}`;
    return brand || suburb || '';
  }

  function parseReceipt(text, known) {
    const t = text.replace(/ /g, ' ');
    const out = { date: parseDate(t), location: parseLocation(t, known), price: null, amount: null, litres: null, notes: [] };

    // "43.03 L @ $2.409/ L   $103.66"
    let m = t.match(/(\d{1,3}\s?[.,]\s?\d{2,3})\s*L\b[^\n$]*?@\s*\$?\s*(\d\s?[.,]\s?\d{2,3})\s*\/?\s*L?[^\n$]*\$?\s*(\d{1,4}[.,]\d{2})?/i);
    if (m) {
      out.litres = num(m[1].replace(',', '.'));
      out.price = num(m[2].replace(',', '.'));
      if (m[3]) out.amount = num(m[3].replace(',', '.'));
    }
    // Fallback: any x.xxx token that looks like a pump price ($1.00-$3.99)
    if (!out.price) {
      const pm = [...t.matchAll(/(?:^|[^\d])([1-3])\s*[.,]\s*(\d{3})(?!\d)/g)].map((x) => num(x[1] + '.' + x[2]));
      if (pm.length) out.price = pm[0];
    }
    // c/L style prices
    if (!out.price) {
      const c = t.match(/(\d{3}\.\d)\s*c\s*\/?\s*L/i);
      if (c) out.price = r2(num(c[1]) / 100 * 1000) / 1000;
    }
    // Totals
    const tot = [...t.matchAll(/(?:total|visa|eftpos|mastercard|amount|purchase|aud)\D{0,12}\$\s*(\d{1,4}\.\d{2})/gi)].map((x) => num(x[1]));
    if (!out.amount && tot.length) out.amount = tot[0];
    // The same total is printed several times (line item, Total, card slip): trust a repeated value
    const money = [...t.matchAll(/\$\s*(\d{1,4}\.\d{2})\b/g)].map((x) => num(x[1]));
    const counts = new Map(); money.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
    let rep = null, repN = 1; for (const [v, n] of counts) if (n > repN || (n === repN && n > 1 && rep != null && v > rep)) { rep = v; repN = n; }
    if (rep != null && repN >= 2 && out.amount !== rep && (counts.get(out.amount) || 0) < repN) out.amount = rep;
    // Cross-check: litres * price ~= amount
    if (out.litres && out.price && out.amount) {
      const calc = out.litres * out.price;
      if (Math.abs(calc - out.amount) > 0.06) out.notes.push(`Litres x price = $${calc.toFixed(2)}, receipt says $${out.amount.toFixed(2)} - check the numbers`);
    } else if (out.litres && out.price && !out.amount) {
      out.amount = r2(out.litres * out.price);
      out.notes.push('Amount worked out from litres x price');
    } else if (out.amount && out.price && !out.litres) {
      out.litres = r2(out.amount / out.price);
      out.notes.push('Litres worked out from amount / price');
    } else if (out.amount && out.litres && !out.price) {
      out.price = Math.round((out.amount / out.litres) * 1000) / 1000;
      out.notes.push('Price worked out from amount / litres');
    }
    return out;
  }

  // Trip meter text like "A 631.9km" (OCR may drop the k or m)
  function parseTrip(text) {
    const c = parseDash(text).filter((x) => x.kind === 'trip').sort((a, b) => b.w - a.w)[0];
    return c ? c.value : null;
  }

  // Digit look-alikes OCR produces on dashboard fonts, only fixed next to other digits
  function fixDashDigits(t) {
    return t.replace(/(?<=\d|[.,])[Oo]|[Oo](?=\d|[.,]\d)/g, '0')
      .replace(/(?<=\d|[.,])[Il|!]|[Il|!](?=\d)/g, '1')
      .replace(/(?<=\d)[Ss$]|[Ss$](?=\d)/g, '5')
      .replace(/(?<=\d)B|B(?=\d)/g, '8')
      .replace(/(?<=\d)Z|Z(?=\d)/g, '2');
  }

  /* Read trip / odometer candidates from one OCR line of a dashboard.
     Mazda shows "TRIP A 631.9 km" (always one decimal) and "ODO 45210 km" (no decimal).
     Returns [{kind:'trip'|'odo', value, w}] where w is how sure the pattern is. */
  function parseDash(text) {
    const out = [];
    const lines = String(text).replace(/\u00a0/g, ' ').split(/\n/);
    for (let raw of lines) {
      const l = fixDashDigits(raw);
      const tripAnchor = /TR[I1l]P|\bA\b|^\s*A\s*\d/i.test(l) && !/ODO|0D0/i.test(l.split(/\d/)[0] || '');
      const odoAnchor = /\b[O0]D[O0]\b|ODO/i.test(l);
      // ODO first so its digits are not read as a trip
      let odoVal = null;
      const om = l.match(/[O0]D[O0]\D{0,6}(\d[\d ,]{2,7}\d)(?!\s*[.,]\s*\d)/i) || l.match(/(?:^|[^\d.,])(\d{5,6})\s*k?m\b/i);
      if (om) { odoVal = parseInt(om[1].replace(/[ ,]/g, ''), 10); if (odoVal >= 100 && odoVal < 1e6) out.push({ kind: 'odo', value: odoVal, w: odoAnchor ? 3 : 1 }); }
      if (odoAnchor && !tripAnchor) continue;
      // x.y with optional km; skip fuel economy (L/100km), temperature, clock
      const re = /(\d{1,4})\s?[.,]\s?(\d)(?!\d)(\s*k?m\b)?(\s*[lL]\s*\/|\s*°|\s*:)?/g;
      let m, found = false;
      while ((m = re.exec(l))) {
        if (m[4]) continue;
        const v = parseFloat(m[1] + '.' + m[2]);
        if (!(v > 0 && v < 2000)) continue;
        out.push({ kind: 'trip', value: v, w: (tripAnchor ? 3 : 0) + (m[3] ? 2 : 0) + 1 });
        found = true;
      }
      // Decimal point read as a space: "TRIP A 631 9 km"
      if (!found && tripAnchor) {
        const sm = l.match(/(\d{1,4}) (\d)\s*k?m\b/i);
        if (sm) { out.push({ kind: 'trip', value: parseFloat(sm[1] + '.' + sm[2]), w: 2 }); found = true; }
      }
      // Decimal point lost: "TRIP A 6319 km" -> 631.9
      if (!found && tripAnchor) {
        const dm = l.match(/(?:TR[I1l]P\s*)?A?\D{0,4}(\d{2,5})\s*k?m?\b/i);
        if (dm && +dm[1] !== odoVal) { const v = parseFloat(dm[1].slice(0, -1) + '.' + dm[1].slice(-1)); if (v > 0 && v < 2000) out.push({ kind: 'trip', value: v, w: 1.5 }); }
      }
    }
    return out;
  }

  // Combine dashboard candidates (each {value, w}) into one trip reading.
  // `expect` (optional) = {litres}: trips that give a sane km/L for that fill get a bonus.
  function pickTrip(cands, expect) {
    const c = new Map();
    for (const x of cands) {
      if (x.kind && x.kind !== 'trip') continue;
      let w = x.w || 1;
      if (expect && expect.litres > 0) { const kpl = x.value / expect.litres; w *= kpl >= 6 && kpl <= 30 ? 1.5 : 0.5; }
      c.set(x.value, (c.get(x.value) || 0) + w);
    }
    let best = null, bw = 0, tot = 0;
    for (const [v, w] of c) { tot += w; if (w > bw) { best = v; bw = w; } }
    return best == null ? null : { value: best, votes: Math.round(bw * 10) / 10, total: Math.round(tot * 10) / 10 };
  }

  // Score a receipt parse: more complete + consistent = better
  function scoreReceipt(o) {
    let s = 0;
    if (o.date) s += 1; if (o.location) s += 1;
    if (o.price) s += 1; if (o.amount) s += 1; if (o.litres) s += 1;
    if (o.price && o.amount && o.litres && Math.abs(o.price * o.litres - o.amount) <= 0.06) s += 3;
    if (o.notes && o.notes.length) s -= 0.5;
    return s;
  }

  // Combine several trip readings: pick the most frequent plausible value
  function voteTrip(values) {
    const c = new Map();
    for (const v of values) if (v != null && v > 0 && v < 2000) c.set(v, (c.get(v) || 0) + 1);
    let best = null, n = 0;
    for (const [v, k] of c) if (k > n) { best = v; n = k; }
    return best == null ? null : { value: best, votes: n, total: values.length };
  }

  const api = { scoreReceipt, voteTrip, parseReceipt, parseTrip, parseDash, pickTrip, fixDashDigits, parseDate, parseLocation, brandOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FuelParse = api;
})(typeof self !== 'undefined' ? self : this);
