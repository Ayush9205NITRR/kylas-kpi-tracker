/* ── picklists ───────────────────────────── */
/* STAGES, STAGE_ID, STAGE_RUNG, STAGE_PRIORITY, LABEL, CNC_LADDER, EXIT_STAGES,
   MEETING_STAGES and UNTOUCHED all come from stages.js, generated from
   docs/stages.json. Do not redeclare them here. */
const SALUTATION=["","MR","MRS","MISS"];
const EMAIL_TYPES=["OFFICE","PERSONAL","OTHER"];
const PHONE_TYPES=["MOBILE","WORK","HOME","OTHER"];
/* The three counted metrics, in ladder order. Company-level reporting reads
   these off pipeline_stage_bd — they are not shown in the console chrome. */
/* The three counted metrics, in ladder order and cumulative — an SQL contact
   also counts in Discovery and Right POC, so the funnel reads straight down.
   Right POC and Discovery come from the event data, not the stage: see
   docs/kpi-spec.md §5. SQL is the only one the stage decides. */
const METRICS=[
  {label:"RIGHT POC", test:a=>hasSignal(a)},
  {label:"DISCOVERY", test:a=>isComplete(a)},
  {label:"SQL",       test:a=>a.stage==="SQL_SALES_QUALIFIED_LEAD"},
];
/* Replaced at runtime by whatever this Kylas account actually defines. */
let SOURCES=["","GOOGLE","FACEBOOK","LINKEDIN","EXHIBITION","COLD_CALLING"];
let OFFSITE_TIMELINE=["","JAN_MAR","APR_JUN","JUL_SEP","OCT_DEC"];
let OWNERS=[""];
function addOwners(names){
  for(const n of names){ if(n&&!OWNERS.includes(n))OWNERS.push(n); }
  OWNERS=[OWNERS[0],...OWNERS.slice(1).sort((a,b)=>a.localeCompare(b))];
}
function adoptPicklists(picklists){
  if(!picklists)return;
  const take=(...names)=>{
    for(const n of names){const v=picklists[n];if(v&&v.length)return ["",...v.map(o=>o.code)];}
    return null;
  };
  const src=take("cfSourceOfData","sourceOfData","source"); if(src)SOURCES=src;
  const off=take("cfOffsiteTimeline","offsiteTimeline");    if(off)OFFSITE_TIMELINE=off;
  for(const list of Object.values(picklists))
    for(const o of list) if(o.code&&o.label&&!LABEL[o.code])LABEL[o.code]=o.label;
}
const label=v=>LABEL[v]||v;
const priority=a=>STAGE_PRIORITY[a.stage]??99;
const rung=a=>STAGE_RUNG[a.stage]||0;
const rungLabel=r=>label(STAGES.find(c=>STAGE_RUNG[c]===r))||"Not reached";
const NOT_CONNECTED=[...UNTOUCHED,...CNC_LADDER];
const EVENT_TYPES=["","Employee offsites","Product launch","Sales conference / dealer meet","Marketing events","Team-building activities","Other engagements"];
const VENDOR_INFO=["","Internal","Vendor Exists","First Event","No Info"];
const MODE_OF_MEETING=["","In Person","Virtual","Calls","Text"];

/* No answer escalates rather than repeating: Kylas models the repeat attempts
   as distinct stages, so the key walks them. */
const OUTCOMES=[
  {k:"1",t:"No answer",   stage:a=>CNC_LADDER[Math.min(CNC_LADDER.indexOf(a.stage)+1,CNC_LADDER.length-1)]||CNC_LADDER[0]},
  {k:"2",t:"Right POC",   stage:"MQL_MARKETING_QUALIFIED_LEAD"},
  {k:"3",t:"Discovery",   stage:"DISCOVERY_CALL_BOOKED"},
  {k:"4",t:"SQL",         stage:"SQL_SALES_QUALIFIED_LEAD"}
];
const outcomeStage=(o,a)=>typeof o.stage==="function"?o.stage(a):o.stage;
const QUICK={
  budget:["Approx","₹L","₹Cr","Not approved","Signed off","No budget yet","Last year was"],
  timeline:["Q2 FY27","Q3 FY27","Q4 FY27","Q1 FY28","Not decided","Month:","Tentative"],
  pax:["Approx","+ internal","incl. contractors","Only leadership","Whole company"]
};

/* ── data ────────────────────────────────── */
/* Every event row carries a key from the moment it is created. It is what
   Airtable upserts on, so without it an edited row would be written as a second
   row and keep counting toward Right POC twice. */
const rowKey=()=>(crypto?.randomUUID?crypto.randomUUID():"r"+Date.now()+Math.random().toString(36).slice(2,8));
const emptyRow=()=>({rowKey:rowKey(),eventType:"",budget:"",timeline:"",pax:"",remarks:""});
const blank=()=>({kid:"",salutation:"",pocName:"",company:"",linkedin:"",designation:"",
  emails:[{type:"OFFICE",value:"",primary:true}],
  phones:[{type:"MOBILE",cc:"+91",value:"",primary:true}],
  stage:"YET_TO_BE_MINED",nextCallDate:"",nextCallTime:"",
  source:"",remarks:"",offsiteTimeline:"",owner:"",
  past:[],current:[],vendorInfo:"",serviceOffering:false,modeOfMeeting:"",
  done:false,flagged:false});

