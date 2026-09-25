/*
  StudyVault Next-Gen Reviewer Engine
  -----------------------------------
  app.js is intentionally NOT modified.
  This layer reads/writes the existing StudyVault v5 IndexedDB stores and
  upgrades the reviewer, flashcards, quiz, and study blueprint using
  evidence-first local NLP heuristics. No LLM/API is required.
*/
(() => {
  "use strict";

  const ENGINE_VERSION = 6;
  const DB_NAME = "studyvault-v5";
  const DB_VERSION = 1;
  const DOC_STORE = "documents";
  const META_STORE = "meta";
  const SETTINGS_KEY = "settings";

  const STOP = new Set((`
    a an and are as at be because been before being between both but by can could did do does for from had has have he her here hers him his how i if in into is it its itself just may me might more most my no not of on one or our ours out over same she should so some than that the their theirs them themselves then there these they this those through to too under up us was we were what when where which while who whom why will with would you your yours about after again against all also among another any anything around become below during each either enough even every example few first following further given going having however important later least little many maybe much must never often other otherwise perhaps rather since such very want without within yet
   `).split(/\s+/));

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const normalize = s => String(s || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const strip = s => normalize(String(s || "").replace(/<[^>]+>/g, " "));
  const tokens = s => normalize(s).toLowerCase().replace(/[^a-z0-9%+./_-]+/g, " ").split(/\s+/).filter(Boolean);
  const words = s => tokens(s).filter(w => !STOP.has(w) && w.length >= 3 && !/^\d+$/.test(w));
  const esc = v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      };
    });
  }

  async function get(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function getAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function put(store, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  function stableId(prefix, value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `${prefix}-${(h >>> 0).toString(36)}`;
  }

  function sentenceList(text) {
    return normalize(text)
      .replace(/\n+/g, " ")
      .match(/[^.!?]+(?:[.!?]+|$)/g)
      ?.map(s => normalize(s))
      .filter(s => s.length >= 35 && s.length <= 520) || [];
  }

  function buildUnits(doc) {
    if (Array.isArray(doc.units) && doc.units.length) return doc.units.filter(x => x && x.text).map(x => ({
      page: Number(x.page) || null,
      text: normalize(x.text),
      source: x.source || "page",
      photoId: x.photoId || null
    }));

    const fromPages = [];
    for (const p of Array.isArray(doc.pageTexts) ? doc.pageTexts : []) {
      for (const text of sentenceList(p.text || "")) fromPages.push({ page: p.page || null, text, source: p.source || "page", photoId: p.photoId || null });
    }
    return fromPages;
  }

  function pageMap(doc) {
    const map = new Map();
    for (const p of Array.isArray(doc.pageTexts) ? doc.pageTexts : []) map.set(Number(p.page) || 1, normalize(p.text || ""));
    return map;
  }

  function phraseStats(units) {
    const one = new Map();
    const bi = new Map();
    const tri = new Map();
    for (const u of units) {
      const ws = words(u.text);
      for (const w of ws) one.set(w, (one.get(w) || 0) + 1);
      for (let i = 0; i < ws.length - 1; i++) {
        const a = `${ws[i]} ${ws[i + 1]}`;
        if (ws[i] !== ws[i + 1]) bi.set(a, (bi.get(a) || 0) + 1);
      }
      for (let i = 0; i < ws.length - 2; i++) {
        const a = `${ws[i]} ${ws[i + 1]} ${ws[i + 2]}`;
        if (new Set([ws[i], ws[i + 1], ws[i + 2]]).size === 3) tri.set(a, (tri.get(a) || 0) + 1);
      }
    }
    return { one, bi, tri };
  }

  function extractTermsAdvanced(doc, units) {
    const stats = phraseStats(units);
    const titleHints = new Set();
    for (const p of Array.isArray(doc.pageTexts) ? doc.pageTexts : []) {
      for (const line of String(p.text || "").split("\n")) {
        const x = normalize(line);
        if (!x || x.length > 90 || /[.!?]$/.test(x)) continue;
        const ws = x.split(/\s+/);
        if (ws.length >= 2 && ws.length <= 8 && (x === x.toUpperCase() || ws.filter(w => /^[A-Z][a-z]/.test(w)).length >= Math.ceil(ws.length * .6))) {
          for (const w of words(x)) titleHints.add(w);
        }
      }
    }

    const candidates = [];
    for (const [w, f] of stats.one) {
      if (w.length < 4 || w.length > 30 || STOP.has(w)) continue;
      let score = Math.log1p(f) * 2.1 + (titleHints.has(w) ? 2.5 : 0);
      if (/^[a-z]+-[a-z]+$/.test(w)) score += 1.25;
      if (/\d/.test(w)) score += 0.8;
      candidates.push({ term: w, score, freq: f, kind: "word" });
    }
    for (const [p, f] of stats.bi) {
      if (f < 2) continue;
      const ws = p.split(" ");
      if (ws.some(x => STOP.has(x))) continue;
      candidates.push({ term: p, score: Math.log1p(f) * 3.0 + 2.0, freq: f, kind: "phrase" });
    }
    for (const [p, f] of stats.tri) {
      if (f < 2) continue;
      const ws = p.split(" ");
      if (ws.some(x => STOP.has(x))) continue;
      candidates.push({ term: p, score: Math.log1p(f) * 3.8 + 1.5, freq: f, kind: "phrase" });
    }

    const curated = [];
    for (const c of candidates.sort((a, b) => b.score - a.score)) {
      if (curated.some(x => x.term === c.term)) continue;
      if (c.kind === "word" && curated.some(x => x.term.includes(c.term) && x.term.split(" ").length > 1)) continue;
      curated.push(c);
      if (curated.length >= 60) break;
    }
    return curated.map(x => x.term);
  }

  function termEvidence(term, units) {
    const low = term.toLowerCase();
    return units
      .filter(u => u.text.toLowerCase().includes(low))
      .sort((a, b) => evidenceScore(b.text, term) - evidenceScore(a.text, term))[0] || null;
  }

  function evidenceScore(text, term) {
    const t = text.toLowerCase();
    let s = 0;
    if (t.includes(`${term.toLowerCase()} is`)) s += 7;
    if (/\b(means|refers to|defined as|known as|is called|consists of|describes)\b/i.test(text)) s += 6;
    if (/\b(example|purpose|function|used|process|method|type|kind|part|cause|effect|result)\b/i.test(text)) s += 3;
    if (/\d/.test(text)) s += 1;
    s += Math.min(3, term.split(" ").length - 1);
    s += Math.max(0, 2 - Math.abs(150 - text.length) / 90);
    return s;
  }

  function detectDefinitions(terms, units) {
    const out = [];
    const seen = new Set();
    for (const u of units) {
      const s = u.text;
      const patterns = [
        /^(.{2,80}?)\s+(?:is|are|means|refers to|is defined as|is known as|is called)\s+(.{12,})$/i,
        /^(.{2,80}?)\s*:\s*(.{12,})$/i,
        /\b(.{2,80}?)\s+(?:consists of|includes|contains)\s+(.{12,})$/i
      ];
      for (const re of patterns) {
        const m = s.match(re);
        if (!m) continue;
        const rawTerm = normalize(m[1]).replace(/^(the|a|an)\s+/i, "");
        const match = terms.find(t => rawTerm.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(rawTerm.toLowerCase()));
        const term = match || rawTerm;
        const key = `${term}|${s}`.toLowerCase();
        if (term.length < 2 || seen.has(key)) continue;
        seen.add(key);
        out.push({ term, definition: s, page: u.page || null, source: u.source || "page", confidence: Math.min(0.99, 0.62 + (re === patterns[0] ? 0.23 : 0.12) + (s.length < 280 ? 0.08 : 0)) });
        break;
      }
    }
    for (const term of terms.slice(0, 35)) {
      if (out.some(x => x.term.toLowerCase() === term.toLowerCase())) continue;
      const hit = termEvidence(term, units);
      if (hit && /\b(is|are|means|refers to|defined as|known as|called|consists|includes)\b/i.test(hit.text)) {
        out.push({ term, definition: hit.text, page: hit.page || null, source: hit.source || "page", confidence: 0.58 });
      }
    }
    return out.sort((a, b) => b.confidence - a.confidence).slice(0, 24);
  }

  function headingCandidates(doc) {
    const out = [];
    for (const p of Array.isArray(doc.pageTexts) ? doc.pageTexts : []) {
      const lines = String(p.text || "").split("\n").map(normalize).filter(Boolean);
      for (const line of lines) {
        if (line.length < 3 || line.length > 90 || /[.!?]$/.test(line)) continue;
        const ws = line.split(/\s+/);
        const titleish = ws.filter(w => /^[A-Z][a-zA-Z0-9/&-]*/.test(w)).length >= Math.ceil(ws.length * .55);
        if ((line === line.toUpperCase() && /[A-Z]/.test(line)) || (ws.length <= 9 && titleish)) {
          if (!/^(page|figure|table|chapter|section)\s*\d*$/i.test(line)) out.push({ page: p.page, text: line });
        }
      }
    }
    return out.slice(0, 40);
  }

  function headingForUnit(unit, headings) {
    const same = headings.filter(h => Number(h.page) === Number(unit.page));
    if (!same.length) return null;
    const idx = Math.max(0, same.findIndex(h => unit.text.toLowerCase().includes(h.text.toLowerCase())));
    return same[idx]?.text || same[0]?.text || null;
  }

  function sentenceInfo(units, terms) {
    const frequencies = new Map();
    const total = Math.max(1, units.length);
    for (const u of units) for (const w of words(u.text)) frequencies.set(w, (frequencies.get(w) || 0) + 1);
    return units.map((u, i) => {
      const ws = words(u.text);
      let tfidf = 0;
      for (const w of ws) {
        const f = frequencies.get(w) || 1;
        tfidf += Math.log1p(frequencies.get(w) || 1) * Math.log((total + 1) / (f + 0.5));
      }
      let termHits = 0;
      for (const t of terms) if (u.text.toLowerCase().includes(t.toLowerCase())) termHits += 1;
      let cues = 0;
      if (/\b(is|are|means|refers to|defined as|purpose|function|process|method|because|therefore|results in|causes|includes|consists)\b/i.test(u.text)) cues += 3;
      if (/\b(first|second|third|next|then|finally|step|stage|phase)\b/i.test(u.text)) cues += 2;
      if (/\d/.test(u.text)) cues += 1;
      const pos = i / Math.max(1, units.length - 1);
      const position = pos < 0.12 ? 1.8 : pos > 0.9 ? 1.0 : 0;
      const length = u.text.length >= 65 && u.text.length <= 260 ? 1.4 : 0;
      return { ...u, i, score: tfidf * 0.34 + termHits * 2.1 + cues + position + length };
    });
  }

  function jaccard(a, b) {
    const A = new Set(words(a)), B = new Set(words(b));
    let common = 0; for (const x of A) if (B.has(x)) common++;
    const total = new Set([...A, ...B]).size;
    return total ? common / total : 0;
  }

  function mmrSelect(items, count) {
    const selected = [];
    const pool = [...items].sort((a, b) => b.score - a.score);
    while (pool.length && selected.length < count) {
      let best = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const x = pool[i];
        const redundancy = selected.length ? Math.max(...selected.map(s => jaccard(s.text, x.text))) : 0;
        const score = x.score - redundancy * 7.0;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      selected.push(pool.splice(best, 1)[0]);
    }
    return selected.sort((a, b) => a.i - b.i);
  }

  function detectPatterns(units) {
    const buckets = {
      causeEffect: [],
      process: [],
      comparison: [],
      examples: [],
      facts: [],
      warnings: []
    };
    for (const u of units) {
      const s = u.text;
      if (/\b(because|therefore|thus|leads to|results in|causes|due to|as a result|consequently)\b/i.test(s)) buckets.causeEffect.push(u);
      if (/\b(first|second|third|next|then|finally|step|stage|phase|procedure|process)\b/i.test(s)) buckets.process.push(u);
      if (/\b(unlike|whereas|while|however|difference between|similar|same as|compared with|versus|vs\.)\b/i.test(s)) buckets.comparison.push(u);
      if (/\b(for example|for instance|such as|e\.g\.)\b/i.test(s)) buckets.examples.push(u);
      if (/\d/.test(s) || /\b(percent|percentage|year|date|cm|mm|kg|v|a|hz|ohm|degree|degrees)\b/i.test(s)) buckets.facts.push(u);
      if (/\b(important|note|warning|avoid|do not|never|must|remember|caution)\b/i.test(s)) buckets.warnings.push(u);
    }
    return buckets;
  }

  function buildConceptMap(terms, units) {
    const top = terms.slice(0, 22);
    const edges = [];
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        let score = 0;
        for (const u of units) {
          const t = u.text.toLowerCase();
          if (t.includes(top[i].toLowerCase()) && t.includes(top[j].toLowerCase())) score += 1;
        }
        if (score >= 2) edges.push({ from: top[i], to: top[j], strength: score });
      }
    }
    return edges.sort((a, b) => b.strength - a.strength).slice(0, 18);
  }

  function memoryCues(terms, units) {
    return terms.slice(0, 16).map(term => {
      const u = termEvidence(term, units);
      if (!u) return { term, clue: "Connect this term to a concrete example from the material.", page: null };
      const phrase = u.text.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "[THIS TERM]");
      const clue = normalize(phrase).slice(0, 210);
      return { term, clue: `Anchor: ${clue}`, page: u.page || null };
    });
  }

  function makeStudyQuestions(defs, selected, patterns, terms) {
    const q = [];
    for (const d of defs.slice(0, 10)) q.push({ q: `Define ${d.term} precisely, then give one supporting detail from the source.`, page: d.page, type: "definition" });
    for (const u of selected.slice(0, 8)) q.push({ q: `Explain the key idea in this passage and connect it to the surrounding topic.`, page: u.page, type: "explain" });
    for (const u of patterns.causeEffect.slice(0, 4)) q.push({ q: `What cause-and-effect relationship is described here?`, page: u.page, type: "cause-effect" });
    for (const u of patterns.comparison.slice(0, 4)) q.push({ q: `What two ideas are being compared or contrasted here?`, page: u.page, type: "comparison" });
    if (!q.length) for (const t of terms.slice(0, 10)) q.push({ q: `What is ${t}, and where is it used in the material?`, page: null, type: "concept" });
    const seen = new Set();
    return q.filter(x => !seen.has(x.q) && seen.add(x.q)).slice(0, 24);
  }

  function buildReviewer(doc) {
    const units = buildUnits(doc);
    const headings = headingCandidates(doc);
    let terms = extractTermsAdvanced(doc, units);
    const oldTerms = Array.isArray(doc.terms) ? doc.terms : [];
    for (const t of oldTerms) if (t && !terms.includes(t)) terms.push(t);
    terms = terms.slice(0, 60);

    const infos = sentenceInfo(units, terms);
    const selected = mmrSelect(infos, Math.min(12, Math.max(6, Math.ceil(units.length * 0.16))));
    const defs = detectDefinitions(terms, units);
    const patterns = detectPatterns(units);
    const map = buildConceptMap(terms, units);
    const questions = makeStudyQuestions(defs, selected, patterns, terms);

    const overview = selected.slice(0, 7).map(x => x.text).join(" ");
    const core = selected.slice(0, 18).map(x => ({ text: x.text, page: x.page, source: x.source || "page", heading: headingForUnit(x, headings) }));
    const pages = [];
    const byPage = new Map();
    for (const u of units) {
      if (!byPage.has(u.page)) byPage.set(u.page, []);
      byPage.get(u.page).push(u);
    }
    for (const [page, arr] of byPage) {
      const ranked = sentenceInfo(arr, terms);
      const best = ranked.sort((a, b) => b.score - a.score)[0];
      if (best) pages.push({ page, text: best.text, source: best.source || "page" });
      if (pages.length >= 35) break;
    }

    const strategy = defs.length >= 6
      ? `Phase 1: master the ${defs.length} definition anchors. Phase 2: explain the key points without looking. Phase 3: revisit cause/effect, comparisons, and examples. Phase 4: take the quiz, then review every missed item at its cited page.`
      : `Use a three-pass cycle: first learn the key terms, second explain the selected evidence in your own words, and third test yourself with the questions and flashcards. When an item is weak, return to the cited page instead of memorizing an isolated sentence.`;

    const blueprint = [
      { label: "Core concepts", value: terms.slice(0, 12) },
      { label: "Definitions", value: defs.slice(0, 10).map(x => x.term) },
      { label: "Processes / sequences", value: patterns.process.slice(0, 8).map(x => x.text) },
      { label: "Cause → effect", value: patterns.causeEffect.slice(0, 8).map(x => x.text) },
      { label: "Compare / contrast", value: patterns.comparison.slice(0, 8).map(x => x.text) },
      { label: "Examples", value: patterns.examples.slice(0, 8).map(x => x.text) },
      { label: "Facts / numbers", value: patterns.facts.slice(0, 10).map(x => x.text) },
      { label: "Warnings / must-remember", value: patterns.warnings.slice(0, 8).map(x => x.text) }
    ];

    const checklist = [
      ...defs.slice(0, 8).map(d => `Define ${d.term} without looking.`),
      ...patterns.process.slice(0, 4).map(x => `Reconstruct the process from ${x.page ? `page ${x.page}` : "the source"}.`),
      ...patterns.causeEffect.slice(0, 3).map(x => `Explain the cause/effect relationship from ${x.page ? `page ${x.page}` : "the source"}.`),
      ...patterns.comparison.slice(0, 3).map(x => `Explain the comparison/contrast from ${x.page ? `page ${x.page}` : "the source"}.`),
      ...patterns.warnings.slice(0, 3).map(x => `Remember the warning or requirement from ${x.page ? `page ${x.page}` : "the source"}.`)
    ].slice(0, 22);

    return {
      engineVersion: ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
      overview: normalize(overview).slice(0, 2600) || "The material contains too little clean text for a reliable automatic summary. Use the visual material/captions or add a text-rich source.",
      strategy,
      definitions: defs,
      keyPoints: core,
      questions,
      pages,
      memory: memoryCues(terms, units),
      checklist,
      conceptMap: map,
      blueprint,
      patterns: {
        causeEffect: patterns.causeEffect.slice(0, 12),
        process: patterns.process.slice(0, 12),
        comparison: patterns.comparison.slice(0, 12),
        examples: patterns.examples.slice(0, 12),
        facts: patterns.facts.slice(0, 14),
        warnings: patterns.warnings.slice(0, 12)
      },
      terms: terms.slice(0, 50)
    };
  }

  function addCard(cards, seen, docId, type, question, answer, page, source, term = "", visual = null) {
    question = normalize(question); answer = normalize(answer);
    if (!question || !answer) return;
    const id = stableId("fc", `${docId}|${type}|${term}|${question}|${answer}`);
    if (seen.has(id)) return;
    seen.add(id);
    cards.push({ id, type, term, question, answer, page: page || null, source: source || "page", visual: visual || null });
  }

  function makeFlashcards(doc, reviewer) {
    const cards = [], seen = new Set(), units = buildUnits(doc);
    for (const d of reviewer.definitions.slice(0, 24)) addCard(cards, seen, doc.id, "definition", `What is "${d.term}"?`, d.definition, d.page, d.source, d.term);
    for (const d of reviewer.definitions.slice(0, 18)) {
      const u = termEvidence(d.term, units);
      if (u) addCard(cards, seen, doc.id, "evidence", `Which evidence in the material supports "${d.term}"?`, u.text, u.page, u.source, d.term);
    }
    for (const t of reviewer.terms.slice(0, 35)) {
      const u = termEvidence(t, units); if (!u) continue;
      const rx = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i");
      if (rx.test(u.text)) addCard(cards, seen, doc.id, "cloze", `Complete the statement:\n${u.text.replace(rx, "________")}`, t, u.page, u.source, t);
      addCard(cards, seen, doc.id, "explain", `Explain "${t}" using the source evidence.`, u.text, u.page, u.source, t);
    }
    for (const q of reviewer.questions) {
      const u = units.find(x => x.page === q.page) || units[0];
      if (u) addCard(cards, seen, doc.id, "study-question", q.q, u.text, u.page, u.source);
    }
    for (const k of reviewer.keyPoints.slice(0, 20)) addCard(cards, seen, doc.id, "main-idea", "What is the main idea of this evidence?", k.text, k.page, k.source);
    for (const m of doc.media || []) {
      const answer = m.caption || m.ocrText || "Study the visual and identify the concept, labels, relationships, or procedure it communicates.";
      addCard(cards, seen, doc.id, "visual", `What should you remember from the visual "${m.name}"?`, answer, null, "photo", "", m.id);
      if (m.ocrText) addCard(cards, seen, doc.id, "visual-ocr", `What important text can you recall from "${m.name}"?`, m.ocrText, null, "photo", "", m.id);
    }
    return cards.slice(0, 60);
  }

  function makeQuiz(doc, reviewer) {
    const quiz = [], seen = new Set(), terms = reviewer.terms.slice(0, 45), units = buildUnits(doc);
    const push = (type, question, context, correct, options, page) => {
      const key = `${type}|${question}|${correct}|${page}`;
      if (seen.has(key)) return;
      const unique = [...new Set([correct, ...options.filter(Boolean)])];
      if (unique.length < 2) return;
      const shuffled = unique.sort(() => Math.random() - 0.5).slice(0, 4);
      if (!shuffled.includes(correct)) shuffled.unshift(correct);
      quiz.push({ id: stableId("q", `${doc.id}|${key}`), type, question, context, options: shuffled, correctIndex: shuffled.indexOf(correct), correct, page: page || null });
      seen.add(key);
    };

    for (const d of reviewer.definitions.slice(0, 10)) {
      const wrong = terms.filter(t => t.toLowerCase() !== d.term.toLowerCase()).slice(0, 15).sort(() => Math.random() - 0.5).slice(0, 3);
      push("definition", `Which concept is best described by this explanation?`, d.definition, d.term, wrong, d.page);
    }
    for (const u of reviewer.keyPoints.slice(0, 8)) {
      const candidates = units.filter(x => x.text !== u.text).slice(0, 18).sort(() => Math.random() - 0.5).slice(0, 3).map(x => x.text);
      push("evidence", `Which statement matches the evidence being tested?`, u.text, u.text, candidates, u.page);
    }
    for (const t of reviewer.terms.slice(0, 10)) {
      const u = termEvidence(t, units); if (!u) continue;
      const others = terms.filter(x => x !== t).sort(() => Math.random() - 0.5).slice(0, 3);
      push("concept", `Which term best completes the statement?`, u.text, t, others, u.page);
    }
    for (const p of reviewer.patterns.causeEffect.slice(0, 3)) {
      const others = reviewer.patterns.causeEffect.filter(x => x.text !== p.text).map(x => x.text).slice(0, 12).sort(() => Math.random() - 0.5).slice(0, 3);
      push("cause-effect", `Which statement describes the cause/effect relationship being tested?`, p.text, p.text, others, p.page);
    }
    for (const m of doc.media || []) {
      if (quiz.length >= 24) break;
      const correct = m.caption || m.ocrText; if (!correct) continue;
      const wrong = reviewer.memory.map(x => x.clue).filter(Boolean).sort(() => Math.random() - 0.5).slice(0, 3);
      push("visual", `Which statement best matches the visual "${m.name}"?`, `Use the visual and its attached study evidence.`, correct, wrong, null);
    }
    return quiz.slice(0, 24);
  }

  function buildReviewerText(doc, r, cards, quiz) {
    const lines = [];
    lines.push(`STUDYVAULT — NEXT-GEN REVIEWER`);
    lines.push(`Source: ${doc.fileName}`);
    lines.push(`Generated: ${new Date(r.generatedAt).toLocaleString()}`);
    lines.push("");
    lines.push("CORE SUMMARY");
    lines.push(r.overview);
    lines.push("");
    lines.push("STUDY STRATEGY");
    lines.push(r.strategy);
    lines.push("");
    lines.push("KEY TERMS");
    r.terms.slice(0, 20).forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    lines.push("");
    lines.push("DEFINITIONS");
    r.definitions.slice(0, 16).forEach(d => lines.push(`• ${d.term}: ${d.definition}${d.page ? ` [Page ${d.page}]` : ""}`));
    lines.push("");
    lines.push("KEY EVIDENCE");
    r.keyPoints.slice(0, 18).forEach((x, i) => lines.push(`${i + 1}. ${x.text}${x.page ? ` [Page ${x.page}]` : ""}`));
    lines.push("");
    lines.push("PROCESS / SEQUENCE");
    r.patterns.process.slice(0, 8).forEach(x => lines.push(`• ${x.text}${x.page ? ` [Page ${x.page}]` : ""}`));
    lines.push("");
    lines.push("CAUSE → EFFECT");
    r.patterns.causeEffect.slice(0, 8).forEach(x => lines.push(`• ${x.text}${x.page ? ` [Page ${x.page}]` : ""}`));
    lines.push("");
    lines.push("COMPARE / CONTRAST");
    r.patterns.comparison.slice(0, 8).forEach(x => lines.push(`• ${x.text}${x.page ? ` [Page ${x.page}]` : ""}`));
    lines.push("");
    lines.push("MEMORY ANCHORS");
    r.memory.slice(0, 14).forEach(x => lines.push(`• ${x.term}: ${x.clue}`));
    lines.push("");
    lines.push("STUDY QUESTIONS");
    r.questions.slice(0, 18).forEach((q, i) => lines.push(`${i + 1}. ${q.q}${q.page ? ` [Page ${q.page}]` : ""}`));
    lines.push("");
    lines.push("EXAM CHECKLIST");
    r.checklist.slice(0, 18).forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    lines.push("");
    lines.push(`Practice set: ${cards.length} flashcards • ${quiz.length} quiz questions`);
    lines.push("");
    lines.push("EVIDENCE NOTE");
    lines.push("This reviewer is generated locally from extracted PDF/photo text and stored study material. Generated statements are deliberately evidence-linked rather than invented by a remote AI model.");
    return lines.join("\n");
  }

  function enhanceStyles() {
    if (document.getElementById("sv6-style")) return;
    const style = document.createElement("style");
    style.id = "sv6-style";
    style.textContent = `
      .sv6-shell{margin:14px 0;padding:18px;border:1px solid var(--border2);border-radius:20px;background:linear-gradient(135deg,rgba(124,108,255,.12),rgba(69,200,255,.05));}
      .sv6-head{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap}.sv6-title{margin:0;font-size:1.02rem}.sv6-sub{margin:4px 0 0;color:var(--muted);font-size:.77rem}.sv6-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}.sv6-stat{padding:13px;border:1px solid var(--border);border-radius:14px;background:var(--panel)}.sv6-stat strong{display:block;font-size:1.3rem}.sv6-stat span{color:var(--muted);font-size:.7rem}.sv6-map{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.sv6-node{padding:7px 9px;border-radius:10px;background:rgba(124,108,255,.10);border:1px solid rgba(124,108,255,.25);font-size:.72rem}.sv6-edge{opacity:.72;font-size:.7rem;color:var(--muted);padding:4px 0}.sv6-section{margin-top:12px;padding:14px;border:1px solid var(--border);border-radius:15px;background:var(--panel)}.sv6-section h4{margin:0 0 9px;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em}.sv6-list{display:grid;gap:7px;margin:0;padding:0;list-style:none}.sv6-list li{padding:9px 10px;border-radius:11px;background:var(--panel3);line-height:1.52;font-size:.79rem}.sv6-pill{display:inline-flex;align-items:center;padding:3px 7px;border-radius:999px;background:rgba(54,217,154,.1);color:#a8efd1;font-size:.63rem;margin-left:5px}.sv6-visual{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:10px}.sv6-visual img{width:100%;height:120px;object-fit:cover;border-radius:12px;border:1px solid var(--border)}
      @media(max-width:900px){.sv6-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.sv6-visual{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:520px){.sv6-grid{grid-template-columns:1fr}.sv6-visual{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    const section = $("#reviewer");
    if (!section || $("#sv6-panel")) return;
    const toolbar = section.querySelector(".toolbar");
    const panel = document.createElement("div");
    panel.id = "sv6-panel";
    panel.className = "sv6-shell";
    panel.innerHTML = `
      <div class="sv6-head"><div><h3 class="sv6-title">Next-Gen Evidence Engine</h3><p class="sv6-sub">Extractive + structure-aware processing. Every study point stays traceable to the source.</p></div><button id="sv6Rebuild" class="btn warning small">Deep Rebuild</button></div>
      <div id="sv6Stats" class="sv6-grid"></div>
      <div id="sv6Blueprint" class="sv6-section"></div>
      <div id="sv6Map" class="sv6-section"></div>
    `;
    toolbar?.after(panel);
    $("#sv6Rebuild").onclick = () => rebuild(true);
  }

  function renderAdvanced(doc) {
    const r = doc?.reviewerData;
    if (!r || r.engineVersion !== ENGINE_VERSION) return;
    ensurePanel();
    const stats = $("#sv6Stats");
    if (stats) {
      stats.innerHTML = [
        [r.terms?.length || 0, "Concepts"],
        [r.definitions?.length || 0, "Definitions"],
        [r.keyPoints?.length || 0, "Evidence points"],
        [doc.flashcards?.length || 0, "Flashcards"],
        [doc.quiz?.length || 0, "Quiz questions"],
        [r.questions?.length || 0, "Study questions"],
        [r.pages?.length || 0, "Page highlights"],
        [doc.media?.length || 0, "Visual sources"]
      ].map(([n,l]) => `<div class="sv6-stat"><strong>${esc(n)}</strong><span>${esc(l)}</span></div>`).join("");
    }
    const bp = $("#sv6Blueprint");
    if (bp) bp.innerHTML = `<h4>Exam Blueprint</h4><ul class="sv6-list">${(r.blueprint || []).map(x => `<li><strong>${esc(x.label)}</strong>${x.value?.length ? `<div class="tiny" style="margin-top:4px">${esc(x.value.slice(0,4).join(" • "))}${x.value.length > 4 ? " • …" : ""}</div>` : `<div class="tiny" style="margin-top:4px">No strong pattern detected</div>`}</li>`).join("")}</ul>`;
    const map = $("#sv6Map");
    if (map) map.innerHTML = `<h4>Concept Connections</h4><div class="sv6-map">${(r.conceptMap || []).length ? r.conceptMap.map(x => `<span class="sv6-node">${esc(x.from)}</span><span class="sv6-edge">↔ ${esc(x.to)} (${x.strength} co-occurrences)</span>`).join("") : `<span class="tiny">No strong co-occurrence links detected yet.</span>`}</div>`;

    const reviewerOverview = $("#reviewerOverview"); if (reviewerOverview) reviewerOverview.textContent = r.overview;
    const strategy = $("#reviewerStrategy"); if (strategy) strategy.textContent = r.strategy;
    const terms = $("#reviewerTerms"); if (terms) terms.innerHTML = (r.terms || []).slice(0, 50).map(t => `<span class="term">${esc(t)}</span>`).join("") || `<div class="empty">No strong concepts detected.</div>`;
    const defs = $("#reviewerDefinitions"); if (defs) defs.innerHTML = (r.definitions || []).slice(0, 18).map(d => `<div class="definition-card"><strong>${esc(d.term)}</strong><span>${esc(d.definition)}${d.page ? ` <span class="tiny">Page ${d.page}</span>` : ""}<span class="sv6-pill">${Math.round((d.confidence || 0) * 100)}% evidence</span></span></div>`).join("") || `<div class="empty">No high-confidence definition pattern was found.</div>`;
    const points = $("#reviewerKeyPoints"); if (points) points.innerHTML = (r.keyPoints || []).slice(0, 28).map(x => `<li>${esc(x.text)}${x.heading ? `<span class="meta">${esc(x.heading)}</span>` : ""}${x.page ? `<span class="meta">Page ${x.page}</span>` : ""}</li>`).join("") || `<li class="empty">No strong evidence points detected.</li>`;
    const qs = $("#reviewerQuestions"); if (qs) qs.innerHTML = (r.questions || []).slice(0, 22).map(q => `<div class="study-question"><strong style="font-size:.68rem;text-transform:uppercase;color:var(--primary2)">${esc(q.type || "study")}</strong><div style="margin-top:4px">${esc(q.q)}</div>${q.page ? `<span class="source-chip">Page ${q.page}</span>` : ""}</div>`).join("") || `<div class="empty">No study questions yet.</div>`;
    const pages = $("#reviewerPages"); if (pages) pages.innerHTML = (r.pages || []).map(p => `<li><strong>Page ${esc(p.page)}</strong><div style="margin-top:5px">${esc(p.text)}</div></li>`).join("") || `<li class="empty">No page highlights.</li>`;
    const mem = $("#reviewerMemory"); if (mem) mem.innerHTML = (r.memory || []).slice(0, 16).map(m => `<div class="memory-item"><strong>${esc(m.term)}</strong><span>${esc(m.clue)}${m.page ? ` <span class="tiny">Page ${m.page}</span>` : ""}</span></div>`).join("") || `<div class="empty">No memory anchors detected.</div>`;
    const check = $("#reviewerChecklist"); if (check) check.innerHTML = (r.checklist || []).slice(0, 20).map(x => `<li>${esc(x)}</li>`).join("") || `<li class="empty">No checklist yet.</li>`;
    renderPhotos(doc);
  }

  function renderPhotos(doc) {
    const box = $("#reviewerPhotos"); if (!box) return;
    const media = doc?.media || [];
    if (!media.length) { box.innerHTML = `<div class="photo-empty">No visual sources attached.</div>`; return; }
    box.innerHTML = media.map(m => `<div class="photo-card"><img src="${m.dataUrl}" alt="${esc(m.name)}"><div class="photo-body"><div class="photo-name">${esc(m.name)}</div><div class="photo-meta">${m.ocrText ? `OCR ${Math.round(m.confidence || 0)}%` : "No OCR text"}</div>${m.caption ? `<div class="tiny" style="margin-top:6px">Caption: ${esc(m.caption)}</div>` : ""}</div></div>`).join("");
  }

  async function activeDocument() {
    const meta = await get(META_STORE, SETTINGS_KEY);
    const id = meta?.activeDocId;
    const docs = await getAll(DOC_STORE);
    return docs.find(d => d.id === id) || docs[0] || null;
  }

  async function rebuild(reloadAfter) {
    const button = $("#regenerateReviewer");
    const old = button?.textContent;
    if (button) { button.disabled = true; button.textContent = "Building…"; }
    try {
      const doc = await activeDocument();
      if (!doc) { alert("Add a PDF or photo first."); return; }
      const reviewer = buildReviewer(doc);
      const cards = makeFlashcards(doc, reviewer);
      const quiz = makeQuiz(doc, reviewer);
      const known = new Set(Array.isArray(doc.knownCardIds) ? doc.knownCardIds : []);
      doc.terms = reviewer.terms;
      doc.reviewerData = reviewer;
      doc.reviewerText = buildReviewerText(doc, reviewer, cards, quiz);
      doc.flashcards = cards;
      doc.quiz = quiz;
      doc.knownCardIds = cards.map(c => c.id).filter(id => known.has(id));
      doc.currentCard = Math.min(Number(doc.currentCard) || 0, Math.max(0, cards.length - 1));
      doc.updatedAt = new Date().toISOString();
      await put(DOC_STORE, doc);
      if (reloadAfter) location.reload();
      else renderAdvanced(doc);
    } catch (err) {
      console.error("StudyVault Next-Gen Engine", err);
      alert(`Deep rebuild failed: ${err?.message || err}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = old || "Regenerate"; }
    }
  }

  async function ensureUpgraded() {
    const doc = await activeDocument();
    if (!doc) return null;
    if (doc.reviewerData?.engineVersion === ENGINE_VERSION) return doc;
    await rebuild(false);
    const upgraded = await activeDocument();
    return upgraded;
  }

  function wire() {
    enhanceStyles();
    ensurePanel();
    const original = $("#regenerateReviewer");
    if (original) original.onclick = () => rebuild(true);
  }

  async function start() {
    wire();
    const doc = await ensureUpgraded();
    if (doc) renderAdvanced(doc);
    setInterval(async () => {
      try {
        const current = await activeDocument();
        if (current?.reviewerData?.engineVersion === ENGINE_VERSION) renderAdvanced(current);
      } catch (_) {}
    }, 1200);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(start, 80));
  else setTimeout(start, 80);
})();
