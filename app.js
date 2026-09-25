
(() => {
"use strict";

const APP_VERSION = 11;
const DB_NAME = "studyvault-v5";
const DB_VERSION = 2;
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
const normalize = v => String(v ?? "").replace(/\u00a0/g," ").replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();
const wordCount = v => normalize(v) ? normalize(v).split(/\s+/).length : 0;
const debounce = (fn, ms=350) => { let t; return (...args) => { clearTimeout(t); t=setTimeout(()=>fn(...args),ms); }; };

const STOP = new Set(("a an and are as at be because been before being between but by can could did do does for from had has have he her here hers him his how i if in into is it its itself just may me might more most my no not of on one or our ours out over same she should so some than that the their theirs them themselves then there these they this those through to too under up us was we were what when where which while who whom why will with would you your yours about after again against all also among another any anything around become below both during each either enough even every example few first following further given going having however important later least little many maybe much must never often other otherwise perhaps rather since such very want without within yet" ).split(/\s+/));

let state = {
  settings: { theme:"dark", pinHash:"", pinSalt:"", pinIterations:120000, ai:{enabled:false,model:"onnx-community/Qwen3-0.6B-ONNX"}, learner:{version:1,sessions:0,streak:0,recentAccuracy:null,concepts:{}} },
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
  setOcrStatus("loading…");
  tesseractPromise=new Promise(resolve=>{
    const script=document.createElement("script");script.src=CDN_TESSERACT;script.async=true;
    let done=false;const finish=ok=>{if(done)return;done=true;clearTimeout(timer);if(ok&&window.Tesseract){setOcrStatus("ready");resolve(true)}else{setOcrStatus("unavailable — photo OCR needs internet on first use");resolve(false)}};
    script.onload=()=>finish(true);script.onerror=()=>finish(false);document.head.appendChild(script);const timer=setTimeout(()=>finish(false),15000);
  });
  return tesseractPromise;
}
async function getOcrWorker(progress){
  const ready=await loadTesseract();if(!ready)throw new Error("Photo OCR is unavailable right now. The photo can still be saved and captioned.");
  if(!tesseractWorker){tesseractWorker=await window.Tesseract.createWorker("eng",1,{logger:m=>{if(m?.status)progress?.(m);}});}
  return tesseractWorker;
}
async function ocrImage(file,progress){const worker=await getOcrWorker(progress);const ret=await worker.recognize(file);return {text:normalize(ret?.data?.text||""),confidence:Number(ret?.data?.confidence)||0};}
function dataUrlFromFile(file,maxSide=1500,quality=.78){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));const c=document.createElement("canvas");c.width=w;c.height=h;const ctx=c.getContext("2d");ctx.drawImage(img,0,0,w,h);resolve({dataUrl:c.toDataURL("image/jpeg",quality),width:w,height:h});};img.onerror=()=>reject(new Error("Could not read the image."));img.src=reader.result;};reader.onerror=()=>reject(reader.error||new Error("Could not read the image."));reader.readAsDataURL(file);});}

let dbPromise=null;
let writeQueue=Promise.resolve();
function openDB(){
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onupgradeneeded=()=>{
      const db=r.result;
      if(!db.objectStoreNames.contains(DOC_STORE))db.createObjectStore(DOC_STORE,{keyPath:"id"});
      if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE);
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
  try{await dbPut(DOC_STORE,doc);}catch(err){
    if(err?.name==="QuotaExceededError")throw new Error("Browser storage is full. Remove large photos or export a backup, then try again.");
    throw err;
  }
}
async function saveMeta(){await dbPut(META_STORE,SETTINGS_KEY,{...state.settings,activeDocId:state.activeDocId,version:APP_VERSION,engine:REVIEW_ENGINE_VERSION});}

async function derivePin(pin,salt,iterations=120000){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations,hash:"SHA-256"},key,256);
  return Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join("");
}
function bytesToB64(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}
function b64ToBytes(s){const bin=atob(s);return Uint8Array.from(bin,c=>c.charCodeAt(0));}
async function setPin(){
  const a=$("#pinA").value.trim(),b=$("#pinB").value.trim();
  if(a.length<4)return toast("PIN must contain at least 4 characters.","error");
  if(a!==b)return toast("PINs do not match.","error");
  const salt=crypto.getRandomValues(new Uint8Array(16));
  state.settings.pinSalt=bytesToB64(salt);
  state.settings.pinIterations=120000;
  state.settings.pinHash=await derivePin(a,salt,state.settings.pinIterations);
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
  const ok=await verifyPin(p);
  if(ok){$("#lock").classList.remove("open");$("#unlockPin").value="";toast("Unlocked.","success");}
  else $("#unlockMsg").textContent="Incorrect PIN.";
}

function tokenize(text){
  return normalize(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g," ")
    .split(/\s+/)
    .filter(Boolean);
}