let DATA=[
{kid:"40912",salutation:"MR",pocName:"Priyank Tewari",company:"nutritap",linkedin:"",designation:"",
 emails:[{type:"OFFICE",value:"priyank.tewari@nutritap.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9873915513",primary:true}],
 stage:"YET_TO_BE_MINED",nextCallDate:"",nextCallTime:"",
 source:"COLD_CALLING",remarks:"",offsiteTimeline:"",owner:"Shreya Bodwal",
 past:[],current:[],vendorInfo:"",serviceOffering:false,modeOfMeeting:"",done:false,flagged:false},

{kid:"40988",salutation:"MISS",pocName:"Shipra Gupta",company:"nutritap",
 linkedin:"linkedin.com/in/shipra-gupta",designation:"Marketing Lead",
 emails:[{type:"OFFICE",value:"shipra@nutritap.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9560313450",primary:true}],
 stage:"DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS",nextCallDate:"",nextCallTime:"",source:"COLD_CALLING",
 remarks:"Runs the dealer meet budget.",offsiteTimeline:"JUL_SEP",owner:"Shreya Bodwal",
 past:[],current:[{eventType:"Marketing events",budget:"6-8L",timeline:"Q3 FY27",
   pax:"80 partners",remarks:"Regional roadshow, three cities."}],
 vendorInfo:"Vendor Exists",serviceOffering:true,modeOfMeeting:"",done:false,flagged:false},

{kid:"41155",salutation:"MR",pocName:"Arjun Sethi",company:"Kritsnam Analytics",
 linkedin:"linkedin.com/in/arjun-sethi-cos",designation:"Chief of Staff",
 emails:[{type:"OFFICE",value:"arjun@kritsnam.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9100044582",primary:true}],
 stage:"MQL_MARKETING_QUALIFIED_LEAD",nextCallDate:"2026-09-18",nextCallTime:"16:00",
 source:"LINKEDIN",remarks:"Call back after their board meet.",
 offsiteTimeline:"OCT_DEC",owner:"Ayush Tiwari",past:[],
 current:[{eventType:"Employee offsites",budget:"Approx 8L, not approved",
  timeline:"Q4 FY27, January if budget clears",pax:"60-70 incl. contractors",
  remarks:"First ever company offsite. Founder wants it near Hyderabad."}],
 vendorInfo:"First Event",serviceOffering:true,modeOfMeeting:"Virtual",done:false,flagged:true},

{kid:"38470",salutation:"MISS",pocName:"Devanshi Kalro",company:"Shorehouse Retail",
 linkedin:"linkedin.com/in/devanshikalro",designation:"AVP Marketing",
 emails:[{type:"OFFICE",value:"d.kalro@shorehouse.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9920477103",primary:true}],
 stage:"SQL_SALES_QUALIFIED_LEAD",nextCallDate:"2026-09-24",nextCallTime:"11:30",
 source:"COLD_CALLING",remarks:"Reopened after last year's loss. Warm.",
 offsiteTimeline:"JUL_SEP",owner:"Shreya Bodwal",
 past:[{eventType:"Sales conference / dealer meet",budget:"Approx 40L, signed off by CFO",
  timeline:"Q1 FY27, first week of April",pax:"300 dealers + 40 internal",
  remarks:"Annual dealer meet in Jaipur. Ran over budget on AV."}],
 current:[{eventType:"Product launch",budget:"15-20L, not approved",
  timeline:"Q3 FY27, mid-November",pax:"120 press and partners",
  remarks:"AW line launch. Needs a press-friendly venue in south Bombay."}],
 vendorInfo:"Internal",serviceOffering:true,modeOfMeeting:"In Person",done:true,flagged:false},

{kid:"39901",salutation:"MR",pocName:"Ishaan Grover",company:"Pralay Fintech",
 linkedin:"",designation:"Senior Manager, HR",
 emails:[{type:"OFFICE",value:"ishaan.g@pralay.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9811062234",primary:true}],
 stage:"FOLLOW_UP_2",nextCallDate:"",nextCallTime:"",source:"LINKEDIN",
 remarks:"Offsites decided by the CHRO, will share the name.",
 offsiteTimeline:"",owner:"Ayush Tiwari",past:[],current:[],
 vendorInfo:"No Info",serviceOffering:false,modeOfMeeting:"",done:true,flagged:false},

{kid:"42308",salutation:"MISS",pocName:"Meera Raghunathan",company:"Anvaya Labs",
 linkedin:"linkedin.com/in/meera-raghunathan",designation:"Founder's Office",
 emails:[{type:"OFFICE",value:"meera@anvayalabs.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"8806019945",primary:true}],
 stage:"FOLLOW_UP_1",nextCallDate:"",nextCallTime:"",source:"LINKEDIN",
 remarks:"",offsiteTimeline:"",owner:"Shreya Bodwal",past:[],current:[],
 vendorInfo:"",serviceOffering:false,modeOfMeeting:"",done:false,flagged:false},

{kid:"37622",salutation:"MR",pocName:"Balaji Venkatesh",company:"Tatvik Logistics",
 linkedin:"",designation:"GM Admin",
 emails:[{type:"OFFICE",value:"balaji.v@tatvik.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9444030871",primary:true}],
 stage:"CNC_COULD_NOT_CONNECT",nextCallDate:"2026-09-17",nextCallTime:"10:00",
 source:"LINKEDIN",remarks:"",offsiteTimeline:"",owner:"Ayush Tiwari",past:[],current:[],
 vendorInfo:"",serviceOffering:false,modeOfMeeting:"",done:false,flagged:false},

{kid:"43017",salutation:"MISS",pocName:"Simran Kohli",company:"Meghdoot Cloud",
 linkedin:"",designation:"People Partner",
 emails:[{type:"OFFICE",value:"simran.k@meghdoot.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9871855420",primary:true}],
 stage:"YET_TO_BE_MINED",nextCallDate:"",nextCallTime:"",source:"LINKEDIN",
 remarks:"",offsiteTimeline:"",owner:"",past:[],current:[],
 vendorInfo:"",serviceOffering:false,modeOfMeeting:"",done:false,flagged:false}
];

let cur=0, isNew=false, filter="todo", target=100, tried=false;
let scope=null;      /* {id,name} when opened from a Kylas company page */
let mode="company";  /* company: follow the Kylas page · session: one flat queue */
let ME="";           /* the associate using the console; learned, then remembered */
let timer=null, secs=0, ringing=false;
let tmode="idle";     /* idle | dial | est */
let lastOutcome=null;
let collapsed={past:false,current:false};
/* Right POC the moment ANY of budget | timeline | pax is filled on ANY row,
   past or current. Until then the contact is only an MQL. Derived, never typed. */
const filled=v=>String(v||"").trim()!=="";
function hasSignal(a){
  return [...a.past,...a.current].some(r=>r.eventType&&(
    (r.budget||"").trim()||(r.timeline||"").trim()||(r.pax||"").trim()));
}
const qualOf=a=>hasSignal(a)?"Right POC":"MQL";
/* swap just the badge — re-rendering the call bar would steal focus mid-typing */
function refreshQual(){
  const a=rec(),q=qualOf(a),n=document.querySelector(".qual");
  if(!n)return;
  n.textContent=q;n.className="qual "+(q==="MQL"?"mql":"poc");
  renderQueue();
}
const rec=()=>{const a=DATA[cur];
  for(const r of [...(a.past||[]),...(a.current||[])]) if(!r.rowKey)r.rowKey=rowKey();if(a.pastAsked===undefined)a.pastAsked=a.past.length?"yes":"";if(a.currAsked===undefined)a.currAsked=a.current.length?"yes":"";if(a.pitched===undefined)a.pitched=a.serviceOffering?"yes":"";return a;};
const today=()=>new Date().toISOString().slice(0,10);
const dateIn=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.toISOString().slice(0,10);};
/* Associates paste "linkedin.com/in/x", "www.linkedin.com/in/x" or a full url.
   Accept all three, reject anything that is not a linkedin address. */
function liUrl(v){
  const t=String(v||"").trim();
  if(!t)return null;
  const u=/^https?:\/\//i.test(t)?t:"https://"+t.replace(/^\/+/,"");
  try{const p=new URL(u);return /(^|\.)linkedin\.com$/i.test(p.hostname)?p.href:null;}catch(e){return null;}
}

/* ── helpers ─────────────────────────────── */
const fmtD=d=>d?new Date(d+"T00:00:00").toLocaleDateString("en-IN",{day:"numeric",month:"short"}):"";
const el=(t,c,h)=>{const n=document.createElement(t);if(c)n.className=c;if(h!=null)n.innerHTML=h;return n;};
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
/* If the stored value is not one of the options, Kylas knows something this
   list does not — show it rather than rendering "Choose" over real data. */
const opts=(l,v)=>{
  const list=(v!==undefined&&v!==null&&v!==""&&!l.includes(v))?[...l,v]:l;
  return list.map(o=>`<option value="${esc(o)}"${o===v?" selected":""}>${o===""?"Choose":esc(label(o))}</option>`).join("");
};
let dirty=new Set();
const touch=f=>dirty.add(f);
let undoState=null;
function toast(m,undo){
  document.querySelectorAll(".toast").forEach(t=>t.remove());
  const t=el("div","toast",`<span>${esc(m)}</span>`);
  if(undo){const b=el("button",null,"Undo");b.type="button";b.onclick=()=>{undo();t.remove();};t.appendChild(b);}
  document.body.appendChild(t);setTimeout(()=>t.remove(),4000);
}
function resetScroll(){
  document.getElementById("scrollL").scrollTo({top:0});
  document.getElementById("scrollR").scrollTo({top:0});
}
function setTab(t){
  document.getElementById("split").dataset.tab=t;
  document.querySelectorAll(".tabbar button").forEach(b=>b.setAttribute("aria-selected",b.dataset.tab===t?"true":"false"));
}
function field(label,id,req,ctrl){
  const f=el("div","f");
  f.innerHTML=`<label for="${id}">${esc(label)}${req?' <span class="req">*</span>':""}</label>`;
  f.appendChild(ctrl);return f;
}
function input(id,val,ph,on,type){
  const i=el("input","in");i.id=id;i.type=type||"text";i.value=val||"";if(ph)i.placeholder=ph;
  i.oninput=e=>{on(e.target.value);validate();};return i;
}
function textarea(id,val,ph,on){
  const t=el("textarea","in");t.id=id;t.value=val||"";if(ph)t.placeholder=ph;
  t.oninput=e=>on(e.target.value);return t;
}
function select(id,list,val,on){
  const s=el("select","in");s.id=id;s.innerHTML=opts(list,val);
  s.onchange=e=>{on(e.target.value);validate();};return s;
}
/* long-text field with one-tap phrase inserts */
function quickField(label,id,val,ph,on,chips){
  const f=el("div","f");
  f.innerHTML=`<label for="${id}">${esc(label)}</label>`;
  const i=el("input","in");i.id=id;i.value=val||"";i.placeholder=ph;
  i.oninput=e=>on(e.target.value);
  f.appendChild(i);
  const w=el("div","qchips");
  chips.forEach(c=>{
    const b=el("button","qc",esc(c));b.type="button";b.tabIndex=-1;
    b.onclick=()=>{
      const v=i.value.trim();
      i.value=v?v+(/[,;]$/.test(v)?" ":", ")+c:c;
      on(i.value);i.focus();
      i.setSelectionRange(i.value.length,i.value.length);
    };
    w.appendChild(b);
  });
  f.appendChild(w);return f;
}

/* ── call bar ────────────────────────────── */
function renderCallbar(){
  const a=rec(),C=document.getElementById("callbar");C.innerHTML="";
  const ph=a.phones.find(p=>p.primary)||a.phones[0];
  const num=ph?(ph.cc+" "+ph.value).trim():"";

  const q=qualOf(a);
  const who=el("div","who",
    `<b>${esc(a.pocName||"New contact")}</b>
     <span class="sub"><i class="qual ${q==="MQL"?"mql":"poc"}">${esc(q)}</i>
     <span>${esc(a.company||"—")}${a.designation?" · "+esc(a.designation):""}</span></span>`);
  C.appendChild(who);

  const d=el("div","dial");
  const link=el("a",null,`<span class="ico">☎</span><span>${esc(num||"no number")}</span>`);
  link.href=num?"tel:"+num.replace(/\s/g,""):"#";
  link.setAttribute("aria-label",num?"Call "+a.pocName+" on "+num:"No number on file");
  link.onclick=e=>{
    if(!num){e.preventDefault();toast("No number on file for "+a.pocName);return;}
    /* the tel: href is what actually hands off to the dialler — this just makes
       it obvious that the request left the app */
    link.classList.add("calling");
    toast("Dialling "+num+" — request sent to the dialler");
    setTimeout(()=>link.classList.remove("calling"),2600);
  };
  d.appendChild(link);C.appendChild(d);

  renderAccount();
  const em=(a.emails.find(x=>x.primary)||a.emails[0]||{}).value;
  const meta=el("div","cbmeta");
  const bits=[];
  if(em)bits.push(`<span class="mail">${esc(em)}</span>`);
  if(a.nextCallDate)bits.push(`<span class="due">Call back ${esc(fmtD(a.nextCallDate))}${a.nextCallTime?" · "+esc(a.nextCallTime):""}</span>`);
  bits.push(`<span class="kid">${esc(a.kid||"unsaved")}</span>`);
  meta.innerHTML=bits.join("");
  C.appendChild(meta);
  const nb=el("div","nextbtn");
  const btn=el("button","pbtn",`Save &amp; next <kbd style="border-color:rgba(255,255,255,.35);background:transparent;color:inherit">⏎</kbd>`);
  btn.type="button";btn.onclick=saveNext;nb.appendChild(btn);
  C.appendChild(nb);
}
const fmtSecs=s=>String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
function startTimer(mode){
  if(timer)clearInterval(timer);
  secs=0;ringing=true;
  timer=setInterval(()=>{secs++;const t=document.getElementById("tm");if(t)t.textContent=fmtSecs(secs);},1000);
  const t=document.getElementById("tm");if(t)t.className="tm run";
}
function stopTimer(){if(timer)clearInterval(timer);timer=null;ringing=false;paintTimer();}
function paintTimer(){
  const t=document.getElementById("tm");
  if(!t)return;
  t.textContent=(tmode==="est"?"~":"")+fmtSecs(secs);
  t.className="tm"+(ringing?(tmode==="est"?" est":" run"):"");
  t.title=tmode==="est"
    ?"Estimated from when you logged the outcome — dial from the console for a real duration."
    :"Call duration";
}
function setOutcome(o){
  const a=rec();
  lastOutcome=o;
  const target=outcomeStage(o,a);
  /* Last quality date is the most recent STAGE CHANGE, not the most recent
     call — a repeat no-answer moves the call log but not the company. */
  if(a.stage!==target)a.lastStageChangeAt=new Date().toISOString();
  a.stage=target;
  if(EXIT_STAGES.includes(target))a.exitReason=target;
  if(!a.nextCallDate&&CNC_LADDER.includes(target))a.nextCallDate=dateIn(1);
  /* Dialled from the console: that timer is the truth, so freeze it. Otherwise
     start estimating from here rather than logging a zero-second call. */
  if(tmode==="dial"&&ringing)stopTimer();
  else if(tmode!=="est")startTimer("est");
  render();
  resetScroll();
  if(!CNC_LADDER.includes(target)&&matchMedia("(max-width:900px)").matches)setTab("more");
}

/* ── queue ───────────────────────────────── */
const FILTERS=[["todo","To call"],["flag","Flagged"],["all","All"]];
function renderFilters(){
  const w=document.getElementById("qfil");w.innerHTML="";
  FILTERS.forEach(([k,l])=>{
    const b=el("button","qf",l);b.type="button";
    b.setAttribute("aria-pressed",filter===k?"true":"false");
    b.onclick=()=>{filter=k;renderFilters();renderQueue();};
    w.appendChild(b);
  });
}
/* A dated promise beats everything; then Ayush's stage order; then longest
   untouched. STAGE_PRIORITY is the funnel read backwards — see stages.js. */
function sessionRank(a){
  const due=a.nextCallDate&&a.nextCallDate<=today();
  return [due?0:1, due?a.nextCallDate:"", priority(a), a.lastCallAt||""];
}
function bySession(x,y){
  const A=sessionRank(x.a),B=sessionRank(y.a);
  for(let i=0;i<A.length;i++){
    if(A[i]===B[i])continue;
    return typeof A[i]==="number"?A[i]-B[i]:String(A[i]).localeCompare(String(B[i]));
  }
  return 0;
}
/* "Today" is a record of work done, not a queue of work outstanding: the calls
   actually made today, most recent first. */
const calledToday=a=>String(a.lastCallAt||"").slice(0,10)===today();
const byRecentCall=(x,y)=>String(y.a.lastCallAt||"").localeCompare(String(x.a.lastCallAt||""));

function visible(){
  const q=(document.getElementById("q").value||"").toLowerCase();
  const rows=DATA.map((a,i)=>({a,i}))
    .filter(({a})=>mode==="session"?calledToday(a):(!scope||String(a.companyId)===String(scope.id)))
    .filter(({a})=>!q||(a.pocName+" "+a.company+" "+a.phones.map(p=>p.value).join(" ")).toLowerCase().includes(q))
    /* Done/flagged narrowing is about what is left to do, so it has no meaning
       over a list of calls already made. */
    .filter(({a})=>mode==="session"||filter==="all"||(filter==="flag"?a.flagged:!a.done));
  return mode==="session"?rows.sort(byRecentCall):rows;
}
function renderQueue(){
  renderMode();renderScope();
  const L=document.getElementById("qlist");L.innerHTML="";
  const rows=visible();
  if(!rows.length){L.appendChild(el("li","qempty","Nothing here right now."));return;}
  rows.forEach(({a,i})=>{
    const li=el("li"),b=el("button");
    b.type="button";b.setAttribute("aria-current",i===cur?"true":"false");
    const q=qualOf(a);
    b.className="qi "+(q==="MQL"?"q-mql":"q-poc");
    /* Whether the record has reached Kylas yet, and whether a promise is due. */
    const sync=a.syncing?'<i class="pend sync" title="Saving to Kylas…">…</i>'
      :a.syncError?`<i class="pend err" title="${esc(a.syncError)}">queued</i>`
      :a.pendingCreate?'<i class="pend" title="Not in Kylas yet">new</i>':"";
    const due=mode==="session"&&a.nextCallDate&&a.nextCallDate<=today()
      ?'<span class="due">due</span>'
      :mode==="session"?`<span class="pri">#${priority(a)}</span>`:"";
    b.innerHTML=`<span class="n">${esc(a.pocName)}${sync}</span>
      <span class="c">${esc([a.company,a.designation].filter(Boolean).join(" · "))}</span>
      <span class="row">
        <span class="badge ${q==="MQL"?"mql":"poc"}">${esc(q)}</span>
        <span class="stage">${esc(label(a.stage))}</span>
        <span class="marks">
          <i class="li${a.linkedin?"":" off"}" title="${a.linkedin?"LinkedIn on file":"No LinkedIn"}">in</i>
          ${a.flagged?'<span class="fl" title="Flagged">⚑</span>':""}
          ${a.done?'<span class="ok" title="Logged today">✓</span>':""}
        </span>
        ${due}
      </span>`;
    b.onclick=()=>{cur=i;isNew=false;tried=false;stopTimer();secs=0;tmode="idle";render();resetScroll();};
    li.appendChild(b);L.appendChild(li);
  });
}
/* account-level rollup: how this company is doing across all its contacts */
function renderAccount(){
  const a=rec();
  /* Match on the Kylas company id, not the typed name — two spellings of one
     account would otherwise split its rollup in two. */
  const peers=a.companyId?companyRoster(a.companyId):[];
  const W=document.getElementById("acct");
  if(!W)return;
  /* Cumulative: each metric counts everyone at or above it. */
  const counts=METRICS.map((m,i)=>peers.filter(x=>METRICS.slice(i).some(n=>n.test(x))).length);
  W.innerHTML=`<span class="scope">${esc(a.company||"No company")}</span>
    <span class="tiles">${METRICS.map((m,i)=>
      `<span class="kpi${counts[i]?" hit":""}"><b>${counts[i]}</b>${esc(m.label)}</span>`).join("")}</span>
    <span class="of">${peers.length} contact${peers.length===1?"":"s"}</span>`;
}
function renderPace(){
  const logged=DATA.filter(a=>a.done);
  document.getElementById("pcount").textContent=logged.length;
  document.getElementById("ptarget").textContent="/ "+target;
  document.getElementById("pbar").style.width=Math.min(100,logged.length/target*100)+"%";
}

/* ── form ────────────────────────────────── */
const rowsOf=c=>[...(c.past||[]),...(c.current||[])];
function isComplete(a){
  return rowsOf(a).some(r=>filled(r.budget)&&filled(r.timeline)&&filled(r.pax));
}
function connected(a){return !!a.stage&&!NOT_CONNECTED.includes(a.stage);}
function companyRoster(id){return DATA.filter(a=>String(a.companyId)===String(id));}
/* The company sits at the best rung any of its POCs has reached. Highest ever,
   never current — a contact slipping back does not drag the company down. */
function companyStage(list){
  const r=list.reduce((m,a)=>Math.max(m,rung(a)),0);
  return {r,t:r?rungLabel(r):"Not reached"};
}


function renderMode(){
  const w=document.getElementById("qmode");
  if(!w)return;
  w.innerHTML="";
  const due=DATA.filter(a=>!a.done&&a.nextCallDate&&a.nextCallDate<=today()).length;
  [["company","Company",scope?companyRoster(scope.id).length:0],
   ["session","Today",DATA.filter(calledToday).length]].forEach(([k,lab,n])=>{
    const b=el("button","qm",`${lab}${n?` <i>${n}</i>`:""}`);
    b.type="button";
    b.setAttribute("aria-pressed",mode===k?"true":"false");
    b.disabled=(k==="company"&&!scope);
    b.title=k==="company"
      ?(scope?"Only the contacts at this company":"Open the console on a Kylas company page to use this")
      :"The calls you have made today"+(due?` · ${due} due now`:"");
    b.onclick=()=>{mode=k;const rows=visible();cur=rows.length?rows[0].i:cur;render();resetScroll();};
    w.appendChild(b);
  });
}
function renderScope(){
  const w=document.getElementById("qscope");
  if(!w)return;
  if(!scope||mode!=="company"){w.innerHTML="";w.hidden=true;return;}
  w.hidden=false;
  const n=companyRoster(scope.id).length;
  /* The id, always. It is what every join is on, and "which company is this"
     must be answerable even when the name could not be resolved. */
  w.innerHTML=`<span class="cn">${esc(scope.name)}</span><span class="cid">#${esc(scope.id)}</span>`
    +`<span class="cc">${n} contact${n===1?"":"s"}</span>`
    +(scope.offline?`<span class="cwarn" title="The proxy is not reachable, so this company's contacts were never fetched. Start it with: source .env.local &amp;&amp; node scripts/proxy.mjs">not loaded from Kylas</span>`:"");
  const x=el("button","cx","×");x.type="button";x.title="Leave this company and show today's calls";
  x.onclick=()=>{scope=null;mode="session";render();};
  w.appendChild(x);
}

function render(){
  renderCallbar();renderQueue();renderPace();renderBasic();renderRight();validate();
}

/* Every section is a card: header band, then body. Structure does the
   separating, so the palette stays at one accent. */
function group(title,nodes,sub){
  const c=el("section","card");
  c.appendChild(el("div","cardH",
    `<h2>${esc(title)}</h2>${sub?`<span class="sub">${esc(sub)}</span>`:""}`));
  const b=el("div","cardB grp");
  nodes.forEach(n=>b.appendChild(n));
  c.appendChild(b);
  return c;
}
function mini(list,val,on){
  const s=el("select","mini");s.innerHTML=opts(list,val);
  s.onchange=e=>on(e.target.value);return s;
}
/* Email / Phone: one entry shows just the value (type sits in the label row).
   Extra entries switch to full rows with a primary radio. */
function contactField(a,kind){
  const isPh=kind==="phones", list=a[kind];
  const TYPES=isPh?PHONE_TYPES:EMAIL_TYPES;
  const f=el("div","f");
  const head=el("div","fhead");
  head.innerHTML=`<label>${isPh?'Phone number <span class="req">*</span>':"Email"}</label>`;
  f.appendChild(head);

  let dialBtn=null;
  /* Every number gets its own dial button, so a second or third number is one
     click away instead of needing to be made primary first. */
  const dialButton=e=>{
    const b=el("button","dialbtn","\u260E");
    b.type="button";b.tabIndex=-1;b.title="Call this number";
    b.disabled=!String(e.value||"").trim();
    b.onclick=()=>{
      const num=((e.cc||"")+String(e.value||"")).replace(/\s/g,"");
      if(!num)return;
      startTimer("dial");
      window.open("tel:"+num,"_self");
    };
    return b;
  };
  const valueInput=(e,idx)=>{
    const i=el("input","in vl2");
    if(idx===0)i.id=isPh?"f-ph":"f-em";
    i.type=isPh?"tel":"email";i.value=e.value;
    i.placeholder=isPh?"9876543210":"name@company.com";
    i.setAttribute("aria-label",isPh?"Phone number":"Email address");
    if(isPh)i.inputMode="tel";
    i.oninput=v=>{e.value=v.target.value;renderCallbar();validate();if(dialBtn)dialBtn.disabled=!e.value.trim();};
    /* A pasted number often carries its own country code or a trunk 0. Left as
       is it doubles against the code beside it and the tel: link dials
       nothing. Tidy on blur rather than mid-keystroke. */
    if(isPh)i.onblur=v=>{
      const t=localPart(v.target.value,e.cc);
      if(t!==v.target.value){v.target.value=t;e.value=t;renderCallbar();validate();persist();}
    };
    return i;
  };
  const ccInput=e=>{
    const c=el("input","in cc");c.value=e.cc;c.setAttribute("aria-label","Country code");
    c.oninput=v=>{e.cc=v.target.value;renderCallbar();};return c;
  };

  if(list.length===1){
    const e=list[0];
    head.appendChild(mini(TYPES,e.type,v=>e.type=v));
    const row=el("div","entry");
    if(isPh)row.appendChild(ccInput(e));
    dialBtn=isPh?dialButton(e):null;
    row.appendChild(valueInput(e,0));
    if(dialBtn)row.appendChild(dialBtn);
    f.appendChild(row);
  }else{
    list.forEach((e,i)=>{
      const row=el("div","entry");
      const rd=el("input");rd.type="radio";rd.name=kind;rd.checked=e.primary;
      rd.setAttribute("aria-label","Primary");
      rd.onchange=()=>{list.forEach(x=>x.primary=false);e.primary=true;renderCallbar();};
      row.appendChild(rd);
      const ty=el("select","in ty2");ty.innerHTML=opts(TYPES,e.type);
      ty.setAttribute("aria-label","Type");ty.onchange=v=>e.type=v.target.value;
      row.appendChild(ty);
      if(isPh)row.appendChild(ccInput(e));
      const db=isPh?dialButton(e):null;
      row.appendChild(valueInput(e,i));
      if(db)row.appendChild(db);
      const d=el("button","del","×");d.type="button";d.setAttribute("aria-label","Remove");
      d.onclick=()=>{list.splice(i,1);if(list.length&&!list.some(x=>x.primary))list[0].primary=true;render();};
      row.appendChild(d);
      f.appendChild(row);
    });
  }
  const add=el("button","add",isPh?"+ Add phone":"+ Add email");add.type="button";
  add.onclick=()=>{list.push(isPh?{type:"MOBILE",cc:"+91",value:"",primary:!list.length}
                               :{type:"OFFICE",value:"",primary:!list.length});render();};
  f.appendChild(add);
  return f;
}

/* Every company the console has seen, so the picker is never empty. */
function knownCompanies(){
  const m=new Map();
  for(const c of DATA) if(c.companyId&&c.company) m.set(String(c.companyId),c.company);
  if(scope&&scope.name) m.set(String(scope.id),scope.name);
  return m;
}
/* A contact belongs to a company in Kylas, and typing a name here never made
   that link — it only produced a second spelling of an existing account. So it
   is chosen, and inside a company scope it is fixed. */
function companyField(a){
  const f=el("div","f");
  f.innerHTML=`<label for="f-co">Where do they work?</label>`;
  if(scope&&String(a.companyId)===String(scope.id)){
    const w=el("div","fixed");
    w.innerHTML=`<b id="f-co" data-value="${esc(a.companyId)}">${esc(a.company||scope.name)}</b>
      <em>kylas ${esc(String(a.companyId))}</em>`;
    f.appendChild(w);
    return f;
  }
  const m=knownCompanies(), ids=[...m.keys()];
  const sel=el("select","in");sel.id="f-co";
  sel.innerHTML=[`<option value="">Choose a company</option>`,
    ...ids.map(id=>`<option value="${esc(id)}"${String(a.companyId)===id?" selected":""}>${esc(m.get(id))}</option>`)].join("");
  sel.onchange=e=>{
    a.companyId=e.target.value;
    a.company=m.get(e.target.value)||"";
    renderCallbar();renderQueue();validate();
  };
  f.appendChild(sel);
  return f;
}

/* Strip a leading +cc, bare cc or trunk 0 so the field holds the local number
   the country code beside it expects. */
function localPart(v,cc){
  let t=String(v||"").trim().replace(/[^\d+]/g,"");
  const code=String(cc||"").replace(/\D/g,"");
  if(t.startsWith("+"))t=t.slice(1);
  if(code&&t.length>code.length&&t.startsWith(code))t=t.slice(code.length);
  t=t.replace(/^0+/,"");
  return t||String(v||"").trim();
}

/* ── duplicates ──────────────────────────── */
/* Three associates working shared lists will re-add the same person. Compare on
   the last 10 digits so +91/0 prefixes and spacing cannot hide a match. */
const digits=v=>String(v||"").replace(/\D/g,"").slice(-10);
function findDupe(a){
  const mine=new Set((a.phones||[]).map(p=>digits(p.value)).filter(d=>d.length===10));
  if(!mine.size)return null;
  for(let i=0;i<DATA.length;i++){
    if(i===cur)continue;
    if((DATA[i].phones||[]).some(p=>mine.has(digits(p.value))))return{i,b:DATA[i]};
  }
  return null;
}
function renderDupe(){
  document.querySelectorAll(".dupe").forEach(n=>n.remove());
  const host=document.getElementById("f-ph")?.closest(".f");
  if(!host)return;
  const d=findDupe(rec());
  if(!d)return;
  const w=el("div","dupe");
  w.innerHTML=`<span>Already on <b>${esc(d.b.pocName||"another contact")}</b>${d.b.company?" · "+esc(d.b.company):""}</span>`;
  const go=el("button",null,"Open");go.type="button";
  go.onclick=()=>{cur=d.i;isNew=false;stopTimer();secs=0;tmode="idle";render();resetScroll();};
  w.appendChild(go);
  host.appendChild(w);
}

function renderBasic(){
  const a=rec(),W=document.getElementById("formL");W.innerHTML="";
  document.getElementById("phL").textContent=isNew?"new contact":(a.kid||"unsaved");

  /* Name — salutation rides in the label row */
  const fName=el("div","f");
  const nh=el("div","fhead");
  nh.innerHTML=`<label for="f-poc">Name <span class="req">*</span></label>`;
  nh.appendChild(mini(SALUTATION,a.salutation,v=>a.salutation=v));
  fName.appendChild(nh);
  fName.appendChild(input("f-poc",a.pocName,"Full name",v=>{a.pocName=v;renderCallbar();renderQueue();}));

  /* LinkedIn with icon */
  const fLi=el("div","f");
  fLi.innerHTML=`<label for="f-li">LinkedIn</label>`;
  const liw=el("div","withIcon");
  liw.appendChild(el("span","ic","in"));
  const liIn=input("f-li",a.linkedin,"linkedin.com/in/…",v=>{a.linkedin=v;syncGo();});
  liw.appendChild(liIn);
  const go=el("button","go","\u2197");
  go.type="button";go.tabIndex=-1;
  go.onclick=()=>{const u=liUrl(a.linkedin);if(u)window.open(u,"_blank","noopener");};
  function syncGo(){
    const ok=!!liUrl(liIn.value);
    go.disabled=!ok;
    go.title=ok?"Open this profile in a new tab":"Enter a LinkedIn URL first";
  }
  syncGo();
  liw.appendChild(go);
  fLi.appendChild(liw);

  const grid=el("div","g2");
  grid.appendChild(fName);
  grid.appendChild(contactField(a,"emails"));
  grid.appendChild(contactField(a,"phones"));
  grid.appendChild(fLi);
  grid.appendChild(companyField(a));
  grid.appendChild(field("Role","f-dg",false,input("f-dg",a.designation,"What do they do?",v=>{a.designation=v;renderCallbar();})));
  W.appendChild(group("Who you're calling",[grid]));

  /* Source */
  const srcRow=el("div","g2");
  srcRow.appendChild(field("Came from","f-src",false,select("f-src",SOURCES,a.source,v=>a.source=v)));
  srcRow.appendChild(field("Owner","f-ow",true,select("f-ow",OWNERS,a.owner,v=>a.owner=v)));
  W.appendChild(group("Where they came from",[srcRow]));

  /* Stage & follow-up */
  const ncd=el("div","f");ncd.id="f-next";
  ncd.innerHTML=`<label>Call them back on${isReq(a,"f-next")?' <span class="req">*</span>':""}</label>`;
  const ncr=el("div","mrow");
  const d1=el("input","in dt");d1.type="date";d1.value=a.nextCallDate;d1.setAttribute("aria-label","Next call date");
  d1.oninput=e=>a.nextCallDate=e.target.value;ncr.appendChild(d1);
  const t1=el("input","in dt");t1.type="time";t1.value=a.nextCallTime;t1.setAttribute("aria-label","Next call time");
  t1.oninput=e=>a.nextCallTime=e.target.value;ncr.appendChild(t1);
  ncd.appendChild(ncr);
  const qc=el("div","qchips");
  [["Tomorrow",1],["+3 days",3],["Next week",7]].forEach(([l,n])=>{
    const b=el("button","qc",l);b.type="button";b.tabIndex=-1;
    b.onclick=()=>{const dt=new Date();dt.setDate(dt.getDate()+n);a.nextCallDate=dt.toISOString().slice(0,10);render();};
    qc.appendChild(b);
  });
  ncd.appendChild(qc);

  const sRow=el("div","g2");
  sRow.appendChild(field("Stage","f-stage",false,select("f-stage",STAGES,a.stage,v=>{a.stage=v;render();})));
  sRow.appendChild(ncd);

  const rRow=el("div","g2");
  rRow.appendChild(field("Notes from the call","f-rm",false,textarea("f-rm",a.remarks,"Whatever they said",v=>a.remarks=v)));
  rRow.appendChild(field("Offsite timeline","f-ot",false,select("f-ot",OFFSITE_TIMELINE,a.offsiteTimeline,v=>a.offsiteTimeline=v)));

  W.appendChild(group("Where this stands",[sRow,rRow]));
}

function renderRight(){
  const a=rec(),F=document.getElementById("formR");F.innerHTML="";
  const n=a.past.length+a.current.length;
  document.getElementById("phR").textContent=n?n+(n===1?" event":" events"):"nothing yet";
  document.getElementById("tabCount").textContent=n?String(n):"";

  if(a.stage==="Could Not Connect"){
    F.appendChild(group("No answer",[el("p","skipnote",
      "Nobody picked up — nothing to write down here. Pick a day to try again on the left, then hit <kbd>↵</kbd>.")]));
    return;
  }

  F.appendChild(eventsGroup());

  /* close-out */
  const g3c=el("section","card");
  g3c.appendChild(el("div","cardH","<h2>Before you hang up</h2>"));
  const g3=el("div","cardB grp");g3c.appendChild(g3);
  g3.appendChild(field("Who handles this for them today?","f-vi",isReq(a,"f-vi"),
    select("f-vi",VENDOR_INFO,a.vendorInfo,v=>a.vendorInfo=v)));

  const lab=el("label","cb1"+(a.serviceOffering?" on":""));
  lab.style.marginBottom="0";
  const c=el("input");c.type="checkbox";c.checked=a.serviceOffering;
  c.onchange=()=>{a.serviceOffering=c.checked;lab.className="cb1"+(c.checked?" on":"");};
  lab.appendChild(c);
  lab.appendChild(el("span",null,"I pitched what Enout does<em>Tick it if you got the pitch in.</em>"));
  g3.appendChild(lab);

  if(MEETING_STAGES.includes(a.stage)){
    g3.appendChild(field("How are you meeting them?","f-mm",isReq(a,"f-mm"),
      select("f-mm",MODE_OF_MEETING,a.modeOfMeeting,v=>a.modeOfMeeting=v)));
  }else{
    g3.appendChild(el("div","locked",
      `<b>later</b><span>Once a meeting is booked we'll ask how you're meeting them.</span>`));
  }
  F.appendChild(g3c);
}

/* One chip per event type, one card per chip. Tapping a lit chip removes its
   card. Past vs Now lives on the card and is echoed back onto the chip, so the
   same six types never get printed on screen twice. */
function bucketOf(a,t){
  if(a.past.some(r=>r.eventType===t))return "past";
  if(a.current.some(r=>r.eventType===t))return "current";
  return null;
}
function eventsGroup(){
  const a=rec();
  const g=el("section","card");g.id="s-events";
  const nEv=a.past.length+a.current.length;
  g.appendChild(el("div","cardH",
    `<h2>Events</h2><span class="sub">${nEv?nEv+" tagged":"none yet"}</span>`));
  const gb=el("div","cardB");g.appendChild(gb);
  gb.appendChild(el("p","ask","Tap a type the moment they mention it, then mark it past or now."));

  const chips=el("div","tcs");
  EVENT_TYPES.filter(Boolean).forEach(t=>{
    const bk=bucketOf(a,t);
    const btn=el("button","tc"+(bk==="past"?" past-on":bk==="current"?" now-on":""),
      `<i class="dot"></i>${esc(t)}`);
    btn.type="button";
    btn.setAttribute("aria-pressed",bk?"true":"false");
    btn.title=bk?"Tap to remove":"Tap to add";
    btn.onclick=()=>{
      if(bk){a.past=a.past.filter(r=>r.eventType!==t);a.current=a.current.filter(r=>r.eventType!==t);}
      else a.current=[...a.current,{...emptyRow(),eventType:t}];
      touch("record");renderRight();refreshQual();
      if(!bk)setTimeout(()=>{
        const cards=document.querySelectorAll("#formR .ev");
        cards[cards.length-1]?.querySelector(".bl input")?.focus();
      },30);
    };
    chips.appendChild(btn);
  });
  gb.appendChild(chips);

  const list=el("div");
  a.past.forEach(r=>{if(r.eventType)list.appendChild(eventCard(a,"past",r));});
  a.current.forEach(r=>{if(r.eventType)list.appendChild(eventCard(a,"current",r));});
  if(!a.past.length&&!a.current.length){
    const e=el("div","empty","Nothing yet — details can wait, just tag the type.");
    e.style.marginTop="9px";list.appendChild(e);
  }
  gb.appendChild(list);
  return g;
}

function eventCard(a,key,r){
  const card=el("div","ev "+(key==="past"?"is-past":"is-now"));
  const h=el("div","evh");

  const seg=el("div","seg");
  [["past","Past"],["current","Now"]].forEach(([k,lbl])=>{
    const bb=el("button",null,lbl);bb.type="button";
    bb.setAttribute("aria-pressed",key===k?"true":"false");
    bb.setAttribute("aria-label",lbl+" — "+r.eventType);
    bb.onclick=()=>{
      if(key===k)return;
      a[key]=a[key].filter(x=>x!==r);a[k]=[...a[k],r];
      touch("record");renderRight();
    };
    seg.appendChild(bb);
  });
  h.appendChild(seg);
  h.appendChild(el("span","t",esc(r.eventType)));
  const x=el("button","del","×");x.type="button";
  x.setAttribute("aria-label","Remove "+r.eventType);
  x.onclick=()=>{a[key]=a[key].filter(o=>o!==r);touch("record");renderRight();};
  h.appendChild(x);
  card.appendChild(h);

  const body=el("div","evb");
  const strip=el("div","strip");
  const blank=(k,ph,chips,min)=>{
    const w=el("span","bl");
    const i=el("input");i.value=r[k]||"";i.placeholder=ph;
    i.setAttribute("aria-label",r.eventType+" — "+ph);
    const size=()=>{i.style.width=Math.max(min,(i.value||ph).length*9+22)+"px";};
    size();
    i.oninput=()=>{r[k]=i.value;size();touch("record");refreshQual();validate();};
    i.onfocus=()=>{
      strip.innerHTML="";strip.appendChild(el("span","lbl","Tap to add:"));
      chips.forEach(c=>{
        const bb=el("button","qc",esc(c));bb.type="button";bb.tabIndex=-1;
        bb.onmousedown=e=>e.preventDefault();
        bb.onclick=()=>{const v=(i.value||"").trim();
          i.value=v?v+(/[,;]$/.test(v)?" ":", ")+c:c;r[k]=i.value;size();i.focus();
          i.setSelectionRange(i.value.length,i.value.length);refreshQual();validate();};
        strip.appendChild(bb);
      });
    };
    i.onblur=()=>setTimeout(()=>{if(!card.contains(document.activeElement))strip.innerHTML="";},120);
    w.appendChild(i);return w;
  };

  const l=el("p","sent");
  l.append("Around ",blank("pax","how many?",QUICK.pax,116)," people, ",
           blank("timeline","when?",QUICK.timeline,116),
           ". Budget ",blank("budget","how much?",QUICK.budget,128),".");
  body.append(l,strip);
  card.appendChild(body);

  /* remarks lives in its own block so it never competes with the numbers */
  const nb=el("div","evnote");
  const nid="rm-"+key+"-"+r.eventType.replace(/\W+/g,"");
  nb.innerHTML=`<label for="${nid}">Remarks</label>`;
  const note=el("textarea");note.id=nid;note.rows=2;note.value=r.remarks||"";
  note.placeholder="Anything worth reading before the next call…";
  note.oninput=e=>{r.remarks=e.target.value;touch("record");};
  nb.appendChild(note);
  card.appendChild(nb);
  return card;
}

function renderRight_counts(){
  const a=rec(),n=a.past.length+a.current.length;
  document.getElementById("phR").textContent=n?n+(n===1?" event":" events"):"nothing yet";
  document.getElementById("tabCount").textContent=n?String(n):"";
}

/* What is required depends on how far the call got. The further along the
   stage, the more the record has to carry before it can be saved. */
function missing(){
  const a=rec(),m=[];
  /* Dedupe by label: two rules can want the same field — mode of meeting is
     required both at a meeting stage and once a row is complete — and listing
     it twice reads as a bug to the person trying to save. */
  const need=(cond,lbl,anc)=>{ if(cond&&!m.some(([l])=>l===lbl))m.push([lbl,anc]); };

  need(!a.pocName.trim(),"Name","f-poc");
  need(!a.phones.some(p=>p.value.trim()),"Phone number","f-poc");
  need(!a.owner,"Owner","f-ow");

  /* a.stage is a CODE (DISCOVERY_CALL_BOOKED), not a label. Three rules here
     used to match labels against it with regexes and a string equality, so
     none of them ever fired and nothing was actually being enforced. */
  need(CNC_LADDER.includes(a.stage)&&!a.nextCallDate,"A day to call back","f-next");

  /* Claiming a booked meeting or better means claiming you learned something. */
  if(rung(a)>=MILESTONE.sqlMeetingBooked.floor){
    need(!blocks(a).length,"At least one event","s-events");
    need(blocks(a).length&&!hasSignal(a),"Budget, timeline or pax","s-events");
  }

  /* A complete row IS the Successful Discovery claim, so the moment one appears
     the three things that qualify it stop being optional. Gating at save is
     deliberately not the same as folding them into isComplete(): blocking the
     save collects the data, whereas adding them to the test would silently
     withhold the credit from someone who filled budget, timeline and pax. */
  if(isComplete(a)){
    need(!a.vendorInfo,"Who handles this for them today","f-vi");
    need(!a.modeOfMeeting,"Mode of meeting","f-mm");
  }

  if(MEETING_STAGES.includes(a.stage)){
    need(!a.nextCallDate,"Meeting date","f-next");
    need(!a.modeOfMeeting,"Mode of meeting","f-mm");
  }
  return m;
}
const blocks=a=>[...a.past,...a.current].filter(r=>r.eventType);
const isReq=(a,id)=>missing().some(([,anc])=>anc===id);
function validate(){
  setTimeout(renderDupe,0);
  const m=missing(),msg=document.getElementById("msg"),a=rec(),sv=document.getElementById("saveBtn");
  document.getElementById("flagBtn").className="flagbtn"+(a.flagged?" on":"");
  sv.disabled=m.length>0;
  if(m.length){
    msg.className="msg bad";msg.innerHTML="";
    msg.append("Still needed: ");
    m.forEach(([lbl,anc],i)=>{
      if(i)msg.append(i===m.length-1?" and ":", ");
      const b=el("button",null,esc(lbl));b.type="button";b.onclick=()=>jump(anc);
      msg.appendChild(b);
    });
  }
  else if(a.done){msg.textContent="Logged \u2014 nice one.";msg.className="msg";}
  else{msg.textContent="Everything needed is in. Save & next when you're ready.";msg.className="msg";}
}
function jump(anc){
  const t=document.getElementById(anc);if(!t)return;
  if(matchMedia("(max-width:920px)").matches)setTab(anc==="s-events"||anc==="f-vi"||anc==="f-mm"?"more":"basic");
  t.scrollIntoView({behavior:"smooth",block:"center"});
  const f=t.querySelector("input,textarea,select,button");
  if(f&&!f.disabled)setTimeout(()=>f.focus({preventScroll:true}),260);
}
function saveNext(){
  const m=missing();
  if(m.length){tried=true;validate();toast("Still needed: "+m.map(x=>x[0]).join(", "));return;}
  tried=false;
  const a=rec(),was=a.done;
  const wasNew=isNew||!a.kid;
  const duration=secs||null;
  const durationSource=secs?(tmode==="est"?"estimated":"dialed"):"none";
  const outcome=lastOutcome;
  /* No Kylas id yet, so this record has to be created there rather than
     updated. That flag is what tells the writer POST rather than PUT. */
  if(wasNew)a.pendingCreate=true;
  a.lastCallAt=new Date().toISOString();
  a.done=true;stopTimer();secs=0;tmode="idle";lastOutcome=null;
  const from=cur;

  /* One entry per save, whether or not the stage moved — see kpi-spec.md §2. */
  Store.appendCall({
    kid:a.kid, pocName:a.pocName, company:a.company, owner:a.owner,
    outcome:outcome?outcome.t:null, stageSet:a.stage, duration, durationSource,
    createdHere:wasNew,
  }).then(n=>{const c=document.getElementById("logCount");if(c)c.textContent=n;});
  persist();
  if(a.kid)Store.clearDraft(a.kid);
  syncToKylas(a,{outcome:outcome?outcome.t:null,duration,at:new Date().toISOString(),
                 note:(a.current||[]).map(r=>r.remarks).filter(Boolean).join(" · ")});
  const rows=visible().filter(r=>r.i!==from);
  const nxt=rows.length?rows[0].i:cur;
  cur=nxt;isNew=false;collapsed={past:false,current:false};
  render();resetScroll();setTab("basic");
  toast(`${a.pocName} logged \u2014 next up: ${DATA[cur].pocName}`,()=>{a.done=was;cur=from;render();});
}

/* ── shortcuts sheet ─────────────────────── */
function openKb(){
  const s=el("div","scrim");
  s.innerHTML=`<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="kh">
    <div class="h"><h3 id="kh">Keyboard</h3><button class="gbtn" id="kx" type="button">Close</button></div>
    <div class="b">
      <div class="krow"><span class="kk"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd></span><span>Set the stage — no answer, right POC, discovery, SQL</span></div>
      <div class="krow"><span class="kk"><kbd>Enter</kbd></span><span>Save and jump to the next contact</span></div>
      <div class="krow"><span class="kk"><kbd>C</kbd></span><span>Dial the primary number</span></div>
      <div class="krow"><span class="kk"><kbd>F</kbd></span><span>Flag this record for end-of-day cleanup</span></div>
      <div class="krow"><span class="kk"><kbd>J</kbd> <kbd>K</kbd></span><span>Next / previous contact in the queue</span></div>
      <div class="krow"><span class="kk"><kbd>/</kbd></span><span>Jump to search</span></div>
      <div class="krow"><span class="kk"><kbd>Esc</kbd></span><span>Leave the field you are in</span></div>
      <div class="krow"><span class="kk"><kbd>?</kbd></span><span>This sheet</span></div>
    </div></div>`;
  document.body.appendChild(s);
  s.onclick=e=>{if(e.target===s)s.remove();};
  document.getElementById("kx").onclick=()=>s.remove();
}

/* ── wiring ──────────────────────────────── */
document.getElementById("q").addEventListener("input",renderQueue);
const on=(id,ev,fn)=>{const n=document.getElementById(id);if(n)n.addEventListener(ev,fn);};
on("kbBtn","click",openKb);
on("qToggle","click",e=>{
  const m=document.getElementById("mid");m.classList.toggle("noq");
  e.target.classList.toggle("on",!m.classList.contains("noq"));
});


document.querySelectorAll(".tabbar button").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.tab)));
function newContact(){
  const b=blank();
  /* Inside a company scope the new POC belongs to that company. */
  if(scope){b.company=scope.name;b.companyId=String(scope.id);}
  if(ME)b.owner=ME;
  DATA=[b,...DATA];cur=0;isNew=true;filter="all";renderFilters();render();
  resetScroll();setTab("basic");
  setTimeout(()=>document.getElementById("f-poc")?.focus(),50);
}
on("newBtn","click",newContact);
on("qNewBtn","click",newContact);
document.getElementById("resetBtn").addEventListener("click",()=>{render();toast("Reset");});
document.getElementById("saveBtn").addEventListener("click",saveNext);
document.getElementById("flagBtn").addEventListener("click",()=>{
  const a=rec();a.flagged=!a.flagged;validate();renderQueue();
  toast(a.flagged?"Flagged for cleanup":"Flag removed");
});

