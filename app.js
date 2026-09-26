
(() => {
"use strict";

const APP_VERSION = 27;
const BUILD_ID = "2026-09-26-wise-tutor-v27";
const MAX_FLASHCARDS = 200;
const VERSION_URL = "./version.json";
const DB_NAME = "studyvault-v5";
const DB_VERSION = 3;
const SCHEMA_VERSION = 3;
const CDN_TESSERACT_WORKER = "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js";
const LOCAL_TESSERACT = "./vendor/tesseract/tesseract.min.js";
const DOC_STORE = "documents";
const META_STORE = "meta";
const SETTINGS_KEY = "settings";
const CDN_PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const CDN_PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const CDN_TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js";
const LOCAL_PDFJS = "./vendor/pdfjs/pdf.min.js";
const LOCAL_PDF_WORKER = "./vendor/pdfjs/pdf.worker.min.js";
const AI_WORKER_URL = "./ai-worker.js";

let pdfEnginePromise = null;
let tesseractPromise = null;
let tesseractWorker = null;
let noteSaveToken = 0;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clamp = (n,min,max) => Math.max(min,Math.min(max,n));
const esc = v => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
/** Keep scientific / math symbols; only tidy whitespace. Never strip Ω Δ → ≤ etc. */
const normalize = v => String(v ?? "")
  .replace(/\u00a0/g," ")
  .replace(/\u2028|\u2029/g,"\n")
  .replace(/[ \t]+/g," ")
  .replace(/\n{3,}/g,"\n\n")
  .trim();
const wordCount = v => normalize(v) ? normalize(v).split(/\s+/).length : 0;
const debounce = (fn, ms=850) => { let t; return (...args) => { clearTimeout(t); t=setTimeout(()=>fn(...args),ms); }; };

/**
 * Repair symbols lost or mangled by PDF fonts and OCR.
 * Maps common OCR/PDF garbage → real math/chem symbols the family can study.
 */
function repairSymbols(text){
  let t=String(text??"");
  if(!t)return "";
  // Ligatures / private-use junk → readable forms
  t=t.replace(/ﬁ/g,"fi").replace(/ﬂ/g,"fl").replace(/ﬀ/g,"ff").replace(/ﬃ/g,"ffi").replace(/ﬄ/g,"ffl");
  // OCR arrow / relation mistakes
  t=t.replace(/(?:-{1,3}>|–>|—>|=>)/g,"→");
  t=t.replace(/(?:<-{1,3}|<–|<—|<=)/g,"←");
  t=t.replace(/<->|<–>|↔/g,"↔");
  t=t.replace(/(?:!=|≠)/g,"≠");
  t=t.replace(/(?:<=|≤)/g,"≤");
  t=t.replace(/(?:>=|≥)/g,"≥");
  t=t.replace(/(?:\approx|~=)/g,"≈");
  t=t.replace(/(?:\+\/-|±)/g,"±");
  t=t.replace(/(?:x\s*(?=10\^)|×)/gi,"×");
  // Degree / percent / micro that OCR mangles
  t=t.replace(/(\d)\s*[oº°]\s*([CF])/g,"$1°$2");
  t=t.replace(/(\d)\s*deg(?:rees?)?\b/gi,"$1°");
  t=t.replace(/\bmu\b(?=\s*[A-Za-z])/gi,"μ");
  t=t.replace(/\bmicro-?/gi,"μ");
  // Chemistry / subscripts often OCR'd as normal digits after element
  t=t.replace(/\b(H|O|N|C|S|P|Cl|Br|I|Na|K|Ca|Mg|Fe|Cu|Zn|Ag|Al|Si)(\d{1,2})\b/g,(_,el,n)=>el+n);
  // Greek letter names OCR'd as words in formula contexts
  t=t.replace(/\balpha\b/gi,"α").replace(/\bbeta\b/gi,"β").replace(/\bgamma\b/gi,"γ")
    .replace(/\bdelta\b/gi,"δ").replace(/\bDelta\b/g,"Δ").replace(/\btheta\b/gi,"θ")
    .replace(/\blambda\b/gi,"λ").replace(/\bmu\b/gi,"μ").replace(/\bpi\b(?![a-z])/gi,"π")
    .replace(/\bsigma\b/gi,"σ").replace(/\bomega\b/gi,"ω").replace(/\bOmega\b/g,"Ω")
    .replace(/\bphi\b/gi,"φ").replace(/\brho\b/gi,"ρ");
  // Ohm / infinity
  t=t.replace(/\bohm(?:s)?\b/gi,"Ω").replace(/\binfinity\b/gi,"∞");
  // ——— Electrical / electronics symbols & unit OCR repair ———
  t=t.replace(/\bkilo-?ohms?\b/gi,"kΩ").replace(/\bmega-?ohms?\b/gi,"MΩ").replace(/\bmilli-?ohms?\b/gi,"mΩ");
  t=t.replace(/(\d)\s*(kohm|kohms|k ohm)\b/gi,"$1kΩ");
  t=t.replace(/(\d)\s*(Mohm|Mohms|M ohm)\b/gi,"$1MΩ");
  t=t.replace(/(\d)\s*ohms?\b/gi,"$1Ω");
  t=t.replace(/\bmicro\s*farad/gi,"μF").replace(/\bnanofarad/gi,"nF").replace(/\bpico\s*farad/gi,"pF");
  t=t.replace(/(\d)\s*uF\b/gi,"$1μF").replace(/(\d)\s*uf\b/g,"$1μF");
  t=t.replace(/(\d)\s*uH\b/gi,"$1μH").replace(/\bmicro\s*henry/gi,"μH");
  t=t.replace(/\bmilli\s*amp(?:ere)?s?\b/gi,"mA").replace(/\bmicro\s*amp(?:ere)?s?\b/gi,"μA");
  t=t.replace(/(\d)\s*mA\b/g,"$1mA").replace(/(\d)\s*uA\b/gi,"$1μA");
  t=t.replace(/\bkilo\s*hertz/gi,"kHz").replace(/\bmega\s*hertz/gi,"MHz").replace(/\bgiga\s*hertz/gi,"GHz");
  t=t.replace(/\bvolt(?:s)?\s*amp(?:ere)?s?\b/gi,"VA");
  t=t.replace(/\bAC\s*ground\b/gi,"⏚").replace(/\bearth\s*ground\b/gi,"⏚");
  // Ohm's law spacing: V = I R → V = IR style keep readable
  t=t.replace(/\bV\s*=\s*I\s*[*·×x]?\s*R\b/gi,"V = IR");
  t=t.replace(/\bI\s*=\s*V\s*\/\s*R\b/gi,"I = V/R");
  t=t.replace(/\bP\s*=\s*V\s*[*·×x]?\s*I\b/gi,"P = VI");
  t=t.replace(/\bP\s*=\s*I\s*\^\s*2\s*[*·×x]?\s*R\b/gi,"P = I²R");
  t=t.replace(/\bP\s*=\s*V\s*\^\s*2\s*\/\s*R\b/gi,"P = V²/R");
  // Square / cube roots written out
  t=t.replace(/\bsqrt\s*\(/gi,"√(").replace(/\bcube\s*root\s*\(/gi,"∛(");
  t=t.replace(/\^(\d+)/g,"^$1");
  t=t.replace(/\b([A-Z][a-z]?)\s+(\d)\b/g,"$1$2");
  t=t.replace(/\b([A-Z][a-z]?\d*)\s*\+\s*/g,"$1 + ");
  return normalize(t);
}

/** Tokens for search/ranking — keep short symbol tokens (Ω, Δ, →, μF) so formulas still match. */
function tokenize(text){
  const raw=normalize(text).toLowerCase();
  const words=raw
    .replace(/[^a-z0-9\s'\-α-ωΑ-Ω°±×÷≤≥≠≈→←↔∞√∛μΩΔφρφ]/g," ")
    .split(/\s+/)
    .filter(Boolean);
  const formulas=(String(text).match(/[A-Za-z]{1,3}\d{1,3}|[A-Za-z]\s*=\s*[^\s,]{1,24}|\d+\s*(?:[%°]|k?Ω|MΩ|mA|μA|μF|nF|pF|μH|kHz|MHz|GHz|V|A|W)|[α-ωΑ-ΩΔμπσθλΣΩφρ]/g)||[])
    .map(x=>x.toLowerCase().replace(/\s+/g,""));
  return [...words,...formulas];
}

/**
 * Built-in subject knowledge for Instant Tutor (works offline, no model download).
 * Prefer uploaded source when it matches; otherwise teach from this curriculum.
 */
const DOMAIN_KB = [
  // —— Electronics ——
  {keys:["ohm","ohm's law","ohms law","v=ir","voltage current resistance"],domain:"electronics",
    answer:"Ohm's law: **V = IR**\n• V = voltage (volts, V)\n• I = current (amperes, A)\n• R = resistance (ohms, Ω)\nAlso: I = V/R and R = V/I.\nPower: **P = VI = I²R = V²/R** (watts, W)."},
  {keys:["resistor","resistance","colour code","color code"],domain:"electronics",
    answer:"A **resistor** limits current. Symbol often looks like a zigzag (US) or rectangle (IEC). Unit: **ohm (Ω)**.\nSeries: R_total = R1 + R2 + …\nParallel: 1/R_total = 1/R1 + 1/R2 + …"},
  {keys:["capacitor","capacitance","farad","μf","uf"],domain:"electronics",
    answer:"A **capacitor** stores charge. Unit: **farad (F)** — usually μF, nF, pF.\nEnergy: E = ½CV².\nIn DC steady state an ideal capacitor acts open; it passes AC changes."},
  {keys:["inductor","inductance","henry","coil"],domain:"electronics",
    answer:"An **inductor** stores energy in a magnetic field. Unit: **henry (H)**.\nOpposes change in current. Energy: E = ½LI²."},
  {keys:["diode","led","rectifier"],domain:"electronics",
    answer:"A **diode** allows current mainly in one direction (anode → cathode when forward biased).\nLED = light-emitting diode. Always check polarity; reverse voltage can damage it."},
  {keys:["transistor","bjt","mosfet","npn","pnp"],domain:"electronics",
    answer:"A **transistor** amplifies or switches.\n• BJT (NPN/PNP): current-controlled; terminals base, collector, emitter.\n• MOSFET: voltage-controlled; gate, drain, source — common in digital power switching."},
  {keys:["ac","dc","alternating","direct current"],domain:"electronics",
    answer:"**DC** flows one way (batteries). **AC** reverses direction (mains). Mains frequency is often 50 or 60 Hz. Transformers work with AC, not steady DC."},
  {keys:["kirchhoff","kcl","kvl"],domain:"electronics",
    answer:"**KCL**: current into a node equals current out.\n**KVL**: sum of voltages around a closed loop is zero.\nThese plus Ohm's law solve most basic circuits."},
  {keys:["ground","earth","common"],domain:"electronics",
    answer:"**Ground / earth** is the reference node (0 V) for measuring other voltages. Circuit diagrams mark it with ground symbols. Safety earth protects people; signal ground is a reference."},
  {keys:["series","parallel","circuit"],domain:"electronics",
    answer:"**Series**: same current through each part; voltages add.\n**Parallel**: same voltage across each branch; currents add.\nMixes are solved section by section using Ohm + Kirchhoff."},
  // —— Digital logic gates ——
  {keys:["logic gate","logic gates","digital logic","boolean gate"],domain:"electronics",
    answer:"**Logic gates** are digital building blocks. Inputs and outputs are binary levels (0/1, LOW/HIGH).\nCommon gates: **NOT, AND, OR, NAND, NOR, XOR, XNOR**.\nRemember: NAND and NOR are *universal* — any circuit can be built from only NAND, or only NOR."},
  {keys:["not gate","inverter","logic not","boolean not"],domain:"electronics",
    answer:"**NOT (inverter)** — 1 input.\n• Output is the opposite of the input.\nTruth: 0→1, 1→0.\nBoolean: Y = NOT A  or  Y = Ā\nSymbol: triangle pointing right with a small circle (bubble) on the output."},
  {keys:["and gate","logic and","boolean and"],domain:"electronics",
    answer:"**AND** — output is 1 only if **all** inputs are 1.\n2-input truth:\nA B | Y\n0 0 | 0\n0 1 | 0\n1 0 | 0\n1 1 | 1\nBoolean: Y = A · B  (or A AND B)\nSymbol: D-shaped (flat input side, curved output)."},
  {keys:["or gate","logic or","boolean or"],domain:"electronics",
    answer:"**OR** — output is 1 if **any** input is 1.\n2-input truth:\nA B | Y\n0 0 | 0\n0 1 | 1\n1 0 | 1\n1 1 | 1\nBoolean: Y = A + B  (or A OR B)\nSymbol: curved input side, pointed output."},
  {keys:["nand gate","nand"],domain:"electronics",
    answer:"**NAND** = NOT-AND — output is 0 only when **all** inputs are 1 (AND then invert).\n2-input truth:\nA B | Y\n0 0 | 1\n0 1 | 1\n1 0 | 1\n1 1 | 0\nBoolean: Y = NOT (A · B)\nSymbol: AND shape + bubble on output. **Universal gate.**"},
  {keys:["nor gate","nor"],domain:"electronics",
    answer:"**NOR** = NOT-OR — output is 1 only when **all** inputs are 0 (OR then invert).\n2-input truth:\nA B | Y\n0 0 | 1\n0 1 | 0\n1 0 | 0\n1 1 | 0\nBoolean: Y = NOT (A + B)\nSymbol: OR shape + bubble on output. **Universal gate.**"},
  {keys:["xor gate","xor","exclusive or"],domain:"electronics",
    answer:"**XOR (exclusive OR)** — output is 1 when inputs are **different**.\n2-input truth:\nA B | Y\n0 0 | 0\n0 1 | 1\n1 0 | 1\n1 1 | 0\nBoolean: Y = A ⊕ B = A·B̄ + Ā·B\nUsed in adders and parity. Symbol: OR shape with an extra curved line on the input side."},
  {keys:["xnor gate","xnor","exclusive nor"],domain:"electronics",
    answer:"**XNOR** — output is 1 when inputs are the **same** (NOT of XOR).\n2-input truth:\nA B | Y\n0 0 | 1\n0 1 | 0\n1 0 | 0\n1 1 | 1\nBoolean: Y = A ⊙ B = A·B + Ā·B̄\nSymbol: XOR shape + bubble on output."},
  {keys:["truth table","boolean algebra","boolean"],domain:"electronics",
    answer:"A **truth table** lists every input combination and the output.\nn inputs → 2ⁿ rows.\nBoolean algebra basics:\n• Identity: A+0=A, A·1=A\n• Null: A+1=1, A·0=0\n• Idempotent: A+A=A, A·A=A\n• Complement: A+Ā=1, A·Ā=0\n• De Morgan: NOT(A·B)=Ā+B̄ , NOT(A+B)=Ā·B̄"},
  {keys:["de morgan","demorgan"],domain:"electronics",
    answer:"**De Morgan's laws**\n1. NOT (A AND B) = (NOT A) OR (NOT B)\n2. NOT (A OR B) = (NOT A) AND (NOT B)\nIn symbols: (A·B)̄ = Ā + B̄  and  (A+B)̄ = Ā · B̄\nUseful when converting NAND/NOR networks."},
  {keys:["combinational","sequential","flip flop","latch"],domain:"electronics",
    answer:"**Combinational** logic: outputs depend only on current inputs (gates only).\n**Sequential** logic: outputs also depend on past state — needs memory (latches, flip-flops).\nA basic **SR latch** remembers a bit; clocked **flip-flops** update on a clock edge."},
  {keys:["ttl","cmos","logic level","high low"],domain:"electronics",
    answer:"Digital levels are **HIGH (1)** and **LOW (0)** within voltage ranges set by the family (e.g. TTL, CMOS).\nNever assume exact 5 V or 3.3 V without checking the datasheet. Floating inputs on CMOS can cause bad behavior — tie unused inputs to a valid level."},
  // end logic gates
  // —— Circuit symbols (from standard electronics sheets) ——
  {keys:["wire","wires joined","wires not joined"],domain:"electronics",
    answer:"**Wire** passes current easily between parts of a circuit.\n**Wires joined** are shown with a blob at the connection (stagger crossroads into T-junctions).\n**Wires not joined** may use a bridge symbol so a crossing is not mistaken for a join."},
  {keys:["cell","battery","dc supply","ac supply"],domain:"electronics",
    answer:"**Cell** supplies energy; the larger terminal is positive (+). One cell is often called a battery, but a **battery** is two or more cells.\n**DC supply** = current always one direction. **AC supply** = current continually reverses."},
  {keys:["fuse"],domain:"electronics",
    answer:"A **fuse** is a safety device that blows (melts) if current exceeds a set value, protecting the rest of the circuit."},
  {keys:["transformer"],domain:"electronics",
    answer:"A **transformer** has two coils linked by an iron core. It steps AC voltages up or down. Energy transfers by magnetic field — no direct electrical connection between coils."},
  {keys:["earth","ground"],domain:"electronics",
    answer:"**Earth (ground)** is a connection to earth / 0 V reference. In many circuits it is the 0 V of the supply; for mains it can mean true earth."},
  {keys:["lamp","heater","motor","bell","buzzer"],domain:"electronics",
    answer:"These are **output transducers**:\n• **Lamp** — electrical energy → light (lighting vs indicator symbols differ)\n• **Heater** — electrical energy → heat\n• **Motor** — electrical energy → motion\n• **Bell / buzzer** — electrical energy → sound"},
  {keys:["push switch","push-to-break","spst","spdt","dpst","dpdt","relay","on-off switch"],domain:"electronics",
    answer:"**Switches** control current paths.\n• Push-to-make: on only while pressed\n• Push-to-break: off only while pressed\n• SPST: simple on-off\n• SPDT: 2-way changeover\n• DPST/DPDT: double-pole (often mains / motor reverse)\n• **Relay**: electrically operated switch (coil can switch a higher-voltage circuit); NO / COM / NC contacts"},
  {keys:["variable resistor","rheostat","potentiometer","preset"],domain:"electronics",
    answer:"**Resistor** restricts current (e.g. limit LED current).\n• **Rheostat** (2 contacts) — usually control current\n• **Potentiometer** (3 contacts) — usually control voltage / position signal\n• **Preset** — set once with a screwdriver, cheaper for projects"},
  {keys:["polarised capacitor","variable capacitor","trimmer capacitor"],domain:"electronics",
    answer:"**Capacitor** stores charge; used in timing with a resistor; can block DC and pass AC.\n**Polarised** types must be connected the correct way round.\n**Variable / trimmer** capacitors are used in radio tuning / set-and-forget adjustment."},
  {keys:["zener","photodiode","led","light emitting"],domain:"electronics",
    answer:"**Diode** allows current mainly one way.\n**LED** converts electrical energy to light.\n**Zener diode** holds a fixed voltage across its terminals.\n**Photodiode** is light-sensitive."},
  {keys:["npn","pnp","phototransistor"],domain:"electronics",
    answer:"**NPN / PNP transistors** amplify current; used in amplifiers and switches.\n**Phototransistor** is light-sensitive."},
  {keys:["microphone","earphone","loudspeaker","piezo","aerial","antenna","amplifier"],domain:"electronics",
    answer:"**Microphone** sound → electrical. **Earphone / loudspeaker / piezo** electrical → sound.\n**Amplifier** (triangle symbol) is often a whole circuit block, not one part.\n**Aerial / antenna** receives or transmits radio signals."},
  {keys:["voltmeter","ammeter","galvanometer","ohmmeter","oscilloscope"],domain:"electronics",
    answer:"**Voltmeter** measures voltage (potential difference).\n**Ammeter** measures current.\n**Galvanometer** measures very small currents (~1 mA or less).\n**Ohmmeter** measures resistance.\n**Oscilloscope** shows signal shape vs time."},
  {keys:["ldr","thermistor","light dependent"],domain:"electronics",
    answer:"**LDR** (Light Dependent Resistor): light → resistance change.\n**Thermistor**: temperature → resistance change."},
  {keys:["ex-or","ex-nor","exor","exnor"],domain:"electronics",
    answer:"**EX-OR (XOR)**: true when inputs differ (only two inputs).\n**EX-NOR (XNOR)**: true when inputs are the same; output bubble means NOT of XOR."},
  // —— Math ——
  {keys:["pythagorean","pythagoras","right triangle","a2+b2"],domain:"math",
    answer:"**Pythagorean theorem** (right triangle): a² + b² = c² where c is the hypotenuse."},
  {keys:["quadratic","quadratic formula"],domain:"math",
    answer:"For ax² + bx + c = 0: **x = (−b ± √(b² − 4ac)) / (2a)**.\nDiscriminant b²−4ac: >0 two real roots, =0 one, <0 complex."},
  {keys:["slope","linear equation","y=mx+b"],domain:"math",
    answer:"Line form: **y = mx + b** (m = slope, b = y-intercept).\nSlope between points: m = (y2−y1)/(x2−x1)."},
  {keys:["percentage","percent","%"],domain:"math",
    answer:"Percent means per 100. Part = percent/100 × whole.\nChange % = (new−old)/old × 100%."},
  {keys:["fraction","numerator","denominator"],domain:"math",
    answer:"Fraction = numerator / denominator. To add: common denominator. Multiply tops and bottoms; divide by multiplying by the reciprocal."},
  {keys:["area","perimeter","circle","π"],domain:"math",
    answer:"Rectangle area = lw; perimeter = 2(l+w).\nCircle: **C = 2πr**, **A = πr²**. Triangle area = ½bh."},
  // —— Science ——
  {keys:["photosynthesis","chlorophyll"],domain:"science",
    answer:"**Photosynthesis** (plants): light energy makes sugar.\nOverall idea: carbon dioxide + water → glucose + oxygen (in light, with chlorophyll).\nTypical equation form: 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂."},
  {keys:["newton","force","f=ma"],domain:"science",
    answer:"Newton's 2nd law: **F = ma** (force = mass × acceleration).\n1st: object stays at rest or steady motion unless a net force acts.\n3rd: action and reaction forces are equal and opposite."},
  {keys:["density","mass volume"],domain:"science",
    answer:"**Density ρ = m/V** (mass ÷ volume). Units often g/cm³ or kg/m³."},
  {keys:["atom","molecule","element","compound"],domain:"science",
    answer:"**Atom** = basic unit of an element. **Molecule** = bonded atoms. **Compound** = substance with two or more elements chemically combined."},
  {keys:["cell","nucleus","membrane"],domain:"science",
    answer:"Cells are basic living units. **Membrane** controls entry/exit; **nucleus** holds genetic material (in eukaryotes). Plant cells also have a wall and often chloroplasts."},
  // —— English / essay ——
  {keys:["thesis","essay structure","introduction body conclusion"],domain:"english",
    answer:"Strong essay shape:\n1. **Introduction** + clear **thesis** (your main claim)\n2. **Body paragraphs** — each one idea + evidence + explanation\n3. **Conclusion** — restate claim, why it matters (no new random facts)"},
  {keys:["topic sentence","paragraph"],domain:"english",
    answer:"A paragraph usually starts with a **topic sentence**, then support (examples, quotes, reasons), then a link back to the thesis."},
  {keys:["grammar","subject verb","tense"],domain:"english",
    answer:"Keep **subject–verb agreement** (She writes / They write).\nStay in one main **tense** unless time truly changes. Prefer clear active verbs."},
  {keys:["formal writing","academic tone"],domain:"english",
    answer:"Academic tone: precise words, complete sentences, evidence for claims, limited slang, cite sources when you use them."},
  {keys:["figurative language","metaphor","simile"],domain:"english",
    answer:"**Simile** compares with like/as. **Metaphor** says one thing *is* another. Both create imagery — explain their effect in essays, don't only name them."},
  {keys:["persuasive","argument","claim evidence"],domain:"english",
    answer:"Argument = **claim** + **evidence** + **reasoning**. Address a counterpoint briefly to look fair and strong."}
];

function detectDomain(q){
  const s=q.toLowerCase();
  if(/ohm|resistor|capacitor|inductor|diode|transistor|voltage|current|circuit|kirchhoff|farad|henry|led|mosfet|electronics?|electrical|logic gate|nand|nor|xor|xnor|boolean|truth table|flip.?flop|combinational/.test(s))return "electronics";
  if(/essay|thesis|paragraph|grammar|metaphor|simile|topic sentence|formal writing|english/.test(s))return "english";
  if(/algebra|equation|quadratic|fraction|percent|geometry|triangle|slope|math|π|sqrt/.test(s))return "math";
  if(/photosynthesis|newton|force|density|atom|cell|molecule|science|physics|chemistry|biology/.test(s))return "science";
  return null;
}
function domainKnowledgeAnswer(question){
  const q=normalize(question).toLowerCase();
  let best=null,bestScore=0;
  for(const entry of DOMAIN_KB){
    let score=0;
    for(const k of entry.keys){if(q.includes(k))score+=k.length+3;}
    // light keyword overlap
    for(const w of q.split(/[^a-z0-9Ωμ]+/).filter(x=>x.length>2)){
      if(entry.keys.some(k=>k.includes(w)||w.includes(k.split(" ")[0])))score+=1;
    }
    if(score>bestScore){bestScore=score;best=entry;}
  }
  if(!best||bestScore<3)return null;
  return {domain:best.domain,answer:best.answer,score:bestScore};
}

const STOP = new Set(("a an and are as at be because been before being between but by can could did do does for from had has have he her here hers him his how i if in into is it its itself just may me might more most my no not of on one or our ours out over same she should so some than that the their theirs them themselves then there these they this those through to too under up us was we were what when where which while who whom why will with would you your yours about after again against all also among another any anything around become below both during each either enough even every example few first following further given going having however important later least little many maybe much must never often other otherwise perhaps rather since such very want without within yet" ).split(/\s+/));

let state = {
  settings: { theme:"dark", pinHash:"", pinSalt:"", pinIterations:120000, ai:{enabled:false,model:"onnx-community/Qwen3-0.6B-ONNX"}, sync:{url:"",token:"",enabled:false}, learner:{version:1,sessions:0,streak:0,recentAccuracy:null,concepts:{}} },
  documents: [],
  activeDocId: null
};
let deferredInstall = null;
function defaultLearner(){return {version:1,sessions:0,streak:0,recentAccuracy:null,concepts:{}};}
function learnerProfile(){state.settings.learner={...defaultLearner(),...(state.settings.learner||{}),concepts:{...(state.settings.learner?.concepts||{})}};return state.settings.learner;}
function adaptConcept(concept,correct){if(!concept)return;const p=learnerProfile();const key=normalize(concept).toLowerCase();if(!key)return;const prev=p.concepts[key]||{label:normalize(concept),attempts:0,correct:0,streak:0,mastery:0.35,lastSeen:0,dueAt:0};const attempts=prev.attempts+1;const good=prev.correct+(correct?1:0);const streak=correct?prev.streak+1:0;const mastery=clamp((good/attempts)*.72+(Math.min(streak,4)/4)*.18+prev.mastery*.10,0,1);prev.attempts=attempts;prev.correct=good;prev.streak=streak;prev.mastery=mastery;prev.lastSeen=Date.now();prev.dueAt=Date.now()+(correct?Math.min(1000*60*60*24*30,1000*60*20*Math.pow(2,Math.min(8,streak))):1000*60*3);p.concepts[key]=prev;}
function recordStudyResult(concepts,accuracy){const p=learnerProfile();p.sessions=(p.sessions||0)+1;p.recentAccuracy=accuracy;const strong=accuracy>=.85;if(strong)p.streak=(p.streak||0)+1;else p.streak=0;for(const c of concepts||[])adaptConcept(c,accuracy>=.7);return p;}
function weakConcepts(limit=8){const p=learnerProfile();return Object.values(p.concepts||{}).sort((a,b)=>(a.mastery||0)-(b.mastery||0)).slice(0,limit).map(x=>x.label);}


function toast(message,type=""){
  const el=$("#toast");
  if(!el)return;
  el.textContent=message;
  el.className=`toast${type?` ${type}`:""}`;
  requestAnimationFrame(()=>el.classList.add("show"));
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>el.classList.remove("show"),3200);
}
function activateSection(id){
  $$(".section").forEach(s=>s.classList.toggle("active",s.id===id));
  $$('[data-section]').forEach(b=>b.classList.toggle("active",b.dataset.section===id));
  window.scrollTo({top:0,behavior:"smooth"});
}
function activeDoc(){return state.documents.find(d=>d.id===state.activeDocId)||null;}

function setEngineStatus(text){const el=$("#engineStatus");if(el)el.textContent=`PDF engine: ${text}`;}
function loadScript(src, timeoutMs=12000){
  return new Promise(resolve=>{
    const script=document.createElement("script");
    script.src=src;
    script.async=true;
    let finished=false;
    const timer=setTimeout(()=>finish(false),timeoutMs);
    function finish(ok){
      if(finished)return; finished=true; clearTimeout(timer); resolve(ok);
      if(!ok)script.remove();
    }
    script.onload=()=>finish(true);
    script.onerror=()=>finish(false);
    document.head.appendChild(script);
  });
}
async function loadPdfEngine(){
  if(window.pdfjsLib){
    window.pdfjsLib.GlobalWorkerOptions.workerSrc=LOCAL_PDF_WORKER;
    setEngineStatus("ready • offline-capable");
    return true;
  }
  if(pdfEnginePromise)return pdfEnginePromise;
  setEngineStatus(navigator.onLine?"loading…":"offline — PDF engine not cached");
  pdfEnginePromise=(async()=>{
    // Prefer a bundled copy. If it is not present, fall back to the pinned CDN copy.
    if(await loadScript(LOCAL_PDFJS,2500) && window.pdfjsLib){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc=LOCAL_PDF_WORKER;
      setEngineStatus("ready • bundled");
      return true;
    }
    if(!navigator.onLine){
      setEngineStatus("offline — PDF engine not cached");
      return false;
    }
    const ok=await loadScript(CDN_PDFJS,12000);
    if(ok&&window.pdfjsLib){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc=CDN_PDF_WORKER;
      setEngineStatus("ready • cached after first use");
      return true;
    }
    setEngineStatus("unavailable — reconnect and try again");
    return false;
  })().finally(()=>{pdfEnginePromise=null;});
  return pdfEnginePromise;
}

function setOcrStatus(text){const el=$("#ocrStatus");if(el)el.textContent=`OCR: ${text}`;}
function loadTesseract(){
  if(window.Tesseract){setOcrStatus("ready");return Promise.resolve(true);}
  if(tesseractPromise)return tesseractPromise;
  setOcrStatus(navigator.onLine?"loading…":"offline — trying local OCR bundle");
  tesseractPromise=(async()=>{
    if(await loadScript(LOCAL_TESSERACT,4000)&&window.Tesseract){setOcrStatus("ready • local vendor");return true;}
    if(!navigator.onLine){setOcrStatus("unavailable offline");return false;}
    if(await loadScript(CDN_TESSERACT,15000)&&window.Tesseract){setOcrStatus("ready • cached after first use");return true;}
    setOcrStatus("unavailable — OCR engine could not load");
    return false;
  })();
  return tesseractPromise;
}
async function getOcrWorker(progress){
  const ready=await loadTesseract();if(!ready)throw new Error("Photo OCR is unavailable right now. The photo can still be saved and captioned.");
  if(!tesseractWorker){
    // Point workers + language data at the public CDN so first-run OCR actually works.
    // After the browser caches these, later runs can succeed offline.
    const opts={
      logger:m=>{if(m?.status)progress?.(m);},
      workerPath:"https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js",
      corePath:"https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core.wasm.js",
      langPath:"https://tessdata.projectnaptha.com/4.0.0"
    };
    try{
      tesseractWorker=await window.Tesseract.createWorker("eng",1,opts);
    }catch(err){
      console.warn("OCR worker with paths failed, retrying defaults",err);
      tesseractWorker=await window.Tesseract.createWorker("eng");
    }
  }
  return tesseractWorker;
}
/** Upscale + contrast boost so thin symbols (arrows, subscripts, Greek) OCR better. */
async function preprocessForOcr(fileOrBlob){
  try{
    const bitmap=await createImageBitmap(fileOrBlob);
    const scale=bitmap.width<900?Math.min(3,1200/Math.max(1,bitmap.width)):bitmap.width<1400?1.5:1;
    const w=Math.max(1,Math.round(bitmap.width*scale));
    const h=Math.max(1,Math.round(bitmap.height*scale));
    const c=document.createElement("canvas");c.width=w;c.height=h;
    const ctx=c.getContext("2d",{alpha:false});
    ctx.fillStyle="#fff";ctx.fillRect(0,0,w,h);
    ctx.imageSmoothingEnabled=true;
    ctx.drawImage(bitmap,0,0,w,h);
    // Mild contrast stretch for light gray PDF scans
    try{
      const img=ctx.getImageData(0,0,w,h);const d=img.data;
      let min=255,max=0;
      for(let i=0;i<d.length;i+=4){const g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];if(g<min)min=g;if(g>max)max=g;}
      const range=Math.max(1,max-min);
      for(let i=0;i<d.length;i+=4){
        let g=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]-min)/range*255;
        g=g<128?g*0.92:Math.min(255,g*1.08); // slightly punch symbols
        d[i]=d[i+1]=d[i+2]=g;d[i+3]=255;
      }
      ctx.putImageData(img,0,0);
    }catch{}
    bitmap.close?.();
    const blob=await new Promise(res=>c.toBlob(b=>res(b),"image/png"));
    return blob||fileOrBlob;
  }catch{
    return fileOrBlob;
  }
}
async function ocrImage(file,progress){
  try{
    const worker=await getOcrWorker(progress);
    const prepared=await preprocessForOcr(file);
    // Prefer layout that keeps sparse symbols / formula lines
    try{
      await worker.setParameters({
        tessedit_pageseg_mode: "3",
        // Do NOT whitelist only A-Z — that kills arrows, Greek, subscripts
        preserve_interword_spaces: "1"
      });
    }catch{}
    let best={text:"",confidence:0};
    const modes=["3","6","4"];
    for(const psm of modes){
      try{
        try{await worker.setParameters({tessedit_pageseg_mode:psm});}catch{}
        const ret=await worker.recognize(prepared);
        const text=repairSymbols(ret?.data?.text||"");
        const conf=Number(ret?.data?.confidence)||0;
        if(wordCount(text)>wordCount(best.text)||(wordCount(text)===wordCount(best.text)&&conf>best.confidence)){
          best={text,confidence:conf};
        }
        if(best.confidence>=72&&wordCount(best.text)>=8)break;
      }catch(err){console.warn("OCR mode",psm,err);}
    }
    if(!best.text){
      const ret=await worker.recognize(prepared);
      best={text:repairSymbols(ret?.data?.text||""),confidence:Number(ret?.data?.confidence)||0};
    }
    return best;
  }catch(err){
    console.warn("ocrImage failed",err);
    try{await tesseractWorker?.terminate?.();}catch{}
    tesseractWorker=null;
    return {text:"",confidence:0};
  }
}
function dataUrlFromFile(file,maxSide=1500,quality=.78){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));const c=document.createElement("canvas");c.width=w;c.height=h;const ctx=c.getContext("2d");ctx.drawImage(img,0,0,w,h);resolve({dataUrl:c.toDataURL("image/jpeg",quality),width:w,height:h});};img.onerror=()=>reject(new Error("Could not read the image."));img.src=reader.result;};reader.onerror=()=>reject(reader.error||new Error("Could not read the image."));reader.readAsDataURL(file);});}
/** Local-only study card image (photo + caption). No cloud, no generative model. */
function exportStudyPic(media,title="StudyVault"){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      try{
        const pad=28,maxW=900,cap=String(media.caption||media.ocrText||"").trim().slice(0,280);
        const scale=Math.min(1,maxW/Math.max(img.naturalWidth,1));
        const iw=Math.round(img.naturalWidth*scale),ih=Math.round(img.naturalHeight*scale);
        const lineH=22,lines=[];
        if(cap){
          const words=cap.split(/\s+/);let line="";
          for(const w of words){const t=line?`${line} ${w}`:w;if(t.length>52){if(line)lines.push(line);line=w;}else line=t;}
          if(line)lines.push(line);
        }
        const textBlock=lines.length?lines.length*lineH+18:0;
        const c=document.createElement("canvas");c.width=iw+pad*2;c.height=ih+pad*2+48+textBlock;
        const ctx=c.getContext("2d");
        ctx.fillStyle="#0f1419";ctx.fillRect(0,0,c.width,c.height);
        ctx.fillStyle="#1a2330";ctx.fillRect(pad-6,pad-6,iw+12,ih+12);
        ctx.drawImage(img,pad,pad,iw,ih);
        ctx.fillStyle="#e8eef6";ctx.font="600 16px system-ui,sans-serif";
        ctx.fillText(String(title).slice(0,48),pad,ih+pad+28);
        ctx.fillStyle="#9fb0c3";ctx.font="13px system-ui,sans-serif";
        ctx.fillText(String(media.name||"study photo").slice(0,56),pad,ih+pad+46);
        ctx.fillStyle="#d7e2ef";ctx.font="14px system-ui,sans-serif";
        lines.forEach((ln,i)=>ctx.fillText(ln,pad,ih+pad+68+i*lineH));
        c.toBlob(blob=>{
          if(!blob)return reject(new Error("Could not build study pic."));
          const a=document.createElement("a");
          a.href=URL.createObjectURL(blob);
          a.download=`studyvault-${(media.name||"card").replace(/\.[^.]+$/,"")}-study.png`;
          a.click();
          setTimeout(()=>URL.revokeObjectURL(a.href),2500);
          resolve();
        },"image/png");
      }catch(err){reject(err);}
    };
    img.onerror=()=>reject(new Error("Could not load photo for study pic."));
    img.src=media.dataUrl;
  });
}