const REVIEW_ENGINE_VERSION = 9;
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
  const out=[];
  for(const rawLine of cleaned.split(/\n+/)){
    const line=normalize(rawLine);if(!line)continue;
    const parts=line.match(/[^.!?]+(?:[.!?]+|$)/g)||[line];
    for(const part of parts){
      let sentence=normalize(part);
      // Drop title-like fragments and tiny continuation clauses that look like sentences.
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

function detectDefinitions(units,terms){
  const defs=[];const patterns=[
    /^(.{2,80}?)\s+(?:is|are|means|refers to|is defined as|are defined as|is known as|is called)\s+(.{12,})$/i,
    /^(.{2,80}?)\s*:\s*(.{12,})$/i,
    /(?:the term|the concept|the process)\s+(.{2,80}?)\s+(?:is|means|refers to)\s+(.{12,})/i
  ];
  for(const u of units){
    const text=normalize(u.text); if(text.length<30)continue;
    let hit=null;
    for(const re of patterns){const m=text.match(re);if(m){hit=m;break;}}
    let term=hit?.[1]?.trim()||terms.find(t=>text.toLowerCase().includes(t.toLowerCase()));
    if(!term)continue;
    term=term.replace(/^(the|a|an)\s+/i,"").trim();
    if(term.length>70)term=terms.find(t=>text.toLowerCase().includes(t.toLowerCase()))||term;
    if(!term||term.length<3)continue;
    if(defs.some(d=>d.term.toLowerCase()===term.toLowerCase()))continue;
    const cue=hit? (hit[2]||text):text;
    const confidence=Math.min(0.98,0.60+(hit?0.22:0)+(text.length<260?0.08:0)+(unitPage(u)?0.04:0));
    defs.push({term,definition:text,page:unitPage(u),confidence});
    if(defs.length>=24)break;
  }
  return defs;
}

function classifyUnit(u,terms){
  const text=u.text||"", low=text.toLowerCase();
  const hits=[];
  if(/\b(is|are|means|refers to|defined as|known as|called)\b/i.test(text))hits.push("definition");
  if(/\b(first|second|third|next|then|finally|step|procedure|process|stage|phase)\b/i.test(text))hits.push("process");
  if(/\b(because|therefore|causes?|results? in|leads? to|due to|as a result|consequently)\b/i.test(text))hits.push("cause-effect");
  if(/\b(whereas|while|unlike|compared with|in contrast|difference between|similar to|both)\b/i.test(text))hits.push("comparison");
  if(/\b(for example|for instance|such as|e\.g\.)\b/i.test(text))hits.push("example");
  if(/\b(important|key|note|remember|warning|caution|must)\b/i.test(text))hits.push("exam-focus");
  if(/\d|%|\b(?:Hz|V|A|W|Ω|ohm|kg|m|cm|mm)\b|[A-Za-z]\s*=\s*[^ ]/i.test(text))hits.push("fact-formula");
  const overlap=terms.slice(0,28).reduce((n,t)=>n+(low.includes(t.toLowerCase())?1:0),0);
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

function synthesizeSummary(units,terms,headings,mode){
  const cfg=SUMMARY_MODES[mode]||SUMMARY_MODES.standard;
  const evidence=selectEvidence(units,terms,headings,cfg.sentenceCount);
  if(!evidence.length)return "Not enough readable source text was found to create an automatic summary.";
  const topic=terms.slice(0,5).join(", ");
  const lines=[];
  if(topic)lines.push(`This material focuses on ${topic}.`);
  const byKind={definition:[],process:[],"cause-effect":[],comparison:[],example:[],"fact-formula":[]};
  for(const e of evidence){const kinds=classifyUnit(e.u,terms).hits;const key=kinds.find(k=>byKind[k])||"general";(byKind[key]??(byKind[key]=[])).push(e.u);}
  const general=evidence.map(e=>e.u);
  const narrative=general.slice(0,cfg.sentenceCount).map(u=>u.text);
  const seen=[];
  for(const n of narrative){
    const clean=normalize(n.replace(/^(note|important|remember)\s*[:.-]?\s*/i,""));
    if(!seen.some(x=>similarity(x,clean)>.62))seen.push(clean);
  }
  if(mode==="cram"){
    for(const u of seen.slice(0,8))lines.push(`• ${u}`);
  }else{
    if(byKind.definition?.length)lines.push(`Core concepts: ${byKind.definition.slice(0,2).map(x=>x.text).join(" ")}`);
    for(const u of seen){
      if(lines.join(" ").length>cfg.maxChars)break;
      lines.push(`• ${u}`);
    }
  }
  let out=normalize(lines.join("\n"));
  if(out.length>cfg.maxChars)out=out.slice(0,cfg.maxChars-1).replace(/\s+\S*$/,'')+"…";
  return out;
}

function detectStructuredPatterns(units,terms,headings){
  const definitions=detectDefinitions(units,terms);
  const processes=units.filter(u=>classifyUnit(u,terms).hits.includes("process")).slice(0,18).map(u=>({text:u.text,page:unitPage(u)}));
  const causes=units.filter(u=>classifyUnit(u,terms).hits.includes("cause-effect")).slice(0,18).map(u=>({text:u.text,page:unitPage(u)}));
  const comparisons=units.filter(u=>classifyUnit(u,terms).hits.includes("comparison")).slice(0,16).map(u=>({text:u.text,page:unitPage(u)}));
  const examples=units.filter(u=>classifyUnit(u,terms).hits.includes("example")).slice(0,16).map(u=>({text:u.text,page:unitPage(u)}));
  const facts=units.filter(u=>classifyUnit(u,terms).hits.includes("fact-formula")).slice(0,20).map(u=>({text:u.text,page:unitPage(u)}));
  const keyPoints=selectEvidence(units,terms,headings,30).map(x=>({text:x.u.text,page:unitPage(x.u),heading:contextHeading(unitPage(x.u),headings),score:Math.round(x.score*10)/10}));
  return {definitions,processes,causes,comparisons,examples,facts,keyPoints};
}

function buildReviewer(doc){
  const units=sentenceUnits(doc),terms=Array.isArray(doc.terms)&&doc.terms.length?doc.terms:candidateTerms(doc),headings=detectHeadings(doc);
  const s=detectStructuredPatterns(units,terms,headings);
  const overview=synthesizeSummary(units,terms,headings,doc.summaryMode||"standard");
  const takeaways=selectEvidence(units,terms,headings,10).map(x=>({text:x.u.text,page:unitPage(x.u),heading:contextHeading(unitPage(x.u),headings)}));
  const memory=terms.slice(0,18).map(term=>{const u=units.find(x=>x.text.toLowerCase().includes(term.toLowerCase()));return {term,clue:u?normalize(u.text).slice(0,180):`Connect ${term} to an example or purpose from the material.`,page:unitPage(u)};});
  const questions=[];
  s.definitions.slice(0,8).forEach(d=>questions.push({type:"definition",q:`Define ${d.term} in your own words and give one detail from the material.`,page:d.page}));
  s.processes.slice(0,5).forEach(p=>questions.push({type:"process",q:`Explain the process or sequence described on page ${p.page??"the source"}.`,page:p.page}));
  s.causes.slice(0,5).forEach(p=>questions.push({type:"cause-effect",q:`What cause-and-effect relationship is described in this point?`,page:p.page}));
  s.comparisons.slice(0,4).forEach(p=>questions.push({type:"compare",q:`What two ideas are being compared or contrasted here?`,page:p.page}));
  takeaways.slice(0,8).forEach(p=>questions.push({type:"recall",q:`Explain this key idea without looking at the source: ${p.text}`,page:p.page}));
  const checklist=[];
  terms.slice(0,10).forEach(t=>checklist.push(`Explain ${t} without reading the source.`));
  s.definitions.slice(0,6).forEach(d=>checklist.push(`Give the definition of ${d.term} and one example.`));
  if(s.processes.length)checklist.push("Reconstruct the important process steps from memory.");
  if(s.causes.length)checklist.push("Explain the main cause-and-effect relationships.");
  if(s.facts.length)checklist.push("Memorize the important formulas, numbers, units, or factual thresholds.");
  (doc.media||[]).forEach((m,i)=>checklist.push(m.ocrText?`Review the text in photo ${i+1}.`:`Explain what photo ${i+1} is showing and why it matters.`));
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
  const examCram=synthesizeSummary(units,terms,headings,"cram");
  const confidence=Math.round(clamp((Math.min(1,units.length/20)*.25)+(Math.min(1,terms.length/20)*.25)+(Math.min(1,s.definitions.length/6)*.20)+(Math.min(1,takeaways.length/8)*.20)+(headings.length?0.10:0),0,1)*100);
  return {
    engineVersion:REVIEW_ENGINE_VERSION,mode:doc.summaryMode||"standard",overview,strategy,examCram,terms,headings,
    definitions:s.definitions,keyPoints:takeaways,processes:s.processes,causes:s.causes,comparisons:s.comparisons,examples:s.examples,facts:s.facts,
    questions:questions.slice(0,28),memory,checklist:checklist.slice(0,24),pages:pages.slice(0,80),blueprint,conceptMap:conceptMap.slice(0,40),confidence
  };
}

function buildStrategy(s,terms,media,mode){
  const pieces=[];
  pieces.push(`Start with the ${Math.min(terms.length,12)} highest-value concepts, then use the ${SUMMARY_MODES[mode]?.label||"Standard"} summary as your first pass.`);
  if(s.definitions.length)pieces.push("Master the definitions before memorizing examples.");
  if(s.processes.length)pieces.push("Reconstruct the process steps from memory, then check the source order.");
  if(s.causes.length)pieces.push("Practice explaining why each cause leads to its stated effect.");
  if(s.comparisons.length)pieces.push("Make a two-column comparison for the ideas that are easy to confuse.");
  if(s.facts.length)pieces.push("Memorize formulas, numbers, units, and thresholds separately from concepts.");
  if(media.length)pieces.push("Study each photo/diagram as a visual cue, then explain it without looking.");
  pieces.push("Finish with the quiz and revisit any concept you miss twice.");
  return pieces.join(" ");
}

function clozeFromSentence(text,term){
  const e=escapeRegExp(term);const re=new RegExp(`\\b${e}\\b`,'i');
  return re.test(text)?text.replace(re,"_____ ").replace(/\s+$/,''):text;
}

function cardId(doc,type,question,answer){return stableId("fc",`${doc.id}|${type}|${question}|${answer}`);}
function makeFlashcards(doc){
  const units=sentenceUnits(doc),r=doc.reviewerData||buildReviewer(doc),cards=[],seen=new Set();
  const add=(type,q,a,term="",page=null,source="page")=>{q=normalize(q);a=normalize(a);if(q.length<8||a.length<3)return;const id=cardId(doc,type,q,a);if(seen.has(id))return;seen.add(id);cards.push({id,type,term,question:q,answer:a,page,source});};
  for(const d of r.definitions){add("definition",`What is ${d.term}?`,d.definition,d.term,d.page);add("explain",`Explain ${d.term} in simple words.`,d.definition,d.term,d.page);}
  for(const p of r.processes.slice(0,12))add("process",`What process or sequence is described here?`,`Explain the sequence in this source statement: ${p.text}`,"",p.page);
  for(const p of r.causes.slice(0,10))add("cause-effect",`What cause leads to what effect in this material?`,p.text,"",p.page);
  for(const p of r.comparisons.slice(0,8))add("compare",`What ideas are being compared in this statement?`,p.text,"",p.page);
  for(const f of r.facts.slice(0,10))add("fact",`What important fact, number, unit, or formula should you remember?`,f.text,"",f.page);
  for(const term of r.terms.slice(0,24)){
    const u=units.find(x=>x.text.toLowerCase().includes(term.toLowerCase()));if(!u)continue;
    add("cloze",`Complete the statement:\n${clozeFromSentence(u.text,term)}`,term,term,u.page);
    add("recall",`What does ${term} do, describe, or relate to in this material?`,u.text,term,u.page);
  }
  for(const q of r.questions.slice(0,18)){const u=units.find(x=>Number(x.page)===Number(q.page))||units[0];add("exam-recall",q.q,u?.text||q.q,"",q.page);}
  for(const m of doc.media||[]){const answer=m.caption||m.ocrText;if(answer)add("visual",`What should you remember from ${m.name}?`,answer,"",null,"photo");}
  if(cards.length<24)for(const p of r.keyPoints){add("key-point","What is the most important idea in this passage?",p.text,"",p.page);if(cards.length>=36)break;}
  return cards.slice(0,60);
}

function deterministicShuffle(arr,seedText=""){
  const a=[...arr];let seed=0;for(const c of seedText)seed=(seed*31+c.charCodeAt(0))>>>0;
  for(let i=a.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;
}

function quizItem(doc,type,question,context,correct,options,page,term=""){
  const unique=[...new Set(options.filter(Boolean))];if(!unique.includes(correct))unique.unshift(correct);const opts=deterministicShuffle(unique.slice(0,4),question+correct);return opts.length>=2?{id:stableId("q",`${doc.id}|${type}|${question}|${correct}`),type,question,context,options:opts,correctIndex:opts.indexOf(correct),correct,page,term}:null;
}

function makeQuiz(doc){
  const r=doc.reviewerData||buildReviewer(doc),terms=r.terms||[],quiz=[],seen=new Set();const add=q=>{if(q&&!seen.has(q.id)){seen.add(q.id);quiz.push(q);}};
  for(const d of (r.definitions||[])){
    const wrong=deterministicShuffle(terms.filter(t=>t.toLowerCase()!==d.term.toLowerCase()),d.term).slice(0,3);
    add(quizItem(doc,"definition",`Which concept is best described by the definition below?`,d.definition,d.term,[d.term,...wrong],d.page,d.term));
    if(quiz.length>=8)break;
  }
  for(const term of terms){
    if(quiz.length>=14)break;
    const u=sentenceUnits(doc).find(x=>x.text.toLowerCase().includes(term.toLowerCase()));if(!u)continue;
    const wrong=deterministicShuffle(terms.filter(t=>t!==term),term).slice(0,3);
    add(quizItem(doc,"concept","Which term is most directly supported by this source statement?",u.text,term,[term,...wrong],u.page,term));
  }
  for(const p of (r.keyPoints||[])){
    if(quiz.length>=20)break;
    const wrong=deterministicShuffle((r.keyPoints||[]).filter(x=>x.text!==p.text).map(x=>x.text),p.text).slice(0,3);
    add(quizItem(doc,"key-point","Which statement best matches the source material?",p.text,p.text,[p.text,...wrong],p.page));
  }
  for(const m of doc.media||[]){
    if(quiz.length>=24)break;
    const correct=m.caption||m.ocrText;if(!correct)continue;
    const wrong=deterministicShuffle((r.memory||[]).map(x=>x.clue).filter(Boolean),m.name).slice(0,3);
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
  doc.terms=candidateTerms(doc);
  doc.reviewerData=buildReviewer(doc);
  doc.reviewerText=reviewerText(doc);
  doc.flashcards=makeFlashcards(doc);
  doc.quiz=makeQuiz(doc);
  doc.currentCard=0;
  doc.knownCardIds=Array.isArray(doc.knownCardIds)?doc.knownCardIds.filter(id=>doc.flashcards.some(c=>c.id===id)):[];
  doc.cardStats=doc.cardStats&&typeof doc.cardStats==="object"?doc.cardStats:{};
  if(resetProgress){doc.knownCardIds=[];doc.cardStats={};doc.quizScore=null;doc.quizHistory=[];}
  doc.reviewerVersion=REVIEW_ENGINE_VERSION;
}


let aiWorker=null, aiSeq=0, aiCurrent=null;
function aiEnsureWorker(){
  if(aiWorker)return aiWorker;
  aiWorker=new Worker(AI_WORKER_URL,{type:"module"});
  aiWorker.onmessage=e=>{
    const m=e.data||{};
    if(m.type==="status"||m.type==="progress"){
      const el=$("#aiStatus");if(el)el.textContent=m.message||"Local AI working…";
      return;
    }
    if(m.type==="ready"){
      const el=$("#aiStatus");if(el)el.textContent=`Local AI ready • ${m.device||"local"}`;
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
function aiSource(d, query=""){
  const pages=(d.pageTexts||[]).filter(p=>normalize(p.text||""));
  if(!pages.length)return normalize(d.rawText||"").slice(0,26000);
  const queryTerms=tokenize(query).filter(x=>x.length>=3&&!STOP.has(x)).slice(0,12);
  const scored=pages.map((p,i)=>({p,i,score:pageRelevance(p,queryTerms,d.terms||[])}));
  const picks=new Set();
  // Always sample the beginning/end and then fill with relevance + coverage.
  [0,1,2,pages.length-3,pages.length-2,pages.length-1].forEach(i=>{if(i>=0&&i<pages.length)picks.add(i);});
  for(const item of scored.sort((a,b)=>b.score-a.score)){
    if(picks.size>=14)break;
    if(item.score>0)picks.add(item.i);
  }
  const step=Math.max(1,Math.floor(pages.length/10));
  for(let i=step;i<pages.length&&picks.size<14;i+=step)picks.add(i);
  const ordered=[...picks].sort((a,b)=>a-b).map(i=>{
    const p=pages[i];
    return `PAGE ${p.page}\n${normalize(p.text).slice(0,2600)}`;
  });
  return ordered.join("\n\n---\n\n").slice(0,26000);
}
function aiQuestionSource(d, question){return aiSource(d,question);}

function scheduleAIForDoc(doc){return Promise.resolve(doc);}


async function renderPdfPageForOcr(page,scale=1.55){
  const viewport=page.getViewport({scale});
  const canvas=document.createElement("canvas");canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  const ctx=canvas.getContext("2d",{alpha:false});await page.render({canvasContext:ctx,viewport}).promise;
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("Could not render PDF page for OCR.")),"image/jpeg",.82));
}
async function extractPdf(file,progress){
  const ready=await loadPdfEngine();
  if(!ready)throw new Error("PDF.js could not be loaded. Connect to the internet once and try again.");
  const buffer=await file.arrayBuffer();
  const pdf=await window.pdfjsLib.getDocument({data:buffer}).promise;
  const pageTexts=[];const units=[];
  for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
    const page=await pdf.getPage(pageNumber);const content=await page.getTextContent();
    const items=content.items.filter(x=>typeof x.str==="string"&&x.str.trim());
    items.sort((a,b)=>{const ay=a.transform?.[5]||0,by=b.transform?.[5]||0;if(Math.abs(by-ay)>3)return by-ay;return (a.transform?.[4]||0)-(b.transform?.[4]||0)});
    const lines=[];let current="";let lastY=null;
    for(const item of items){const y=item.transform?.[5]||0;if(lastY!==null&&Math.abs(y-lastY)>3){if(current.trim())lines.push(current.trim());current="";}current+=`${current?" ":""}${item.str.trim()}`;lastY=y;}
    if(current.trim())lines.push(current.trim());
    const text=normalize(lines.join("\n"));pageTexts.push({page:pageNumber,text});
    for(const x of extractSentences(text,24))units.push({page:pageNumber,text:x});
    progress?.(pageNumber,pdf.numPages);
  }
  let rawText=pageTexts.map(p=>`Page ${p.page}\n${p.text}`).join("\n\n");
  if(wordCount(rawText)<20){
    const readyOcr=await loadTesseract();
    if(readyOcr){
      for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
        const page=await pdf.getPage(pageNumber);
        progress?.(`ocr:${pageNumber}`,pdf.numPages);
        try{
          const blob=await renderPdfPageForOcr(page);const ocr=await ocrImage(new File([blob],`${file.name}-page-${pageNumber}.jpg`,{type:"image/jpeg"}));
          if(ocr.text){pageTexts[pageNumber-1].text=ocr.text;pageTexts[pageNumber-1].source="ocr";for(const x of extractSentences(ocr.text,18))units.push({page:pageNumber,text:x,source:"ocr"});}
        }catch(err){console.warn("Scanned PDF OCR failed on page",pageNumber,err);}
      }
      rawText=pageTexts.map(p=>`Page ${p.page}\n${p.text}`).join("\n\n");
    }
  }
  return {pageCount:pdf.numPages,pageTexts,units,rawText};
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
function renderActivePanel(){const d=activeDoc(),box=$("#activeDocPanel");if(!d){box.innerHTML='<div class="empty">Add a PDF or photo to start studying.</div>';return;}const known=d.knownCardIds.length,total=d.flashcards.length,progress=total?Math.round(known/total*100):0;box.innerHTML=`<div class="doc" style="margin-bottom:12px"><div class="doc-icon">${d.sourceType==='image'?'🖼':'📘'}</div><div class="doc-main"><div class="doc-name">${esc(d.fileName)}</div><div class="doc-meta">${d.sourceType==='image'?'Photo study':'PDF'} • ${d.pageCount||1} page${(d.pageCount||1)===1?'':'s'} • ${d.media?.length||0} photo(s) • ${wordCount(d.rawText||'').toLocaleString()} words</div></div></div><div class="source-pill">${d.sourceType==='image'?'OCR + Visual':'PDF text + page structure'}</div><p class="muted" style="line-height:1.65;margin-top:12px">${esc(d.reviewerData?.overview||'')}</p><div style="margin-top:14px"><div style="display:flex;justify-content:space-between;gap:10px;font-size:.75rem;color:var(--muted)"><span>Flashcard progress</span><span>${known}/${total} (${progress}%)</span></div><div class="progress-track" style="margin-top:6px"><div class="progress-bar" style="width:${progress}%"></div></div></div><div class="row" style="margin-top:14px"><button class="btn primary small" data-go="reviewer">Reviewer</button><button class="btn secondary small" data-go="flashcards">Flashcards</button><button class="btn secondary small" data-go="quiz">Quiz</button><button id="regenDocBtn" class="btn warning small">Regenerate</button></div>`;box.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>activateSection(b.dataset.go));$("#regenDocBtn").onclick=async()=>{regenerateDoc(d,true);await saveDoc(d);renderAll();toast('Reviewer, flashcards, and quiz regenerated.','success');};}
function renderTerms(){const c=$("#reviewerTerms"),terms=activeDoc()?.terms||[];c.innerHTML=terms.length?terms.map(t=>`<span class="term">${esc(t)}</span>`).join(''):'<div class="empty">No terms detected.</div>';}
function renderReviewer(){
  const d=activeDoc(),r=d?.reviewerData;
  $("#reviewerOverview").textContent=r?.overview||"Select a study material.";
  $("#reviewerCram").textContent=r?.examCram||"Upload a PDF or photo to create a compact exam summary.";
  $("#reviewerStrategy").textContent=r?.strategy||"Upload a PDF to create a study strategy.";
  $("#reviewerMeta").textContent=d?`${d.fileName} • ${r?.mode?SUMMARY_MODES[r.mode]?.label||r.mode:"Standard"} • ${r?.terms?.length||0} concepts • ${r?.confidence||0}% source-structure confidence`:`Evidence-first local synthesis. Change the summary depth without changing your source material.`;
  $("#reviewerConfidence").textContent=d?`${r?.confidence||0}% evidence confidence`:`Not analyzed`;
  $$('[data-summary-mode]').forEach(b=>b.classList.toggle("active",b.dataset.summaryMode===(d?.summaryMode||"standard")));
  renderTerms();
  const fill=(sel,items,map,empty)=>{const el=$(sel);if(!el)return;el.innerHTML=items?.length?items.map(map).join(""):empty;};
  fill("#reviewerDefinitions",r?.definitions,d=>`<div class="definition-card"><strong>${esc(d.term)}</strong><span>${esc(d.definition)}${d.page?` <span class="tiny">Page ${d.page}</span>`:""}<span class="confidence-badge">${Math.round((d.confidence||0)*100)}%</span></span></div>`,'<div class="empty">No explicit definition pattern was detected. Contextual evidence is still available.</div>');
  fill("#reviewerKeyPoints",r?.keyPoints,x=>`<li>${esc(x.text)}${x.heading?`<span class="meta">${esc(x.heading)}</span>`:""}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No strong evidence points yet.</li>');
  fill("#reviewerProcesses",r?.processes,x=>`<li>${esc(x.text)}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No process or sequence pattern detected.</li>');
  fill("#reviewerCauses",r?.causes,x=>`<li>${esc(x.text)}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No cause-effect pattern detected.</li>');
  fill("#reviewerComparisons",r?.comparisons,x=>`<li>${esc(x.text)}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No comparison pattern detected.</li>');
  fill("#reviewerExamples",r?.examples,x=>`<li>${esc(x.text)}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No example pattern detected.</li>');
  fill("#reviewerFacts",r?.facts,x=>`<li>${esc(x.text)}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No fact or formula pattern detected.</li>');
  fill("#reviewerQuestions",r?.questions,q=>`<div class="study-question"><span class="question-type">${esc(q.type||"recall")}</span><div>${esc(q.q)}</div>${q.page?`<span class="source-chip">Page ${q.page}</span>`:""}</div>`,'<div class="empty">No study questions yet.</div>');
  fill("#reviewerPages",r?.pages,p=>`<li><strong>Page ${esc(p.page)}</strong>${p.heading?`<span class="meta">${esc(p.heading)}</span>`:""}<div style="margin-top:5px">${esc(p.text)}</div></li>`,'<li class="empty">No page evidence detected.</li>');
  fill("#reviewerMemory",r?.memory,m=>`<div class="memory-item"><strong>${esc(m.term)}</strong><span>${esc(m.clue)}${m.page?` <span class="tiny">Page ${m.page}</span>`:""}</span></div>`,'<div class="empty">No memory cues yet.</div>');
  fill("#reviewerChecklist",r?.checklist,x=>`<li>${esc(x)}</li>`,'<li class="empty">No checklist yet.</li>');
  const map=$("#reviewerConceptMap");if(map)map.innerHTML=r?.conceptMap?.length?r.conceptMap.slice(0,24).map(x=>`<div class="concept-link"><span>${esc(x.from)}</span><span>↔</span><span>${esc(x.to)}</span><em>${x.strength}</em></div>`).join(""):'<div class="empty">No strong concept links yet.</div>';
  const photos=$("#reviewerPhotos"),media=d?.media||[];
  photos.innerHTML=media.length?media.map(m=>`<div class="photo-card"><img src="${m.dataUrl}" alt="${esc(m.name)}"><div class="photo-body"><div class="photo-name">${esc(m.name)}</div><div class="photo-meta">${m.confidence?`OCR confidence ${Math.round(m.confidence)}%`:'OCR text not available'}</div><div class="ocr-badge ${m.ocrText?'':'warn'}">${m.ocrText?'✓ OCR text available':'⚠ Add a caption'}</div><input class="photo-caption" data-caption="${esc(m.id)}" value="${esc(m.caption||"")}" maxlength="300" placeholder="What should you remember from this photo?"><div class="photo-actions"><button class="btn small secondary" data-insert-note="${esc(m.id)}">Insert in notes</button><button class="btn small danger" data-remove-photo="${esc(m.id)}">Remove</button></div></div></div>`).join(""):'<div class="photo-empty">No photos attached.</div>';
  photos.querySelectorAll("[data-caption]").forEach(input=>input.addEventListener("change",async()=>{const m=d?.media.find(x=>x.id===input.dataset.caption);if(!m)return;m.caption=input.value.trim();regenerateDoc(d,false);await saveDoc(d);renderAll();toast("Photo caption saved and reviewer regenerated.","success");}));
  photos.querySelectorAll("[data-remove-photo]").forEach(b=>b.onclick=async()=>{const m=d?.media.find(x=>x.id===b.dataset.removePhoto);if(!m)return;if(!confirm(`Remove ${m.name}?`))return;d.media=d.media.filter(x=>x.id!==m.id);d.pageTexts=d.pageTexts.filter(pg=>pg.photoId!==m.id);d.units=d.units.filter(u=>u.photoId!==m.id);regenerateDoc(d,true);await saveDoc(d);renderAll();toast("Photo removed.","success");});
  photos.querySelectorAll("[data-insert-note]").forEach(b=>b.onclick=()=>{const m=d?.media.find(x=>x.id===b.dataset.insertNote);if(!m)return;activateSection("notes");setTimeout(()=>insertAtCursor(`<p><img src="${m.dataUrl}" alt="${esc(m.name)}"><br><strong>${esc(m.name)}</strong></p>`),60);});
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
async function markKnown(known){
  const d=activeDoc();if(!d?.flashcards.length)return;const card=d.flashcards[d.currentCard],id=card.id;
  d.cardStats=d.cardStats||{};const prev=d.cardStats[id]||{attempts:0,correct:0,streak:0,ease:2.5,interval:0,dueAt:0,lastSeen:0};const next={...prev,attempts:prev.attempts+1,lastSeen:Date.now()};
  if(known){next.correct=prev.correct+1;next.streak=prev.streak+1;next.ease=Math.min(3.25,prev.ease+.10);next.interval=next.streak===1?1:next.streak===2?3:Math.max(5,Math.round((prev.interval||3)*next.ease));next.dueAt=Date.now()+Math.min(1000*60*60*24*365,next.interval*24*60*60*1000);if(!d.knownCardIds.includes(id))d.knownCardIds.push(id);}else{next.streak=0;next.ease=Math.max(1.3,prev.ease-.20);next.interval=0;next.dueAt=Date.now()+1000*60*5;d.knownCardIds=d.knownCardIds.filter(x=>x!==id);}
  d.cardStats[id]=next;adaptConcept(card.term||card.question,known);await saveDoc(d);await saveMeta();renderFlash();renderDashboard();renderAI();toast(known?"Marked known and scheduled for later review.":"Marked for review soon.",known?"success":"");}

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
  }catch(e){if(status)status.textContent=e.message==="AI task cancelled."?"AI stopped.":"AI unavailable — deterministic reviewer kept";if(e.message!=="AI task cancelled.")toast(e.message||"Local AI failed. Your source reviewer is still available.","error");}
  finally{if(btn)btn.disabled=false;}
}
async function enableLocalAI(){
  const status=$("#aiStatus");if(status)status.textContent="Loading the on-device model. The page will stay responsive while it downloads…";
  try{const worker=aiEnsureWorker();state.settings.ai.enabled=true;await saveMeta();worker.postMessage({type:"load"});toast("Local AI load started. Keep the app open until the model finishes downloading.","success");}catch(e){state.settings.ai.enabled=false;await saveMeta();toast(e.message||"Local AI could not start.","error");}
}
async function disableLocalAI(){aiCancel();state.settings.ai.enabled=false;await saveMeta();renderAll();toast("Local AI disabled. Your deterministic reviewer remains available.");}
function renderAI(){
  const d=activeDoc(),ai=d?.ai||{},p=learnerProfile();
  const status=$("#aiStatus");const info=$("#aiDevice");
  if(status&&!ai.generatedAt)status.textContent=state.settings.ai?.enabled?"Local AI enabled — load it from Settings or run it below.":"Optional on-device AI. Your study source stays in your browser during inference.";
  if($("#aiReviewer"))$("#aiReviewer").textContent=ai.reviewer||"No AI rewrite yet. The deterministic source-grounded reviewer remains available below.";
  const weak=$("#weakConcepts");if(weak){const ws=weakConcepts();weak.innerHTML=ws.length?ws.map(x=>`<span class="term">${esc(x)}</span>`).join(""):"<span class='tiny'>Weak areas appear after you study and answer questions.</span>";}
  const entries=Object.values(p.concepts||{}),avg=entries.length?entries.reduce((s,x)=>s+(Number(x.mastery)||0),0)/entries.length:0;if($("#aiMasteryBar"))$("#aiMasteryBar").style.width=`${Math.round(avg*100)}%`;if($("#aiMasteryText"))$("#aiMasteryText").textContent=entries.length?`Overall mastery ${Math.round(avg*100)}% • ${p.sessions||0} sessions • streak ${p.streak||0}`:"No mastery data yet.";
  if(info)info.textContent=ai.model?`${ai.model} • ${ai.device||"local"}`:`Model: on-device Qwen3 0.6B • first load downloads model files`;
  const settingsInfo=$("#settingsAiInfo");if(settingsInfo)settingsInfo.textContent=state.settings.ai?.enabled?"AI enabled. The model loads in a worker so the UI remains interactive.":"AI is optional; deterministic review works without it.";
}

function updateConnectivity(){
  const el=$("#networkStatus");
  if(!el)return;
  const online=navigator.onLine;
  el.textContent=online?"ONLINE • AI available":"OFFLINE • study mode available";
  el.classList.toggle("offline",!online);
  const aiButtons=[$("#aiEnable"),$("#settingsAiEnable")].filter(Boolean);
  if(!online){for(const b of aiButtons)b.title="The app still works offline. Local AI needs the model to have been downloaded and cached first.";}
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
async function processPdfFiles(files){for(const file of [...files]){if(file.type!=='application/pdf'){toast(`${file.name}: not a PDF.`,'error');continue;}$("#upload").innerHTML=`<div class="loading"><span class="spinner"></span><span id="processStatus">Reading ${esc(file.name)}…</span></div>`;try{const extracted=await extractPdf(file,(page,total)=>{$("#processStatus").textContent=String(page).startsWith("ocr:")?`OCR ${file.name} — page ${String(page).slice(4)} of ${total}…`:`Reading ${file.name} — page ${page} of ${total}…`;});if(wordCount(extracted.rawText)<20)throw new Error('This PDF has little or no selectable text. Use Add Photos/OCR for scanned pages.');const doc=baseDoc(file,'pdf',extracted,[]);state.documents.unshift(doc);state.activeDocId=doc.id;await dbPut(DOC_STORE,doc);await saveMeta();renderAll();toast(`${file.name} added and reviewer generated.`,'success');}catch(e){console.error(e);toast(`${file.name}: ${e.message||'Could not process PDF.'}`,'error');}}}
async function processImageFiles(files){for(const file of [...files]){if(!/^image\/(png|jpeg|webp|bmp)$/.test(file.type)){toast(`${file.name}: unsupported image type.`,'error');continue;}$("#upload").innerHTML=`<div class="loading"><span class="spinner"></span><span id="processStatus">Preparing ${esc(file.name)}…</span></div>`;try{const visual=await dataUrlFromFile(file);let ocr={text:'',confidence:0};try{ocr=await ocrImage(file,m=>{$("#processStatus").textContent=`OCR ${file.name} — ${m.progress?Math.round(m.progress*100):0}%…`;});}catch(err){console.warn('OCR unavailable',err);toast(`${file.name}: photo saved, but OCR was unavailable. Add a caption on the Reviewer page.`,'error');}const mediaId=uid();const extracted={pageCount:1,pageTexts:[{page:1,text:ocr.text,source:'photo',photoId:mediaId}],units:extractSentences(ocr.text,18).map(text=>({page:1,text,source:'photo',photoId:mediaId})),rawText:ocr.text};const media=[{id:mediaId,name:file.name,dataUrl:visual.dataUrl,width:visual.width,height:visual.height,caption:'',ocrText:ocr.text,confidence:ocr.confidence,createdAt:now()}];const doc=baseDoc(file,'image',extracted,media);state.documents.unshift(doc);state.activeDocId=doc.id;await dbPut(DOC_STORE,doc);await saveMeta();renderAll();toast(`${file.name} added as a photo study sheet.`,'success');}catch(e){console.error(e);toast(`${file.name}: ${e.message||'Could not process photo.'}`,'error');}}}
async function processFiles(files){const list=[...files].filter(Boolean);if(!list.length)return;const pdfs=list.filter(f=>f.type==='application/pdf'),images=list.filter(f=>f.type.startsWith('image/'));if(pdfs.length)await processPdfFiles(pdfs);if(images.length)await processImageFiles(images);$("#upload").innerHTML='<div><div class="upload-icon">📚</div><h3>Drop PDFs or study photos here</h3><p>Add PDFs, screenshots, and class photos. OCR can turn image text into reviewer material; visual cards keep the photo itself available for study.</p><div class="hero-actions" style="justify-content:center"><label for="pdfInput" class="btn primary">Choose PDFs</label><label for="imageInput" class="btn secondary">Choose Photos</label></div></div>';}

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
  $("#aiAsk").onclick=async()=>{const d=activeDoc(),q=$("#aiQuestion").value.trim(),out=$("#aiAnswer");if(!d)return toast("Select a study material first.","error");if(!q)return toast("Write a question first.","error");out.textContent="Thinking locally…";try{const r=await aiRequest("ask",{source:aiQuestionSource(d,q),profile:learnerDigestForAI(),question:q});out.textContent=r.text;toast("Answer generated from the study material.","success");}catch(e){out.textContent=e.message==="AI task cancelled."?"AI stopped.":"Local AI could not answer this yet.";if(e.message!=="AI task cancelled.")toast(e.message||"Local AI unavailable.","error");}};
  $("#copyReviewer").onclick=copyReviewer;$("#downloadReviewer").onclick=downloadReviewer;$("#regenerateReviewer").onclick=async()=>{const d=activeDoc();if(!d)return toast('Select a document first.','error');regenerateDoc(d,true);await saveDoc(d);renderAll();toast('Reviewer, flashcards, and quiz regenerated.','success');};
  $("#prevFlash").onclick=()=>moveFlash(-1);$("#nextFlash").onclick=()=>moveFlash(1);$("#showFlashAnswer").onclick=()=>activeDoc()&&$("#flashAnswer").classList.remove('hidden');$("#knowFlash").onclick=()=>markKnown(true);$("#reviewFlash").onclick=()=>markKnown(false);
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
    if(meta){state.settings={...state.settings,...meta,ai:{...state.settings.ai,...(meta.ai||{})},learner:{...defaultLearner(),...(meta.learner||{})}};state.activeDocId=meta.activeDocId||null;}
    state.documents=(await dbGetAll(DOC_STORE)).map(normalizeDoc);
    for(const d of state.documents)await dbPut(DOC_STORE,d);
    if(!state.activeDocId)state.activeDocId=state.documents[0]?.id||null;
    await saveMeta();renderAll();setupDrop();setupInstall();
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