document.addEventListener("keydown",e=>{
  const typing=e.target.matches("input,textarea,select");
  if(e.key==="Escape"){
    const sc=document.querySelector(".scrim");if(sc){sc.remove();return;}
    if(typing){e.target.blur();return;}
  }
  if(typing&&!(e.key==="Enter"&&(e.metaKey||e.ctrlKey)))return;
  if(e.key==="Enter"){e.preventDefault();saveNext();return;}
  const o=OUTCOMES.find(x=>x.k===e.key);
  if(o){e.preventDefault();setOutcome(o);return;}
  const k=e.key.toLowerCase();
  if(k==="c"){const a=rec(),p=a.phones.find(x=>x.primary)||a.phones[0];
    if(p&&p.value){startTimer();window.location.href="tel:"+(p.cc+p.value).replace(/\s/g,"");}return;}
  if(k==="f"){document.getElementById("flagBtn").click();return;}
  if(k==="j"||k==="k"){
    const rows=visible();const at=rows.findIndex(r=>r.i===cur);
    const nx=k==="j"?at+1:at-1;
    if(rows[nx]){cur=rows[nx].i;stopTimer();secs=0;render();resetScroll();}
    return;}
  if(e.key==="/"){e.preventDefault();document.getElementById("q").focus();return;}
  if(e.key==="?"){openKb();return;}
});