let dbPromise=null;
let writeQueue=Promise.resolve();
function openDB(){
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onupgradeneeded=e=>{
      const db=r.result;
      if(!db.objectStoreNames.contains(DOC_STORE))db.createObjectStore(DOC_STORE,{keyPath:"id"});
      if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE);
      // Schema bump marker for future migrations (v2→v3+). User data stays; we only ensure stores exist.
      try{const tx=e.target.transaction;const meta=tx.objectStore(META_STORE);meta.put({key:"schema",version:SCHEMA_VERSION,migratedAt:new Date().toISOString()},"schema");}catch{}
    };
    r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();resolve(db);};
    r.onerror=()=>reject(r.error);
  }).catch(err=>{dbPromise=null;throw err;});
  return dbPromise;
}
function txRequest(store,mode,action){
  return openDB().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction(store,mode);let request;
    try{request=action(tx.objectStore(store));}catch(err){reject(err);return;}
    if(request){request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}
    tx.onabort=()=>reject(tx.error||new Error("IndexedDB transaction aborted."));
    tx.onerror=()=>reject(tx.error||new Error("IndexedDB transaction failed."));
    tx.oncomplete=()=>{if(!request)resolve();};
  }));
}
function queueWrite(fn){
  writeQueue=writeQueue.catch(()=>{}).then(fn);
  return writeQueue;
}
async function dbPut(store,keyOrValue,value){
  return queueWrite(()=>txRequest(store,"readwrite",os=>value===undefined?os.put(keyOrValue):os.put(value,keyOrValue)));
}
async function dbGet(store,key){return txRequest(store,"readonly",os=>os.get(key));}
async function dbGetAll(store){return txRequest(store,"readonly",os=>os.getAll());}
async function dbDelete(store,key){return queueWrite(()=>txRequest(store,"readwrite",os=>os.delete(key)));}
async function dbClear(){
  return queueWrite(()=>openDB().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction([DOC_STORE,META_STORE],"readwrite");
    tx.objectStore(DOC_STORE).clear();tx.objectStore(META_STORE).clear();
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("Clear failed."));
  })));
}
async function saveDoc(doc){
  doc.updatedAt=now();
  // Phone-safe save: retry once if the DB connection was closed in the background
  const attempt=async()=>{
    try{await dbPut(DOC_STORE,doc);}
    catch(err){
      if(err?.name==="QuotaExceededError")throw new Error("Browser storage is full. Remove large photos or export a backup, then try again.");
      // Recover from closed connection (common when phone tabs sleep)
      if(/closed|InvalidState|AbortError/i.test(String(err?.message||err?.name||""))){
        dbPromise=null;
        await dbPut(DOC_STORE,doc);
        return;
      }
      throw err;
    }
  };
  try{await attempt();}
  catch(err){
    console.error("saveDoc failed",err);
    toast(err?.message||"Could not save. Try again.","error");
    throw err;
  }
}
async function saveMeta(){
  try{
    await dbPut(META_STORE,SETTINGS_KEY,{...state.settings,activeDocId:state.activeDocId,version:APP_VERSION,engine:REVIEW_ENGINE_VERSION});
  }catch(err){
    if(/closed|InvalidState|AbortError/i.test(String(err?.message||err?.name||""))){
      dbPromise=null;
      await dbPut(META_STORE,SETTINGS_KEY,{...state.settings,activeDocId:state.activeDocId,version:APP_VERSION,engine:REVIEW_ENGINE_VERSION});
      return;
    }
    console.warn("saveMeta",err);
  }
}

async function derivePin(pin,salt,iterations=120000){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations,hash:"SHA-256"},key,256);
  return Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join("");
}
function bytesToB64(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}
function b64ToBytes(s){const bin=atob(s);return Uint8Array.from(bin,c=>c.charCodeAt(0));}
async function setPin(){
  const a=$("#pinA").value.trim(),b=$("#pinB").value.trim();
  if(a.length<6)return toast("PIN must be at least 6 characters for family-grade protection.","error");
  if(a!==b)return toast("PINs do not match.","error");
  const salt=crypto.getRandomValues(new Uint8Array(16));
  state.settings.pinSalt=bytesToB64(salt);
  state.settings.pinIterations=120000;
  state.settings.pinHash=await derivePin(a,salt,state.settings.pinIterations);
  state.settings.pinFails=0;state.settings.pinLockUntil=0;
  await saveMeta();closePin();toast("PIN protection enabled.","success");
}
function constantTimeEqual(a,b){
  const A=String(a||""),B=String(b||"");
  let diff=A.length^B.length;
  const n=Math.max(A.length,B.length);
  for(let i=0;i<n;i++)diff|=(A.charCodeAt(i%n)||0)^(B.charCodeAt(i%n)||0);
  return diff===0;
}
async function verifyPin(pin){
  if(!state.settings.pinHash||!state.settings.pinSalt)return false;
  const hash=await derivePin(pin,b64ToBytes(state.settings.pinSalt),state.settings.pinIterations||120000);
  return constantTimeEqual(hash,state.settings.pinHash);
}
async function removePin(){
  if(!state.settings.pinHash)return toast("No PIN is enabled.");
  if(!confirm("Remove the StudyVault PIN?"))return;
  state.settings.pinHash="";state.settings.pinSalt="";await saveMeta();closePin();toast("PIN removed.","success");
}
function openPin(){$("#pinModal").classList.add("open");}
function closePin(){$("#pinModal").classList.remove("open");$("#pinA").value="";$("#pinB").value="";}
function lockApp(){
  if(!state.settings.pinHash)return toast("Set a PIN first in Settings.","error");
  $("#lock").classList.add("open");$("#unlockPin").value="";$("#unlockMsg").textContent="";setTimeout(()=>$("#unlockPin").focus(),30);
}
async function unlockApp(){
  const p=$("#unlockPin").value.trim();if(!p)return $("#unlockMsg").textContent="Enter your PIN.";
  const until=Number(state.settings.pinLockUntil||0);
  if(until&&Date.now()<until){
    const sec=Math.ceil((until-Date.now())/1000);
    return $("#unlockMsg").textContent=`Too many attempts. Wait ${sec}s.`;
  }
  const ok=await verifyPin(p);
  if(ok){
    state.settings.pinFails=0;state.settings.pinLockUntil=0;await saveMeta();
    $("#lock").classList.remove("open");$("#unlockPin").value="";toast("Unlocked.","success");
  }else{
    const fails=Number(state.settings.pinFails||0)+1;
    state.settings.pinFails=fails;
    // Exponential backoff: 2^fails seconds, capped at 5 minutes
    const delay=Math.min(300,Math.pow(2,Math.min(fails,8)))*1000;
    if(fails>=3)state.settings.pinLockUntil=Date.now()+delay;
    await saveMeta();
    $("#unlockMsg").textContent=fails>=3?`Incorrect PIN. Locked ${Math.ceil(delay/1000)}s.`:"Incorrect PIN.";
  }
}

