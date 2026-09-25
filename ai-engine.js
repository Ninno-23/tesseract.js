(() => {
  "use strict";

  const LIB_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
  const DEFAULT_MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";
  let runtimePromise = null;
  let generator = null;
  let runtimeInfo = { loaded: false, device: "unknown", model: DEFAULT_MODEL, error: "" };

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const words = (s) => norm(s).toLowerCase().split(/[^a-z0-9'-]+/).filter(Boolean);

  function notify(kind, payload) {
    try { window.dispatchEvent(new CustomEvent(`studyvault:ai:${kind}`, { detail: payload })); } catch {}
  }

  function deviceChoice() {
    return navigator.gpu ? "webgpu" : "wasm";
  }

  async function loadRuntime(progress) {
    if (generator) return generator;
    if (runtimePromise) return runtimePromise;

    runtimePromise = (async () => {
      try {
        const mod = await import(LIB_URL);
        if (mod.env) {
          mod.env.useBrowserCache = true;
          mod.env.allowLocalModels = false;
        }
        const device = deviceChoice();
        progress?.({ stage: "runtime", message: `Loading local AI runtime (${device.toUpperCase()})…` });
        notify("progress", { stage: "runtime", message: `Loading local AI runtime (${device.toUpperCase()})…` });

        try {
          generator = await mod.pipeline("text-generation", DEFAULT_MODEL, {
            device,
            dtype: "q4",
            progress_callback: (p) => {
              if (p?.status === "progress") {
                const percent = typeof p.progress === "number" ? Math.round(p.progress) : null;
                progress?.({ stage: "model", message: percent == null ? "Downloading model…" : `Downloading model… ${percent}%`, percent });
                notify("progress", { stage: "model", message: percent == null ? "Downloading model…" : `Downloading model… ${percent}%`, percent });
              } else if (p?.status) {
                progress?.({ stage: "model", message: String(p.status) });
              }
            }
          });
        } catch (webgpuError) {
          if (device !== "wasm") {
            progress?.({ stage: "fallback", message: "WebGPU model load failed. Falling back to CPU/WASM…" });
            notify("progress", { stage: "fallback", message: "WebGPU model load failed. Falling back to CPU/WASM…" });
            generator = await mod.pipeline("text-generation", DEFAULT_MODEL, {
              device: "wasm",
              dtype: "q4",
              progress_callback: (p) => {
                if (p?.status === "progress") {
                  const percent = typeof p.progress === "number" ? Math.round(p.progress) : null;
                  progress?.({ stage: "model", message: percent == null ? "Downloading model…" : `Downloading model… ${percent}%`, percent });
                }
              }
            });
            runtimeInfo.device = "wasm";
          } else throw webgpuError;
        }

        runtimeInfo.loaded = true;
        runtimeInfo.device = runtimeInfo.device === "unknown" ? device : runtimeInfo.device;
        runtimeInfo.model = DEFAULT_MODEL;
        runtimeInfo.error = "";
        notify("ready", runtimeInfo);
        return generator;
      } catch (error) {
        runtimeInfo.loaded = false;
        runtimeInfo.error = error?.message || String(error);
        runtimePromise = null;
        generator = null;
        notify("error", runtimeInfo);
        throw new Error(`Local AI could not start: ${runtimeInfo.error}`);
      }
    })();

    return runtimePromise;
  }

  function sourceDigest(doc, maxChars = 12000) {
    const parts = [];
    for (const p of (doc.pageTexts || [])) {
      const text = norm(p.text || "");
      if (text) parts.push(`PAGE ${p.page}\n${text.slice(0, 1000)}`);
      if (parts.join("\n\n").length >= maxChars) break;
    }
    if (!parts.length && doc.rawText) parts.push(norm(doc.rawText).slice(0, maxChars));
    return parts.join("\n\n").slice(0, maxChars);
  }

  function learnerDigest(profile) {
    const concepts = Object.entries(profile?.concepts || {})
      .map(([concept, s]) => ({ concept, ...s }))
      .sort((a, b) => (a.mastery || 0) - (b.mastery || 0));
    const weak = concepts.slice(0, 10).filter(x => x.concept);
    const strengths = concepts.slice(-5).reverse().filter(x => x.concept);
    return [
      `Learner level: ${profile?.level || "beginner"}`,
      `Study sessions: ${profile?.sessions || 0}`,
      weak.length ? `Weak/review concepts: ${weak.map(x => `${x.concept} (${Math.round((x.mastery || 0) * 100)}%)`).join(", ")}` : "Weak/review concepts: none recorded yet",
      strengths.length ? `Strong concepts: ${strengths.map(x => x.concept).join(", ")}` : "Strong concepts: none recorded yet",
      `Recent quiz accuracy: ${profile?.recentAccuracy == null ? "unknown" : `${Math.round(profile.recentAccuracy * 100)}%`}`
    ].join("\n");
  }

  function cleanGenerated(text) {
    let t = String(text || "");
    t = t.replace(/^```(?:markdown|md|text)?/i, "").replace(/```$/i, "").trim();
    t = t.replace(/\bI can't\b.*?\n/gi, "");
    return t.trim();
  }

  function groundingScore(output, source, terms = []) {
    const ow = new Set(words(output));
    const sw = new Set(words(source));
    let shared = 0;
    for (const w of ow) if (sw.has(w) && w.length >= 5) shared++;
    const coverage = sw.size ? clamp(shared / Math.max(25, Math.min(180, sw.size * 0.35)), 0, 1) : 0;
    const termHits = terms.slice(0, 18).filter(t => output.toLowerCase().includes(String(t).toLowerCase())).length;
    const termScore = terms.length ? clamp(termHits / Math.min(12, terms.length), 0, 1) : 0;
    return Math.round((coverage * .65 + termScore * .35) * 100);
  }

  async function generate(prompt, options = {}, progress) {
    const pipe = await loadRuntime(progress);
    const maxTokens = options.max_new_tokens || 420;
    const temperature = options.temperature ?? 0.2;
    const output = await pipe([
      { role: "system", content: "You are StudyVault Local Tutor. You may ONLY use facts supported by the SOURCE MATERIAL. Never invent citations, definitions, formulas, examples, or names. When evidence is insufficient, explicitly say that the source does not provide enough information. Prefer concise, student-friendly explanations." },
      { role: "user", content: prompt }
    ], {
      max_new_tokens: maxTokens,
      do_sample: temperature > 0.01,
      temperature,
      return_full_text: false
    });
    let text = "";
    const value = output?.[0]?.generated_text;
    if (Array.isArray(value)) text = value.at(-1)?.content || value.at(-1)?.text || "";
    else text = value || "";
    return cleanGenerated(text);
  }

  function parseCards(text) {
    const cards = [];
    const lines = String(text || "").split(/\r?\n/);
    let q = "", a = "", t = "", page = null;
    const flush = () => {
      if (norm(q).length > 7 && norm(a).length > 2) cards.push({ question: norm(q), answer: norm(a), term: norm(t), page: page ? Number(page) || null : null, source: "local-ai" });
      q = a = t = ""; page = null;
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (/^CARD\b/i.test(line)) { flush(); continue; }
      const qm = line.match(/^Q\s*[:|]\s*(.+)$/i); if (qm) { q = qm[1]; continue; }
      const am = line.match(/^A\s*[:|]\s*(.+)$/i); if (am) { a = am[1]; continue; }
      const tm = line.match(/^T\s*[:|]\s*(.+)$/i); if (tm) { t = tm[1]; continue; }
      const pm = line.match(/^P(?:AGE)?\s*[:|]\s*(\d+)/i); if (pm) { page = pm[1]; continue; }
    }
    flush();
    return cards.slice(0, 16);
  }

  function parseQuiz(text) {
    const items = [];
    const blocks = String(text || "").split(/(?:^|\n)Q\d*\s*[:.)]\s*/i).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (!lines.length) continue;
      const question = lines.shift();
      const opts = [];
      let answer = "";
      let page = null;
      for (const line of lines) {
        const om = line.match(/^[A-D]\s*[-.):]\s*(.+)$/i);
        if (om) { opts.push(om[1].trim()); continue; }
        const cm = line.match(/^ANSWER\s*[:|-]\s*(.+)$/i); if (cm) { answer = cm[1].trim(); continue; }
        const pm = line.match(/^PAGE\s*[:|-]\s*(\d+)/i); if (pm) { page = Number(pm[1]) || null; }
      }
      if (question.length > 8 && opts.length >= 3 && answer) {
        const idx = opts.findIndex(x => x.toLowerCase() === answer.toLowerCase());
        if (idx >= 0) items.push({ question, options: opts.slice(0, 4), correctIndex: idx, correct: opts[idx], page, type: "local-ai" });
      }
    }
    return items.slice(0, 10);
  }

  async function enhanceDocument(doc, profile, options = {}) {
    const source = sourceDigest(doc, options.maxChars || 12000);
    if (!source) throw new Error("No source text is available for local AI.");
    const terms = (doc.terms || []).slice(0, 24);
    const evidence = learnerDigest(profile || {});
    const mode = doc.summaryMode || "standard";
    const prompt = `Create a source-grounded study reviewer from the SOURCE MATERIAL below. This is ${mode} mode. The reviewer must be a rewrite, not a copy-paste list of sentences.\n\nRequired structure:\n1. BIG PICTURE — 1 compact paragraph.\n2. CORE IDEAS — 5-10 bullets with the concept and what the source says about it.\n3. WHAT TO REMEMBER — 5-8 high-value facts.\n4. CONFUSION ALERTS — only if the source contains easily confused ideas.\n5. EXAM CRAM — 5-8 bullets.\n6. PERSONAL FOCUS — prioritize the learner's weak concepts when they are supported by the source.\n\nTERMS FOUND BY THE NON-AI ANALYZER:\n${terms.join(", ")}\n\nLEARNER PROFILE:\n${evidence}\n\nSOURCE MATERIAL:\n${source}`;
    const generated = await generate(prompt, { max_new_tokens: mode === "deep" ? 700 : 520, temperature: .12 }, options.progress);
    const score = groundingScore(generated, source, terms);
    const ai = {
      enabled: true,
      generatedAt: new Date().toISOString(),
      model: DEFAULT_MODEL,
      device: runtimeInfo.device,
      groundingScore: score,
      reviewer: generated,
      cards: [],
      quiz: []
    };

    if (score < 18) {
      throw new Error("The local model returned content with too little source overlap. The safer deterministic reviewer was kept.");
    }

    const cardPrompt = `Using ONLY the SOURCE MATERIAL, generate 8-12 flashcards. Use exactly this format for each card:\nCARD\nQ: question\nA: answer\nT: key term (optional)\nP: page number (optional)\nDo not add commentary.\n\nSOURCE MATERIAL:\n${source}`;
    try { ai.cards = parseCards(await generate(cardPrompt, { max_new_tokens: 520, temperature: .08 }, options.progress)); } catch {}

    const quizPrompt = `Using ONLY the SOURCE MATERIAL, create 6-8 multiple-choice questions. Use exactly:\nQ1: question\nA) option\nB) option\nC) option\nD) option\nANSWER: exact correct option text\nPAGE: page number if known\nRepeat for each question. No commentary.\n\nSOURCE MATERIAL:\n${source}`;
    try { ai.quiz = parseQuiz(await generate(quizPrompt, { max_new_tokens: 700, temperature: .08 }, options.progress)); } catch {}

    return ai;
  }

  async function ask(doc, profile, question, options = {}) {
    const source = sourceDigest(doc, options.maxChars || 9000);
    if (!source) throw new Error("No source material available.");
    const context = learnerDigest(profile || {});
    return generate(`Answer this student's question using ONLY the SOURCE MATERIAL.\n\nSTUDENT QUESTION:\n${question}\n\nLEARNER PROFILE:\n${context}\n\nSOURCE MATERIAL:\n${source}`, { max_new_tokens: options.max_new_tokens || 350, temperature: .15 }, options.progress);
  }

  window.StudyVaultAI = {
    model: DEFAULT_MODEL,
    getRuntimeInfo: () => ({ ...runtimeInfo }),
    isReady: () => Boolean(generator),
    isSupported: () => Boolean(navigator.gpu || typeof Worker !== "undefined"),
    load: (progress) => loadRuntime(progress),
    enhanceDocument,
    ask,
    resetRuntime: () => { generator = null; runtimePromise = null; runtimeInfo = { loaded: false, device: "unknown", model: DEFAULT_MODEL, error: "" }; }
  };
})();
