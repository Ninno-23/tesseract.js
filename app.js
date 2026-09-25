
(() => {
"use strict";

const APP_VERSION = 5;
const DB_NAME = "studyvault-v5";
const DB_VERSION = 1;
const DOC_STORE = "documents";
const META_STORE = "meta";
const SETTINGS_KEY = "settings";
const CDN_PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const CDN_PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const CDN_TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js";

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
  settings: { theme:"dark", pinHash:"", pinSalt:"", pinIterations:120000 },
  documents: [],
  activeDocId: null
};
let deferredInstall = null;

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
function loadPdfEngine(){
  if(window.pdfjsLib){
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN_PDF_WORKER;
    setEngineStatus("ready");
    return Promise.resolve(true);
  }
  if(pdfEnginePromise)return pdfEnginePromise;
  setEngineStatus("loading…");
  pdfEnginePromise = new Promise(resolve=>{
    const script=document.createElement("script");
    script.src=CDN_PDFJS;
    script.async=true;
    let done=false;
    const finish=ok=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      if(ok&&window.pdfjsLib){window.pdfjsLib.GlobalWorkerOptions.workerSrc=CDN_PDF_WORKER;setEngineStatus("ready");resolve(true);}
      else {setEngineStatus("unavailable — connect to the internet to process PDFs");resolve(false);}
    };
    script.onload=()=>finish(true);
    script.onerror=()=>finish(false);
    document.head.appendChild(script);
    const timer=setTimeout(()=>finish(false),10000);
  });
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
function dataUrlFromFile(file,maxSide=1900,quality=.86){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));const c=document.createElement("canvas");c.width=w;c.height=h;const ctx=c.getContext("2d");ctx.drawImage(img,0,0,w,h);resolve({dataUrl:c.toDataURL("image/jpeg",quality),width:w,height:h});};img.onerror=()=>reject(new Error("Could not read the image."));img.src=reader.result;};reader.onerror=()=>reject(reader.error||new Error("Could not read the image."));reader.readAsDataURL(file);});}