const REVIEW_ENGINE_VERSION = 13;
const SUMMARY_MODES = {
  quick:    {label:"Quick Scan", sentenceCount:6,  maxChars:900},
  standard: {label:"Standard",   sentenceCount:10, maxChars:1500},
  deep:     {label:"Deep Review",sentenceCount:16, maxChars:2400},
  cram:     {label:"Exam Cram",  sentenceCount:8,  maxChars:1200}
};

function stableId(prefix,text){
  let h=2166136261;
  for(let i=0;i<String(text).length;i++){
    h^=String(text).charCodeAt(i);
    h=Math.imul(h,16777619);
  }
  return `${prefix}-${(h>>>0).toString(36)}`;
}

function similarity(a,b){
  const A=new Set(tokenize(a).filter(x=>x.length>2));
  const B=new Set(tokenize(b).filter(x=>x.length>2));
  if(!A.size&&!B.size)return 1;
  let common=0;for(const x of A)if(B.has(x))common++;
  return common/Math.max(1,new Set([...A,...B]).size);
}

function extractSentences(text,min=24){
  const cleaned=String(text||"").replace(/\r/g,"");
  if(!cleaned.trim())return [];
  // Protect decimals and common abbreviations so "3.14" / "e.g." / "Dr." do not split.
  const shielded=cleaned
    .replace(/\b(e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|Prof|Fig|eq|approx)\./gi,(m)=>m.replace(/\./g,"∯"))
    .replace(/(\d)\.(\d)/g,"$1∯$2");
  const out=[];
  for(const rawLine of shielded.split(/\n+/)){
    const line=normalize(rawLine.replace(/∯/g,"."));if(!line)continue;
    // Split on sentence enders only when not mid-decimal / abbreviation (already protected).
    const parts=line.split(/(?<=[.!?])\s+(?=[A-Z0-9("'])|(?<=[.!?])$/).filter(Boolean);
    for(const part of parts.length?parts:[line]){
      let sentence=normalize(part.replace(/∯/g,"."));
      if(/^(?:next|then|finally|first|second|third|lastly)\s*[,;:-]/i.test(sentence)&&sentence.length<90)continue;
      if(sentence.length>=min)out.push(sentence);
    }
  }
  const seen=new Set();
  return out.filter(x=>{const k=x.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});
}

function sentenceUnits(doc){
  if(Array.isArray(doc.units)&&doc.units.length)return doc.units.filter(u=>normalize(u.text));
  const out=[];
  for(const p of doc.pageTexts||[]){
    for(const text of extractSentences(p.text||"",20))out.push({page:p.page,text,source:p.source||"page",photoId:p.photoId||null});
  }
  for(const m of doc.media||[]){
    const combined=normalize(`${m.caption||""}\n${m.ocrText||""}`);
    for(const text of extractSentences(combined,18))out.push({page:null,text,source:"photo",photoId:m.id});
  }
  return out;
}

function candidateTerms(doc){
  const units=sentenceUnits(doc), all=units.map(u=>u.text).join(" \n");
  const tokens=tokenize(all).filter(w=>w.length>=4&&w.length<=28&&!STOP.has(w)&&!/^\d+$/.test(w));
  const freq=new Map(), spread=new Map(), firstPos=new Map();
  tokens.forEach((w,i)=>{
    freq.set(w,(freq.get(w)||0)+1);
    if(!firstPos.has(w))firstPos.set(w,i);
  });
  for(const u of units){const seen=new Set(tokenize(u.text));for(const w of seen)if(freq.has(w))spread.set(w,(spread.get(w)||0)+1);}
  const phrases=new Map();
  const normTokens=tokenize(all);
  for(let i=0;i<normTokens.length-1;i++){
    const a=normTokens[i],b=normTokens[i+1];
    if([a,b].every(w=>w.length>=4&&!STOP.has(w))){
      const k=`${a} ${b}`;phrases.set(k,(phrases.get(k)||0)+1);
    }
  }
  const ranked=[...freq].map(([term,f])=>({term,f,score:f*1.15+(spread.get(term)||0)*1.5+(f>=3?2:0)+((firstPos.get(term)||0)<Math.max(40,tokens.length*.12)?1.2:0)}));
  const phraseRanked=[...phrases].filter(([,f])=>f>=2).map(([term,f])=>({term,f,score:f*3.4}));
  const result=[];
  for(const item of [...phraseRanked.sort((a,b)=>b.score-a.score),...ranked.sort((a,b)=>b.score-a.score)]){
    const t=item.term;
    if(result.some(x=>x.toLowerCase()===t.toLowerCase()))continue;
    if(result.some(x=>similarity(x,t)>.80))continue;
    result.push(t);
    if(result.length>=40)break;
  }
  return result;
}

function detectHeadings(doc){
  const headings=[];
  for(const p of doc.pageTexts||[]){
    const lines=String(p.text||"").split(/\n+/).map(normalize).filter(Boolean);
    for(const line of lines){
      const words=line.split(/\s+/);
      const alpha=line.replace(/[^A-Za-z]/g,"");
      const titleCase=/^(?:[A-Z][A-Za-z0-9-]*\s*){1,10}$/.test(line);
      const numbered=/^(?:\d+(?:\.\d+)*[.)]|[IVXLC]+[.)]|[A-Z][.)])\s+/.test(line);
      if((words.length<=12&&line.length<=100&&alpha.length>=5&&(titleCase||numbered||line===line.toUpperCase()))){
        if(!/^(page|chapter|figure|table)\s*\d*$/i.test(line))headings.push({text:line,page:p.page});
      }
    }
  }
  const seen=new Set();return headings.filter(h=>{const k=h.text.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;}).slice(0,40);
}

function patternHits(text,re){return re.test(text);}
function unitPage(u){return u?.page??null;}
function contextHeading(page,headings){
  const list=headings.filter(h=>Number(h.page)<=Number(page));
  return list.length?list[list.length-1].text:"";
}

/** Clean answer text for flashcards / tutor — short, study-ready, no table junk. */
function cleanAnswer(text,maxLen=220){
  let t=normalize(String(text||""))
    .replace(/^(?:component|circuit symbol|function of component|function of gate)\s*[:|]?\s*/i,"")
    .replace(/\bFunction of Component\b/gi,"")
    .replace(/\s*\|\s*/g," ")
    .replace(/\s{2,}/g," ")
    .trim();
  if(!t)return "";
  // Prefer first 1–2 full sentences
  const parts=t.match(/[^.!?]+[.!?]?/g)||[t];
  t=parts.slice(0,2).join(" ").trim();
  if(t.length>maxLen){
    let cut=t.slice(0,maxLen);
    const b=Math.max(cut.lastIndexOf(". "),cut.lastIndexOf(" "));
    if(b>maxLen*0.5)cut=cut.slice(0,b+(cut[b]==="."?1:0));
    t=cut.trim();
    if(!/[.!?]$/.test(t))t+="…";
  }
  return t.charAt(0).toUpperCase()+t.slice(1);
}

/**
 * Pull Component → Function pairs from electronics symbol sheets and glossary tables.
 * Handles lines like: "Fuse  A safety device which will blow…"
 */
function extractGlossaryPairs(doc){
  const pairs=[];
  const seen=new Set();
  const pageBlob=(doc.pageTexts||[]).map(p=>String(p.text||"")).join("\n");
  const raw=pageBlob||String(doc.rawText||"");
  const lines=raw.split(/\n+/).map(l=>normalize(l)).filter(Boolean);
  // Known component name starts (electronics sheet + general)
  const nameRe=/^((?:Wire|Wires joined|Wires not joined|Cell|Battery|DC supply|AC supply|Fuse|Transformer|Earth(?:\s*\(Ground\))?|Ground|Lamp(?:\s*\([^)]+\))?|Heater|Motor|Bell|Buzzer|Inductor(?:\s*\([^)]+\))?|Push(?:\s*Switch|\s*to[- ]Break)?(?:\s*\([^)]+\))?|On-Off Switch(?:\s*\([^)]+\))?|2-way Switch(?:\s*\([^)]+\))?|Dual On-Off Switch(?:\s*\([^)]+\))?|Reversing Switch(?:\s*\([^)]+\))?|Relay|Resistor|Variable Resistor(?:\s*\([^)]+\))?|Capacitor(?:[,\s]+polarised)?|Variable Capacitor|Trimmer Capacitor|Diode|LED|Light Emitting Diode|Zener Diode|Photodiode|Transistor(?:\s+NPN|\s+PNP)?|Phototransistor|Microphone|Earphone|Loudspeaker|Piezo Transducer|Amplifier(?:\s*\([^)]+\))?|Aerial(?:\s*\([^)]+\))?|Antenna|Voltmeter|Ammeter|Galvanometer|Ohmmeter|Oscilloscope|LDR|Thermistor|NOT|AND|NAND|OR|NOR|EX-OR|EX-NOR|XOR|XNOR)(?:\s*\([^)]+\))?)\b/i;

  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^(?:component|circuit symbol|function)/i.test(line)&&line.length<40)continue;
    if(/wires and connections|power supplies|output devices|switches|resistors|capacitors|diodes|transistors|logic gates|meters/i.test(line)&&line.length<50)continue;

    let term="",fn="";
    const m=line.match(nameRe);
    if(m){
      term=m[1].trim();
      fn=line.slice(m[0].length).replace(/^[\s|:–—-]+/,"").trim();
      // Function may continue on next lines
      let j=i+1;
      while(j<lines.length&&fn.length<40&&!nameRe.test(lines[j])&&lines[j].length>12&&!/^(?:component|circuit)/i.test(lines[j])){
        fn=(fn+" "+lines[j]).trim();j++;
      }
    }else{
      // Generic: short name + long explanation on same line
      const gm=line.match(/^([A-Z][A-Za-z0-9+\/\-() ]{1,42}?)\s{2,}(.{20,})$/);
      if(gm){term=gm[1].trim();fn=gm[2].trim();}
    }
    if(!term||!fn||fn.length<15)continue;
    // Drop if "function" is actually another header
    if(/^(?:wires|power|switches|resistors|function of)/i.test(fn))continue;
    term=term.replace(/\s+/g," ").trim();
    const key=term.toLowerCase();
    if(seen.has(key))continue;
    seen.add(key);
    pairs.push({term,definition:cleanAnswer(fn,280),page:null,confidence:0.92,kind:"component"});
    if(pairs.length>=80)break;
  }

  // Also scan units for "X is a device which…"
  for(const u of sentenceUnits(doc)){
    const text=normalize(u.text||"");
    const m=text.match(/^([A-Za-z][A-Za-z0-9+\/\-() ]{1,40}?)\s+(?:is|are|means)\s+(.{15,})$/i);
    if(!m)continue;
    const term=m[1].trim();
    const key=term.toLowerCase();
    if(seen.has(key)||term.length>45)continue;
    seen.add(key);
    pairs.push({term,definition:cleanAnswer(text,280),page:unitPage(u),confidence:0.85,kind:"definition"});
    if(pairs.length>=80)break;
  }
  return pairs;
}

function detectDefinitions(units,terms){
  // Prefer structured glossary pairs (electronics symbol sheets, etc.)
  const fromGlossary=[];
  try{
    // units alone may not have pageTexts — caller often has doc via sentenceUnits
  }catch{}
  const defs=[];
  const patterns=[
    /^(.{2,80}?)\s+(?:is|are|means|refers to|is defined as|are defined as|is known as|is called)\s+(.{12,})$/i,
    /^(.{2,80}?)\s*:\s*(.{12,})$/i,
    /^(.{2,60}?)\s*[-–—]\s+(.{12,})$/,
    /^(.{2,60}?)\s*\(\s*(?:def(?:inition)?|means)\s*\)\s*[-–—:]?\s*(.{12,})$/i,
    /(?:the term|the concept|the process)\s+(.{2,80}?)\s+(?:is|means|refers to)\s+(.{12,})/i,
    // Electronics sheet style: short name then long function sentence
    /^((?:[A-Z][A-Za-z0-9+\/\-()]*(?:\s+[A-Za-z0-9+\/\-()]+){0,5}))\s+((?:A |An |This |The |Supplies |Allows |Restricts |Converts |Stores |Creates |Amplifies |Measures |Only |Used ).{12,})$/
  ];
  for(const u of units){
    const text=normalize(String(u.text||"").replace(/([A-Za-z])-\s*\n\s*([a-z])/g,"$1$2"));
    if(text.length<18)continue;
    let hit=null;
    for(const re of patterns){const m=text.match(re);if(m){hit=m;break;}}
    let term=hit?.[1]?.trim()||terms.find(t=>text.toLowerCase().includes(String(t).toLowerCase()));
    if(!term)continue;
    term=term.replace(/^(the|a|an)\s+/i,"").replace(/[.:;]+$/,"").trim();
    if(term.length>55)term=terms.find(t=>text.toLowerCase().includes(String(t).toLowerCase()))||term;
    if(!term||term.length<2||term.length>55)continue;
    if(defs.some(d=>d.term.toLowerCase()===term.toLowerCase()))continue;
    const body=hit?.[2]?cleanAnswer(hit[2],260):cleanAnswer(text,260);
    if(body.length<12)continue;
    const confidence=Math.min(0.98,0.58+(hit?0.24:0)+(text.length<260?0.08:0)+(unitPage(u)?0.04:0));
    defs.push({term,definition:body,page:unitPage(u),confidence});
    if(defs.length>=60)break;
  }
  return defs;
}

function classifyUnit(u,terms){
  const text=u.text||"", low=text.toLowerCase();
  const hits=[];
  if(/\b(is|are|means|refers to|defined as|known as|called)\b/i.test(text)||/^.{2,60}\s*[-–—:]\s+.{12,}/.test(text))hits.push("definition");
  if(/\b(first|second|third|next|then|finally|step|procedure|process|stage|phase)\b/i.test(text))hits.push("process");
  if(/\b(because|therefore|causes?|results? in|leads? to|due to|as a result|consequently)\b/i.test(text))hits.push("cause-effect");
  if(/\b(whereas|while|unlike|compared with|in contrast|difference between|similar to|both)\b/i.test(text))hits.push("comparison");
  if(/\b(for example|for instance|such as|e\.g\.|eg\.)\b/i.test(text))hits.push("example");
  if(/\b(important|key|note|remember|warning|caution|must)\b/i.test(text))hits.push("exam-focus");
  if(/\d|%|\b(?:Hz|V|A|W|Ω|ohm|kg|m|cm|mm|mol)\b|[A-Za-z]\s*=\s*[^ ]|→|->/i.test(text))hits.push("fact-formula");
  const overlap=terms.slice(0,28).reduce((n,t)=>n+(low.includes(String(t).toLowerCase())?1:0),0);
  return {hits,overlap};
}

function scoreUnit(u,terms,headings,position,total){
  const f=classifyUnit(u,terms), text=u.text||"";let score=f.overlap*2.2+f.hits.length*2;
  if(text.length>=55&&text.length<=300)score+=2.5;
  if(text.length>420)score-=2;
  if(position<Math.max(3,total*.12))score+=1.7;
  if(f.hits.includes("definition"))score+=4;
  if(f.hits.includes("exam-focus"))score+=3;
  if(f.hits.includes("cause-effect")||f.hits.includes("comparison")||f.hits.includes("process"))score+=2.3;
  const h=contextHeading(unitPage(u),headings);if(h)score+=1;
  return score;
}

function selectEvidence(units,terms,headings,count,filterFn=()=>true){
  const ranked=units.map((u,i)=>({u,i,score:scoreUnit(u,terms,headings,i,units.length)})).filter(x=>filterFn(x.u)).sort((a,b)=>b.score-a.score);
  const picked=[];
  for(const item of ranked){
    if(picked.some(x=>similarity(x.u.text,item.u.text)>.58))continue;
    picked.push(item);if(picked.length>=count)break;
  }
  return picked.sort((a,b)=>a.i-b.i);
}

function softenBullet(text,maxLen=150){
  let t=normalize(String(text||"").replace(/^(note|important|remember|tip)\s*[:.\-–—]?\s*/i,""));
  if(!t)return "";
  if(t.length>maxLen){
    const clause=t.split(/[;:]/)[0].trim();
    if(clause.length>=40&&clause.length<=maxLen)t=clause;
    else{
      // Never cut mid-word: back up to last whitespace / punctuation boundary.
      let cut=t.slice(0,maxLen);
      const boundary=Math.max(cut.lastIndexOf(" "),cut.lastIndexOf(","),cut.lastIndexOf(";"),cut.lastIndexOf("."),cut.lastIndexOf("—"));
      if(boundary>=Math.floor(maxLen*0.55))cut=cut.slice(0,boundary);
      else cut=cut.replace(/\s+\S*$/,"");
      t=cut.replace(/[,:;.\-–—]+$/,"").trim()+"…";
    }
  }
  if(!t)return "";
  return t.charAt(0).toUpperCase()+t.slice(1);
}

function synthesizeSummary(units,terms,headings,mode){
  const cfg=SUMMARY_MODES[mode]||SUMMARY_MODES.standard;
  const evidence=selectEvidence(units,terms,headings,cfg.sentenceCount);
  if(!evidence.length)return "Not enough readable source text was found to create an automatic summary.";

  const topicTerms=terms.slice(0,5);
  const byKind={definition:[],process:[],"cause-effect":[],comparison:[],example:[],"fact-formula":[]};
  for(const e of evidence){
    const kinds=classifyUnit(e.u,terms).hits;
    const key=kinds.find(k=>byKind[k])||"general";
    (byKind[key]??(byKind[key]=[])).push(e.u);
  }

  const narrative=evidence.map(e=>e.u.text);
  const seen=[];
  for(const n of narrative){
    const clean=softenBullet(n, mode==="cram"?120:160);
    if(!clean)continue;
    if(!seen.some(x=>similarity(x,clean)>.58))seen.push(clean);
  }

  const blocks=[];
  if(topicTerms.length){
    blocks.push("Focus");
    blocks.push(topicTerms.join(" · "));
  }

  if(mode==="cram"){
    blocks.push("");
    blocks.push("Remember these");
    for(const u of seen.slice(0,8))blocks.push("• "+u);
  }else{
    if(byKind.definition?.length){
      blocks.push("");
      blocks.push("Core ideas");
      for(const u of byKind.definition.slice(0,3)){
        const line=softenBullet(u.text,140);
        if(line)blocks.push("• "+line);
      }
    }
    blocks.push("");
    blocks.push(mode==="quick"?"Quick points":mode==="deep"?"Detailed points":"Key points");
    let used=blocks.join("\n").length;
    for(const u of seen){
      const line="• "+u;
      if(used+line.length+1>cfg.maxChars)break;
      // Skip near-duplicates of definition lines already shown
      if(byKind.definition?.some(d=>similarity(softenBullet(d.text,140),u)>.7))continue;
      blocks.push(line);
      used+=line.length+1;
    }
  }

  let out=blocks.join("\n").replace(/\n{3,}/g,"\n\n").trim();
  if(out.length>cfg.maxChars)out=out.slice(0,cfg.maxChars-1).replace(/\s+\S*$/,"")+"…";
  return out;
}

function mergeDefinitions(primary,extra){
  const out=[...(primary||[])];
  const seen=new Set(out.map(d=>d.term.toLowerCase()));
  for(const d of extra||[]){
    const k=String(d.term||"").toLowerCase();
    if(!k||seen.has(k))continue;
    seen.add(k);out.push(d);
  }
  return out;
}
function detectStructuredPatterns(units,terms,headings,doc=null){
  let definitions=detectDefinitions(units,terms);
  if(doc){
    const glossary=extractGlossaryPairs(doc);
    definitions=mergeDefinitions(glossary,definitions);
  }
  const processes=units.filter(u=>classifyUnit(u,terms).hits.includes("process")).slice(0,18).map(u=>({text:u.text,page:unitPage(u)}));
  const causes=units.filter(u=>classifyUnit(u,terms).hits.includes("cause-effect")).slice(0,18).map(u=>({text:u.text,page:unitPage(u)}));
  const comparisons=units.filter(u=>classifyUnit(u,terms).hits.includes("comparison")).slice(0,16).map(u=>({text:u.text,page:unitPage(u)}));
  const examples=units.filter(u=>classifyUnit(u,terms).hits.includes("example")).slice(0,16).map(u=>({text:u.text,page:unitPage(u)}));
  const facts=units.filter(u=>classifyUnit(u,terms).hits.includes("fact-formula")).slice(0,20).map(u=>({text:u.text,page:unitPage(u)}));
  const keyPoints=selectEvidence(units,terms,headings,30).map(x=>({text:x.u.text,page:unitPage(x.u),heading:contextHeading(unitPage(x.u),headings),score:Math.round(x.score*10)/10}));
  return {definitions,processes,causes,comparisons,examples,facts,keyPoints};
}

