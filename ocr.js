// Fotoimport: Texterkennung im Browser (Tesseract.js) + Erkennung der Spalten Französisch | Deutsch
const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
let tessLoad = null, workerP = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tessLoad) tessLoad = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = TESS_URL; s.onload = res;
    s.onerror = () => { tessLoad = null; rej(new Error("offline")); };
    document.head.appendChild(s);
  });
  return tessLoad;
}

let onProgress = () => {}, workerLang = null;
async function getWorker(lang) {
  await loadTesseract();
  if (workerP && workerLang !== lang) {          // Sprache gewechselt: alten Worker beenden
    const old = workerP; workerP = null;
    old.then(w => w.terminate()).catch(() => {});
  }
  if (!workerP) {
    workerLang = lang;
    workerP = Tesseract.createWorker([lang, "deu"], 1, {
      logger: m => onProgress(m)
    }).catch(e => { workerP = null; throw e; });
  }
  return workerP;
}

// Foto verkleinern, in Graustufen wandeln und Kontrast anheben
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const max = 2400, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * sc), h = Math.round(img.naturalHeight * sc);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h), p = d.data;
    let lo = 255, hi = 0;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const v = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
      gray[j] = v;
    }
    // robuste Grenzen (2 % / 98 %)
    const hist = new Uint32Array(256); gray.forEach(v => hist[v]++);
    let acc = 0; const n = gray.length;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const v = Math.max(0, Math.min(255, ((gray[j] - lo) / span) * 255));
      p[i] = p[i + 1] = p[i + 2] = v;
    }
    g.putImageData(d, 0, 0);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

function collectWords(data) {
  let words = [];
  if (data.blocks && data.blocks.length) {
    data.blocks.forEach(b => (b.paragraphs || []).forEach(pa => (pa.lines || []).forEach(l => (l.words || []).forEach(w => words.push(w)))));
  }
  if (!words.length && data.words) words = data.words;
  return words
    .filter(w => w.text && w.text.trim() && (w.confidence ?? 100) > 25)
    .map(w => ({ t: w.text.trim(), x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1 }));
}

// Spalten anhand senkrechter Lücken finden, Zeilen anhand der Höhe gruppieren
function wordsToPairs(words) {
  if (!words.length) return [];
  const minX = Math.min(...words.map(w => w.x0)), maxX = Math.max(...words.map(w => w.x1));
  const width = Math.max(1, maxX - minX), BINS = 600;
  const cov = new Uint16Array(BINS);
  words.forEach(w => {
    const a = Math.floor((w.x0 - minX) / width * (BINS - 1)), b = Math.ceil((w.x1 - minX) / width * (BINS - 1));
    for (let i = a; i <= b; i++) cov[i]++;
  });
  // Lücken: Bereiche, die (fast) kein Wort berühren
  const thr = Math.max(0, Math.floor(words.length * 0.004));
  const gaps = []; let s = -1;
  for (let i = 0; i < BINS; i++) {
    if (cov[i] <= thr) { if (s < 0) s = i; }
    else if (s >= 0) { if (i - s >= BINS * 0.03) gaps.push((s + i) / 2); s = -1; }
  }
  const cuts = gaps.map(g => minX + g / (BINS - 1) * width);

  const hs = words.map(w => w.y1 - w.y0).sort((a, b) => a - b);
  const mh = hs[hs.length >> 1] || 20;
  const sorted = words.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const rows = [];
  sorted.forEach(w => {
    const yc = (w.y0 + w.y1) / 2, r = rows[rows.length - 1];
    if (r && Math.abs(yc - r.yc) < mh * 0.6) { r.w.push(w); r.yc = (r.yc * (r.w.length - 1) + yc) / r.w.length; }
    else rows.push({ yc, w: [w] });
  });

  const colOf = w => { const xc = (w.x0 + w.x1) / 2; let c = 0; while (c < cuts.length && xc > cuts[c]) c++; return c; };
  const nCols = cuts.length + 1;
  const table = rows.map(r => {
    const cols = Array.from({ length: nCols }, () => []);
    r.w.sort((a, b) => a.x0 - b.x0).forEach(w => cols[colOf(w)].push(w.t));
    return cols.map(c => c.join(" ").trim());
  });

  const pairs = [];
  if (nCols >= 2) {
    // erste belegte Spalte = Französisch, letzte = Deutsch (Beispielsätze in der Mitte fallen weg)
    const used = [...Array(nCols).keys()].filter(c => table.filter(r => r[c]).length >= Math.max(2, rows.length * 0.15));
    const fc = used[0] ?? 0, dc = used[used.length - 1] ?? nCols - 1;
    table.forEach(r => {
      const fr = r[fc], de = fc === dc ? "" : r[dc];
      if (fr && de) pairs.push([fr, de]);
      else if (!fr && de && pairs.length) pairs[pairs.length - 1][1] += " " + de;   // umbrochene Übersetzung
      else if (fr && !de && pairs.length && /^[a-zàâçéèêëîïôûùüÿœáíóúñ¿¡(]/.test(fr) && /[,;]$/.test(pairs[pairs.length - 1][0])) pairs[pairs.length - 1][0] += " " + fr;
    });
  }
  if (!pairs.length) {
    // eine Spalte: Trennzeichen in der Zeile suchen
    table.forEach(r => {
      const line = r.join(" ");
      const m = line.split(/\s+[-–—=:]\s+|\s{3,}/);
      if (m.length >= 2 && m[0].trim() && m[m.length - 1].trim()) pairs.push([m[0].trim(), m[m.length - 1].trim()]);
    });
  }
  return pairs
    .map(([a, b]) => [clean(a), clean(b)])
    .filter(([a, b]) => a.length > 1 && b.length > 1 && !/^\d+$/.test(a) && !/^(unité|atelier|vocabulaire|unidad|vocabulario|lección|seite|page)\b/i.test(a));
}

function clean(s) {
  return s.replace(/\s*\[[^\]]*\]\s*/g, " ")       // Lautschrift [ ... ] entfernen
          .replace(/[|_~«»]+/g, " ")
          .replace(/\s+/g, " ")
          .replace(/^[\s\-–•·.,;:]+|[\s\-–•·]+$/g, "")
          .trim();
}

async function recognizePhoto(file, lang, progress) {
  onProgress = progress || (() => {});
  const canvas = await prepareImage(file);
  const worker = await getWorker(lang || "fra");
  await worker.setParameters({ tessedit_pageseg_mode: "4", preserve_interword_spaces: "1" });
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  let pairs = wordsToPairs(collectWords(data));
  if (!pairs.length) {
    await worker.setParameters({ tessedit_pageseg_mode: "3" });
    const r2 = await worker.recognize(canvas, {}, { text: true, blocks: true });
    pairs = wordsToPairs(collectWords(r2.data));
  }
  return pairs;
}
