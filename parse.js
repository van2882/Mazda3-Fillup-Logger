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
    const t = text.replace(/\u00a0/g, ' ');
    const m = t.match(/(\d{1,4})\s*[.,]\s*(\d)\s*[kKmM]/);
    return m ? parseFloat(m[1] + '.' + m[2]) : null;
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

  const api = { scoreReceipt, voteTrip, parseReceipt, parseTrip, parseDate, parseLocation, brandOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FuelParse = api;
})(typeof self !== 'undefined' ? self : this);