function buildReviewer(doc){
  const units=sentenceUnits(doc);
  let terms=Array.isArray(doc.terms)&&doc.terms.length?doc.terms:candidateTerms(doc);
  const headings=detectHeadings(doc);
  const s=detectStructuredPatterns(units,terms,headings,doc);
  // Glossary sheets: promote component names into terms
  if((s.definitions||[]).length>=8){
    const extra=s.definitions.map(d=>d.term).filter(Boolean);
    const merged=[];
    const seen=new Set();
    for(const t of [...extra,...terms]){
      const k=String(t).toLowerCase();if(seen.has(k))continue;seen.add(k);merged.push(t);
      if(merged.length>=60)break;
    }
    terms=merged;
  }
  let overview=synthesizeSummary(units,terms,headings,doc.summaryMode||"standard");
  // Smarter overview for component/symbol reference sheets
  if((s.definitions||[]).length>=6){
    const top=s.definitions.slice(0,12).map(d=>`• ${d.term} — ${cleanAnswer(d.definition,110)}`);
    const head=(doc.summaryMode==="cram")?"Exam cram — components to know":"This material is a component / symbol reference. Master these first:";
    overview=`${head}\n${top.join("\n")}`;
  }
  const takeaways=(s.definitions||[]).length>=6
    ? s.definitions.slice(0,14).map(d=>({text:`${d.term}: ${cleanAnswer(d.definition,140)}`,page:d.page,heading:""}))
    : selectEvidence(units,terms,headings,10).map(x=>({text:cleanAnswer(x.u.text,160),page:unitPage(x.u),heading:contextHeading(unitPage(x.u),headings)}));
  const memory=(s.definitions||[]).slice(0,24).map(d=>({term:d.term,clue:cleanAnswer(d.definition,160),page:d.page}));
  if(memory.length<8){
    for(const term of terms.slice(0,18)){
      if(memory.some(m=>m.term.toLowerCase()===String(term).toLowerCase()))continue;
      const u=units.find(x=>x.text.toLowerCase().includes(String(term).toLowerCase()));
      memory.push({term,clue:u?cleanAnswer(u.text,160):`Connect ${term} to its purpose in the material.`,page:unitPage(u)});
    }
  }
  const questions=[];
  s.definitions.slice(0,16).forEach(d=>{
    questions.push({type:"definition",q:`What is the function of a ${d.term}?`,page:d.page});
    questions.push({type:"recall",q:`In one sentence, explain what a ${d.term} does in a circuit.`,page:d.page});
  });
  s.processes.slice(0,5).forEach(p=>questions.push({type:"process",q:`Explain the process or sequence described on page ${p.page??"the source"}.`,page:p.page}));
  s.causes.slice(0,5).forEach(p=>questions.push({type:"cause-effect",q:`What cause-and-effect relationship is described in this point?`,page:p.page}));
  takeaways.slice(0,6).forEach(p=>questions.push({type:"recall",q:`Explain without looking: ${cleanAnswer(p.text,90)}`,page:p.page}));
  const checklist=[];
  s.definitions.slice(0,12).forEach(d=>checklist.push(`Name ${d.term} and state its function from memory.`));
  terms.slice(0,8).forEach(t=>{if(!checklist.some(c=>c.includes(t)))checklist.push(`Explain ${t} without reading the source.`);});
  if(s.processes.length)checklist.push("Reconstruct the important process steps from memory.");
  if(s.facts.length)checklist.push("Memorize the important formulas, numbers, units, or factual thresholds.");
  (doc.media||[]).forEach((m,i)=>checklist.push(m.ocrText?`Review the text in photo ${i+1}.`:`Explain what photo ${i+1} is showing and why it matters.`));
  // Better exam cram for glossary sheets
  let examCramOverride=null;
  if(s.definitions.length>=6){
    examCramOverride="Remember these\n"+s.definitions.slice(0,14).map(d=>`• ${d.term}: ${cleanAnswer(d.definition,90)}`).join("\n");
  }
  const pages=[];
  for(const p of doc.pageTexts||[]){
    const pu=units.filter(u=>Number(u.page)===Number(p.page));
    const top=selectEvidence(pu,terms,headings,1)[0]?.u;
    if(top)pages.push({page:p.page,text:top.text,source:p.source||"page",heading:contextHeading(p.page,headings)});
  }
  const blueprint=[
    {label:"Definitions",value:s.definitions.map(d=>d.term)},
    {label:"Processes / steps",value:s.processes.slice(0,5).map(x=>x.text)},
    {label:"Cause & effect",value:s.causes.slice(0,5).map(x=>x.text)},
    {label:"Comparisons",value:s.comparisons.slice(0,5).map(x=>x.text)},
    {label:"Examples",value:s.examples.slice(0,5).map(x=>x.text)},
    {label:"Facts / formulas",value:s.facts.slice(0,6).map(x=>x.text)}
  ];
  const conceptMap=[];
  for(let i=0;i<Math.min(terms.length,18);i++)for(let j=i+1;j<Math.min(terms.length,18);j++){
    const a=terms[i],b=terms[j];const co=units.filter(u=>u.text.toLowerCase().includes(a.toLowerCase())&&u.text.toLowerCase().includes(b.toLowerCase())).length;if(co>=2)conceptMap.push({from:a,to:b,strength:co});
  }
  conceptMap.sort((a,b)=>b.strength-a.strength);
  const strategy=buildStrategy(s,terms,doc.media||[],doc.summaryMode||"standard");
  const examCram=examCramOverride||synthesizeSummary(units,terms,headings,"cram");
  const confidence=Math.round(clamp((Math.min(1,units.length/20)*.25)+(Math.min(1,terms.length/20)*.25)+(Math.min(1,s.definitions.length/6)*.20)+(Math.min(1,takeaways.length/8)*.20)+(headings.length?0.10:0),0,1)*100);
  return {
    engineVersion:REVIEW_ENGINE_VERSION,mode:doc.summaryMode||"standard",overview,strategy,examCram,terms,headings,
    definitions:s.definitions,keyPoints:takeaways,processes:s.processes,causes:s.causes,comparisons:s.comparisons,examples:s.examples,facts:s.facts,
    questions:questions.slice(0,40),memory,checklist:checklist.slice(0,28),pages:pages.slice(0,80),blueprint,conceptMap:conceptMap.slice(0,40),confidence
  };
}

function buildStrategy(s,terms,media,mode){
  const steps=[];
  steps.push(`Start with the top ${Math.min(terms.length,10)} concepts, then read the ${SUMMARY_MODES[mode]?.label||"Standard"} summary once.`);
  if(s.definitions.length)steps.push("Learn definitions first — say each one out loud before looking at examples.");
  if(s.processes.length)steps.push("Cover the page and rebuild the process steps from memory, then check the order.");
  if(s.causes.length)steps.push("For each cause–effect pair, explain why it happens in one short sentence.");
  if(s.comparisons.length)steps.push("Write a quick two-column table for ideas that are easy to mix up.");
  if(s.facts.length)steps.push("Memorize formulas, numbers, and units on their own — separate from the story.");
  if(media.length)steps.push("Study each photo or diagram, then explain it with your eyes closed.");
  steps.push("Finish with the quiz. Any concept you miss twice goes back into flashcards.");
  return steps.map((s,i)=>`${i+1}. ${s}`).join("\n");
}

function clozeFromSentence(text,term){
  const raw=String(term||"").trim();
  if(!raw)return String(text||"");
  const e=raw.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  // Safe word-boundary replace (no lookbehind — older browsers crash otherwise and kill PDF import)
  try{
    const re=new RegExp(`(?:^|[^A-Za-z0-9_])(${e})(?=[^A-Za-z0-9_]|$)`,"i");
    if(re.test(text))return String(text).replace(re,(m,g1)=>m.replace(g1,"_____")).replace(/\s{2,}/g," ").trim();
  }catch{}
  // Last resort: case-insensitive plain replace of whole term only when isolated by spaces
  const plain=String(text);
  const idx=plain.toLowerCase().indexOf(raw.toLowerCase());
  if(idx<0)return plain;
  return (plain.slice(0,idx)+"_____"+plain.slice(idx+raw.length)).replace(/\s{2,}/g," ").trim();
}

function cardId(doc,type,question,answer){return stableId("fc",`${doc.id}|${type}|${question}|${answer}`);}
/** Scale flashcard count to material size — small handouts stay light; rich PDFs grow up to 200. */
function flashcardBudget(doc,r,units){
  const pages=Math.max(1,Number(doc.pageCount)||(doc.pageTexts||[]).length||1);
  const terms=(r.terms||[]).length;
  const defs=(r.definitions||[]).length;
  const media=(doc.media||[]).length;
  const unitN=units.length;
  // Estimate complexity, then clamp 24…200
  let target=24
    +Math.min(40,pages*3)
    +Math.min(50,terms*2)
    +Math.min(30,defs*2)
    +Math.min(40,Math.floor(unitN/4))
    +Math.min(20,media*2);
  if(pages>=15||terms>=30||unitN>=80)target=Math.max(target,120);
  if(pages>=25||terms>=45||unitN>=150)target=Math.max(target,180);
  return clamp(Math.round(target),24,MAX_FLASHCARDS);
}
function makeFlashcards(doc){
  const units=sentenceUnits(doc),r=doc.reviewerData||buildReviewer(doc),cards=[],seen=new Set();
  const limit=flashcardBudget(doc,r,units);
  const add=(type,q,a,term="",page=null,source="page")=>{
    if(cards.length>=limit)return;
    q=normalize(q);a=cleanAnswer(a,240);if(q.length<8||a.length<8)return;
    // Reject trash answers (headers, tiny fragments)
    if(/^(?:component|circuit symbol|function of)/i.test(a))return;
    if(a.split(/\s+/).length<4)return;
    const id=cardId(doc,type,q,a);if(seen.has(id))return;seen.add(id);
    cards.push({id,type,term,question:q,answer:a,page,source});
  };

  // 1) Clean component / definition cards (highest quality for symbol sheets)
  for(const d of r.definitions||[]){
    const ans=cleanAnswer(d.definition,220);
    add("definition",`What is the function of a ${d.term}?`,ans,d.term,d.page);
    add("name-it",`Which component: ${ans}`,d.term,d.term,d.page);
    add("explain",`Explain ${d.term} like you are teaching a classmate.`,ans,d.term,d.page);
  }

  // 2) Term recall with cleaned unit answers only
  const termCap=Math.min((r.terms||[]).length,Math.max(20,Math.floor(limit/3)));
  for(const term of (r.terms||[]).slice(0,termCap)){
    if((r.definitions||[]).some(d=>d.term.toLowerCase()===String(term).toLowerCase()))continue;
    const u=units.find(x=>x.text.toLowerCase().includes(String(term).toLowerCase()));if(!u)continue;
    const ans=cleanAnswer(u.text,200);
    add("recall",`What does ${term} do in this material?`,ans,term,u.page);
    const cloze=clozeFromSentence(u.text,term);
    if(cloze&&cloze.includes("_____"))add("cloze",`Fill in the blank:\n${cleanAnswer(cloze,200)}`,String(term),term,u.page);
  }

  for(const p of (r.processes||[]).slice(0,12))add("process",`Describe this process from the material.`,cleanAnswer(p.text,200),"",p.page);
  for(const f of (r.facts||[]).slice(0,16))add("fact",`What fact or formula should you remember?`,cleanAnswer(f.text,200),"",f.page);
  for(const q of (r.questions||[]).slice(0,20)){
    const def=(r.definitions||[]).find(d=>(q.q||"").toLowerCase().includes(String(d.term).toLowerCase()));
    const ans=def?cleanAnswer(def.definition,200):cleanAnswer((units.find(x=>Number(x.page)===Number(q.page))||units[0])?.text||"",200);
    add("exam-recall",q.q||q,ans,def?.term||"",q.page);
  }
  for(const m of doc.media||[]){
    const answer=cleanAnswer(m.caption||m.ocrText||"",200);if(!answer)continue;
    add("visual",`What should you remember from ${m.name}?`,answer,"",null,"photo");
  }
  for(const p of r.keyPoints||[]){
    if(cards.length>=limit)break;
    const text=typeof p==="string"?p:p.text;
    add("key-point",`Key idea — explain it:`,cleanAnswer(text,180),"",p.page);
  }
  return cards.slice(0,limit);
}

function deterministicShuffle(arr,seedText=""){
  const a=[...arr];let seed=0;for(const c of seedText)seed=(seed*31+c.charCodeAt(0))>>>0;
  for(let i=a.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;
}

function lengthMatchedDistractors(correct,pool,seed,count=3){
  const c=normalize(correct);const target=c.length||20;const seen=new Set([c.toLowerCase()]);
  const scored=pool.map(x=>{const t=normalize(x);if(!t||seen.has(t.toLowerCase()))return null;return{t,score:Math.abs(t.length-target)+Math.abs(tokenize(t).length-tokenize(c).length)*4};}).filter(Boolean).sort((a,b)=>a.score-b.score);
  const picks=[];
  for(const item of scored){if(picks.some(p=>similarity(p,item.t)>.72))continue;picks.push(item.t);seen.add(item.t.toLowerCase());if(picks.length>=count)break;}
  if(picks.length<count){for(const x of deterministicShuffle(pool,seed)){const t=normalize(x);if(!t||seen.has(t.toLowerCase()))continue;picks.push(t);seen.add(t.toLowerCase());if(picks.length>=count)break;}}
  return picks;
}
function quizItem(doc,type,question,context,correct,options,page,term=""){
  const unique=[];const seen=new Set();
  for(const o of [correct,...(options||[])]){const t=normalize(o);if(!t)continue;const k=t.toLowerCase();if(seen.has(k))continue;seen.add(k);unique.push(t);}
  const right=normalize(correct);if(!unique.includes(right))unique.unshift(right);
  const opts=deterministicShuffle(unique.slice(0,4),question+right);
  return opts.length>=2?{id:stableId("q",`${doc.id}|${type}|${question}|${right}`),type,question,context,options:opts,correctIndex:opts.indexOf(right),correct:right,page,term}:null;
}

function makeQuiz(doc){
  const r=doc.reviewerData||buildReviewer(doc),terms=r.terms||[],quiz=[],seen=new Set();const add=q=>{if(q&&!seen.has(q.id)){seen.add(q.id);quiz.push(q);}};
  for(const d of (r.definitions||[])){
    const wrong=lengthMatchedDistractors(d.term,terms.filter(t=>t.toLowerCase()!==d.term.toLowerCase()),d.term,3);
    add(quizItem(doc,"definition",`Which concept is best described by the definition below?`,d.definition,d.term,[d.term,...wrong],d.page,d.term));
    if(quiz.length>=8)break;
  }
  for(const term of terms){
    if(quiz.length>=14)break;
    const u=sentenceUnits(doc).find(x=>x.text.toLowerCase().includes(term.toLowerCase()));if(!u)continue;
    const wrong=lengthMatchedDistractors(term,terms.filter(t=>t.toLowerCase()!==term.toLowerCase()),term,3);
    add(quizItem(doc,"concept","Which term is most directly supported by this source statement?",u.text,term,[term,...wrong],u.page,term));
  }
  for(const p of (r.keyPoints||[])){
    if(quiz.length>=20)break;
    const wrong=lengthMatchedDistractors(p.text,(r.keyPoints||[]).filter(x=>x.text!==p.text).map(x=>x.text),p.text,3);
    add(quizItem(doc,"key-point","Which statement best matches the source material?",p.text,p.text,[p.text,...wrong],p.page));
  }
  for(const m of doc.media||[]){
    if(quiz.length>=24)break;
    const correct=m.caption||m.ocrText;if(!correct)continue;
    const wrong=lengthMatchedDistractors(correct,(r.memory||[]).map(x=>x.clue).filter(Boolean),m.name||"photo",3);
    add(quizItem(doc,"visual",`Which statement best matches ${m.name}?`,correct,correct,[correct,...wrong],null));
  }
  return quiz.slice(0,24);
}

function reviewerText(doc){
  const r=doc.reviewerData||buildReviewer(doc);
  const sec=(title,lines)=>`${title}\n${lines?.length?lines.map((x,i)=>`${i+1}. ${typeof x==="string"?x:x.text||x.definition||x.q||JSON.stringify(x)}`).join("\n"):'—'}`;
  return [
    `STUDYVAULT REVIEWER — ${doc.fileName}`,
    `SUMMARY MODE: ${SUMMARY_MODES[r.mode]?.label||r.mode}`,
    `SOURCE CONFIDENCE: ${r.confidence||0}%`,
    `\nEXECUTIVE SUMMARY\n${r.overview}`,
    doc.ai?.reviewer?`\nLOCAL AI REVIEW\n${doc.ai.reviewer}`:"",
    `\nEXAM CRAM\n${r.examCram}`,
    `\nHOW TO STUDY\n${r.strategy}`,
    sec("\nKEY TERMS",r.terms),
    sec("\nDEFINITIONS",r.definitions.map(d=>`${d.term}: ${d.definition}${d.page?` (Page ${d.page})`:""}`)),
    sec("\nKEY POINTS",r.keyPoints),
    sec("\nPROCESSES / STEPS",r.processes),
    sec("\nCAUSE & EFFECT",r.causes),
    sec("\nCOMPARISONS",r.comparisons),
    sec("\nEXAMPLES",r.examples),
    sec("\nFACTS / FORMULAS",r.facts),
    sec("\nMEMORY CUES",r.memory),
    sec("\nSTUDY QUESTIONS",r.questions.map(q=>q.q)),
    sec("\nEXAM CHECKLIST",r.checklist),
    sec("\nPAGE HIGHLIGHTS",r.pages.map(p=>`Page ${p.page}: ${p.text}`))
  ].join("\n\n");
}

function regenerateDoc(doc,resetProgress=false){
  try{
    doc.terms=candidateTerms(doc);
    doc.reviewerData=buildReviewer(doc);
    doc.reviewerText=reviewerText(doc);
    try{doc.flashcards=makeFlashcards(doc);}catch(err){console.warn("flashcards failed",err);doc.flashcards=doc.flashcards||[];}
    try{doc.quiz=makeQuiz(doc);}catch(err){console.warn("quiz failed",err);doc.quiz=doc.quiz||[];}
    doc.currentCard=0;
    doc.knownCardIds=Array.isArray(doc.knownCardIds)?doc.knownCardIds.filter(id=>doc.flashcards.some(c=>c.id===id)):[];
    doc.cardStats=doc.cardStats&&typeof doc.cardStats==="object"?doc.cardStats:{};
    if(resetProgress){doc.knownCardIds=[];doc.cardStats={};doc.quizScore=null;doc.quizHistory=[];}
    doc.reviewerVersion=REVIEW_ENGINE_VERSION;
  }catch(err){
    console.error("regenerateDoc failed",err);
    doc.terms=doc.terms||[];
    doc.reviewerData=doc.reviewerData||{overview:"Reviewer will fill in after the next regenerate.",terms:[],keyPoints:[],definitions:[],confidence:0};
    doc.flashcards=doc.flashcards||[];
    doc.quiz=doc.quiz||[];
  }
}


let aiWorker=null, aiSeq=0, aiCurrent=null;
let tutorChat=[]; // {role:'user'|'tutor', text, mode, at}
let tutorBusy=false;
function aiEnsureWorker(){
  if(aiWorker)return aiWorker;
  aiWorker=new Worker(AI_WORKER_URL,{type:"module"});
  aiWorker.onmessage=e=>{
    const m=e.data||{};
    if(m.type==="status"||m.type==="progress"){
      const el=$("#aiStatus");if(el)el.textContent=m.message||"Local AI working…";
      return;
    }
    if(m.type==="device"){
      const el=$("#aiStatus");
      if(el && m.android) el.textContent=m.conservative?"Android safe mode • low-memory profile • CPU/WASM AI":"Android optimized • preparing the best available AI path…";
      return;
    }
    if(m.type==="ready"){
      const el=$("#aiStatus");if(el)el.textContent=`AI ready • ${m.android?"Android optimized":"on-device"} • ${m.device||"local"}`;
      return;
    }
    if(m.type==="token" && aiCurrent?.requestId===m.requestId){
      aiCurrent.text=(aiCurrent.text||"")+String(m.text||"");
      const box=aiCurrent.mode==="ask"?$("#aiAnswer"):$("#aiReviewer");if(box)box.textContent=aiCurrent.text;
      return;
    }
    if(m.type==="done"){
      const pending=aiCurrent;if(!pending||pending.requestId!==m.requestId)return;
      aiCurrent=null;pending.resolve(m);return;
    }
    if(m.type==="error"){
      const pending=aiCurrent;if(!pending||pending.requestId!==m.requestId)return;
      aiCurrent=null;pending.reject(new Error(m.message||"Local AI failed."));return;
    }
  };
  aiWorker.onerror=e=>{if(aiCurrent){aiCurrent.reject(new Error("Local AI worker stopped unexpectedly."));aiCurrent=null;}const s=$("#aiStatus");if(s)s.textContent="Local AI worker unavailable.";};
  return aiWorker;
}
function aiRequest(task,payload){
  if(/Android/i.test(navigator.userAgent||"") && task==="ask") payload={...payload, mobile:true};
  const worker=aiEnsureWorker(),requestId=++aiSeq;
  return new Promise((resolve,reject)=>{aiCurrent={requestId,resolve,reject,mode:task==="ask"?"ask":"reviewer",text:""};worker.postMessage({type:"task",task,requestId,...payload});});
}
function aiCancel(){if(aiWorker){try{aiWorker.postMessage({type:"cancel"});}catch{};try{aiWorker.terminate();}catch{};aiWorker=null;}if(aiCurrent){aiCurrent.reject(new Error("AI task cancelled."));aiCurrent=null;}const s=$("#aiStatus");if(s)s.textContent="AI stopped. Your saved reviewer is safe.";const b=$("#aiEnhance");if(b)b.disabled=false;}
function learnerDigestForAI(){const p=learnerProfile();return JSON.stringify({level:p.level||"beginner",sessions:p.sessions||0,recentAccuracy:p.recentAccuracy,weak:weakConcepts(8),concepts:Object.values(p.concepts||{}).slice(0,20).map(x=>({label:x.label,mastery:x.mastery,attempts:x.attempts,streak:x.streak}))});}
function pageRelevance(page, queryTerms, terms){
  const text=normalize(page?.text||"").toLowerCase();
  if(!text)return 0;
  let score=0;
  for(const q of queryTerms){if(q.length>=3&&text.includes(q))score+=3;}
  for(const t of terms.slice(0,30)){const tt=String(t).toLowerCase();if(tt.length>=4&&text.includes(tt))score+=0.35;}
  if(page?.source==="photo"||page?.source==="ocr")score+=0.2;
  return score;
}
function softPageClip(text,maxChars){
  const t=normalize(text||"");
  if(t.length<=maxChars)return t;
  // Prefer ending on a sentence/page boundary, never mid-word
  let cut=t.slice(0,maxChars);
  const stop=Math.max(cut.lastIndexOf("\n"),cut.lastIndexOf(". "),cut.lastIndexOf("? "),cut.lastIndexOf("! "));
  if(stop>=Math.floor(maxChars*0.55))cut=cut.slice(0,stop+1);
  else cut=cut.replace(/\s+\S*$/,"");
  return cut.trim();
}
function aiSource(d, query=""){
  const pages=(d.pageTexts||[]).filter(p=>normalize(p.text||""));
  const mobile=/Android/i.test(navigator.userAgent||"");
  const budget=mobile?14000:26000;
  if(!pages.length)return softPageClip(d.rawText||"",budget);
  const queryTerms=tokenize(query).filter(x=>x.length>=3&&!STOP.has(x)).slice(0,12);
  const scored=pages.map((p,i)=>({p,i,score:pageRelevance(p,queryTerms,d.terms||[])}));
  const picks=new Set();
  [0,1,2,pages.length-3,pages.length-2,pages.length-1].forEach(i=>{if(i>=0&&i<pages.length)picks.add(i);});
  for(const item of scored.sort((a,b)=>b.score-a.score)){
    if(picks.size>=14)break;
    if(item.score>0)picks.add(item.i);
  }
  const step=Math.max(1,Math.floor(pages.length/10));
  for(let i=step;i<pages.length&&picks.size<14;i+=step)picks.add(i);
  // Pack whole pages until budget is reached so definitions are not sliced mid-sentence
  let used=0;const chunks=[];
  for(const i of [...picks].sort((a,b)=>a-b)){
    const p=pages[i];
    const body=softPageClip(p.text,Math.min(3200,budget-used-40));
    if(!body)continue;
    const block=`PAGE ${p.page}\n${body}`;
    if(used+block.length+8>budget)break;
    chunks.push(block);used+=block.length+8;
  }
  return chunks.join("\n\n---\n\n");
}
function aiQuestionSource(d, question){return aiSource(d,question);}

function scheduleAIForDoc(doc){return Promise.resolve(doc);}


async function renderPdfPageForOcr(page,scale=2.0){
  // Cap huge pages so phones do not run out of memory mid-OCR
  let viewport=page.getViewport({scale});
  const maxSide=2200;
  if(Math.max(viewport.width,viewport.height)>maxSide){
    scale=scale*(maxSide/Math.max(viewport.width,viewport.height));
    viewport=page.getViewport({scale});
  }
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.ceil(viewport.width));
  canvas.height=Math.max(1,Math.ceil(viewport.height));
  const ctx=canvas.getContext("2d",{alpha:false});
  ctx.fillStyle="#ffffff";
  ctx.fillRect(0,0,canvas.width,canvas.height);
  // Do not pass unsupported render options — they crash OCR on some pdf.js builds
  await page.render({canvasContext:ctx,viewport}).promise;
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("Could not render PDF page for OCR.")),"image/jpeg",.9));
}
async function extractEmbeddedPdfImages(page,pageNumber,limit=4){
  // Pull embedded image operators so picture-heavy PDFs become study photos, not just OCR text.
  const media=[];
  try{
    const ops=await page.getOperatorList();
    const common=window.pdfjsLib.OPS||{};
    const paintOps=new Set([common.paintImageXObject,common.paintInlineImageXObject,common.paintImageMaskXObject].filter(Boolean));
    const names=[];
    for(let i=0;i<ops.fnArray.length;i++){
      if(paintOps.has(ops.fnArray[i])){
        const arg=ops.argsArray[i]?.[0];
        if(typeof arg==="string")names.push(arg);
      }
    }
    const unique=[...new Set(names)].slice(0,limit);
    for(const name of unique){
      try{
        const obj=await page.objs.get(name);
        if(!obj)continue;
        let dataUrl="";
        if(obj instanceof HTMLCanvasElement)dataUrl=obj.toDataURL("image/jpeg",.85);
        else if(obj?.data&&obj?.width&&obj?.height){
          const c=document.createElement("canvas");c.width=obj.width;c.height=obj.height;
          const ctx=c.getContext("2d");
          const imgData=ctx.createImageData(obj.width,obj.height);
          // pdf.js image data may be RGB or RGBA
          const src=obj.data;const dst=imgData.data;
          if(src.length>=obj.width*obj.height*4){for(let i=0;i<dst.length;i++)dst[i]=src[i];}
          else if(src.length>=obj.width*obj.height*3){
            for(let i=0,j=0;i<dst.length;i+=4,j+=3){dst[i]=src[j];dst[i+1]=src[j+1];dst[i+2]=src[j+2];dst[i+3]=255;}
          }else continue;
          ctx.putImageData(imgData,0,0);dataUrl=c.toDataURL("image/jpeg",.85);
        }
        if(!dataUrl||dataUrl.length<80)continue;
        media.push({id:uid(),name:`page-${pageNumber}-${name}.jpg`,dataUrl,width:obj.width||0,height:obj.height||0,caption:`Image from PDF page ${pageNumber}`,ocrText:"",confidence:0,createdAt:now(),page:pageNumber,fromPdf:true});
      }catch(err){console.warn("embedded image extract failed",name,err);}
    }
  }catch(err){console.warn("operator list failed",err);}
  return media;
}
async function blobToDataUrl(blob){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onload=()=>resolve(r.result);
    r.onerror=()=>reject(r.error||new Error("read failed"));
    r.readAsDataURL(blob);
  });
}
async function extractPdf(file,progress){
  const ready=await loadPdfEngine();
  if(!ready)throw new Error("PDF.js could not be loaded. Connect once so the engine can cache, then try again.");
  const buffer=await file.arrayBuffer();
  const pdf=await window.pdfjsLib.getDocument({data:buffer}).promise;
  const pageTexts=[];const units=[];const media=[];
  const maxPages=Math.min(pdf.numPages,40); // safety for huge PDFs on phones
  for(let pageNumber=1;pageNumber<=maxPages;pageNumber++){
    const page=await pdf.getPage(pageNumber);
    let text="";let itemCount=0;
    try{
      const content=await page.getTextContent();
      const items=content.items.filter(x=>typeof x.str==="string"&&x.str.length);
      itemCount=items.length;
      items.sort((a,b)=>{const ay=a.transform?.[5]||0,by=b.transform?.[5]||0;if(Math.abs(by-ay)>3)return by-ay;return (a.transform?.[4]||0)-(b.transform?.[4]||0)});
      // Smarter join: no space before/after pure symbol glyphs so "H"+"2"+"O" → "H2O", "→" stays tight
      const lines=[];let current="";let lastY=null;let lastStr="";
      const isSym=s=>/^[\s]*[→←↔≤≥≠≈±×÷°√∛μΩΔα-ωΑ-Ω^_+\-=/\\()\[\]{}.,;:°%∞]+[\s]*$/.test(s)||/^\d+$/.test(s);
      for(const item of items){
        const y=item.transform?.[5]||0;
        const s=item.str;
        if(lastY!==null&&Math.abs(y-lastY)>3){if(current.trim())lines.push(current.trim());current="";lastStr="";}
        if(!current)current=s;
        else if(isSym(s)||isSym(lastStr)||/^[.,;:)\]]$/.test(s)||/^[(\[]$/.test(lastStr)||item.hasEOL===false&&(item.width||0)<2){
          current+=s; // glue symbols/subscripts tightly
        }else current+=` ${s}`;
        lastStr=s;lastY=y;
        if(item.hasEOL){if(current.trim())lines.push(current.trim());current="";lastStr="";}
      }
      if(current.trim())lines.push(current.trim());
      text=repairSymbols(lines.join("\n"));
    }catch(err){console.warn("text extract failed page",pageNumber,err);}
    pageTexts.push({page:pageNumber,text,source:"text",itemCount});
    for(const x of extractSentences(text,24))units.push({page:pageNumber,text:x,source:"text"});
    try{
      const imgs=await extractEmbeddedPdfImages(page,pageNumber,3);
      for(const m of imgs)media.push(m);
    }catch{}
    progress?.(pageNumber,maxPages);
  }
  // Treat as visual when text is thin OR page looks image-heavy
  const imagePages=new Set(media.map(m=>m.page));
  const sparsePages=pageTexts
    .filter(p=>wordCount(p.text)<50||imagePages.has(p.page)||(p.itemCount||0)<12)
    .map(p=>p.page);
  let ocrPages=0;
  // Always try to capture page pictures for sparse pages (even if OCR is offline)
  for(const pageNumber of [...new Set(sparsePages)].slice(0,20)){
    progress?.(`ocr:${pageNumber}`,maxPages);
    try{
      const page=await pdf.getPage(pageNumber);
      const blob=await renderPdfPageForOcr(page,2.0);
      const pageDataUrl=await blobToDataUrl(blob);
      let full=media.find(m=>m.page===pageNumber&&m.fullPage);
      if(pageDataUrl&&!full){
        full={id:uid(),name:`${(file.name||"pdf").replace(/\.pdf$/i,"")}-page-${pageNumber}.jpg`,dataUrl:pageDataUrl,width:0,height:0,caption:`Page ${pageNumber} (visual)`,ocrText:"",confidence:0,createdAt:now(),page:pageNumber,fullPage:true,fromPdf:true};
        media.push(full);
      }
      // OCR when engine is ready
      const readyOcr=await loadTesseract();
      if(readyOcr){
        const ocr=await ocrImage(new File([blob],`page-${pageNumber}.jpg`,{type:"image/jpeg"}));
        const ocrText=repairSymbols(ocr.text||"");
        // Prefer OCR when it has more words OR richer symbols (arrows, Greek, operators)
        const symbolScore=s=>((String(s).match(/[→←↔≤≥≠≈±×÷°√μΩΔα-ωΑ-Ω^_=]/g)||[]).length);
        const prev=pageTexts[pageNumber-1].text||"";
        const better=wordCount(ocrText)>Math.max(3,wordCount(prev))
          ||(symbolScore(ocrText)>symbolScore(prev)+1&&wordCount(ocrText)>=3);
        if(ocrText&&better){
          pageTexts[pageNumber-1].text=ocrText;
          pageTexts[pageNumber-1].source="ocr";
          pageTexts[pageNumber-1].confidence=ocr.confidence;
          ocrPages++;
          for(const x of extractSentences(ocrText,18))units.push({page:pageNumber,text:x,source:"ocr"});
          if(full){full.ocrText=ocrText;full.confidence=ocr.confidence;full.caption=`Page ${pageNumber} · OCR + symbols`;}
        }else if(ocrText&&full&&!full.ocrText){
          full.ocrText=ocrText;full.confidence=ocr.confidence;
        }
      }
    }catch(err){console.warn("PDF visual/OCR failed on page",pageNumber,err);}
  }
  if(!sparsePages.length)progress?.("ocr-skip",maxPages);
  const rawText=pageTexts.map(p=>`Page ${p.page}\n${p.text}`).join("\n\n");
  return {pageCount:pdf.numPages,pageTexts,units,rawText,ocrPages,media};
}

