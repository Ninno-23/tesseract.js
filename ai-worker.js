"use strict";

const HF_RUNTIME = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
const MODEL = "onnx-community/Qwen3-0.6B-ONNX";
let runtime = null;
let pipe = null;
let loading = null;
let cancelled = false;
let activeRequest = 0;

function post(type, data = {}) { self.postMessage({ type, ...data }); }
function cleanText(value) {
  return String(value ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, "")
    .replace(/^\s*```(?:markdown|md|text)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}
function isAndroid() { return /Android/i.test(self.navigator?.userAgent || ""); }
function deviceMemory() { return Number(self.navigator?.deviceMemory || 0); }
function cores() { return Number(self.navigator?.hardwareConcurrency || 0); }
function deviceProfile() {
  const android = isAndroid();
  const memory = deviceMemory();
  const cpu = cores();
  const gpu = !!self.navigator?.gpu;
  const conservative = android && ((memory && memory <= 4) || (cpu && cpu <= 4));
  return { android, memory, cpu, gpu, conservative };
}
function devicePreference() {
  const p = deviceProfile();
  // Android WebGPU is preferred only when the browser exposes it. Low-memory phones
  // still get a CPU/WASM path instead of risking a GPU allocation failure.
  return p.gpu && !p.conservative ? "webgpu" : "wasm";
}
function dtypeFor(device, attempt=0) {
  // q4 is the safer mobile WebGPU format; q4f16 is attempted only on capable devices.
  if (device === "webgpu") return attempt === 0 ? "q4" : "q4f16";
  return "q4";
}

async function getRuntime() {
  if (runtime) return runtime;
  if (loading) return loading;
  loading = (async () => {
    const mod = await import(HF_RUNTIME);
    if (mod.env) {
      mod.env.useBrowserCache = true;
      mod.env.allowRemoteModels = true;
      mod.env.allowLocalModels = false;
    }
    runtime = mod;
    return mod;
  })().finally(() => { loading = null; });
  return loading;
}

async function ensurePipeline() {
  if (pipe) return pipe;
  const mod = await getRuntime();
  const preferred = devicePreference();
  const profile = deviceProfile();
  post("device", { android: profile.android, memory: profile.memory, cpu: profile.cpu, gpu: profile.gpu, conservative: profile.conservative });
  const tryLoad = async (device, attempt=0) => {
    post("status", { message: `Loading on-device AI (${device === "webgpu" ? "mobile GPU" : "CPU/WASM"})…` });
    return mod.pipeline("text-generation", MODEL, {
      device,
      dtype: dtypeFor(device, attempt),
      progress_callback: (info) => {
        if (info?.status === "progress") {
          post("progress", {
            message: typeof info.progress === "number"
              ? `AI model download ${Math.round(info.progress)}%…`
              : `Downloading AI model…`,
            progress: typeof info.progress === "number" ? info.progress : null
          });
        } else if (info?.status) {
          post("status", { message: String(info.status) });
        }
      }
    });
  };
  try {
    pipe = await tryLoad(preferred, 0);
  } catch (firstError) {
    if (preferred === "webgpu") {
      try {
        post("status", { message: "Mobile GPU format was unavailable; trying a compatible GPU format…" });
        pipe = await tryLoad("webgpu", 1);
      } catch {
        post("status", { message: "GPU path unavailable; switching to CPU/WASM fallback…" });
        pipe = await tryLoad("wasm", 0);
      }
    } else {
      throw firstError;
    }
  }
  const actualDevice = preferred === "webgpu" && pipe ? "webgpu" : "wasm";
  post("ready", { model: MODEL, device: actualDevice, android: profile.android, conservative: profile.conservative });
  return pipe;
}

function sourceChunks(source, maxChars = 4800, maxChunks = 6) {
  const raw = String(source || "").replace(/\r/g, "").trim();
  if (!raw) return [];
  const pages = raw.split(/\n\s*---\s*\n|(?=\bPAGE\s+\d+\b)/i).map(s => s.trim()).filter(Boolean);
  const pieces = [];
  let current = "";
  for (const piece of pages.length > 1 ? pages : raw.split(/\n{2,}/)) {
    if (!piece.trim()) continue;
    if ((current.length + piece.length + 2) <= maxChars) {
      current += (current ? "\n\n" : "") + piece;
    } else {
      if (current) pieces.push(current);
      if (piece.length <= maxChars) current = piece;
      else {
        for (let i = 0; i < piece.length; i += maxChars) pieces.push(piece.slice(i, i + maxChars));
        current = "";
      }
    }
    if (pieces.length >= maxChunks) break;
  }
  if (current && pieces.length < maxChunks) pieces.push(current);
  return pieces.slice(0, maxChunks);
}

function parseGenerated(result) {
  const generated = result?.[0]?.generated_text;
  if (Array.isArray(generated)) {
    const last = generated.at(-1);
    return cleanText(last?.content || last?.text || "");
  }
  return cleanText(generated || "");
}

async function generate(messages, options = {}, requestId = 0) {
  const generator = await ensurePipeline();
  if (cancelled || requestId !== activeRequest) throw new Error("AI task cancelled.");
  const mod = runtime || await getRuntime();
  let streamed = "";
  const streamer = mod.TextStreamer
    ? new mod.TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: token => {
          if (cancelled || requestId !== activeRequest) return;
          streamed += token;
          post("token", { requestId, text: token });
        }
      })
    : undefined;
  const result = await generator(messages, {
    max_new_tokens: options.max_new_tokens || (deviceProfile().android ? 192 : 320),
    do_sample: false,
    return_full_text: false,
    streamer
  });
  if (cancelled || requestId !== activeRequest) throw new Error("AI task cancelled.");
  return cleanText(streamed || parseGenerated(result));
}

function groundingScore(output, source, terms = []) {
  const words = text => new Set(cleanText(text).toLowerCase().split(/[^a-z0-9'-]+/).filter(w => w.length >= 5));
  const a = words(output), b = words(source);
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const overlap = b.size ? Math.min(1, shared / Math.max(18, Math.min(150, b.size * 0.18))) : 0;
  const hits = terms.filter(t => output.toLowerCase().includes(String(t).toLowerCase())).length;
  const termScore = terms.length ? Math.min(1, hits / Math.min(8, terms.length)) : 0;
  const caveat = /not in the source|not enough information|source does not/i.test(output) ? .08 : 0;
  return Math.round(Math.min(1, overlap * .76 + termScore * .24 + caveat) * 100);
}

async function runReviewer(msg) {
  const source = String(msg.source || "").slice(0, 26000);
  const profile = String(msg.profile || "");
  const chunks = sourceChunks(source, 5200, 3);
  const summaries = [];

  for (let i = 0; i < chunks.length; i++) {
    if (cancelled) throw new Error("AI task cancelled.");
    post("status", { message: `Reading source section ${i + 1} of ${chunks.length}…` });
    const chunkSummary = await generate([
      { role: "system", content: "You are a careful academic study assistant. Summarize only facts present in SOURCE. Do not invent or add outside knowledge. Keep important terms, relationships, formulas, and warnings." },
      { role: "user", content: `Create a compact evidence summary for this SOURCE SECTION. Preserve exact technical meaning.\n\nSOURCE SECTION:\n${chunks[i]}` }
    ], { max_new_tokens: 150 }, msg.requestId);
    summaries.push(`SECTION ${i + 1}:\n${chunkSummary}`);
  }

  post("status", { message: "Synthesizing the complete reviewer…" });
  const finalPrompt = `Create a coherent, student-friendly study reviewer using ONLY the evidence below.

Return exactly these sections:
BIG PICTURE:
CORE IDEAS:
HOW IT WORKS:
WHAT TO MEMORIZE:
COMMON CONFUSIONS:
EXAM CRAM:
PERSONAL FOCUS:

Rules:
- Do not invent facts or citations.
- Keep formulas, names, definitions, and relationships faithful to the evidence.
- Merge repeated ideas.
- Prefer clear explanations over sentence copying.
- Personal Focus should prioritize weak concepts from the learner profile but still use only supported material.

LEARNER PROFILE:
${profile}

EVIDENCE PACK:
${summaries.join("\n\n")}

SOURCE EXCERPTS:
${source.slice(0, 9500)}`;
  const text = await generate([
    { role: "system", content: "You are a source-grounded study tutor. Accuracy is more important than creativity. If evidence is insufficient, say so." },
    { role: "user", content: finalPrompt }
  ], { max_new_tokens: 320 }, msg.requestId);
  return { text, score: groundingScore(text, source, msg.terms || []) };
}

async function runAsk(msg) {
  const source = String(msg.source || "").slice(0, 18000);
  const text = await generate([
    {
      role: "system",
      content:
        "You are an expert family study tutor — clear and structured like a great teacher. " +
        "Strong on English/essays, math, science, electronics circuit symbols, components, Ohm's law, and logic gates. " +
        "When STUDY MATERIAL is provided, answer from it first. For component sheets, reply as: **Name** then function in 1–3 clean sentences. " +
        "If material is thin, teach accurate foundational knowledge. Be encouraging and precise. Never invent page numbers."
    },
    {
      role: "user",
      content: `STUDENT QUESTION:\n${msg.question}\n\nSTUDY MATERIAL (may be empty or partial):\n${source || "(none loaded — use general curriculum knowledge)"}`
    }
  ], { max_new_tokens: 280 }, msg.requestId);
  // Grounding is softer when source is empty — still return a score for UI
  const score = source.trim() ? groundingScore(text, source, msg.terms || []) : 70;
  return { text, score };
}

let loadAbort = null;

self.onmessage = async event => {
  const msg = event.data || {};
  if (msg.type === "cancel") {
    cancelled = true;
    activeRequest = 0;
    try { loadAbort?.abort?.(); } catch {}
    loadAbort = null;
    // Drop in-flight pipeline reference so a later load starts clean
    loading = null;
    post("cancelled");
    return;
  }
  if (msg.type === "load") {
    cancelled = false;
    loadAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    try {
      await ensurePipeline();
      if (cancelled) post("cancelled");
    } catch (error) {
      if (!cancelled) post("error", { message: error?.message || String(error) });
    }
    return;
  }
  if (msg.type !== "task") return;
  activeRequest = Number(msg.requestId || Date.now());
  cancelled = false;
  try {
    const result = msg.task === "reviewer" ? await runReviewer(msg) : await runAsk(msg);
    if (cancelled || Number(msg.requestId) !== activeRequest) {
      post("cancelled");
      return;
    }
    post("done", { requestId: msg.requestId, text: result.text, groundingScore: result.score, model: MODEL, device: self.navigator?.gpu ? "webgpu" : "wasm" });
  } catch (error) {
    if (!cancelled) post("error", { requestId: msg.requestId, message: error?.message || String(error) });
  }
};