/* ── persistence ──────────────────────────── */
let persistTimer=null;
function persist(){
  clearTimeout(persistTimer);
  persistTimer=setTimeout(()=>Store.saveContacts(DATA),400);
}
/* Capture phase, so every input is covered without each handler opting in.
   Losing a call's notes to a refresh is unacceptable. */
document.addEventListener("input",()=>{
  persist();
  const a=rec();
  if(a&&a.kid)Store.saveDraft(a.kid,a);
},true);
document.addEventListener("change",persist,true);

/* ── sync ─────────────────────────────────── */
async function syncToKylas(a,call){
  a.syncing=true;renderQueue();
  const res=await API.queueSave(a,call);
  a.syncing=false;
  if(res.ok){
    if(res.created&&res.kid){a.kid=res.kid;a.pendingCreate=false;}
    a.syncedAt=new Date().toISOString();
    /* Airtable is where the KPIs come from, so its failure has to surface even
       though Kylas took the write. */
    a.syncError=res.airtableError?("airtable: "+res.airtableError)
      :res.callLogError?("call log: "+res.callLogError):null;
  }else{
    a.syncError=res.error||"not sent";
  }
  persist();renderQueue();
  if(!res.ok)toast(`${a.pocName} saved locally — Kylas unreachable, queued`);
  else if(res.created)toast(`${a.pocName} created in Kylas`);
}

async function boot(){
  ME=(await Store.getSetting("me"))||"";
  addOwners((await Store.getSetting("owners"))||[]);
  const saved=await Store.loadContacts();
  if(saved&&saved.length)DATA=saved;
  const log=await Store.loadLog();
  const c=document.getElementById("logCount");
  if(c)c.textContent=log.length;
  /* done means "logged today", derived from the log — not a stored field. */
  const t=today();
  const loggedToday=new Set(log.filter(e=>(e.at||"").slice(0,10)===t).map(e=>e.kid));
  DATA.forEach(a=>{a.done=loggedToday.has(a.kid);});
  addOwners(DATA.map(a=>a.owner));
  renderFilters();render();
}
boot();