function plainToHtml(text){
  return normalize(text).split(/\n\n+/).map(p=>`<p>${esc(p).replace(/\n/g,"<br>")}</p>`).join("")||"<p></p>";
}
function stripHtml(html){
  const box=document.createElement("div");box.innerHTML=html||"";
  return normalize(box.innerText||box.textContent||"");
}
function safeNoteHtml(html){
  const box=document.createElement("div");box.innerHTML=String(html||"");
  const allowed=new Set(["P","DIV","BR","STRONG","B","EM","I","U","H2","H3","UL","OL","LI","BLOCKQUOTE","IMG","A","SPAN"]);
  const safeImage=/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i;
  const safeHref=/^(?:https?:\/\/|mailto:)[^\s]+$/i;
  box.querySelectorAll("*").forEach(el=>{
    if(!allowed.has(el.tagName)){el.replaceWith(...el.childNodes);return;}
    [...el.attributes].forEach(attr=>{
      const n=attr.name.toLowerCase(),v=attr.value||"";
      if(n.startsWith("on")||n==="style"||n==="srcdoc"||n==="formaction"||n==="xlink:href"||n==="xmlns"||n==="is"||n==="slot"||n==="part"){el.removeAttribute(attr.name);return;}
      if(el.tagName==="IMG"&&n==="src"&&!safeImage.test(v)){el.removeAttribute(attr.name);return;}
      if(el.tagName==="A"&&n==="href"&&!safeHref.test(v)){el.removeAttribute(attr.name);return;}
      if(el.tagName==="A"&&n==="target"){el.setAttribute("rel","noopener noreferrer");}
      if(!["src","alt","href","target","rel"].includes(n))el.removeAttribute(attr.name);
    });
  });
  return box.innerHTML||"<p></p>";
}

function migrateCardStats(d){
  const out=typeof d.cardStats==="object"&&d.cardStats?{...d.cardStats}:{};
  for(const c of d.flashcards||[]){
    const s=out[c.id]; if(!s)out[c.id]={attempts:0,correct:0,streak:0,ease:2.5,dueAt:0,lastSeen:0};
  }
  return out;
}
function normalizeDoc(raw){
  const d={...raw};
  d.id=d.id||uid();d.sourceType=d.sourceType||"pdf";d.ai=typeof d.ai==="object"&&d.ai?d.ai:{enabled:false,generatedAt:"",reviewer:"",cards:[],quiz:[],groundingScore:0};d.fileName=String(d.fileName||"Untitled Study Material");
  d.pageCount=Number(d.pageCount)||0;d.media=Array.isArray(d.media)?d.media:[];d.pageTexts=Array.isArray(d.pageTexts)?d.pageTexts:[];
  d.rawText=String(d.rawText||d.pageTexts.map(p=>p.text||"").join("\n\n"));
  d.units=Array.isArray(d.units)&&d.units.length?d.units:sentenceUnits(d);
  d.summaryMode=SUMMARY_MODES[d.summaryMode]?d.summaryMode:"standard";
  d.terms=candidateTerms(d);
  if(!d.reviewerData||d.reviewerData.engineVersion!==REVIEW_ENGINE_VERSION||d.reviewerData.mode!==d.summaryMode){regenerateDoc(d,false);}
  d.reviewerText=reviewerText(d);
  d.flashcards=Array.isArray(d.flashcards)?d.flashcards:makeFlashcards(d);d.flashcards=d.flashcards.map((c,i)=>({...c,id:c.id||cardId(d,c.type||"recall",c.question||`Card ${i+1}`,c.answer||"")}));
  d.currentCard=clamp(Number(d.currentCard)||0,0,Math.max(0,d.flashcards.length-1));
  d.knownCardIds=Array.isArray(d.knownCardIds)?d.knownCardIds.filter(id=>d.flashcards.some(c=>c.id===id)):[];
  d.cardStats=migrateCardStats(d);
  d.quiz=Array.isArray(d.quiz)&&d.quiz.length?d.quiz:makeQuiz(d);
  d.quiz=d.quiz.map((q,i)=>{const options=Array.isArray(q.options)?q.options:[];let ci=Number.isInteger(q.correctIndex)?q.correctIndex:options.indexOf(q.correct);ci=ci>=0?ci:0;return {...q,id:q.id||stableId("q",`${d.id}|${i}|${q.question||""}`),options,correctIndex:clamp(ci,0,Math.max(0,options.length-1)),correct:options[ci]||q.correct||""};});
  d.quizHistory=Array.isArray(d.quizHistory)?d.quizHistory:[];d.quizScore=Number.isFinite(d.quizScore)?d.quizScore:null;
  d.notesTitle=String(d.notesTitle||"Study Notes");d.notesHtml=safeNoteHtml(d.notesHtml||plainToHtml(String(d.notes||"")));d.notes=stripHtml(d.notesHtml);d.notesUpdatedAt=d.notesUpdatedAt||"";
  d.createdAt=d.createdAt||now();d.updatedAt=d.updatedAt||now();
  return d;
}

function renderLibrary(){
  const box=$("#library");
  if(!state.documents.length)return box.innerHTML='<div class="empty">Your PDFs will appear here.</div>';
  box.innerHTML=state.documents.map(d=>`<div class="doc ${d.id===state.activeDocId?'active':''}"><div class="doc-icon">📘</div><div class="doc-main"><div class="doc-name">${esc(d.fileName)}</div><div class="doc-meta">${d.pageCount} pages • ${wordCount(d.rawText).toLocaleString()} words • ${d.terms.length} terms</div></div><div class="doc-actions"><button class="btn small secondary" data-open="${esc(d.id)}">Open</button><button class="btn small danger" data-delete="${esc(d.id)}">Delete</button></div></div>`).join('');
  box.querySelectorAll('[data-open]').forEach(b=>b.onclick=async()=>{state.activeDocId=b.dataset.open;await saveMeta();renderAll();activateSection('dashboard');});
  box.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const d=state.documents.find(x=>x.id===b.dataset.delete);if(!d)return;if(!confirm(`Delete ${d.fileName}?`))return;await dbDelete(DOC_STORE,d.id);state.documents=state.documents.filter(x=>x.id!==d.id);state.activeDocId=state.documents[0]?.id||null;await saveMeta();renderAll();toast('Document deleted.','success');});
}
function renderStats(){const docs=state.documents;$("#stats").classList.toggle('hidden',!docs.length);$("#statDocs").textContent=docs.length;if($("#heroDocCount"))$("#heroDocCount").textContent=docs.length;$("#statPages").textContent=docs.reduce((a,d)=>a+(d.pageCount||0),0).toLocaleString();$("#statPhotos").textContent=docs.reduce((a,d)=>a+(d.media?.length||0),0).toLocaleString();$("#statWords").textContent=docs.reduce((a,d)=>a+wordCount(d.rawText||''),0).toLocaleString();$("#statTerms").textContent=activeDoc()?.terms.length||0;$("#statFlash").textContent=activeDoc()?.flashcards.length||0;$("#statQuiz").textContent=activeDoc()?.quiz.length||0;$("#navFlash").textContent=activeDoc()?.flashcards.length||0;$("#navQuiz").textContent=activeDoc()?.quiz.length||0;}
function renderActivePanel(){const d=activeDoc(),box=$("#activeDocPanel");if(!d){box.innerHTML='<div class="empty">Add a PDF or photo to start studying.</div>';return;}const known=d.knownCardIds.length,total=d.flashcards.length,progress=total?Math.round(known/total*100):0;box.innerHTML=`<div class="doc" style="margin-bottom:12px"><div class="doc-icon">${d.sourceType==='image'?'🖼':'📘'}</div><div class="doc-main"><div class="doc-name">${esc(d.fileName)}</div><div class="doc-meta">${d.sourceType==='image'?'Photo study':'PDF'} • ${d.pageCount||1} page${(d.pageCount||1)===1?'':'s'} • ${d.media?.length||0} photo(s) • ${wordCount(d.rawText||'').toLocaleString()} words</div></div></div><div class="source-pill">${d.sourceType==='image'?'OCR + Visual':'PDF text + page structure'}</div><p class="muted" style="line-height:1.65;margin-top:12px">${esc(d.reviewerData?.overview||'')}</p><div style="margin-top:14px"><div style="display:flex;justify-content:space-between;gap:10px;font-size:.75rem;color:var(--muted)"><span>Flashcard progress</span><span>${known}/${total} (${progress}%)</span></div><div class="progress-track" style="margin-top:6px"><div class="progress-bar" style="width:${progress}%"></div></div></div><div class="row" style="margin-top:14px"><button class="btn primary small" data-go="reviewer">Reviewer</button><button class="btn secondary small" data-go="flashcards">Flashcards</button><button class="btn secondary small" data-go="quiz">Quiz</button><button id="regenDocBtn" class="btn warning small">Regenerate</button></div>`;box.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>activateSection(b.dataset.go));$("#regenDocBtn").onclick=async()=>{regenerateDoc(d,true);await saveDoc(d);renderAll();toast(`Reviewer ready · ${(d.flashcards||[]).length} flashcards · ${(d.quiz||[]).length} quiz items.`,'success');};}
function renderTerms(){const c=$("#reviewerTerms"),terms=activeDoc()?.terms||[];c.innerHTML=terms.length?terms.map(t=>`<span class="term">${esc(t)}</span>`).join(''):'<div class="empty">No terms detected.</div>';}
function formatReviewerProse(text,emptyMsg){
  const raw=normalize(text||"");
  if(!raw)return `<p class="empty">${esc(emptyMsg)}</p>`;
  const lines=raw.split(/\n+/).map(l=>l.trim()).filter(Boolean);
  const html=[];
  let inList=false;
  const closeList=()=>{if(inList){html.push("</ul>");inList=false;}};
  for(const line of lines){
    const isHeading=/^(Focus|Core ideas|Key points|Quick points|Detailed points|Remember these)$/i.test(line);
    const isBullet=/^[•\-–—]\s+/.test(line)||/^\d+\.\s+/.test(line);
    if(isHeading){
      closeList();
      html.push(`<div class="review-label">${esc(line)}</div>`);
    }else if(isBullet){
      if(!inList){html.push('<ul class="review-bullets">');inList=true;}
      const body=line.replace(/^[•\-–—]\s+/,"").replace(/^\d+\.\s+/,"");
      html.push(`<li>${esc(body)}</li>`);
    }else{
      closeList();
      // Topic line under Focus gets a softer style
      if(html.length&&html[html.length-1].includes("review-label")){
        html.push(`<p class="review-focus">${esc(line)}</p>`);
      }else{
        html.push(`<p class="review-prose">${esc(line)}</p>`);
      }
    }
  }
  closeList();
  return html.join("")||`<p class="empty">${esc(emptyMsg)}</p>`;
}