function openDB(){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onupgradeneeded=()=>{
      const db=r.result;
      if(!db.objectStoreNames.contains(DOC_STORE))db.createObjectStore(DOC_STORE,{keyPath:"id"});
      if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE);
    };
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(r.error);
  });
}
async function dbPut(store,keyOrValue,value){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");
    const os=tx.objectStore(store);
    if(value===undefined)os.put(keyOrValue);else os.put(value,keyOrValue);
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function dbGet(store,key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readonly");
    const r=tx.objectStore(store).get(key);
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(r.error);
    tx.oncomplete=()=>db.close();
  });
}
async function dbGetAll(store){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readonly");
    const r=tx.objectStore(store).getAll();
    r.onsuccess=()=>resolve(r.result||[]);
    r.onerror=()=>reject(r.error);
    tx.oncomplete=()=>db.close();
  });
}
async function dbDelete(store,key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function dbClear(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction([DOC_STORE,META_STORE],"readwrite");
    tx.objectStore(DOC_STORE).clear();tx.objectStore(META_STORE).clear();
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function saveDoc(doc){doc.updatedAt=now();await dbPut(DOC_STORE,doc);}
async function saveMeta(){await dbPut(META_STORE,SETTINGS_KEY,{...state.settings,activeDocId:state.activeDocId,version:APP_VERSION});}

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
async function verifyPin(pin){
  if(!state.settings.pinHash||!state.settings.pinSalt)return false;
  const hash=await derivePin(pin,b64ToBytes(state.settings.pinSalt),state.settings.pinIterations||120000);
  return hash===state.settings.pinHash;
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

function tokenize(text){return normalize(text).toLowerCase().replace(/[^a-z0-9\s'-]/g," ").split(/\s+/).filter(Boolean);}
function stableId(prefix,text){
  let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return `${prefix}-${(h>>>0).toString(16)}`;
}
function similarity(a,b){
  const A=new Set(tokenize(a)),B=new Set(tokenize(b));let common=0;
  for(const x of A)if(B.has(x))common++;
  const union=new Set([...A,...B]).size;return union?common/union:0;
}

function extractSentences(text,min=28){
  const cleaned=normalize(text);
  if(!cleaned)return [];
  const raw=[];
  for(const part of cleaned.split(/\n+/)){
    const line=part.trim();
    if(!line)continue;
    const pieces=line.match(/[^.!?;]+(?:[.!?]+|;|$)/g)||[line];
    for(const p of pieces){const s=normalize(p);if(s.length>=min)raw.push(s);}
  }
  const seen=new Set();
  return raw.filter(s=>{const k=s.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});
}

function extractTerms(text){
  const toks=tokenize(text);const uni=new Map(),bi=new Map(),tri=new Map();
  for(const w of toks){
    if(w.length<4||w.length>28||STOP.has(w)||/^\d+$/.test(w))continue;
    uni.set(w,(uni.get(w)||0)+1);
  }
  for(let i=0;i<toks.length-1;i++){
    const a=toks[i],b=toks[i+1];
    if(a.length>=4&&b.length>=4&&!STOP.has(a)&&!STOP.has(b)){
      const k=`${a} ${b}`;bi.set(k,(bi.get(k)||0)+1);
      if(i<toks.length-2){const c=toks[i+2];if(c.length>=4&&!STOP.has(c)){const t=`${a} ${b} ${c}`;tri.set(t,(tri.get(t)||0)+1)}}
    }
  }
  const ranked=[...uni.entries()].map(([term,freq])=>({term,freq,score:freq+(freq>=3?1.4:0)+(freq>=7?1.3:0)+(term.includes("-")?1:0)})).sort((a,b)=>b.score-a.score);
  const phrases=[...bi.entries()].filter(([,f])=>f>=2).map(([term,freq])=>({term,freq,score:freq*2.6})).sort((a,b)=>b.score-a.score);
  const triples=[...tri.entries()].filter(([,f])=>f>=2).map(([term,freq])=>({term,freq,score:freq*3.2})).sort((a,b)=>b.score-a.score);
  const out=[];
  for(const item of [...triples,...phrases,...ranked]){
    const term=item.term;
    if(out.some(x=>x.toLowerCase()===term.toLowerCase()))continue;
    if(out.some(x=>similarity(x,term)>.82))continue;
    out.push(term);
    if(out.length>=32)break;
  }
  return out;
}

function detectDefinitions(sentences,terms){
  const patterns=[/\b(.+?)\s+(?:is|are|means|refers to|defined as|known as|is called|can be defined as)\b/i,/\b(.+?)\s*:\s*(.+)/i];
  const defs=[];
  for(const s of sentences){
    if(defs.length>=16)break;
    if(patterns[0].test(s)||patterns[1].test(s)){
      const low=s.toLowerCase();
      const term=terms.find(t=>low.includes(t.toLowerCase()));
      if(term&&!defs.some(d=>d.term.toLowerCase()===term.toLowerCase()))defs.push({term,definition:s});
    }
  }
  return defs;
}

function sentenceScore(s,terms){
  const l=s.toLowerCase();let score=0;
  for(const t of terms.slice(0,22))if(l.includes(t.toLowerCase()))score+=2;
  if(/\b(is|are|means|refers to|defined as|known as|is called|consists of)\b/i.test(s))score+=6;
  if(/\b(function|purpose|process|used|example|important|include|includes|types|steps|characteristics|advantages|disadvantages|difference|cause|effect|result)\b/i.test(s))score+=3;
  if(/\b(first|second|third|finally|therefore|because|however|for example|such as)\b/i.test(s))score+=2;
  if(/\d/.test(s))score+=1;
  if(s.length>=55&&s.length<=280)score+=2;
  if(s.length>360)score-=2;
  return score;
}

function pickDiverse(sentences,terms,count){
  const ranked=sentences.map((s,i)=>({s,i,score:sentenceScore(s,terms)})).sort((a,b)=>b.score-a.score);
  const chosen=[];
  for(const x of ranked){
    if(chosen.some(y=>similarity(y.s,x.s)>.62))continue;
    chosen.push(x);
    if(chosen.length>=count)break;
  }
  return chosen.sort((a,b)=>a.i-b.i);
}

function contextForTerm(term,units){
  const l=term.toLowerCase();
  const hits=units.filter(u=>u.text.toLowerCase().includes(l)).sort((a,b)=>sentenceScore(b.text,[term])-sentenceScore(a.text,[term]));
  return hits[0]||null;
}
function bestDefinition(term,units){
  const direct=units.filter(u=>u.text.toLowerCase().includes(term.toLowerCase())).sort((a,b)=>{
    const cue=x=>/\b(is|are|means|refers to|defined as|known as|is called|consists of)\b/i.test(x.text)?4:0;
    return (cue(b)+b.text.length*.001)-(cue(a)+a.text.length*.001);
  })[0];
  return direct||null;
}

function buildReviewer(doc){
  const units=doc.units||[];const sentences=units.map(u=>u.text).filter(Boolean);const terms=doc.terms||[];
  const defs=detectDefinitions(sentences,terms).map(d=>{const u=units.find(x=>x.text===d.definition);return {...d,page:u?.page||null,source:u?.source||"page"};});
  const picked=pickDiverse(sentences,terms,28).map(x=>{const u=units.find(y=>y.text===x.s);return {text:x.s,page:u?.page||null,source:u?.source||"page"};});
  const overviewParts=pickDiverse(sentences,terms,6).map(x=>x.s);
  if(overviewParts.length<3){for(const p of (doc.pageTexts||[])){if(p.text&&normalize(p.text).length>40){overviewParts.push(normalize(p.text).slice(0,380));if(overviewParts.length>=3)break;}}}
  const overview=normalize(overviewParts.join(' ')).slice(0,1800);
  const questions=[];
  defs.slice(0,10).forEach(d=>questions.push({q:`Define ${d.term} in your own words and state one detail from the material.`,page:d.page}));
  picked.filter(k=>!defs.some(d=>d.definition===k.text)).slice(0,10).forEach(k=>questions.push({q:`Explain the key idea from ${k.page?`page ${k.page}`:"this passage"} and why it matters.`,page:k.page}));
  if(!questions.length)terms.slice(0,10).forEach(t=>questions.push({q:`What is ${t}, and what example, use, or purpose is associated with it?`,page:null}));
  const memory=terms.slice(0,14).map(t=>{const c=contextForTerm(t,units);return {term:t,clue:c?normalize(c.text).slice(0,190):"Connect this term to an example from the material."};});
  const checklist=[];defs.slice(0,8).forEach(d=>checklist.push(`Know the meaning of ${d.term}.`));picked.slice(0,8).forEach(k=>checklist.push(`Explain the key point from ${k.page?`page ${k.page}`:"the source"} without looking.`));(doc.media||[]).forEach((m,i)=>checklist.push(m.ocrText?`Review the text extracted from photo ${i+1}.`:`Review the visual information in photo ${i+1}.`));
  const pages=[];for(const p of (doc.pageTexts||[])){const ps=p.text?extractSentences(p.text,18):[];if(ps.length){const top=pickDiverse(ps,terms,1)[0]?.s||ps[0];pages.push({page:p.page,text:top,source:p.source||"page"});}if(pages.length>=30)break;}
  const visuals=(doc.media||[]).map((m,i)=>({id:m.id,index:i,name:m.name,dataUrl:m.dataUrl,caption:m.caption||"",ocrText:m.ocrText||"",confidence:m.confidence||0}));
  const strategy=defs.length>=5?"Learn the definitions first, explain the key points aloud, use the memory cues, then take the quiz and revisit the cited page/photo for every mistake.":"Start with the key terms and key points. For each concept, say what it means, how it works or is used, and one example. Then use flashcards and the quiz to find weak areas.";
  return {overview:overview||"The source did not yield enough clean sentences for an automatic summary. Use the key terms, visual material, and notes to complete the missing explanations.",strategy,definitions:defs.slice(0,18),keyPoints:picked.slice(0,28),pages,questions:questions.slice(0,18),memory,checklist:checklist.slice(0,20),visuals};
}
function makeFlashcards(doc){
  const units=doc.units||[],cards=[],seen=new Set(),defs=detectDefinitions(units.map(u=>u.text),doc.terms||[]);
  const add=(type,question,answer,term,page,source="page")=>{const q=normalize(question),a=normalize(answer);if(!q||!a)return;const id=stableId('fc',`${doc.id}|${type}|${term||''}|${q}|${a}`);if(seen.has(id))return;seen.add(id);cards.push({id,type,term:term||'',question:q,answer:a,page:page||null,source});};
  defs.forEach(d=>{const u=units.find(x=>x.text===d.definition);add('definition',`What is "${d.term}"?`,d.definition,d.term,u?.page,u?.source||'page');});
  for(const term of (doc.terms||[])){
    const u=contextForTerm(term,units);if(!u)continue;const text=u.text;const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),re=new RegExp(`\\b${escaped}\\b`,'i');
    if(re.test(text)&&text.length>=45)add('cloze',`Complete the statement:\n${text.replace(re,'_____')}`,term,term,u.page,u.source||'page');
    add('explain',`Explain "${term}" using the material.`,text,term,u.page,u.source||'page');
    add('example',`What example, use, or purpose is given for "${term}"?`,text,term,u.page,u.source||'page');
    if(cards.length>=42)break;
  }
  for(const q of (doc.reviewerData?.questions||[])){if(cards.length>=48)break;const u=units.find(x=>x.page===q.page)||units[0];add('study-question',q.q,u?.text||'Review the source and explain the concept.','',u?.page,u?.source||'page');}
  for(const m of (doc.media||[])){if(cards.length>=50)break;const ans=m.caption||m.ocrText||'Study the visual carefully and identify the main information it communicates.';add('photo',`What should you remember from the photo "${m.name}"?`,ans,'',null,'photo');if(m.ocrText)add('photo-ocr',`What important text can you recall from photo "${m.name}"?`,m.ocrText,'',null,'photo');}
  for(const u of units){if(cards.length>=50)break;if((u.text||'').length<60)continue;add('main-idea','What is the main idea of this passage?',u.text,'',u.page,u.source||'page');}
  return cards.slice(0,50);
}
function shuffle(arr){const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function makeQuiz(doc){
  const units=doc.units||[],defs=doc.reviewerData?.definitions||[],terms=doc.terms||[],points=doc.reviewerData?.keyPoints||[],quiz=[],seen=new Set();
  const make=(question,context,correct,options,page,type)=>{const key=`${question}|${correct}|${page}`;if(seen.has(key))return;seen.add(key);const opts=shuffle([...new Set(options)]).slice(0,4);if(!opts.includes(correct))opts.unshift(correct);if(opts.length<2)return;quiz.push({id:stableId('q',`${doc.id}|${key}`),question,context,options:opts,correctIndex:opts.indexOf(correct),correct,page,type});};
  for(const d of defs){const wrong=shuffle(terms.filter(t=>t.toLowerCase()!==d.term.toLowerCase())).slice(0,3);make(`Which concept is best described by this explanation?`,d.definition,d.term,[d.term,...wrong],d.page,'definition');if(quiz.length>=8)break;}
  for(const term of terms){const u=contextForTerm(term,units);if(!u)continue;const wrong=shuffle(terms.filter(t=>t!==term)).slice(0,3);make(`Which term best completes the statement?`,u.text,term,[term,...wrong],u.page,'concept');if(quiz.length>=14)break;}
  for(const p of points){if(quiz.length>=20)break;const wrong=shuffle(points.filter(x=>x.text!==p.text).map(x=>x.text)).slice(0,3);make(`Which statement matches the key point being tested?`,p.text,p.text,[p.text,...wrong],p.page,'key-point');}
  for(const m of (doc.media||[])){if(quiz.length>=20)break;const answer=m.caption||m.ocrText;if(answer){const wrong=shuffle((doc.reviewerData?.memory||[]).map(x=>x.clue).filter(Boolean)).slice(0,3);make(`Which statement best matches photo "${m.name}"?`,answer,answer,[answer,...wrong],null,'photo');}}
  return quiz.slice(0,20);
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
    for(const item of items){
      const y=item.transform?.[5]||0;
      if(lastY!==null&&Math.abs(y-lastY)>3){if(current.trim())lines.push(current.trim());current="";}
      current+=`${current?" ":""}${item.str.trim()}`;lastY=y;
    }
    if(current.trim())lines.push(current.trim());
    const text=normalize(lines.join("\n"));
    pageTexts.push({page:pageNumber,text});
    for(const s of extractSentences(text,24))units.push({page:pageNumber,text:s});
    progress?.(pageNumber,pdf.numPages);
  }
  return {pageCount:pdf.numPages,pageTexts,units,rawText:pageTexts.map(p=>`Page ${p.page}\n${p.text}`).join("\n\n")};
}

function normalizeDoc(raw){
  const d={...raw};
  d.id=d.id||uid();
  d.sourceType=d.sourceType||"pdf";
  d.fileName=String(d.fileName||"Untitled Study Material");
  d.pageCount=Number(d.pageCount)||0;
  d.media=Array.isArray(d.media)?d.media:[];
  d.pageTexts=Array.isArray(d.pageTexts)?d.pageTexts:[];
  d.rawText=String(d.rawText||d.pageTexts.map(p=>p.text||"").join("\n\n"));
  d.units=Array.isArray(d.units)?d.units:d.pageTexts.flatMap(p=>extractSentences(p.text||"").map(text=>({page:p.page,text})));
  d.terms=Array.isArray(d.terms)&&d.terms.length?d.terms:extractTerms(d.rawText);
  d.reviewerData=d.reviewerData||buildReviewer(d);
  d.reviewerText=d.reviewerText||buildReviewerText(d);
  d.flashcards=Array.isArray(d.flashcards)&&d.flashcards.length?d.flashcards:makeFlashcards(d);
  d.flashcards=d.flashcards.map((c,i)=>({...c,id:c.id||stableId("fc",`${d.id}|${i}|${c.question||""}|${c.answer||""}`)}));
  d.currentCard=clamp(Number(d.currentCard)||0,0,Math.max(0,d.flashcards.length-1));
  d.knownCardIds=Array.isArray(d.knownCardIds)?d.knownCardIds.filter(id=>d.flashcards.some(c=>c.id===id)):[];
  d.quiz=Array.isArray(d.quiz)&&d.quiz.length?d.quiz:makeQuiz(d);
  d.quiz=d.quiz.map((q,i)=>{const options=Array.isArray(q.options)?q.options:[];const ci=Number.isInteger(q.correctIndex)?q.correctIndex:options.indexOf(q.correct);return {...q,id:q.id||stableId("q",`${d.id}|${i}|${q.question||""}`),options,correctIndex:clamp(ci>=0?ci:0,0,Math.max(0,options.length-1)),correct:options[ci>=0?ci:0]||q.correct||""};});
  d.quizHistory=Array.isArray(d.quizHistory)?d.quizHistory:[];
  d.quizScore=Number.isFinite(d.quizScore)?d.quizScore:null;
  d.notesTitle=String(d.notesTitle||"Study Notes");
  d.notesHtml=safeNoteHtml(d.notesHtml||plainToHtml(String(d.notes||"")));
  d.notes=stripHtml(d.notesHtml);
  d.notesUpdatedAt=d.notesUpdatedAt||"";
  d.createdAt=d.createdAt||now();d.updatedAt=d.updatedAt||now();
  return d;
}
function plainToHtml(text){return normalize(text).split(/\n\n+/).map(p=>`<p>${esc(p).replace(/\n/g,"<br>")}</p>`).join("")||"<p></p>";}
function stripHtml(html){const box=document.createElement("div");box.innerHTML=html||"";return normalize(box.innerText||box.textContent||"");}
function safeNoteHtml(html){const box=document.createElement('div');box.innerHTML=String(html||'');const allowed=new Set(['P','DIV','BR','STRONG','B','EM','I','U','H2','H3','UL','OL','LI','BLOCKQUOTE','IMG','A','SPAN']);box.querySelectorAll('*').forEach(el=>{if(!allowed.has(el.tagName)){el.replaceWith(...el.childNodes);return;}[...el.attributes].forEach(a=>{const n=a.name.toLowerCase(),v=a.value||'';if(n.startsWith('on'))el.removeAttribute(a.name);else if(el.tagName==='IMG'&&n==='src'&&!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(v))el.removeAttribute(a.name);else if(el.tagName==='A'&&n==='href'&&!/^(https?:|mailto:)/i.test(v))el.removeAttribute(a.name);else if(!['src','alt','href','target','rel'].includes(n))el.removeAttribute(a.name);});});return box.innerHTML||'<p></p>';}

function buildReviewerText(doc){const r=doc.reviewerData||buildReviewer(doc);return [`STUDY REVIEWER\n${doc.fileName}`,`AT A GLANCE\n${r.overview}`,`STUDY STRATEGY\n${r.strategy}`,`KEY TERMS\n${(doc.terms||[]).map((t,i)=>`${i+1}. ${t}`).join('\n')}`,`DEFINITIONS & EXPLANATIONS\n${r.definitions.map(d=>`${d.term}: ${d.definition}${d.page?` (Page ${d.page})`:''}`).join('\n\n')||'No clean definitions detected.'}`,`KEY POINTS\n${r.keyPoints.map((k,i)=>`${i+1}. ${k.text}${k.page?` (Page ${k.page})`:''}`).join('\n\n')}`,`MEMORY CUES\n${(r.memory||[]).map((m,i)=>`${i+1}. ${m.term}: ${m.clue}`).join('\n')}`,`EXAM CHECKLIST\n${(r.checklist||[]).map((x,i)=>`${i+1}. ${x}`).join('\n')}`,`STUDY QUESTIONS\n${r.questions.map((q,i)=>`${i+1}. ${typeof q==='string'?q:q.q}`).join('\n')}`,`PAGE HIGHLIGHTS\n${r.pages.map(p=>`Page ${p.page}: ${p.text}`).join('\n\n')}`,`VISUAL MATERIAL\n${(doc.media||[]).map((m,i)=>`Photo ${i+1}: ${m.name}${m.caption?` — ${m.caption}`:''}${m.ocrText?`\nOCR: ${m.ocrText.slice(0,700)}`:''}`).join('\n\n')||'No photos.'}`].join('\n\n');}

function regenerateDoc(doc,resetProgress=false){
  doc.terms=extractTerms(doc.rawText);doc.reviewerData=buildReviewer(doc);doc.reviewerText=buildReviewerText(doc);doc.flashcards=makeFlashcards(doc);doc.quiz=makeQuiz(doc);doc.currentCard=0;
  if(resetProgress){doc.knownCardIds=[];doc.quizScore=null;}
}

function renderLibrary(){
  const box=$("#library");
  if(!state.documents.length)return box.innerHTML='<div class="empty">Your PDFs will appear here.</div>';
  box.innerHTML=state.documents.map(d=>`<div class="doc ${d.id===state.activeDocId?'active':''}"><div class="doc-icon">📘</div><div class="doc-main"><div class="doc-name">${esc(d.fileName)}</div><div class="doc-meta">${d.pageCount} pages • ${wordCount(d.rawText).toLocaleString()} words • ${d.terms.length} terms</div></div><div class="doc-actions"><button class="btn small secondary" data-open="${esc(d.id)}">Open</button><button class="btn small danger" data-delete="${esc(d.id)}">Delete</button></div></div>`).join('');
  box.querySelectorAll('[data-open]').forEach(b=>b.onclick=async()=>{state.activeDocId=b.dataset.open;await saveMeta();renderAll();activateSection('dashboard');});
  box.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const d=state.documents.find(x=>x.id===b.dataset.delete);if(!d)return;if(!confirm(`Delete ${d.fileName}?`))return;await dbDelete(DOC_STORE,d.id);state.documents=state.documents.filter(x=>x.id!==d.id);state.activeDocId=state.documents[0]?.id||null;await saveMeta();renderAll();toast('Document deleted.','success');});
}
function renderStats(){const docs=state.documents;$("#stats").classList.toggle('hidden',!docs.length);$("#statDocs").textContent=docs.length;$("#statPages").textContent=docs.reduce((a,d)=>a+(d.pageCount||0),0).toLocaleString();$("#statPhotos").textContent=docs.reduce((a,d)=>a+(d.media?.length||0),0).toLocaleString();$("#statWords").textContent=docs.reduce((a,d)=>a+wordCount(d.rawText||''),0).toLocaleString();$("#statTerms").textContent=activeDoc()?.terms.length||0;$("#statFlash").textContent=activeDoc()?.flashcards.length||0;$("#statQuiz").textContent=activeDoc()?.quiz.length||0;$("#navFlash").textContent=activeDoc()?.flashcards.length||0;$("#navQuiz").textContent=activeDoc()?.quiz.length||0;}
function renderActivePanel(){const d=activeDoc(),box=$("#activeDocPanel");if(!d){box.innerHTML='<div class="empty">Add a PDF or photo to start studying.</div>';return;}const known=d.knownCardIds.length,total=d.flashcards.length,progress=total?Math.round(known/total*100):0;box.innerHTML=`<div class="doc" style="margin-bottom:12px"><div class="doc-icon">${d.sourceType==='image'?'🖼':'📘'}</div><div class="doc-main"><div class="doc-name">${esc(d.fileName)}</div><div class="doc-meta">${d.sourceType==='image'?'Photo study':'PDF'} • ${d.pageCount||1} page${(d.pageCount||1)===1?'':'s'} • ${d.media?.length||0} photo(s) • ${wordCount(d.rawText||'').toLocaleString()} words</div></div></div><div class="source-pill">${d.sourceType==='image'?'OCR + Visual':'PDF text + page structure'}</div><p class="muted" style="line-height:1.65;margin-top:12px">${esc(d.reviewerData?.overview||'')}</p><div style="margin-top:14px"><div style="display:flex;justify-content:space-between;gap:10px;font-size:.75rem;color:var(--muted)"><span>Flashcard progress</span><span>${known}/${total} (${progress}%)</span></div><div class="progress-track" style="margin-top:6px"><div class="progress-bar" style="width:${progress}%"></div></div></div><div class="row" style="margin-top:14px"><button class="btn primary small" data-go="reviewer">Reviewer</button><button class="btn secondary small" data-go="flashcards">Flashcards</button><button class="btn secondary small" data-go="quiz">Quiz</button><button id="regenDocBtn" class="btn warning small">Regenerate</button></div>`;box.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>activateSection(b.dataset.go));$("#regenDocBtn").onclick=async()=>{regenerateDoc(d,true);await saveDoc(d);renderAll();toast('Reviewer, flashcards, and quiz regenerated.','success');};}
function renderTerms(){const c=$("#reviewerTerms"),terms=activeDoc()?.terms||[];c.innerHTML=terms.length?terms.map(t=>`<span class="term">${esc(t)}</span>`).join(''):'<div class="empty">No terms detected.</div>';}
function renderReviewer(){
  const d=activeDoc(),r=d?.reviewerData;$("#reviewerOverview").textContent=r?.overview||'Select a study material.';$("#reviewerStrategy").textContent=r?.strategy||'Add a PDF or photo to create a study strategy.';renderTerms();
  const defs=$("#reviewerDefinitions");defs.innerHTML=r?.definitions?.length?r.definitions.map(x=>`<div class="definition-card"><strong>${esc(x.term)}</strong><span>${esc(x.definition)}${x.page?` <span class="tiny">Page ${x.page}</span>`:''}</span></div>`).join(''):'<div class="empty">No clean definition sentence was detected. The reviewer still uses key points, memory cues, questions, and visual material.</div>';
  const points=$("#reviewerKeyPoints");points.innerHTML=r?.keyPoints?.length?r.keyPoints.map(x=>`<li>${esc(x.text)}${x.page?`<span class="meta">Page ${x.page}</span>`:''}</li>`).join(''):'<li class="empty">No key points yet.</li>';
  const qs=$("#reviewerQuestions");qs.innerHTML=r?.questions?.length?r.questions.map(q=>`<div class="study-question">${esc(typeof q==='string'?q:q.q)}${q?.page?` <span class="source-chip">Page ${q.page}</span>`:''}</div>`).join(''):'<div class="empty">No study questions yet.</div>';
  const pages=$("#reviewerPages");pages.innerHTML=r?.pages?.length?r.pages.map(p=>`<li><strong>Page ${p.page}</strong><div style="margin-top:5px">${esc(p.text)}</div></li>`).join(''):'<li class="empty">No page highlights.</li>';
  const mem=$("#reviewerMemory");mem.innerHTML=r?.memory?.length?r.memory.map(m=>`<div class="memory-item"><strong>${esc(m.term)}</strong><span>${esc(m.clue)}</span></div>`).join(''):'<div class="empty">No memory cues yet.</div>';
  const checklist=$("#reviewerChecklist");checklist.innerHTML=r?.checklist?.length?r.checklist.map(x=>`<li>${esc(x)}</li>`).join(''):'<li class="empty">No checklist yet.</li>';
  const photos=$("#reviewerPhotos"),media=d?.media||[];photos.innerHTML=media.length?media.map(m=>`<div class="photo-card"><img src="${m.dataUrl}" alt="${esc(m.name)}"><div class="photo-body"><div class="photo-name">${esc(m.name)}</div><div class="photo-meta">${m.confidence?`OCR confidence ${Math.round(m.confidence)}%`:'OCR text not available'}</div><div class="ocr-badge ${m.ocrText?'':'warn'}">${m.ocrText?'✓ OCR text available':'⚠ Add a caption'}</div><input class="photo-caption" data-caption="${esc(m.id)}" value="${esc(m.caption||'')}" maxlength="300" placeholder="What should you remember from this photo?"><div class="photo-actions"><button class="btn small secondary" data-insert-note="${esc(m.id)}">Insert in notes</button><button class="btn small danger" data-remove-photo="${esc(m.id)}">Remove</button></div></div></div>`).join(''):'<div class="photo-empty">No photos attached. Use Add Photos from Dashboard or add an image directly to Notes.</div>';
  photos.querySelectorAll('[data-caption]').forEach(input=>input.addEventListener('change',async()=>{const m=d.media.find(x=>x.id===input.dataset.caption);if(!m)return;m.caption=input.value.trim();regenerateDoc(d,false);await saveDoc(d);renderAll();toast('Photo caption saved and study material regenerated.','success');}));
  photos.querySelectorAll('[data-remove-photo]').forEach(b=>b.onclick=async()=>{const m=d.media.find(x=>x.id===b.dataset.removePhoto);if(!m)return;if(!confirm(`Remove ${m.name}?`))return;d.media=d.media.filter(x=>x.id!==m.id);d.pageTexts=d.pageTexts.filter(p=>p.photoId!==m.id);d.units=d.units.filter(u=>u.photoId!==m.id);regenerateDoc(d,true);await saveDoc(d);renderAll();toast('Photo removed.','success');});
  photos.querySelectorAll('[data-insert-note]').forEach(b=>b.onclick=()=>{const m=d.media.find(x=>x.id===b.dataset.insertNote);if(!m)return;activateSection('notes');setTimeout(()=>insertAtCursor(`<p><img src="${m.dataUrl}" alt="${esc(m.name)}"><br><strong>${esc(m.name)}</strong></p>`),60);});
}
function renderFlash(){
  const d=activeDoc();
  if(!d||!d.flashcards.length){$("#flashPosition").textContent='Select a document.';$("#flashQuestion").textContent='Your flashcards will appear here.';$("#flashAnswer").classList.add('hidden');$("#flashStatus").textContent='NOT STARTED';$("#flashKnown").textContent='Unmarked';return;}
  d.currentCard=clamp(d.currentCard||0,0,d.flashcards.length-1);
  const c=d.flashcards[d.currentCard],known=d.knownCardIds.includes(c.id);
  $("#flashPosition").textContent=`Card ${d.currentCard+1} of ${d.flashcards.length}${c.page?` • Page ${c.page}`:''}`;
  $("#flashStatus").textContent=`${String(c.type).toUpperCase()} • CARD ${d.currentCard+1}`;
  $("#flashKnown").textContent=known?'✓ Known':'Unmarked';
  $("#flashQuestion").textContent=c.question;$("#flashAnswer").textContent=c.answer;$("#flashAnswer").classList.add('hidden');$("#knowFlash").disabled=known;
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
function renderAll(){renderDashboard();renderReviewer();renderFlash();renderQuiz();renderNotes();applyTheme();}

function escapeRegExp(text){return String(text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function highlight(text,q){const safe=esc(text);if(!q)return safe;const e=escapeRegExp(q);return safe.replace(new RegExp(`(${e})`,'gi'),'<mark>$1</mark>');}
function searchActive(q){
  const d=activeDoc(),box=$("#searchResults");if(!d)return box.innerHTML='<div class="empty">Select a study material first.</div>';q=q.trim();if(!q)return box.innerHTML='<div class="empty">Type a search term.</div>';
  const low=q.toLowerCase(),matches=[];for(const p of (d.pageTexts||[])){const t=p.text||'',l=t.toLowerCase();let idx=l.indexOf(low);while(idx>=0&&matches.length<80){const start=Math.max(0,idx-120),end=Math.min(t.length,idx+q.length+200);matches.push({label:p.photoId?'Photo':'Page '+p.page,snippet:t.slice(start,end),before:start?'…':'',after:end<t.length?'…':''});idx=l.indexOf(low,idx+Math.max(1,q.length));}}
  for(const m of (d.media||[])){const text=`${m.name} ${m.caption||''} ${m.ocrText||''}`,l=text.toLowerCase();let idx=l.indexOf(low);while(idx>=0&&matches.length<80){const start=Math.max(0,idx-100),end=Math.min(text.length,idx+q.length+180);matches.push({label:`Photo: ${m.name}`,snippet:text.slice(start,end),before:start?'…':'',after:end<text.length?'…':''});idx=l.indexOf(low,idx+Math.max(1,q.length));}}
  if(!matches.length)return box.innerHTML='<div class="empty">No match found.</div>';box.innerHTML=matches.map(m=>`<div class="result"><span class="page">${esc(m.label)}</span><div>${m.before}${highlight(m.snippet,q)}${m.after}</div></div>`).join('');
}
async function insertImageFilesIntoNotes(files){for(const file of [...files].filter(f=>f.type.startsWith('image/'))){try{const visual=await dataUrlFromFile(file,1600,.84);insertAtCursor(`<p><img src="${visual.dataUrl}" alt="${esc(file.name)}"><br><em>${esc(file.name)}</em></p>`);}catch(e){toast(`${file.name}: ${e.message||'Could not add image.'}`,'error');}}}

function selectNoteCommand(cmd,value){
  const editor=$("#notesEditor");editor.focus();
  if(cmd==="formatBlock")document.execCommand(cmd,false,`<${value}>`);else document.execCommand(cmd,false,null);
  scheduleNoteSave();
}
function insertAtCursor(html){
  const editor=$("#notesEditor");editor.focus();
  document.execCommand('insertHTML',false,html);scheduleNoteSave();
}
function scheduleNoteSave(){
  const d=activeDoc();if(!d)return;
  const token=++noteSaveToken;$("#noteSaveStatus").textContent='Saving…';
  setTimeout(async()=>{
    if(token!==noteSaveToken)return;
    const doc=state.documents.find(x=>x.id===d.id);if(!doc)return;
    doc.notesTitle=$("#notesTitle").value.trim()||'Study Notes';
    doc.notesHtml=safeNoteHtml($("#notesEditor").innerHTML||'<p></p>');
    doc.notes=stripHtml(doc.notesHtml);doc.notesUpdatedAt=now();await saveDoc(doc);
    if(activeDoc()?.id===doc.id){$("#noteSaveStatus").textContent='Saved';$("#noteWordCount").textContent=`${wordCount(doc.notes)} words`;$("#noteUpdatedAt").textContent=`Saved ${new Date(doc.notesUpdatedAt).toLocaleTimeString()}`;}
  },500);
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
  let score=0;
  d.quiz.forEach((q,i)=>{const item=document.querySelector(`[data-q="${i}"]`),picked=document.querySelector(`input[name="q-${i}"]:checked`);if(!item)return;item.classList.remove('correct','wrong');if(picked&&Number(picked.value)===q.correctIndex){score++;item.classList.add('correct')}else item.classList.add('wrong');});
  d.quizScore=score;d.quizHistory=d.quizHistory||[];const percent=d.quiz.length?Math.round(score/d.quiz.length*100):0;d.quizHistory.push({at:now(),score,total:d.quiz.length,percent});await saveDoc(d);
  $("#quizResult").classList.remove('hidden');$("#quizResult").innerHTML=`<div class="score">${percent}%</div><p>You scored <strong>${score}/${d.quiz.length}</strong>.</p><p class="muted">Use the page numbers on missed questions to review the exact material before trying a new quiz.</p>`;renderQuizHistory(d);toast(`Quiz completed: ${score}/${d.quiz.length}.`,'success');
}
async function newQuiz(){const d=activeDoc();if(!d)return toast('Select a document first.','error');d.quiz=makeQuiz(d);d.quizScore=null;await saveDoc(d);renderQuiz();renderStats();toast('New quiz generated.','success');}
async function moveFlash(delta){const d=activeDoc();if(!d?.flashcards.length)return;d.currentCard=(d.currentCard+delta+d.flashcards.length)%d.flashcards.length;await saveDoc(d);renderFlash();renderDashboard();}
async function markKnown(known){const d=activeDoc();if(!d?.flashcards.length)return;const id=d.flashcards[d.currentCard].id;if(known&&!d.knownCardIds.includes(id))d.knownCardIds.push(id);if(!known)d.knownCardIds=d.knownCardIds.filter(x=>x!==id);await saveDoc(d);renderFlash();renderDashboard();}

function applyTheme(){document.body.classList.toggle('light',state.settings.theme==='light');}
async function setTheme(theme){state.settings.theme=theme==='light'?'light':'dark';await saveMeta();applyTheme();toast(`${state.settings.theme==='light'?'Light':'Dark'} mode enabled.`,'success');}

function exportBackup(){
  const payload={app:'StudyVault',version:APP_VERSION,exportedAt:now(),settings:{theme:state.settings.theme},documents:state.documents};
  downloadText(`studyvault-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(payload,null,2));toast('Backup exported.','success');
}
async function importBackup(){
  const file=$("#backupInput").files[0];if(!file)return toast('Choose a JSON backup first.','error');
  try{
    const data=JSON.parse(await file.text());if(data.app!=='StudyVault')throw new Error('Invalid StudyVault backup.');
    const incoming=Array.isArray(data.documents)?data.documents:(data.data?.fileName?[data.data]:null);if(!incoming)throw new Error('No StudyVault documents found in this backup.');
    for(const raw of incoming){const d=normalizeDoc(raw);await dbPut(DOC_STORE,d);}
    state.documents=(await dbGetAll(DOC_STORE)).map(normalizeDoc);state.activeDocId=state.documents[0]?.id||null;state.settings.theme=data.settings?.theme==='light'?'light':'dark';await saveMeta();$("#importModal").classList.remove('open');$("#backupInput").value='';renderAll();toast('Backup imported.','success');
  }catch(e){console.error(e);toast(e.message||'Import failed.','error');}
}
async function resetAll(){if(!confirm('Delete ALL StudyVault data from this browser? This removes every document, note, quiz history, and PIN.'))return;await dbClear();location.reload();}

function baseDoc(file,sourceType,extracted,media=[]){const doc={id:uid(),fileName:file.name,sourceType,pageCount:extracted.pageCount||0,pageTexts:extracted.pageTexts||[],units:extracted.units||[],rawText:extracted.rawText||'',terms:extractTerms(extracted.rawText||''),reviewerData:null,reviewerText:'',flashcards:[],currentCard:0,knownCardIds:[],notesTitle:'Study Notes',notesHtml:'<p></p>',notes:'',notesUpdatedAt:'',quiz:[],quizScore:null,quizHistory:[],media,createdAt:now(),updatedAt:now()};doc.reviewerData=buildReviewer(doc);doc.reviewerText=buildReviewerText(doc);doc.flashcards=makeFlashcards(doc);doc.quiz=makeQuiz(doc);return doc;}
async function processPdfFiles(files){for(const file of [...files]){if(file.type!=='application/pdf'){toast(`${file.name}: not a PDF.`,'error');continue;}$("#upload").innerHTML=`<div class="loading"><span class="spinner"></span><span id="processStatus">Reading ${esc(file.name)}…</span></div>`;try{const extracted=await extractPdf(file,(page,total)=>{$("#processStatus").textContent=`Reading ${file.name} — page ${page} of ${total}…`;});if(wordCount(extracted.rawText)<20)throw new Error('This PDF has little or no selectable text. Use Add Photos/OCR for scanned pages.');const doc=baseDoc(file,'pdf',extracted,[]);state.documents.unshift(doc);state.activeDocId=doc.id;await dbPut(DOC_STORE,doc);await saveMeta();renderAll();toast(`${file.name} added and reviewer generated.`,'success');}catch(e){console.error(e);toast(`${file.name}: ${e.message||'Could not process PDF.'}`,'error');}}}
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
  $("#openReviewer").onclick=()=>activateSection('reviewer');
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
    if(meta){state.settings={...state.settings,...meta};state.activeDocId=meta.activeDocId||null;}
    state.documents=(await dbGetAll(DOC_STORE)).map(normalizeDoc);
    for(const d of state.documents)await dbPut(DOC_STORE,d);
    if(!state.activeDocId)state.activeDocId=state.documents[0]?.id||null;
    await saveMeta();renderAll();setupDrop();setupInstall();
    if(state.settings.pinHash)lockApp();
  }catch(e){console.error(e);toast('StudyVault could not initialize IndexedDB.','error');}
}

bind();
setEngineStatus("idle — loads when a PDF is added");
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(err=>console.warn('Service worker registration failed:',err)));
load();
})();