function renderReviewer(){
  const d=activeDoc(),r=d?.reviewerData;
  const overviewEl=$("#reviewerOverview");
  const cramEl=$("#reviewerCram");
  const strategyEl=$("#reviewerStrategy");
  if(overviewEl)overviewEl.innerHTML=formatReviewerProse(r?.overview,"Select a study material.");
  if(cramEl)cramEl.innerHTML=formatReviewerProse(r?.examCram,"Upload a PDF or photo to create a compact exam summary.");
  if(strategyEl)strategyEl.innerHTML=formatReviewerProse(r?.strategy,"Upload a PDF to create a study strategy.");
  $("#reviewerMeta").textContent=d?`${d.fileName} • ${r?.mode?SUMMARY_MODES[r.mode]?.label||r.mode:"Standard"} • ${r?.terms?.length||0} concepts • ${r?.confidence||0}% source-structure confidence`:`Evidence-first local synthesis. Change the summary depth without changing your source material.`;
  $("#reviewerConfidence").textContent=d?`${r?.confidence||0}% evidence confidence`:`Not analyzed`;
  $$('[data-summary-mode]').forEach(b=>b.classList.toggle("active",b.dataset.summaryMode===(d?.summaryMode||"standard")));
  renderTerms();
  const softListText=t=>softenBullet(t,220);
  const fill=(sel,items,map,empty)=>{const el=$(sel);if(!el)return;el.innerHTML=items?.length?items.map(map).join(""):empty;};
  fill("#reviewerDefinitions",r?.definitions,d=>`<div class="definition-card"><strong>${esc(d.term)}</strong><span>${esc(softListText(d.definition))}${d.page?` <span class="tiny">Page ${d.page}</span>`:""}<span class="confidence-badge">${Math.round((d.confidence||0)*100)}%</span></span></div>`,'<div class="empty">No explicit definition pattern was detected. Contextual evidence is still available.</div>');
  fill("#reviewerKeyPoints",r?.keyPoints,x=>`<li>${esc(softListText(x.text))}${x.heading?`<span class="meta">${esc(x.heading)}</span>`:""}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No strong evidence points yet.</li>');
  fill("#reviewerProcesses",r?.processes,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No process or sequence pattern detected.</li>');
  fill("#reviewerCauses",r?.causes,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No cause-effect pattern detected.</li>');
  fill("#reviewerComparisons",r?.comparisons,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No comparison pattern detected.</li>');
  fill("#reviewerExamples",r?.examples,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No example pattern detected.</li>');
  fill("#reviewerFacts",r?.facts,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No fact or formula pattern detected.</li>');
  fill("#reviewerQuestions",r?.questions,q=>`<div class="study-question"><span class="question-type">${esc(q.type||"recall")}</span><div>${esc(q.q)}</div>${q.page?`<span class="source-chip">Page ${q.page}</span>`:""}</div>`,'<div class="empty">No study questions yet.</div>');
  fill("#reviewerPages",r?.pages,p=>`<li><strong>Page ${esc(p.page)}</strong>${p.heading?`<span class="meta">${esc(p.heading)}</span>`:""}<div class="page-snippet">${esc(softListText(p.text))}</div></li>`,'<li class="empty">No page evidence detected.</li>');
  fill("#reviewerMemory",r?.memory,m=>`<div class="memory-item"><strong>${esc(m.term)}</strong><span>${esc(softListText(m.clue))}${m.page?` <span class="tiny">Page ${m.page}</span>`:""}</span></div>`,'<div class="empty">No memory cues yet.</div>');
  fill("#reviewerChecklist",r?.checklist,x=>`<li>${esc(x)}</li>`,'<li class="empty">No checklist yet.</li>');
  const map=$("#reviewerConceptMap");if(map)map.innerHTML=r?.conceptMap?.length?r.conceptMap.slice(0,24).map(x=>`<div class="concept-link"><span>${esc(x.from)}</span><span>↔</span><span>${esc(x.to)}</span><em>${x.strength}</em></div>`).join(""):'<div class="empty">No strong concept links yet.</div>';
  const photos=$("#reviewerPhotos"),media=d?.media||[];
  photos.innerHTML=media.length?media.map(m=>`<div class="photo-card"><img src="${m.dataUrl}" alt="${esc(m.name)}"><div class="photo-body"><div class="photo-name">${esc(m.name)}</div><div class="photo-meta">${m.confidence?`OCR confidence ${Math.round(m.confidence)}%`:'OCR text not available'}</div><div class="ocr-badge ${m.ocrText?'':'warn'}">${m.ocrText?'✓ OCR text available':'⚠ Add a caption or re-run OCR'}</div><input class="photo-caption" data-caption="${esc(m.id)}" value="${esc(m.caption||"")}" maxlength="300" placeholder="What should you remember from this photo?"><div class="photo-actions"><button class="btn small secondary" data-rerun-ocr="${esc(m.id)}">Re-run OCR</button><button class="btn small secondary" data-export-pic="${esc(m.id)}">Create study pic</button><button class="btn small secondary" data-insert-note="${esc(m.id)}">Insert in notes</button><button class="btn small danger" data-remove-photo="${esc(m.id)}">Remove</button></div></div></div>`).join(""):'<div class="photo-empty">No photos attached. Use Choose Photos on Library, or drop images on the upload zone.</div>';
  photos.querySelectorAll("[data-caption]").forEach(input=>input.addEventListener("change",async()=>{const m=d?.media.find(x=>x.id===input.dataset.caption);if(!m)return;m.caption=input.value.trim();regenerateDoc(d,false);await saveDoc(d);renderAll();toast("Photo caption saved and reviewer regenerated.","success");}));
  photos.querySelectorAll("[data-remove-photo]").forEach(b=>b.onclick=async()=>{const m=d?.media.find(x=>x.id===b.dataset.removePhoto);if(!m)return;if(!confirm(`Remove ${m.name}?`))return;d.media=d.media.filter(x=>x.id!==m.id);d.pageTexts=d.pageTexts.filter(pg=>pg.photoId!==m.id);d.units=d.units.filter(u=>u.photoId!==m.id);regenerateDoc(d,true);await saveDoc(d);renderAll();toast("Photo removed.","success");});
  photos.querySelectorAll("[data-insert-note]").forEach(b=>b.onclick=()=>{const m=d?.media.find(x=>x.id===b.dataset.insertNote);if(!m)return;activateSection("notes");setTimeout(()=>insertAtCursor(`<p><img src="${m.dataUrl}" alt="${esc(m.name)}"><br><strong>${esc(m.name)}</strong></p>`),60);});
  photos.querySelectorAll("[data-rerun-ocr]").forEach(b=>b.onclick=async()=>{
    const m=d?.media.find(x=>x.id===b.dataset.rerunOcr);if(!m)return;
    b.disabled=true;b.textContent="OCR…";
    try{
      const blob=await (await fetch(m.dataUrl)).blob();
      const ocr=await ocrImage(new File([blob],m.name||"photo.jpg",{type:blob.type||"image/jpeg"}),prog=>{
        const pct=prog?.progress?Math.round(prog.progress*100):null;
        b.textContent=pct!=null?`OCR ${pct}%`:"OCR…";
      });
      m.ocrText=ocr.text||"";m.confidence=ocr.confidence||0;
      const pg=d.pageTexts.find(p=>p.photoId===m.id);
      if(pg){pg.text=m.ocrText;pg.source="photo-ocr";}
      d.units=d.units.filter(u=>u.photoId!==m.id);
      for(const x of extractSentences(m.ocrText,18))d.units.push({page:1,text:x,source:"photo",photoId:m.id});
      regenerateDoc(d,true);await saveDoc(d);renderAll();
      toast(m.ocrText?`OCR updated for ${m.name}.`:`OCR found little text on ${m.name}. Add a caption so the reviewer still knows what matters.`,"success");
    }catch(err){
      console.warn(err);
      toast("OCR needs a one-time internet connection so Tesseract can cache, then it works offline. Caption the photo for now.","error");
      b.disabled=false;b.textContent="Re-run OCR";
    }
  });
  photos.querySelectorAll("[data-export-pic]").forEach(b=>b.onclick=async()=>{
    const m=d?.media.find(x=>x.id===b.dataset.exportPic);if(!m)return;
    try{
      await exportStudyPic(m,d?.title||"StudyVault");
      toast("Study pic saved to your downloads — local only, nothing left the device.","success");
    }catch(err){console.warn(err);toast("Could not create the study pic.","error");}
  });
}
async function setSummaryMode(mode){const d=activeDoc();if(!d||!SUMMARY_MODES[mode])return toast("Select a study material first.","error");d.summaryMode=mode;regenerateDoc(d,false);await saveDoc(d);renderAll();toast(`${SUMMARY_MODES[mode].label} summary generated.`,`success`);}
function renderFlash(){
  const d=activeDoc();
  if(!d||!d.flashcards.length){$("#flashPosition").textContent="Select a document.";$("#flashQuestion").textContent="Your flashcards will appear here.";$("#flashAnswer").classList.add("hidden");$("#flashStatus").textContent="NOT STARTED";$("#flashKnown").textContent="Unmarked";return;}
  d.currentCard=clamp(Number(d.currentCard)||0,0,d.flashcards.length-1);
  const c=d.flashcards[d.currentCard],stats=d.cardStats?.[c.id]||{attempts:0,correct:0,streak:0,ease:2.5,dueAt:0};
  const known=d.knownCardIds.includes(c.id),due=stats.dueAt&&stats.dueAt<=Date.now(),mastery=stats.attempts?Math.round(stats.correct/stats.attempts*100):0;
  $("#flashPosition").textContent=`Card ${d.currentCard+1} of ${d.flashcards.length}${c.page?` • Page ${c.page}`:""}${due&&!known?" • Due now":""}`;
  $("#flashStatus").textContent=`${String(c.type).toUpperCase()} • CARD ${d.currentCard+1}`;
  $("#flashKnown").textContent=known?"✓ Known":stats.attempts?`${mastery}% mastery`:(due?"Due for review":"New");
  $("#flashQuestion").textContent=c.question;$("#flashAnswer").textContent=c.answer;$("#flashAnswer").classList.add("hidden");$("#knowFlash").disabled=known;
}
function renderQuiz(){
  const d=activeDoc(),ctn=$("#quizContainer");
  if(!d||!d.quiz.length){ctn.innerHTML='<div class="card empty">Add a PDF to build a quiz.</div>';$("#quizResult").classList.add('hidden');renderQuizHistory(d);return;}
  ctn.innerHTML=d.quiz.map((q,i)=>`<article class="quiz-item" data-q="${i}"><p class="q">${i+1}. ${esc(q.question)}</p><div class="context">${esc(q.context)}${q.page?` <span class="tiny">Page ${q.page}</span>`:''}</div>${q.options.map((o,j)=>`<label class="option"><input type="radio" name="q-${i}" value="${j}"><span>${esc(o)}</span></label>`).join('')}</article>`).join('');
  if(d.quizScore===null)$("#quizResult").classList.add('hidden');
  renderQuizHistory(d);
}
function renderQuizHistory(d){
  const h=$("#quizHistory");
  if(!d?.quizHistory?.length){h.innerHTML='<div class="empty">No attempts yet.</div>';return;}
  h.innerHTML=d.quizHistory.slice().reverse().slice(0,15).map(x=>`<div class="history-item"><span>${new Date(x.at).toLocaleString()}</span><strong>${x.score}/${x.total} (${x.percent}%)</strong></div>`).join('');
}
function renderDashboard(){renderStats();renderLibrary();renderActivePanel();$("#libraryStatus").textContent=state.documents.length?`${state.documents.length} PDF${state.documents.length===1?'':'s'} stored locally.`:'No PDF loaded yet.';}
function renderNotes(){
  const d=activeDoc(), editor=$("#notesEditor"),title=$("#notesTitle");
  editor.contentEditable=!!d;editor.innerHTML=d?.notesHtml||'<p></p>';title.value=d?.notesTitle||'';title.disabled=!d;$("#notesDocLabel").textContent=d?`Notes for ${d.fileName}`:'Notes are stored per document.';$("#noteDocumentHint").textContent=d?d.fileName:'Select a PDF to begin.';$("#noteWordCount").textContent=`${wordCount(stripHtml(editor.innerHTML))} words`;$("#noteUpdatedAt").textContent=d?.notesUpdatedAt?`Saved ${new Date(d.notesUpdatedAt).toLocaleTimeString()}`:'Not saved yet';
}
function renderAll(){renderDashboard();renderReviewer();renderFlash();renderQuiz();renderNotes();renderAI();applyTheme();}

function escapeRegExp(text){return String(text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function highlight(text,q){const safe=esc(text);if(!q)return safe;const e=escapeRegExp(q);return safe.replace(new RegExp(`(${e})`,'gi'),'<mark>$1</mark>');}
function searchActive(q){
  const d=activeDoc(),box=$("#searchResults");if(!d)return box.innerHTML='<div class="empty">Select a study material first.</div>';q=q.trim();if(!q)return box.innerHTML='<div class="empty">Type a search term.</div>';
  const low=q.toLowerCase(),matches=[];for(const p of (d.pageTexts||[])){const t=p.text||'',l=t.toLowerCase();let idx=l.indexOf(low);while(idx>=0&&matches.length<80){const start=Math.max(0,idx-120),end=Math.min(t.length,idx+q.length+200);matches.push({label:p.photoId?'Photo':'Page '+p.page,snippet:t.slice(start,end),before:start?'…':'',after:end<t.length?'…':''});idx=l.indexOf(low,idx+Math.max(1,q.length));}}
  for(const m of (d.media||[])){const text=`${m.name} ${m.caption||''} ${m.ocrText||''}`,l=text.toLowerCase();let idx=l.indexOf(low);while(idx>=0&&matches.length<80){const start=Math.max(0,idx-100),end=Math.min(text.length,idx+q.length+180);matches.push({label:`Photo: ${m.name}`,snippet:text.slice(start,end),before:start?'…':'',after:end<text.length?'…':''});idx=l.indexOf(low,idx+Math.max(1,q.length));}}
  if(!matches.length)return box.innerHTML='<div class="empty">No match found.</div>';box.innerHTML=matches.map(m=>`<div class="result"><span class="page">${esc(m.label)}</span><div>${m.before}${highlight(m.snippet,q)}${m.after}</div></div>`).join('');
}
async function insertImageFilesIntoNotes(files){for(const file of [...files].filter(f=>f.type.startsWith('image/'))){try{const visual=await dataUrlFromFile(file,1600,.84);insertAtCursor(`<p><img src="${visual.dataUrl}" alt="${esc(file.name)}"><br><em>${esc(file.name)}</em></p>`);}catch(e){toast(`${file.name}: ${e.message||'Could not add image.'}`,'error');}}}

function getEditorRange(){
  const editor=$("#notesEditor");const sel=window.getSelection();
  if(!sel||!sel.rangeCount||!editor.contains(sel.anchorNode))return null;
  return sel.getRangeAt(0);
}
function wrapSelection(tagName){
  const range=getEditorRange();if(!range||range.collapsed)return false;
  const node=document.createElement(tagName);
  try{node.appendChild(range.extractContents());range.insertNode(node);range.selectNodeContents(node);}catch{const frag=range.cloneContents();node.appendChild(frag);range.deleteContents();range.insertNode(node);range.selectNodeContents(node);}
  return true;
}
function formatSelectionBlock(tagName){
  const editor=$("#notesEditor"),range=getEditorRange();if(!range)return false;
  const container=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement)?.closest("p,div,h2,h3,blockquote,li");
  if(container&&editor.contains(container)){const n=document.createElement(tagName);while(container.firstChild)n.appendChild(container.firstChild);container.replaceWith(n);return true;}
  return wrapSelection(tagName);
}
function makeListFromSelection(){
  const range=getEditorRange();if(!range||range.collapsed)return false;
  const text=range.toString().split(/\n+/).map(x=>x.trim()).filter(Boolean);if(!text.length)return false;
  const ul=document.createElement("ul");text.forEach(x=>{const li=document.createElement("li");li.textContent=x;ul.appendChild(li);});range.deleteContents();range.insertNode(ul);return true;
}
function selectNoteCommand(cmd,value){
  const editor=$("#notesEditor");editor.focus();let changed=false;
  if(cmd==="bold")changed=wrapSelection("strong");
  else if(cmd==="italic")changed=wrapSelection("em");
  else if(cmd==="formatBlock")changed=formatSelectionBlock(String(value||"p").toLowerCase()==="h3"?"h3":"h2");
  else if(cmd==="insertUnorderedList")changed=makeListFromSelection();
  if(!changed)toast("Select some note text first.","error");else scheduleNoteSave();
}
function insertAtCursor(html){
  const editor=$("#notesEditor");editor.focus();const range=getEditorRange();
  if(!range){editor.insertAdjacentHTML("beforeend",safeNoteHtml(html));scheduleNoteSave();return;}
  const holder=document.createElement("div");holder.innerHTML=safeNoteHtml(html);const frag=document.createDocumentFragment();while(holder.firstChild)frag.appendChild(holder.firstChild);range.deleteContents();range.insertNode(frag);scheduleNoteSave();
}
function scheduleNoteSave(){
  const d=activeDoc();if(!d)return;
  const docId=d.id;
  const title=($("#notesTitle")?.value||"Study Notes").trim()||"Study Notes";
  const htmlSnapshot=safeNoteHtml($("#notesEditor")?.innerHTML||"<p></p>");
  const token=++noteSaveToken;
  $("#noteSaveStatus").textContent="Saving…";
  setTimeout(async()=>{
    if(token!==noteSaveToken)return;
    const doc=state.documents.find(x=>x.id===docId);if(!doc)return;
    try{
      doc.notesTitle=title;
      doc.notesHtml=htmlSnapshot;
      doc.notes=stripHtml(htmlSnapshot);
      doc.notesUpdatedAt=now();
      await saveDoc(doc);
      if(activeDoc()?.id===docId){$("#noteSaveStatus").textContent="Saved";$("#noteWordCount").textContent=`${wordCount(doc.notes)} words`;$("#noteUpdatedAt").textContent=`Saved ${new Date(doc.notesUpdatedAt).toLocaleTimeString()}`;}
    }catch(e){if(activeDoc()?.id===docId)$("#noteSaveStatus").textContent="Save failed";toast(e.message||"Could not save notes.","error");}
  },420);
}

function exportNotes(){
  const d=activeDoc();if(!d)return toast('Select a document first.','error');
  const txt=`${d.notesTitle}\n\n${d.notes}\n`;
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([txt],{type:'text/plain;charset=utf-8'}));a.download=`${d.fileName.replace(/\.pdf$/i,'')}-notes.txt`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),500);toast('Notes exported.','success');
}

async function copyReviewer(){const d=activeDoc();if(!d)return toast('Select a document first.','error');try{await navigator.clipboard.writeText(d.reviewerText);toast('Reviewer copied.','success')}catch{toast('Clipboard access was blocked.','error')}}
function downloadText(filename,text){const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500);}
function downloadReviewer(){const d=activeDoc();if(!d)return toast('Select a document first.','error');downloadText(`${d.fileName.replace(/\.pdf$/i,'')}-reviewer.txt`,d.reviewerText);toast('Reviewer downloaded.','success')}

async function submitQuiz(){
  const d=activeDoc();if(!d)return toast('Select a document first.','error');
  let score=0;const concepts=[];
  d.quiz.forEach((q,i)=>{const item=document.querySelector(`[data-q="${i}"]`),picked=document.querySelector(`input[name="q-${i}"]:checked`);if(!item)return;item.classList.remove('correct','wrong');const ok=!!picked&&Number(picked.value)===q.correctIndex;const concept=q.term||((d.terms||[]).find(t=>(q.context||q.question||'').toLowerCase().includes(String(t).toLowerCase())));if(concept){adaptConcept(concept,ok);concepts.push(concept);}if(ok){score++;item.classList.add('correct')}else item.classList.add('wrong');});
  d.quizScore=score;d.quizHistory=d.quizHistory||[];const percent=d.quiz.length?Math.round(score/d.quiz.length*100):0;recordStudyResult(concepts,percent/100);await saveMeta();d.quizHistory.push({at:now(),score,total:d.quiz.length,percent,concepts:[...new Set(concepts)]});await saveDoc(d);
  $("#quizResult").classList.remove('hidden');$("#quizResult").innerHTML=`<div class="score">${percent}%</div><p>You scored <strong>${score}/${d.quiz.length}</strong>.</p><p class="muted">Weak concepts are now prioritized in future flashcard sessions.</p>`;renderQuizHistory(d);renderAI();toast(`Quiz completed: ${score}/${d.quiz.length}.`,'success');
}
async function newQuiz(){const d=activeDoc();if(!d)return toast('Select a document first.','error');d.quiz=makeQuiz(d);d.quizScore=null;await saveDoc(d);renderQuiz();renderStats();toast('New quiz generated.','success');}
function nextSmartIndex(d,current,delta){
  if(!d.flashcards.length)return 0;
  if(delta<0)return (current-1+d.flashcards.length)%d.flashcards.length;
  const nowMs=Date.now(),known=new Set(d.knownCardIds||[]),stats=d.cardStats||{};
  const candidates=d.flashcards.map((c,i)=>{const st=stats[c.id]||{attempts:0,correct:0,streak:0,ease:2.5,dueAt:0};const due=st.dueAt&&st.dueAt<=nowMs;const weak=st.attempts?1-st.correct/st.attempts:.45;const cp=learnerProfile().concepts?.[normalize(c.term||"").toLowerCase()];const conceptWeak=cp?1-(cp.mastery||.35):.35;return {i,score:(due&&!known.has(c.id)?100:0)+weak*20+conceptWeak*28+(known.has(c.id)?-8:8)-Math.abs(i-current)*.01};}).filter(x=>x.i!==current).sort((a,b)=>b.score-a.score);
  return candidates[0]?.i??((current+1)%d.flashcards.length);
}
async function moveFlash(delta){const d=activeDoc();if(!d?.flashcards.length)return;d.currentCard=nextSmartIndex(d,d.currentCard,delta);await saveDoc(d);renderFlash();renderDashboard();}
function speakText(text){
  const t=normalize(String(text||""));
  if(!t)return toast("Nothing to read aloud.","error");
  if(!window.speechSynthesis)return toast("This browser does not support speech synthesis.","error");
  try{window.speechSynthesis.cancel();}catch{}
  const u=new SpeechSynthesisUtterance(t.slice(0,1200));
  u.rate=1;u.pitch=1;u.lang=navigator.language||"en-US";
  window.speechSynthesis.speak(u);
  toast("Reading aloud…","success");
}
function sm2Schedule(prev,quality){
  const p={attempts:0,correct:0,streak:0,ease:2.5,interval:0,repetitions:0,dueAt:0,lastSeen:0,...prev};
  const next={...p,attempts:p.attempts+1,lastSeen:Date.now()};
  if(quality<3){
    next.streak=0;next.repetitions=0;
    next.ease=Math.max(1.3,+(p.ease-0.20).toFixed(2));
    next.interval=0;next.dueAt=Date.now()+1000*60*5;
    return next;
  }
  next.correct=p.correct+1;next.streak=p.streak+1;
  next.ease=Math.min(3.0,Math.max(1.3,+(p.ease+0.1-(5-quality)*(0.08+(5-quality)*0.02)).toFixed(2)));
  if(p.repetitions<=0){next.interval=1;next.repetitions=1;}
  else if(p.repetitions===1){next.interval=3;next.repetitions=2;}
  else{next.interval=Math.max(5,Math.round((p.interval||3)*next.ease));next.repetitions=p.repetitions+1;}
  next.dueAt=Date.now()+Math.min(1000*60*60*24*365,next.interval*24*60*60*1000);
  return next;
}
async function markKnown(known){
  const d=activeDoc();if(!d?.flashcards.length)return;const card=d.flashcards[d.currentCard],id=card.id;
  d.cardStats=d.cardStats||{};
  const prev=d.cardStats[id]||{attempts:0,correct:0,streak:0,ease:2.5,interval:0,repetitions:0,dueAt:0,lastSeen:0};
  const next=sm2Schedule(prev,known?3:1);
  if(known){if(!d.knownCardIds.includes(id))d.knownCardIds.push(id);}
  else d.knownCardIds=d.knownCardIds.filter(x=>x!==id);
  d.cardStats[id]=next;adaptConcept(card.term||card.question,known);await saveDoc(d);await saveMeta();renderFlash();renderDashboard();renderAI();toast(known?"Marked known — spaced review scheduled.":"Miss after streak reset — back in 5 minutes.",known?"success":"");
}

function looksLikeFormula(text){
  const t=String(text||"");
  if(/→|->|⇒|⟶/.test(t)) return true;
  if(/\bequation\b|\bformula\b|\breaction\b|\bohm/i.test(t)&&/[A-Za-z0-9)]\s*[+=→]/.test(t)) return true;
  if(/\d\s*[A-Z][a-z]?\d*(?:\s*[+＋]\s*\d*\s*[A-Z][a-z]?\d*)+\s*(?:→|->|=)/.test(t)) return true;
  // Electrical: V=IR, P=VI, units
  if(/\bV\s*=\s*I\s*R\b|\bI\s*=\s*V\s*\/\s*R\b|\bP\s*=\s*V\s*I\b|\bP\s*=\s*I\s*²?\s*R\b/i.test(t)) return true;
  if(/[Ωμ]|kΩ|MΩ|mA|μA|μF|nF|pF|kHz|MHz/.test(t)&&/\d|=/.test(t)) return true;
  if(/\b[A-Za-z]\s*=\s*[^.]{2,40}/.test(t)&&/\d|%|Δ|√|∛|mol|Hz|V\b|W\b|A\b|Ω|kg|m\/s/.test(t)) return true;
  if(/\b\d+[A-Z][a-z]?\d*\b/.test(t)&&/\+|→|->|=/.test(t)) return true;
  return false;
}

function extractFormulaSnippet(text){
  const t=normalize(text);
  // Prefer the clause that actually holds the equation symbols
  const parts=t.split(/(?<=[.!?])\s+/);
  const hit=parts.find(p=>looksLikeFormula(p))||parts.find(p=>/→|->|=/.test(p));
  if(hit) return softenBullet(hit,220);
  // Fallback: pull a dense symbol-rich span
  const m=t.match(/[^.]{0,40}(?:→|->|⇒|=)[^.]{0,80}/);
  if(m) return softenBullet(m[0],220);
  return softenBullet(t,200);
}

function localTutorAnswer(doc, question){
  const qRaw=normalize(question);
  const q=qRaw.toLowerCase();
  const source=normalize(doc?.rawText||"");
  const domainHit=domainKnowledgeAnswer(qRaw);

  // No document loaded: still teach from built-in curriculum
  if(!source){
    if(domainHit){
      return `I’ll teach this clearly from solid ${domainHit.domain} foundations:\n\n${domainHit.answer}\n\nWhen you load your class file, I’ll also match answers to *your* exact wording.`;
    }
    return "Add a PDF or photo — or ask about English, essays, math, science, electronics, or logic gates (example: “What does a fuse do?”).";
  }

  const defs=doc?.reviewerData?.definitions||[];
  // Direct component lookup — ChatGPT-style short teaching answer
  if(defs.length){
    let best=null,bestScore=0;
    for(const d of defs){
      const name=String(d.term||"").toLowerCase();
      if(!name||name.length<2)continue;
      let score=0;
      if(q.includes(name))score+=name.length+10;
      for(const w of name.split(/[^a-z0-9]+/).filter(x=>x.length>2))if(q.includes(w))score+=3;
      if(score>bestScore){bestScore=score;best=d;}
    }
    if(best&&bestScore>=5){
      const ans=cleanAnswer(best.definition,280);
      let out=`**${best.term}**\n\n${ans}`;
      if(domainHit&&domainHit.score>=6)out+=`\n\nExtra foundation:\n${domainHit.answer}`;
      out+=`\n\nStudy tip: cover the page, say the function out loud, then check the symbol on the sheet.`;
      return out;
    }
  }

  const sentences=extractSentences(source,120);
  const terms=(doc?.terms||[]).map(t=>typeof t==='string'?t:t?.term||t?.label||"").filter(Boolean);
  const qWords=new Set(q.split(/[^a-z0-9Ωμ]+/).filter(w=>w.length>=2 && !STOP.has(w)));
  const wantsDef=/what is|define|meaning|definition|who is|what are|function of|what does/.test(q);
  const wantsEq=/equation|formula|chemical|overall reaction|balanced|stoichiometr|ohm|v\s*=\s*ir|kirchhoff/.test(q)
    || /\b(co2|h2o|o2|c6h12o6|nacl|hcl|v=ir)\b/.test(q);
  const wantsHow=/how does|how do|process|steps|stage|happen|sequence|write an essay|structure/.test(q);
  const wantsWhy=/why |cause|because|reason/.test(q);
  const wantsQuiz=/quiz me|test me|ask me|practice question/.test(q);

  if(wantsQuiz){
    const pool=(doc.reviewerData?.questions||[]).slice(0,6);
    if(pool.length){
      const pick=pool[Math.floor(Math.random()*pool.length)];
      return `Practice question (${pick.type||"recall"}):\n\n${pick.q}\n\nTry answering from memory, then check the Reviewer or Cards.`;
    }
    if(domainHit)return `Practice from built-in ${domainHit.domain} knowledge:\n\nExplain this in your own words:\n${domainHit.answer.split("\n")[0]}`;
    const term=terms[Math.floor(Math.random()*Math.max(1,terms.length))]||"the main idea";
    return `Practice prompt:\n\nExplain ${term} in your own words, then name one detail from the source that supports it.`;
  }

  // Formula-first from source
  let sourceBlock="";
  if(wantsEq){
    const formulaHits=sentences
      .map((text,i)=>({text,i,formula:looksLikeFormula(text)}))
      .filter(x=>x.formula||/equation|formula|overall|ohm|voltage|current|resistance/i.test(x.text));
    const ranked=formulaHits.map(x=>{
      let score=looksLikeFormula(x.text)?20:4;
      const lower=x.text.toLowerCase();
      for(const w of qWords) if(lower.includes(w)) score+=2;
      if(/overall|balanced|ohm|v\s*=\s*ir/i.test(x.text)) score+=8;
      if(/→|->|⇒|Ω|μF|kΩ/.test(x.text)) score+=6;
      return {...x,score};
    }).sort((a,b)=>b.score-a.score||a.i-b.i);
    if(ranked.length){
      const primary=extractFormulaSnippet(ranked[0].text);
      const support=ranked.slice(1,3).map(x=>`• ${extractFormulaSnippet(x.text)}`);
      const lines=[`From your material:`,`\n${primary}`];
      if(support.length){lines.push("\nRelated lines:");lines.push(...support);}
      sourceBlock=lines.join("\n");
    }
  }

  const scored=sentences.map((text,i)=>{
    const lower=text.toLowerCase();
    const words=lower.split(/[^a-z0-9Ωμ]+/).filter(Boolean);
    let score=0;
    for(const w of words) if(qWords.has(w)) score+=2;
    for(const t of terms){const tl=String(t).toLowerCase();if(tl&&lower.includes(tl)) score+=3;}
    if(wantsDef&&/\bis\b|means|refers to|defined as|known as/i.test(text)) score+=4;
    if(wantsHow&&(/stage|step|process|then|first|next|finally|reaction/i.test(text))) score+=3;
    if(wantsWhy&&(/because|therefore|leads to|results in|cause/i.test(text))) score+=3;
    if(looksLikeFormula(text)) score+=2;
    if(/[ΩμFVWA]|kΩ|mA|μF/.test(text)) score+=1;
    if(text.length>220) score-=1;
    return {text,i,score};
  }).sort((a,b)=>b.score-a.score||a.i-b.i).filter(x=>x.score>0);

  if(!sourceBlock&&scored.length){
    const top=scored.slice(0,4);
    let lead="From your material:";
    if(wantsDef) lead="From your material (definition-style):";
    else if(wantsHow) lead="From your material (process):";
    else if(wantsWhy) lead="From your material (cause–effect):";
    sourceBlock=`${lead}\n\n${top.map(x=>`• ${softenBullet(x.text,200)}`).join("\n")}`;
  }

  // Blend: source first, then curriculum if useful or if source is thin
  if(sourceBlock&&domainHit&&domainHit.score>=5){
    return `${sourceBlock}\n\n——\n📚 Extra ${domainHit.domain} foundation (built-in):\n${domainHit.answer}\n\nTip: use the foundation to understand the page, then match every claim back to your notes.`;
  }
  if(sourceBlock){
    return `${sourceBlock}\n\nTip: say it out loud, then check the page so wording stays faithful to your material.`;
  }
  if(domainHit){
    return `Your PDF did not clearly cover this, so here is built-in ${domainHit.domain} knowledge:\n\n${domainHit.answer}\n\nIf this should match a diagram in your file, try Re-run OCR or add a caption on that photo.`;
  }
  return "I could not find enough evidence in the loaded material, and this question is outside the built-in basics pack.\n\nTry a term from the lesson, or ask about English, essays, math, science, or electronics fundamentals.";
}
function localTutorReview(doc){
  const r=doc?.reviewerData;
  if(!r) return "Upload study material first.";
  return [
    r.overview||"",
    r.keyPoints?.length?`Key points:\n${r.keyPoints.map(x=>`• ${x}`).join("\n")}`:"",
    r.terms?.length?`Key terms:\n${r.terms.map(x=>`• ${typeof x==='string'?x:(x.term||x.label||"")}`).join("\n")}`:"",
    r.examCram?`Exam cram:\n${r.examCram}`:""
  ].filter(Boolean).join("\n\n");
}

async function runLocalAIEnhancement(){
  const d=activeDoc();if(!d)return toast("Select a study material first.","error");
  const status=$("#aiStatus"),btn=$("#aiEnhance");if(btn)btn.disabled=true;if(status)status.textContent="Starting local AI…";
  const reviewBox=$("#aiReviewer");if(reviewBox)reviewBox.textContent="AI is working locally. Tokens will appear here as they are generated…";
  try{
    const result=await aiRequest("reviewer",{source:aiSource(d),profile:learnerDigestForAI(),terms:d.terms||[]});
    const threshold=35;
    if((result.groundingScore||0)<threshold)throw new Error("AI output did not meet the grounding threshold. The deterministic reviewer was kept.");
    d.ai={...(d.ai||{}),enabled:true,generatedAt:now(),reviewer:result.text,groundingScore:result.groundingScore,device:result.device,model:result.model||state.settings.ai.model};
    d.reviewerData=d.reviewerData||buildReviewer(d);d.reviewerData.aiReviewer=result.text;await saveDoc(d);state.settings.ai.enabled=true;await saveMeta();renderAll();if(status)status.textContent=`Local AI ready • grounded ${result.groundingScore}% • ${result.device}`;toast("Local AI reviewer completed.","success");
  }catch(e){if(e.message==="AI task cancelled."){if(status)status.textContent="AI stopped.";return;}const fallback=localTutorReview(d);d.ai={...(d.ai||{}),enabled:false,generatedAt:now(),reviewer:fallback,groundingScore:100,device:"local smart tutor",model:"deterministic-source-engine"};await saveDoc(d);renderAll();if(status)status.textContent="Smart Tutor ready • source-grounded local fallback";toast("The neural model was unavailable, so StudyVault used its instant local tutor instead.","success");}
  finally{if(btn)btn.disabled=false;}
}
async function enableLocalAI(){
  const status=$("#aiStatus");if(status)status.textContent="Loading the on-device model. The page will stay responsive while it downloads…";
  try{const worker=aiEnsureWorker();state.settings.ai.enabled=true;await saveMeta();worker.postMessage({type:"load"});toast("Local AI load started. Keep the app open until the model finishes downloading.","success");}catch(e){state.settings.ai.enabled=false;await saveMeta();toast(e.message||"Local AI could not start.","error");}
}
async function disableLocalAI(){aiCancel();state.settings.ai.enabled=false;await saveMeta();renderAll();toast("Local AI disabled. Your deterministic reviewer remains available.");}
function tutorSuggestionsFor(doc){
  if(!doc)return ["Add a PDF or photo first."];
  const terms=(doc.terms||[]).slice(0,4);
  const out=[];
  if(terms[0])out.push(`What is ${terms[0]}?`);
  if(terms[1])out.push(`How does ${terms[1]} work?`);
  out.push("What is the main equation or formula?");
  out.push("Quiz me on the key ideas");
  out.push("Explain the main process in simple steps");
  return out.slice(0,5);
}

/** When user asks to see a picture, fetch a safe educational image (Wikipedia). Needs internet once. */
async function fetchTopicImage(query){
  const topic=normalize(query)
    .replace(/^(?:show|send|give|find|display|draw|picture|photo|image|pic|of|a|an|the|me|please|can|you)\s+/gi,"")
    .replace(/\b(?:show|send|give|find|display|picture|photo|image|pic|of|a|an|the|me|please)\b/gi," ")
    .replace(/\s+/g," ")
    .trim()
    .slice(0,80);
  if(!topic||topic.length<2)return null;
  if(!navigator.onLine)return {error:"offline",topic};
  try{
    const title=encodeURIComponent(topic.replace(/\s+/g,"_"));
    // Try exact summary, then search
    let data=null;
    try{
      const r=await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`,{headers:{Accept:"application/json"}});
      if(r.ok)data=await r.json();
    }catch{}
    if(!data?.thumbnail?.source){
      const s=await fetch(`https://en.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(topic)}&limit=1`,{headers:{Accept:"application/json"}});
      if(s.ok){
        const sj=await s.json();
        const hit=sj?.pages?.[0]?.key||sj?.pages?.[0]?.title;
        if(hit){
          const r2=await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit)}`,{headers:{Accept:"application/json"}});
          if(r2.ok)data=await r2.json();
        }
      }
    }
    if(!data)return {error:"not-found",topic};
    return {
      topic:data.title||topic,
      imageUrl:data.thumbnail?.source||data.originalimage?.source||"",
      extract:cleanAnswer(data.extract||data.description||"",220),
      pageUrl:data.content_urls?.desktop?.page||""
    };
  }catch(err){
    console.warn("image fetch failed",err);
    return {error:"failed",topic};
  }
}
function isPictureRequest(q){
  return /\b(show|send|give|display|find|picture|photo|image|pic|draw)\b/i.test(q)
    && /\b(picture|photo|image|pic|of|show me)\b/i.test(q);
}

function formatWiseAnswer(body,opts={}){
  // Calm, teacher-like framing without sounding fake-mystical
  const tip=opts.tip||"";
  let out=String(body||"").trim();
  if(!out)return "I need a clearer question or more study text to answer well.";
  if(tip)out+=`\n\n💡 ${tip}`;
  return out;
}

function renderTutorChat(){
  const box=$("#tutorChat");if(!box)return;
  if(!tutorChat.length){
    box.innerHTML=`<div class="tutor-welcome"><strong>Your wise study tutor is ready.</strong><p>Ask about your PDF, school subjects, or “show me a picture of …” (needs internet for pictures). Try “What does a fuse do?”, “Ohm’s law”, or “show me a picture of a lion”.</p></div>`;
    return;
  }
  box.innerHTML=tutorChat.map(m=>{
    const who=m.role==="user"?"You":"Tutor";
    const mode=m.mode?`<span class="tutor-mode-tag">${esc(m.mode)}</span>`:"";
    let body=`<div class="tutor-msg-body">${esc(m.text).replace(/\n/g,"<br>")}</div>`;
    if(m.imageUrl){
      body+=`<div class="tutor-img-wrap"><img class="tutor-img" src="${esc(m.imageUrl)}" alt="${esc(m.imageAlt||"Illustration")}" loading="lazy" referrerpolicy="no-referrer"><div class="tutor-img-cap tiny">${esc(m.imageAlt||"")}</div></div>`;
    }
    return `<div class="tutor-msg ${m.role==="user"?"is-user":"is-tutor"}"><div class="tutor-msg-meta"><span>${who}</span>${mode}</div>${body}</div>`;
  }).join("");
  box.scrollTop=box.scrollHeight;
}

function renderTutor(){
  const d=activeDoc();
  const meta=$("#tutorMeta");
  if(meta)meta.textContent=d?`Chatting about: ${d.fileName}`:"A separate chat for your study material — always answers from the source.";
  const status=$("#tutorStatus");
  const device=$("#tutorDevice");
  const modeLabel=$("#tutorModeLabel");
  const neural=!!(state.settings.ai?.enabled&&aiWorker);
  if(status)status.textContent=neural?"Neural AI available":"Instant Tutor ready";
  if(device)device.textContent=neural?"On-device model can deepen answers when online/cached":"Source-grounded • no model required";
  if(modeLabel)modeLabel.textContent=neural?"Neural + Instant":"Instant";
  if($("#tutorMsgCount"))$("#tutorMsgCount").textContent=String(tutorChat.length);
  const weak=$("#tutorWeak");
  if(weak){const ws=weakConcepts();weak.innerHTML=ws.length?ws.map(x=>`<span class="term">${esc(x)}</span>`).join(""):"<span class='tiny'>Appear after quizzes and cards.</span>";}
  const sug=$("#tutorSuggestions");
  if(sug){
    const items=tutorSuggestionsFor(d);
    sug.innerHTML=items.map(t=>`<button type="button" class="tutor-chip" data-tutor-q="${esc(t)}">${esc(t)}</button>`).join("");
    sug.querySelectorAll("[data-tutor-q]").forEach(b=>b.onclick=()=>{const input=$("#tutorInput");if(input){input.value=b.dataset.tutorQ;input.focus();}tutorSendMessage();});
  }
  renderTutorChat();
}

async function tutorSendMessage(){
  const d=activeDoc();
  const input=$("#tutorInput");
  const q=(input?.value||"").trim();
  if(!q)return toast("Type a question first.","error");
  if(tutorBusy)return toast("Tutor is still answering…","error");
  tutorBusy=true;
  tutorChat.push({role:"user",text:q,at:now()});
  if(input)input.value="";
  renderTutorChat();
  if($("#tutorMsgCount"))$("#tutorMsgCount").textContent=String(tutorChat.length);
  const status=$("#tutorStatus");
  if(status)status.textContent="Thinking…";

  let answer="", mode="Wise Tutor", imageUrl="", imageAlt="";
  try{
    // Picture requests: show an educational image + short description
    if(isPictureRequest(q)){
      if(status)status.textContent="Finding a picture…";
      const img=await fetchTopicImage(q);
      if(img?.imageUrl){
        imageUrl=img.imageUrl;
        imageAlt=img.topic||"Illustration";
        answer=formatWiseAnswer(
          `Here is a clear picture of **${img.topic}**.\n\n${img.extract||"A reference image for your study or curiosity."}`,
          {tip:"Images come from educational sources when you are online."}
        );
        mode="Picture";
      }else if(img?.error==="offline"){
        answer="I can show pictures when this device is online. Connect once, ask again, and I’ll fetch a clear reference image.";
        mode="Offline";
      }else{
        answer=formatWiseAnswer(
          `I couldn’t find a safe public picture for “${img?.topic||q}”. Try a simpler name (e.g. “lion”, “volcano”, “resistor”).`,
          {tip:"You can also add your own photos with Add Photos."}
        );
        mode="Picture";
      }
    }else{
      // Instant wise answer from file + curriculum
      answer=formatWiseAnswer(localTutorAnswer(d,q));
      mode="Wise Tutor";
      tutorChat.push({role:"tutor",text:answer,mode,at:now(),imageUrl,imageAlt});
      renderTutorChat();
      // Optional neural deepen
      if(d&&state.settings.ai?.enabled&&aiWorker){
        if(status)status.textContent="Deepening with on-device AI…";
        try{
          const r=await aiRequest("ask",{source:aiQuestionSource(d,q),profile:learnerDigestForAI(),question:q});
          if(r?.text&&(r.groundingScore==null||r.groundingScore>=28)){
            answer=formatWiseAnswer(r.text,{tip:"Cross-check important facts with your uploaded notes."});
            mode="Neural AI";
            for(let i=tutorChat.length-1;i>=0;i--){
              if(tutorChat[i].role==="tutor"){tutorChat[i]={role:"tutor",text:answer,mode,at:now()};break;}
            }
            renderTutorChat();
          }
        }catch(e){console.warn("Neural tutor optional path failed",e);}
      }
      if(status)status.textContent=mode==="Neural AI"?"Answered with on-device AI":"Answered";
      return;
    }
    tutorChat.push({role:"tutor",text:answer,mode,at:now(),imageUrl,imageAlt});
    renderTutorChat();
    if(status)status.textContent=mode==="Picture"?"Picture ready":"Answered";
  }catch(e){
    tutorChat.push({role:"tutor",text:e.message||"Could not answer right now. Try again in a moment.",mode:"Error",at:now()});
    if(status)status.textContent="Could not answer";
  }finally{
    tutorBusy=false;
    renderTutor();
  }
}

function renderAI(){
  const d=activeDoc(),ai=d?.ai||{},p=learnerProfile();
  const status=$("#aiStatus");
  if(status&&!ai.generatedAt)status.textContent=state.settings.ai?.enabled?"Local AI enabled — use Deep AI Review here, or chat in the Tutor tab.":"Optional on-device AI for a deeper reviewer rewrite. Everyday questions live in Tutor.";
  if($("#aiReviewer"))$("#aiReviewer").textContent=ai.reviewer||"No AI rewrite yet. The deterministic source-grounded reviewer below stays available.";
  const weak=$("#weakConcepts");if(weak){const ws=weakConcepts();weak.innerHTML=ws.length?ws.map(x=>`<span class="term">${esc(x)}</span>`).join(""):"<span class='tiny'>Weak areas appear after you study and answer questions.</span>";}
  const entries=Object.values(p.concepts||{}),avg=entries.length?entries.reduce((s,x)=>s+(Number(x.mastery)||0),0)/entries.length:0;if($("#aiMasteryBar"))$("#aiMasteryBar").style.width=`${Math.round(avg*100)}%`;if($("#aiMasteryText"))$("#aiMasteryText").textContent=entries.length?`Overall mastery ${Math.round(avg*100)}% • ${p.sessions||0} sessions • streak ${p.streak||0}`:"No mastery data yet.";
  const settingsInfo=$("#settingsAiInfo");if(settingsInfo)settingsInfo.textContent=state.settings.ai?.enabled?"AI enabled. Chat lives in Tutor; Deep AI Review can still rewrite the reviewer.":"AI is optional; Instant Tutor and deterministic review work without it.";
  renderTutor();
}

function updateConnectivity(){
  const el=$("#networkStatus");
  if(!el)return;
  const online=navigator.onLine;
  el.textContent=online?"ONLINE • AI optional":"OFFLINE • study mode available";
  el.classList.toggle("offline",!online);
  const aiButtons=[$("#aiEnable"),$("#settingsAiEnable"),$("#tutorLoadAI")].filter(Boolean);
  if(!online){for(const b of aiButtons)b.title="The app still works offline. Local AI needs the model to have been downloaded and cached first.";}
}

async function checkForUpdates(){
  const status=$("#updateStatus");
  if(status)status.textContent="Checking version.json…";
  try{
    const res=await fetch(VERSION_URL,{cache:"no-store"});
    if(!res.ok)throw new Error("version.json not reachable ("+res.status+")");
    const remote=await res.json();
    const remoteVer=Number(remote.version||0);
    const remoteBuild=String(remote.buildId||"");
    if(status)$("#buildVersionLabel")&&($("#buildVersionLabel").textContent=String(APP_VERSION));
    if(remoteVer>APP_VERSION){
      const msg=`Newer shell available: v${remoteVer}${remoteBuild?" ("+remoteBuild+")":""}. Replace the app files from your backup/update package, then hard-refresh. Your IndexedDB study data is kept.`;
      if(status)status.textContent=msg;
      toast("A newer StudyVault shell was found.","success");
      return {update:true,remote};
    }
    if(remoteBuild&&remoteBuild!==BUILD_ID&&remoteVer===APP_VERSION){
      const msg=`Same version number (v${APP_VERSION}) but a different build id is listed: ${remoteBuild}. You are on ${BUILD_ID}.`;
      if(status)status.textContent=msg;
      toast("Build id differs — refresh if you just replaced files.","success");
      return {update:false,remote};
    }
    const msg=`You are current: v${APP_VERSION} · ${BUILD_ID}. Released notes: ${(remote.notes||[]).slice(0,2).join(" · ")||"foundation build"}`;
    if(status)status.textContent=msg;
    toast("StudyVault shell is up to date.","success");
    return {update:false,remote};
  }catch(e){
    const msg=`Could not check updates (${e.message||"offline"}). The app still works with local files.`;
    if(status)status.textContent=msg;
    toast("Update check unavailable offline — local shell is fine.","error");
    return {update:false,error:e};
  }
}
function applyTheme(){document.body.classList.toggle('light',state.settings.theme==='light');updateConnectivity();}
async function setTheme(theme){state.settings.theme=theme==='light'?'light':'dark';await saveMeta();applyTheme();toast(`${state.settings.theme==='light'?'Light':'Dark'} mode enabled.`,'success');}

function exportBackup(){
  const payload={app:'StudyVault',version:APP_VERSION,exportedAt:now(),settings:{theme:state.settings.theme,ai:{enabled:!!state.settings.ai?.enabled,model:state.settings.ai?.model||"onnx-community/Qwen3-0.6B-ONNX"},learner:learnerProfile()},documents:state.documents};
  downloadText(`studyvault-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(payload,null,2));toast('Backup exported.','success');
}
async function importBackup(){
  const file=$("#backupInput").files[0];if(!file)return toast('Choose a JSON backup first.','error');
  try{
    const data=JSON.parse(await file.text());if(data.app!=='StudyVault')throw new Error('Invalid StudyVault backup.');
    const incoming=Array.isArray(data.documents)?data.documents:(data.data?.fileName?[data.data]:null);if(!incoming)throw new Error('No StudyVault documents found in this backup.');
    for(const raw of incoming){const d=normalizeDoc(raw);await dbPut(DOC_STORE,d);}
    state.documents=(await dbGetAll(DOC_STORE)).map(normalizeDoc);state.activeDocId=state.documents[0]?.id||null;state.settings.theme=data.settings?.theme==='light'?'light':'dark';state.settings.learner={...defaultLearner(),...(data.settings?.learner||{})};state.settings.ai={...state.settings.ai,model:"onnx-community/Qwen3-0.6B-ONNX",...(data.settings?.ai||{enabled:false})};await saveMeta();$("#importModal").classList.remove('open');$("#backupInput").value='';renderAll();toast('Backup imported.','success');
  }catch(e){console.error(e);toast(e.message||'Import failed.','error');}
}
async function resetAll(){if(!confirm('Delete ALL StudyVault data from this browser? This removes every document, note, quiz history, and PIN.'))return;await dbClear();location.reload();}

function baseDoc(file,sourceType,extracted,media=[]){
  const doc={id:uid(),fileName:file.name,sourceType,pageCount:extracted.pageCount||0,pageTexts:extracted.pageTexts||[],units:extracted.units||[],rawText:extracted.rawText||"",terms:[],reviewerData:null,reviewerText:"",summaryMode:"standard",flashcards:[],currentCard:0,knownCardIds:[],cardStats:{},notesTitle:"Study Notes",notesHtml:"<p></p>",notes:"",notesUpdatedAt:"",quiz:[],quizScore:null,quizHistory:[],ai:{enabled:false,generatedAt:"",reviewer:"",cards:[],quiz:[],groundingScore:0},media,createdAt:now(),updatedAt:now()};
  regenerateDoc(doc,true);return doc;
}
async function processPdfFiles(files){
  for(const file of [...files]){
    if(file.type!=='application/pdf'&&!/\.pdf$/i.test(file.name||"")){toast(`${file.name}: not a PDF.`,'error');continue;}
    $("#upload").innerHTML=`<div class="loading"><span class="spinner"></span><span id="processStatus">Reading ${esc(file.name)}…</span></div>`;
    try{
      const extracted=await extractPdf(file,(page,total)=>{
        const el=$("#processStatus");if(!el)return;
        el.textContent=String(page).startsWith("ocr:")
          ?`Reading pictures on ${file.name} — page ${String(page).slice(4)} of ${total}…`
          :page==="ocr-skip"
            ?`OCR skipped (engine not ready) for ${file.name}`
            :`Reading ${file.name} — page ${page} of ${total}…`;
      });
      const pdfMedia=Array.isArray(extracted.media)?extracted.media:[];
      const words=wordCount(extracted.rawText);
      // Allow picture-only PDFs: media alone is enough to create a study doc
      if(words<5&&!pdfMedia.length){
        throw new Error("This PDF has almost no readable text and no pictures could be captured. Try Add Photos on the scanned pages.");
      }
      const doc=baseDoc(file,"pdf",extracted,pdfMedia);
      if(words<8&&pdfMedia.length){
        // Seed a tiny bit of structure so reviewer is not empty
        doc.rawText=doc.rawText||pdfMedia.map((m,i)=>`Visual page ${m.page||i+1}: ${m.caption||m.name}`).join("\n");
      }
      state.documents.unshift(doc);state.activeDocId=doc.id;
      await dbPut(DOC_STORE,doc);await saveMeta();renderAll();
      const ocrNote=extracted.ocrPages?` · OCR on ${extracted.ocrPages} page${extracted.ocrPages===1?"":"s"}`:"";
      const picNote=pdfMedia.length?` · ${pdfMedia.length} picture${pdfMedia.length===1?"":"s"}`:"";
      toast(`${file.name} added${ocrNote}${picNote} · ${(doc.flashcards||[]).length} cards. Open Reviewer or Flashcards.`,"success");
    }catch(e){
      console.error(e);
      toast(`${file.name}: ${e.message||"Could not process PDF."}`,"error");
    }
  }
}
async function processImageFiles(files){for(const file of [...files]){if(!/^image\/(png|jpeg|webp|bmp)$/.test(file.type)){toast(`${file.name}: unsupported image type.`,'error');continue;}$("#upload").innerHTML=`<div class="loading"><span class="spinner"></span><span id="processStatus">Preparing ${esc(file.name)}…</span></div>`;try{const visual=await dataUrlFromFile(file);let ocr={text:'',confidence:0};try{ocr=await ocrImage(file,m=>{$("#processStatus").textContent=`OCR ${file.name} — ${m.progress?Math.round(m.progress*100):0}%…`;});ocr.text=repairSymbols(ocr.text||'');}catch(err){console.warn('OCR unavailable',err);toast(`${file.name}: photo saved, but OCR was unavailable. Add a caption on the Reviewer page.`,'error');}const mediaId=uid();const extracted={pageCount:1,pageTexts:[{page:1,text:ocr.text,source:'photo',photoId:mediaId}],units:extractSentences(ocr.text,18).map(text=>({page:1,text,source:'photo',photoId:mediaId})),rawText:ocr.text};const media=[{id:mediaId,name:file.name,dataUrl:visual.dataUrl,width:visual.width,height:visual.height,caption:'',ocrText:ocr.text,confidence:ocr.confidence,createdAt:now()}];const doc=baseDoc(file,'image',extracted,media);state.documents.unshift(doc);state.activeDocId=doc.id;await dbPut(DOC_STORE,doc);await saveMeta();renderAll();toast(`${file.name} added as a photo study sheet.`,'success');}catch(e){console.error(e);toast(`${file.name}: ${e.message||'Could not process photo.'}`,'error');}}}
async function processFiles(files){const list=[...files].filter(Boolean);if(!list.length)return;const pdfs=list.filter(f=>f.type==='application/pdf'),images=list.filter(f=>f.type.startsWith('image/'));if(pdfs.length)await processPdfFiles(pdfs);if(images.length)await processImageFiles(images);$("#upload").innerHTML='<div><div class="upload-icon">📚</div><h3>Drop PDFs or study photos here</h3><p>Add PDFs, screenshots, and class photos. OCR can turn image text into reviewer material; visual cards keep the photo itself available for study.</p><div class="hero-actions" style="justify-content:center"><label for="pdfInput" class="btn primary">Choose PDFs</label><label for="imageInput" class="btn secondary">Choose Photos</label></div></div>';}

async function buildBackupPayload(){
  return {app:"StudyVault",version:APP_VERSION,exportedAt:now(),settings:{theme:state.settings.theme,ai:{enabled:false,model:state.settings.ai?.model||"onnx-community/Qwen3-0.6B-ONNX"},learner:learnerProfile()},documents:state.documents};
}
async function syncPush(){
  const url=String(state.settings.sync?.url||"").trim().replace(/\/$/,"");
  const token=String(state.settings.sync?.token||"");
  if(!url||!token)return toast("Enter a Sync URL and token first.","error");
  const payload=await buildBackupPayload();
  try{const r=await fetch(url+"/api/sync/push",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:JSON.stringify({updatedAt:Date.now(),payload})});if(!r.ok)throw new Error("Sync server returned "+r.status);state.settings.sync.enabled=true;await saveMeta();toast("Cloud/self-hosted backup synced.","success");}catch(e){toast("Sync failed: "+(e.message||"server unavailable"),"error");}}
async function syncPull(){
  const url=String(state.settings.sync?.url||"").trim().replace(/\/$/,"");
  const token=String(state.settings.sync?.token||"");
  if(!url||!token)return toast("Enter a Sync URL and token first.","error");
  try{const r=await fetch(url+"/api/sync/pull",{headers:{"Authorization":"Bearer "+token}});if(!r.ok)throw new Error("Sync server returned "+r.status);const data=await r.json();if(!data.payload)return toast("The sync server has no backup yet.");if(!confirm("Replace this browser's StudyVault data with the synced backup?"))return;const p=data.payload;await dbClear();state.settings={...state.settings,...(p.settings||{}),sync:{...state.settings.sync,url,token,enabled:true}};state.documents=Array.isArray(p.documents)?p.documents.map(normalizeDoc):[];for(const d of state.documents)await dbPut(DOC_STORE,d);state.activeDocId=state.documents[0]?.id||null;await saveMeta();renderAll();toast("Synced study library restored.","success");}catch(e){toast("Sync failed: "+(e.message||"server unavailable"),"error");}}
function setupSync(){
  const url=$("#syncUrl"),token=$("#syncToken");if(!url||!token)return;
  url.value=state.settings.sync?.url||"";token.value=state.settings.sync?.token||"";
  $("#saveSync").onclick=async()=>{state.settings.sync={...(state.settings.sync||{}),url:url.value.trim().replace(/\/$/,""),token:token.value.trim(),enabled:!!url.value.trim()&&!!token.value.trim()};await saveMeta();toast("Sync settings saved.","success");};
  $("#syncPush").onclick=syncPush;$("#syncPull").onclick=syncPull;
}
function setupDrop(){
  const u=$("#upload");
  ['dragenter','dragover'].forEach(ev=>u.addEventListener(ev,e=>{e.preventDefault();u.classList.add('drag')}));
  ['dragleave','drop'].forEach(ev=>u.addEventListener(ev,e=>{e.preventDefault();u.classList.remove('drag')}));
  u.addEventListener('drop',e=>processFiles(e.dataTransfer.files));
}
function setupInstall(){
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;$("#installBtn").disabled=false;});
  $("#installBtn").onclick=async()=>{if(!deferredInstall)return toast('Use your browser menu to install the app after it becomes installable.');await deferredInstall.prompt();deferredInstall=null;};
}
function bind(){
  $("#pdfInput").addEventListener('change',e=>{processFiles(e.target.files);e.target.value='';});
  $("#imageInput").addEventListener('change',e=>{processImageFiles(e.target.files);e.target.value='';});
  $("#noteImageInput").addEventListener('change',e=>{insertImageFilesIntoNotes(e.target.files);e.target.value='';});
  $$('[data-section]').forEach(b=>b.addEventListener('click',()=>activateSection(b.dataset.section)));
  $$('[data-summary-mode]').forEach(b=>b.addEventListener('click',()=>setSummaryMode(b.dataset.summaryMode)));
  $("#openReviewer").onclick=()=>activateSection('reviewer');
  $("#aiEnable").onclick=enableLocalAI;$("#aiEnhance").onclick=runLocalAIEnhancement;$("#aiCancel").onclick=aiCancel;$("#settingsAiEnable").onclick=enableLocalAI;$("#settingsAiDisable").onclick=disableLocalAI;
  // Dedicated Tutor workspace (separate from Reviewer)
  if($("#tutorSend"))$("#tutorSend").onclick=()=>tutorSendMessage();
  if($("#tutorLoadAI"))$("#tutorLoadAI").onclick=enableLocalAI;
  if($("#tutorClear"))$("#tutorClear").onclick=()=>{tutorChat=[];renderTutor();toast("Tutor chat cleared.","success");};
  if($("#tutorStop"))$("#tutorStop").onclick=()=>{aiCancel();tutorBusy=false;const s=$("#tutorStatus");if(s)s.textContent="Stopped";toast("Tutor stopped.","success");};
  if($("#tutorInput"))$("#tutorInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();tutorSendMessage();}});
  if($("#checkUpdateBtn"))$("#checkUpdateBtn").onclick=()=>checkForUpdates();
  if($("#buildVersionLabel"))$("#buildVersionLabel").textContent=String(APP_VERSION);
  if($("#updateStatus"))$("#updateStatus").textContent=`Running foundation build v${APP_VERSION} · ${BUILD_ID}`;
  $("#copyReviewer").onclick=copyReviewer;$("#downloadReviewer").onclick=downloadReviewer;$("#regenerateReviewer").onclick=async()=>{const d=activeDoc();if(!d)return toast('Select a document first.','error');regenerateDoc(d,true);await saveDoc(d);renderAll();toast(`Reviewer ready · ${(d.flashcards||[]).length} flashcards · ${(d.quiz||[]).length} quiz items.`,'success');};
  $("#prevFlash").onclick=()=>moveFlash(-1);$("#nextFlash").onclick=()=>moveFlash(1);$("#showFlashAnswer").onclick=()=>activeDoc()&&$("#flashAnswer").classList.remove('hidden');$("#knowFlash").onclick=()=>markKnown(true);$("#reviewFlash").onclick=()=>markKnown(false);
  if($("#speakFlash"))$("#speakFlash").onclick=()=>{const d=activeDoc();if(!d?.flashcards?.length)return;const c=d.flashcards[d.currentCard];const ans=$("#flashAnswer");const text=(ans&&!ans.classList.contains("hidden"))?`${c.question}. ${c.answer}`:c.question;speakText(text);};
  if($("#speakNotes"))$("#speakNotes").onclick=()=>{const d=activeDoc();if(!d)return;speakText(stripHtml(d.notesHtml||d.notes||""));};
  $("#submitQuiz").onclick=submitQuiz;$("#newQuiz").onclick=newQuiz;
  $("#searchInput").addEventListener('input',debounce(e=>searchActive(e.target.value),180));
  $("#notesEditor").addEventListener('input',()=>{const d=activeDoc();if(!d)return;$("#noteWordCount").textContent=`${wordCount(stripHtml($("#notesEditor").innerHTML))} words`;scheduleNoteSave();});
  $("#notesTitle").addEventListener('input',scheduleNoteSave);
  $$('[data-note-cmd]').forEach(b=>b.onclick=()=>selectNoteCommand(b.dataset.noteCmd,b.dataset.noteValue));
  $("#insertChecklist").onclick=()=>insertAtCursor('<p>☐ </p>');
  $("#insertDefinitionNote").onclick=()=>insertAtCursor('<blockquote><strong>Definition:</strong> Write the concept and its meaning here.</blockquote>');
  $("#insertQuestionNote").onclick=()=>insertAtCursor('<blockquote><strong>Exam question:</strong> </blockquote>');
  $("#exportNotesBtn").onclick=exportNotes;
  $("#clearNotesBtn").onclick=async()=>{const d=activeDoc();if(!d)return;if(!confirm('Clear the notes for this document?'))return;d.notesTitle='Study Notes';d.notesHtml='<p></p>';d.notes='';d.notesUpdatedAt=now();await saveDoc(d);renderNotes();toast('Notes cleared.','success');};
  $("#themeBtn").onclick=()=>setTheme(state.settings.theme==='dark'?'light':'dark');$("#darkMode").onclick=()=>setTheme('dark');$("#lightMode").onclick=()=>setTheme('light');
  $("#lockBtn").onclick=lockApp;$("#settingsLock").onclick=lockApp;$("#pinSettings").onclick=openPin;$("#savePin").onclick=setPin;$("#removePin").onclick=removePin;$("#closePin").onclick=closePin;$("#unlockBtn").onclick=unlockApp;$("#unlockPin").addEventListener('keydown',e=>{if(e.key==='Enter')unlockApp();});
  $("#resetBtn").onclick=resetAll;$("#exportBtn").onclick=exportBackup;$("#openImport").onclick=()=>$("#importModal").classList.add('open');$("#closeImport").onclick=()=>$("#importModal").classList.remove('open');$("#importBackup").onclick=importBackup;
  $("#pinModal").addEventListener('click',e=>{if(e.target.id==='pinModal')closePin();});$("#importModal").addEventListener('click',e=>{if(e.target.id==='importModal')$("#importModal").classList.remove('open');});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePin();$("#importModal").classList.remove('open');}if(e.target.matches('input,textarea,select,[contenteditable="true"]'))return;if($("#flashcards").classList.contains('active')){if(e.key==='ArrowRight')moveFlash(1);if(e.key==='ArrowLeft')moveFlash(-1);if(e.key===' ')e.preventDefault(),$("#showFlashAnswer").click();}});
}

async function load(){
  try{
    const meta=await dbGet(META_STORE,SETTINGS_KEY);
    if(meta){state.settings={...state.settings,...meta,ai:{...state.settings.ai,...(meta.ai||{})},sync:{...state.settings.sync,...(meta.sync||{})},learner:{...defaultLearner(),...(meta.learner||{})}};state.activeDocId=meta.activeDocId||null;}
    state.documents=(await dbGetAll(DOC_STORE)).map(normalizeDoc);
    for(const d of state.documents)await dbPut(DOC_STORE,d);
    if(!state.activeDocId)state.activeDocId=state.documents[0]?.id||null;
    await saveMeta();renderAll();setupDrop();setupInstall();setupSync();
    if(state.settings.pinHash)lockApp();
  }catch(e){console.error(e);toast('StudyVault could not initialize IndexedDB.','error');}
}

window.addEventListener("unhandledrejection",e=>{console.error(e.reason||e);toast("A background task failed. Your saved study data was kept.","error");});
window.addEventListener("error",e=>{if(e?.error)console.error(e.error);});

window.addEventListener("online",updateConnectivity);
window.addEventListener("offline",updateConnectivity);
updateConnectivity();
bind();
setEngineStatus("idle — loads when a PDF is added");
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(err=>console.warn('Service worker registration failed:',err)));
load();
})();
