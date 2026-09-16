/* ── picklists ───────────────────────────── */
const SALUTATION=["","MR","MRS","MISS"];
/* Kylas stores these uppercase. A title-case list never matches a fetched
   record, so the dropdown grew a duplicate rather than selecting one. */
const EMAIL_TYPES=["OFFICE","PERSONAL","OTHER"];
const PHONE_TYPES=["MOBILE","WORK","HOME","OTHER"];
/* Stage tables live in stages.js, generated from docs/stages.json. */
/* Seeded from the picklist dump, then replaced by whatever this account
   actually defines — see adoptPicklists. cfSourceOfData is a custom field, so
   its values differ per account ("Round-Robin" on Ayush's). */
let SOURCES=["","GOOGLE","FACEBOOK","LINKEDIN","EXHIBITION","COLD_CALLING"];
/* MULTI_PICKLIST in Kylas — more than one quarter can be selected. */
let OFFSITE_TIMELINE=["","JAN_MAR","APR_JUN","JUL_SEP","OCT_DEC"];

/* Kylas is the authority on what its own fields offer. */
function adoptPicklists(picklists){
  if(!picklists)return;
  const take=(...names)=>{
    for(const n of names){
      const v=picklists[n];
      if(v&&v.length)return ["",...v.map(o=>o.code)];
    }
    return null;
  };
  const src=take("cfSourceOfData","sourceOfData","source");
  if(src)SOURCES=src;
  const off=take("cfOffsiteTimeline","offsiteTimeline");
  if(off)OFFSITE_TIMELINE=off;
  for(const list of Object.values(picklists))
    for(const o of list) if(o.code&&o.label&&!LABEL[o.code])LABEL[o.code]=o.label;
}

const label=v=>LABEL[v]||v;

const priority=a=>STAGE_PRIORITY[a.stage]??99;
/* 24 = SQL, the top of the funnel. 0 means the stage is unknown. */
const rung=a=>STAGE_RUNG[a.stage]||0;
const rungLabel=r=>label(STAGES.find(c=>STAGE_RUNG[c]===r))||"Not reached";
/* Seeded empty and filled from whoever Kylas reports — see API.owners. */
let OWNERS=[""];
function addOwners(names){
  for(const n of names){ if(n&&!OWNERS.includes(n))OWNERS.push(n); }
  OWNERS=[OWNERS[0],...OWNERS.slice(1).sort((a,b)=>a.localeCompare(b))];
}
const EVENT_TYPES=["","Employee offsites","Product launch","Sales conference / dealer meet","Marketing events","Team-building activities","Other engagements"];
const VENDOR_INFO=["","Internal","Vendor Exists","First Event","No Info"];
const MODE_OF_MEETING=["","In Person","Virtual","Calls","Text"];

/* No answer escalates rather than repeating: CNC 1 -> 2 -> 3 -> Follow-up CNC.
   Kylas models the repeat attempts as distinct stages, so the button walks them
   instead of writing the same value every time. */
const OUTCOMES=[
  {k:"1",t:"No answer",   stage:a=>CNC_LADDER[Math.min(CNC_LADDER.indexOf(a.stage)+1,CNC_LADDER.length-1)]||CNC_LADDER[0]},
  {k:"2",t:"Wrong POC",   stage:"DISQUALIFIED_WRONG_POC"},
  {k:"3",t:"Right POC",   stage:"MQL_MARKETING_QUALIFIED_LEAD"},
  {k:"4",t:"Discovery",   stage:"DISCOVERY_CALL_BOOKED"}
];
const outcomeStage=(o,a)=>typeof o.stage==="function"?o.stage(a):o.stage;
const QUICK={
  budget:["Approx","₹L","₹Cr","Not approved","Signed off","No budget yet","Last year was"],
  timeline:["Q2 FY27","Q3 FY27","Q4 FY27","Q1 FY28","Not decided","Month:","Tentative"],
  pax:["Approx","+ internal","incl. contractors","Only leadership","Whole company"]
};

/* ── data ────────────────────────────────── */
const emptyRow=()=>({eventType:"",budget:"",timeline:"",pax:"",remarks:""});
const blank=()=>({kid:"",salutation:"",pocName:"",company:"",companyId:"",linkedin:"",designation:"",
  emails:[{type:"OFFICE",value:"",primary:true}],
  phones:[{type:"MOBILE",cc:"+91",value:"",primary:true}],
  stage:"YET_TO_BE_MINED",nextCallDate:"",nextCallTime:"",
  source:"",remarks:"",offsiteTimeline:"",owner:ME,
  past:[],current:[],vendorInfo:"",serviceOffering:false,modeOfMeeting:"",
  done:false,flagged:false});

let DATA=[
{kid:"40912",salutation:"MR",pocName:"Priyank Tewari",company:"nutritap",companyId:"901",linkedin:"",designation:"",
 emails:[{type:"OFFICE",value:"priyank.tewari@nutritap.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9873915513",primary:true}],
 stage:"YET_TO_BE_MINED",nextCallDate:"",nextCallTime:"",
 source:"COLD_CALLING",remarks:"",offsiteTimeline:"",owner:"Shreya Bodwal",
 past:[],current:[],vendorInfo:"",serviceOffering:false,modeOfMeeting:"",done:false,flagged:false},

{kid:"41155",salutation:"MR",pocName:"Arjun Sethi",company:"Kritsnam Analytics",companyId:"902",
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

{kid:"38470",salutation:"MISS",pocName:"Devanshi Kalro",company:"Shorehouse Retail",companyId:"903",
 linkedin:"linkedin.com/in/devanshikalro",designation:"AVP Marketing",
 emails:[{type:"OFFICE",value:"d.kalro@shorehouse.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9920477103",primary:true}],
 stage:"DISCOVERY_CALL_DONE_AWAITING_CLIENT_INPUTS",nextCallDate:"2026-09-24",nextCallTime:"11:30",
 source:"COLD_CALLING",remarks:"Reopened after last year's loss. Warm.",
 offsiteTimeline:"JUL_SEP",owner:"Shreya Bodwal",
 past:[{eventType:"Sales conference / dealer meet",budget:"Approx 40L, signed off by CFO",
  timeline:"Q1 FY27, first week of April",pax:"300 dealers + 40 internal",
  remarks:"Annual dealer meet in Jaipur. Ran over budget on AV."}],
 current:[{eventType:"Product launch",budget:"15-20L, not approved",
  timeline:"Q3 FY27, mid-November",pax:"120 press and partners",
  remarks:"AW line launch. Needs a press-friendly venue in south Bombay."}],
 vendorInfo:"Internal",serviceOffering:true,modeOfMeeting:"In Person",done:true,flagged:false},

{kid:"39901",salutation:"MR",pocName:"Ishaan Grover",company:"Pralay Fintech",companyId:"904",
 linkedin:"",designation:"Senior Manager, HR",
 emails:[{type:"OFFICE",value:"ishaan.g@pralay.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9811062234",primary:true}],
 stage:"DISQUALIFIED_WRONG_POC",nextCallDate:"",nextCallTime:"",source:"LINKEDIN",
 remarks:"Offsites decided by the CHRO, will share the name.",
 offsiteTimeline:"",owner:"Ayush Tiwari",past:[],current:[],
 vendorInfo:"No Info",serviceOffering:false,modeOfMeeting:"",done:true,flagged:false},

{kid:"42308",salutation:"MISS",pocName:"Meera Raghunathan",company:"Anvaya Labs",companyId:"905",
 linkedin:"linkedin.com/in/meera-raghunathan",designation:"Founder's Office",
 emails:[{type:"OFFICE",value:"meera@anvayalabs.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"8806019945",primary:true}],
 stage:"FOLLOW_UP_1",nextCallDate:"",nextCallTime:"",source:"LINKEDIN",
 remarks:"",offsiteTimeline:"",owner:"Shreya Bodwal",past:[],current:[],
 vendorInfo:"",serviceOffering:false,modeOfMeeting:"",done:false,flagged:false},

{kid:"37622",salutation:"MR",pocName:"Balaji Venkatesh",company:"Tatvik Logistics",companyId:"906",
 linkedin:"",designation:"GM Admin",
 emails:[{type:"OFFICE",value:"balaji.v@tatvik.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9444030871",primary:true}],
 stage:"CNC_COULD_NOT_CONNECT",nextCallDate:"2026-09-17",nextCallTime:"10:00",
 source:"LINKEDIN",remarks:"",offsiteTimeline:"",owner:"Ayush Tiwari",past:[],current:[],
 vendorInfo:"",serviceOffering:false,modeOfMeeting:"",done:false,flagged:false},

{kid:"38512",salutation:"MR",pocName:"Rohit Nambiar",company:"Shorehouse Retail",companyId:"903",
 linkedin:"",designation:"Head of Admin",
 emails:[{type:"OFFICE",value:"r.nambiar@shorehouse.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9833126740",primary:true}],
 stage:"MQL_MARKETING_QUALIFIED_LEAD",nextCallDate:"",nextCallTime:"",
 source:"EXHIBITION",remarks:"Devanshi's counterpart on logistics. Handles venue contracts.",
 offsiteTimeline:"JUL_SEP",owner:"Ayush Tiwari",past:[],
 current:[{eventType:"Team-building activities",budget:"",timeline:"Q3 FY27",pax:"",remarks:""}],
 vendorInfo:"Vendor Exists",serviceOffering:false,modeOfMeeting:"",done:false,flagged:false},

{kid:"43017",salutation:"MISS",pocName:"Simran Kohli",company:"Meghdoot Cloud",companyId:"907",
 linkedin:"",designation:"People Partner",
 emails:[{type:"OFFICE",value:"simran.k@meghdoot.example",primary:true}],
 phones:[{type:"MOBILE",cc:"+91",value:"9871855420",primary:true}],
 stage:"YET_TO_BE_MINED",nextCallDate:"",nextCallTime:"",source:"LINKEDIN",
 remarks:"",offsiteTimeline:"",owner:"",past:[],current:[],
 vendorInfo:"",serviceOffering:false,modeOfMeeting:"",done:false,flagged:false}
];

let cur=0, isNew=false, filter="todo", target=100;
let scope=null;   /* {id,name} when opened from a Kylas company page */
let ME="";        /* the associate using the console; learned, then remembered */
let mode="company";  /* company: follow the Kylas page · session: one flat queue */
let timer=null, secs=0, ringing=false;
let lastOutcome=null;
let tmode="idle";   /* idle | dial | est */
let collapsed={past:false,current:false};
const rec=()=>DATA[cur];
const today=()=>new Date().toISOString().slice(0,10);
const dateIn=n=>{const d=new Date();d.setDate(d.getDate()+n);return d.toISOString().slice(0,10);};
/* Associates paste "linkedin.com/in/x", "www.linkedin.com/in/x" or a full url.
   Accept all three, reject anything that is not a linkedin address. */
function liUrl(v){
  const t=String(v||"").trim();
  if(!t)return null;
  const u=/^https?:\/\//i.test(t)?t:"https://"+t.replace(/^\/+/,"");
  try{
    const p=new URL(u);
    return /(^|\.)linkedin\.com$/i.test(p.hostname)?p.href:null;
  }catch(e){return null;}
}

/* ── helpers ─────────────────────────────── */
const el=(t,c,h)=>{const n=document.createElement(t);if(c)n.className=c;if(h!=null)n.innerHTML=h;return n;};
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
/* If the stored value is not one of the options, Kylas knows something this
   list does not — show it rather than silently rendering "Choose" over real
   data. This is what was blanking Owner and Source of data on fetched records. */
const opts=(l,v)=>{
  const list=(v!==undefined&&v!==null&&v!==""&&!l.includes(v))?[...l,v]:l;
  return list.map(o=>`<option value="${esc(o)}"${o===v?" selected":""}>${o===""?"Choose":esc(label(o))}</option>`).join("");
};
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

  const who=el("div","who",`<b>${esc(a.pocName||"New contact")}</b><span>${esc(a.company||"—")}${a.designation?" · "+esc(a.designation):""}</span>`);
  C.appendChild(who);

  const d=el("div","dial");
  const link=el("a",null,`<span>☏</span>${esc(num||"no number")}`);
  link.href=num?"tel:"+num.replace(/\s/g,""):"#";
  link.onclick=e=>{if(!num){e.preventDefault();return;}startTimer("dial");};
  d.appendChild(link);
  const tm=el("span","tm",fmtSecs(secs));
  tm.id="tm";d.appendChild(tm);
  setTimeout(paintTimer,0);
  C.appendChild(d);

  const ocs=el("div","ocs");
  OUTCOMES.forEach(o=>{
    const b=el("button","oc",`<kbd>${o.k}</kbd>${esc(o.t)}`);
    b.type="button";b.dataset.oc=o.k;
    const target=outcomeStage(o,a);
    b.setAttribute("aria-pressed",a.stage===target||(o.k==="1"&&CNC_LADDER.includes(a.stage))?"true":"false");
    b.title=`Sets stage to ${label(target)}`;
    b.onclick=()=>setOutcome(o);
    ocs.appendChild(b);
  });
  C.appendChild(ocs);

  const nb=el("div","nextbtn");
  const btn=el("button","pbtn",`Save &amp; next <kbd style="border-color:rgba(255,255,255,.35);background:transparent;color:inherit">⏎</kbd>`);
  btn.type="button";btn.onclick=saveNext;nb.appendChild(btn);
  C.appendChild(nb);
}
const fmtSecs=s=>String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");
function startTimer(mode){
  if(timer)clearInterval(timer);
  secs=0;ringing=true;tmode=mode||"dial";
  timer=setInterval(tick,1000);
  paintTimer();
}
function tick(){secs++;paintTimer();}
function paintTimer(){
  const t=document.getElementById("tm");
  if(!t)return;
  t.textContent=(tmode==="est"?"~":"")+fmtSecs(secs);
  t.className="tm"+(ringing?(tmode==="est"?" est":" run"):"");
  t.title=tmode==="est"
    ?"Estimated from when you logged the outcome — dial from the console for a real duration."
    :"Call duration";
}
function stopTimer(){if(timer)clearInterval(timer);timer=null;ringing=false;paintTimer();}
function setOutcome(o){
  const a=rec();
  lastOutcome=o;
  const target=outcomeStage(o,a);
  a.stage=target;
  if(EXIT_STAGES.includes(target))a.exitReason=target;
  /* Dialled from the console: that timer is the truth, so freeze it. Otherwise
     start estimating from here rather than logging a zero-second call. */
  if(tmode==="dial"&&ringing){stopTimer();}
  else if(tmode!=="est"){startTimer("est");}
  /* They did not pick up today; calling again today is not the plan. */
  if(!a.nextCallDate&&CNC_LADDER.includes(target)){a.nextCallDate=dateIn(1);}
  render();
  resetScroll();
  if(!CNC_LADDER.includes(target)&&matchMedia("(max-width:900px)").matches)setTab("more");
}

/* ── session order ───────────────────────── */
/* A promise to call on a date beats everything — breaking those is what loses
   deals. After that it is Ayush's stage order, and within a stage the contact
   left longest goes first. */
function sessionRank(a){
  const due=a.nextCallDate&&a.nextCallDate<=today();
  return [
    due?0:1,
    due?a.nextCallDate:"",
    priority(a),
    a.lastCallAt||"",              /* never called sorts first, then oldest */
  ];
}
function bySession(x,y){
  const A=sessionRank(x.a),B=sessionRank(y.a);
  for(let i=0;i<A.length;i++){
    if(A[i]===B[i])continue;
    return typeof A[i]==="number"?A[i]-B[i]:String(A[i]).localeCompare(String(B[i]));
  }
  return 0;
}

function renderMode(){
  const w=document.getElementById("qmode");
  if(!w)return;
  w.innerHTML="";
  const due=DATA.filter(a=>!a.done&&a.nextCallDate&&a.nextCallDate<=today()).length;
  [["company","Company",scope?DATA.filter(a=>String(a.companyId)===String(scope.id)).length:0],
   ["session","Session",DATA.filter(a=>!a.done).length]].forEach(([k,label,n])=>{
    const b=el("button","qm",`${label}${n?` <i>${n}</i>`:""}`);
    b.type="button";
    b.setAttribute("aria-pressed",mode===k?"true":"false");
    b.disabled=(k==="company"&&!scope);
    b.title=k==="company"
      ? (scope?"Only the contacts at this company":"Open the console on a Kylas company page to use this")
      : "Every contact due, in call order"+(due?` · ${due} due now`:"");
    b.onclick=()=>{mode=k;cur=firstIn();render();resetScroll();};
    w.appendChild(b);
  });
}
/* Land on the first record of whichever list is now showing. */
function firstIn(){
  const rows=visible();
  return rows.length?rows[0].i:cur;
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
function visible(){
  const q=(document.getElementById("q").value||"").toLowerCase();
  const rows=DATA.map((a,i)=>({a,i}))
    .filter(({a})=>mode==="session"||!scope||String(a.companyId)===String(scope.id))
    .filter(({a})=>!q||(a.pocName+" "+a.company+" "+a.phones.map(p=>p.value).join(" ")).toLowerCase().includes(q))
    .filter(({a})=>filter==="all"||(filter==="flag"?a.flagged:!a.done));
  return mode==="session"?rows.sort(bySession):rows;
}
function renderScope(){
  const w=document.getElementById("qscope");
  if(!w)return;
  if(!scope||mode!=="company"){w.innerHTML="";w.hidden=true;return;}
  w.hidden=false;
  const n=DATA.filter(a=>String(a.companyId)===String(scope.id)).length;
  w.innerHTML=`<span class="cn">${esc(scope.name)}</span>
    <span class="cc">${n} contact${n===1?"":"s"}</span>`;
  const x=el("button","cx","×");x.type="button";x.title="Show the whole queue";
  x.onclick=()=>{scope=null;render();};
  w.appendChild(x);
}
function renderQueue(){
  renderMode();renderScope();
  const L=document.getElementById("qlist");L.innerHTML="";
  const rows=visible();
  if(!rows.length){
    L.appendChild(el("li","qempty",scope
      ? "No contacts held for "+esc(scope.name)+" yet.<br>Use <b>New contact</b> to add the first one."
      : "Nothing here."));
    return;
  }
  rows.forEach(({a,i})=>{
    const li=el("li"),b=el("button","qi");
    b.type="button";b.setAttribute("aria-current",i===cur?"true":"false");
    b.dataset.stage=a.stage;
    b.innerHTML=`<span class="n">${esc(a.pocName)}${a.syncing?' <i class="pend sync" title="Saving to Kylas…">…</i>'
        :a.syncError?' <i class="pend err" title="'+esc(a.syncError)+'">queued</i>'
        :a.pendingCreate?' <i class="pend" title="Not in Kylas yet">new</i>':""}</span><span class="c">${esc(a.company)}</span>
      <span class="s"><i class="dotd${a.done?" done":a.flagged?" flag":""}"></i><span class="st">${esc(label(a.stage))}</span>${
        mode==="session"&&a.nextCallDate&&a.nextCallDate<=today()?'<span class="due">due</span>'
        :mode==="session"?`<span class="pri">#${priority(a)}</span>`:""}</span>`;
    b.onclick=()=>{cur=i;isNew=false;stopTimer();secs=0;render();resetScroll();};
    li.appendChild(b);L.appendChild(li);
  });
}
function renderPace(){
  const n=DATA.filter(a=>a.done).length;
  document.getElementById("pcount").textContent=n;
  document.getElementById("ptarget").textContent="/ "+target;
  document.getElementById("pbar").style.width=Math.min(100,n/target*100)+"%";
}

/* ── form ────────────────────────────────── */
function render(){
  renderCompany();renderCallbar();renderQueue();renderPace();renderBasic();renderRight();validate();
}

/* Everything here is derived from the contacts we hold for this company, so it
   moves the moment a call is saved. Mirrors the ladder in docs/kpi-spec.md. */
const NOT_CONNECTED=[...UNTOUCHED,...CNC_LADDER];
function companyRoster(id){return DATA.filter(a=>String(a.companyId)===String(id));}
function hasSignal(a){
  return a.past.concat(a.current).some(r=>r.eventType||r.budget||r.timeline||r.pax);
}
function isComplete(a){
  return a.past.concat(a.current).some(r=>r.eventType&&r.budget&&r.timeline&&r.pax);
}
function connected(a){
  return !!a.stage&&!NOT_CONNECTED.includes(a.stage);
}
/* The company sits at the best rung any of its contacts has reached. Highest
   ever, not current — a contact slipping back never drags the company down. */
function companyStage(list){
  const r=list.reduce((m,a)=>Math.max(m,rung(a)),0);
  const k=r>=23?"sql":r>=19?"disc":r>=13?"booked":r>=6?"rpoc":r>0?"picked":"none";
  return{r,t:r?rungLabel(r):"Not reached",k};
}
function renderCompany(){
  const w=document.getElementById("cohead");
  if(!w)return;
  if(!scope||mode!=="company"){w.hidden=true;w.innerHTML="";return;}
  const list=companyRoster(scope.id);
  const st=companyStage(list);
  const last=list.map(a=>a.lastCallAt).filter(Boolean).sort().pop();
  const days=last?Math.floor((Date.now()-new Date(last))/864e5):null;
  const fresh=days===null?"never":days<=14?"fresh":"stale";
  const tile=(n,l,k)=>`<div class="tile ${k}"><b>${n}</b><span>${l}</span></div>`;
  w.hidden=false;
  w.innerHTML=`
    <div class="coIn">
      <div class="coName">
        <span class="av">${esc((scope.name||"?").slice(0,2).toUpperCase())}</span>
        <span class="nm"><b>${esc(scope.name)}</b><em>kylas ${esc(String(scope.id))}</em></span>
        <span class="kpi ${st.k}">${esc(st.t)}</span>
      </div>
      <div class="tiles">
        ${tile(list.length,"total POCs","t1")}
        ${tile(list.filter(connected).length,"connected","t2")}
        ${tile(list.filter(hasSignal).length,"right POC","t3")}
        ${tile(list.filter(isComplete).length,"discovery","t4")}
      </div>
      <div class="reach ${fresh}">
        <span class="lbl">Status of reachout</span>
        <b>${fresh==="never"?"Never called":(fresh==="fresh"?"Fresh":"Stale")}${last?" · last call "+esc(last.slice(0,10)):""}</b>
      </div>
    </div>`;
}

function group(title,nodes){
  const g=el("div","grp");
  g.appendChild(el("div","grpH",`<span>${esc(title)}</span>`));
  nodes.forEach(n=>g.appendChild(n));
  return g;
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

  const valueInput=(e,idx)=>{
    const i=el("input","in vl2");
    if(idx===0)i.id=isPh?"f-ph":"f-em";
    i.type=isPh?"tel":"email";i.value=e.value;
    i.placeholder=isPh?"9876543210":"name@company.com";
    i.setAttribute("aria-label",isPh?"Phone number":"Email address");
    if(isPh)i.inputMode="tel";
    i.oninput=v=>{e.value=v.target.value;renderCallbar();validate();dialBtn.disabled=!e.value.trim();};
    /* A pasted number often carries its own country code or a trunk 0. Left as
       is it doubles up against the code beside it and the tel: link dials
       nothing. Tidy on blur rather than mid-keystroke. */
    if(isPh)i.onblur=v=>{
      const t=localPart(v.target.value,e.cc);
      if(t!==v.target.value){v.target.value=t;e.value=t;renderCallbar();validate();persist();}
    };
    return i;
  };
  /* Every number gets its own dial button, so a second or third number is one
     click away instead of needing to be made primary first. */
  const dialButton=e=>{
    const b=el("button","dialbtn","\u260E");
    b.type="button";b.tabIndex=-1;
    b.title="Call this number";
    b.disabled=!String(e.value||"").trim();
    b.onclick=()=>{
      const num=((e.cc||"")+String(e.value||"")).replace(/\s/g,"");
      if(!num)return;
      startTimer("dial");
      window.open("tel:"+num,"_self");
    };
    return b;
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
    var dialBtn=isPh?dialButton(e):null;
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
      var dialBtn=isPh?dialButton(e):null;
      row.appendChild(valueInput(e,i));
      if(dialBtn)row.appendChild(dialBtn);
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
   that link — it only produced a second spelling of an existing account. So the
   name is chosen, not typed, and inside a company scope it is fixed. */
function companyField(a){
  const f=el("div","f");
  const head=el("div","fhead");
  head.innerHTML=`<label for="f-co">Company</label>`;
  f.appendChild(head);

  const locked=!!scope&&String(a.companyId)===String(scope.id);
  if(locked){
    const w=el("div","fixed");
    w.innerHTML=`<b id="f-co" data-value="${esc(a.companyId)}">${esc(a.company||scope.name)}</b>
      <em>kylas ${esc(String(a.companyId))}</em>`;
    f.appendChild(w);
    return f;
  }

  const m=knownCompanies();
  const ids=[...m.keys()];
  const sel=el("select","in");sel.id="f-co";
  sel.innerHTML=[`<option value="">Choose a company</option>`,
    ...ids.map(id=>`<option value="${esc(id)}"${String(a.companyId)===id?" selected":""}>${esc(m.get(id))}</option>`)].join("");
  sel.onchange=e=>{
    a.companyId=e.target.value;
    a.company=m.get(e.target.value)||"";
    renderCallbar();renderQueue();validate();
  };
  f.appendChild(sel);
  if(!ids.length){
    const n=el("div","rmnote");
    n.innerHTML="<span>Open a company in Kylas first — the console lists the ones it has seen.</span>";
    f.appendChild(n);
  }
  return f;
}

function renderBasic(){
  const a=rec(),W=document.getElementById("formL");W.innerHTML="";
  document.getElementById("phL").textContent=isNew?"new contact":(a.kid?"kylas "+a.kid:"unsaved");

  /* A new contact has no Kylas id yet, so say so plainly rather than letting it
     look like an existing record that failed to load. */
  if(isNew){
    const nb=el("div","newbar");
    nb.innerHTML=`<span class="tag">New</span>
      <span class="tx">Not in Kylas yet${scope?` · will be added under <b>${esc(scope.name)}</b>`:""}.
        Name, phone and owner are required before it can be saved.</span>`;
    const dc=el("button","dc","Discard");dc.type="button";
    dc.onclick=()=>{
      DATA.splice(cur,1);
      if(!DATA.length)DATA=[blank()];
      cur=0;isNew=false;render();resetScroll();toast("Discarded");
    };
    nb.appendChild(dc);
    W.appendChild(nb);
  }

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
  const go=el("button","go","↗");
  go.type="button";go.tabIndex=-1;go.title="Open this profile in a new tab";
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
  grid.appendChild(field("Designation","f-dg",false,input("f-dg",a.designation,"Job title",v=>{a.designation=v;renderCallbar();})));
  W.appendChild(group("POC",[grid]));

  /* Source */
  const srcRow=el("div","g2");
  srcRow.appendChild(field("Source of data","f-src",false,select("f-src",SOURCES,a.source,v=>a.source=v)));
  /* Picking an owner teaches the console who is sitting here, so the next new
     contact does not ask again. */
  srcRow.appendChild(field("Owner","f-ow",true,select("f-ow",OWNERS,a.owner,v=>{
    a.owner=v;
    if(v){ME=v;Store.setSetting("me",v);}
  })));
  W.appendChild(group("Source",[srcRow]));

  /* Stage & follow-up */
  const ncd=el("div","f");ncd.innerHTML=`<label>Next call date (call later)</label>`;
  const ncr=el("div","mrow");
  const d1=el("input","in dt");d1.type="date";d1.value=a.nextCallDate;d1.setAttribute("aria-label","Next call date");
  d1.oninput=e=>a.nextCallDate=e.target.value;ncr.appendChild(d1);
  const t1=el("input","in dt");t1.type="time";t1.value=a.nextCallTime;t1.setAttribute("aria-label","Next call time");
  t1.oninput=e=>a.nextCallTime=e.target.value;ncr.appendChild(t1);
  ncd.appendChild(ncr);
  const qc=el("div","qchips");
  [["Tomorrow",1],["+3 days",3],["Next week",7]].forEach(([l,n])=>{
    const b=el("button","qc",l);b.type="button";b.tabIndex=-1;
    b.onclick=()=>{a.nextCallDate=dateIn(n);render();};
    qc.appendChild(b);
  });
  ncd.appendChild(qc);

  const sRow=el("div","g2");
  sRow.appendChild(field("Pipeline stage — BD","f-stage",false,select("f-stage",STAGES,a.stage,v=>{a.stage=v;render();})));
  sRow.appendChild(ncd);

  const rRow=el("div","g2");
  const fRm=field("Remarks","f-rm",false,textarea("f-rm",a.remarks,"Notes on this contact",v=>a.remarks=v));
  /* This field is what Kylas already holds, and where the overlay's summary will
     be written. Say so, so nobody is surprised when a block appears in it. */
  const rmNote=el("div","rmnote");
  rmNote.innerHTML=a.kid
    ? `<span>From Kylas · editable here${a.remarks?"":" · currently empty"}</span>`
    : `<span>Saved to Kylas once this contact is created</span>`;
  fRm.appendChild(rmNote);
  rRow.appendChild(fRm);
  rRow.appendChild(field("Offsite timeline","f-ot",false,select("f-ot",OFFSITE_TIMELINE,a.offsiteTimeline,v=>a.offsiteTimeline=v)));

  W.appendChild(group("Stage & follow-up",[sRow,rRow]));
}

function renderRight(){
  const a=rec(),F=document.getElementById("formR");F.innerHTML="";
  const n=a.past.length+a.current.length;
  document.getElementById("phR").textContent=n?n+(n===1?" row":" rows"):"empty";
  document.getElementById("tabCount").textContent=n?String(n):"";

  /* no-answer short circuit */
  if(CNC_LADDER.includes(a.stage)){
    const s=el("section","sec");
    s.innerHTML=`<div class="skipnote">No answer — nothing else to capture. Set a next call date on the left, then
      <kbd>⏎</kbd> to save and move to the next contact.</div>`;
    F.appendChild(s);return;
  }

  /* Past first: what they have already run is the context for what is on the
     table now. Both feed the KPI rules the same way — see companyStage(). */
  F.appendChild(eventSection("past","Past","One row per event they have already run."));
  F.appendChild(eventSection("current","Current","One row per event on the table now."));

  /* vendor & offering */
  const s4=el("section","sec");
  s4.dataset.kind="vendor";
  s4.innerHTML=`<div class="sh"><h2>Vendor &amp; offering</h2></div>`;
  const b4=el("div","sb");
  b4.appendChild(field("Vendor info","f-vi",false,select("f-vi",VENDOR_INFO,a.vendorInfo,v=>a.vendorInfo=v)));

  const sf=el("div","f");
  const lab=el("label","cb1"+(a.serviceOffering?" on":""));
  lab.style.marginBottom="0";
  const c=el("input");c.type="checkbox";c.checked=a.serviceOffering;
  c.onchange=()=>{a.serviceOffering=c.checked;lab.className="cb1"+(c.checked?" on":"");};
  lab.appendChild(c);
  lab.appendChild(el("span",null,"Enout service offering<em>Tick if the offering was pitched on this call.</em>"));
  sf.appendChild(lab);b4.appendChild(sf);

  if(MEETING_STAGES.includes(a.stage)){
    b4.appendChild(field("Mode of meeting","f-mm",false,select("f-mm",MODE_OF_MEETING,a.modeOfMeeting,v=>a.modeOfMeeting=v)));
  }else{
    const lk=el("div","f");
    lk.innerHTML=`<div class="locked"><b>hidden</b><span>Mode of meeting opens once a
      meeting is booked or held.</span></div>`;
    b4.appendChild(lk);
  }
  s4.appendChild(b4);F.appendChild(s4);
}

function eventSection(key,title,sub){
  const a=rec();
  const s=el("section","sec"+(collapsed[key]?" collapsed":""));
  s.dataset.kind=key;
  const h=el("div","sh");
  h.innerHTML=`<h2>${esc(title)}</h2><p>${esc(sub)}</p>`;
  const tg=el("button","shbtn",collapsed[key]?`▸ ${a[key].length} row${a[key].length===1?"":"s"}`:"▾ Hide");
  tg.type="button";tg.onclick=()=>{collapsed[key]=!collapsed[key];render();};
  h.appendChild(tg);s.appendChild(h);

  const b=el("div","sb");
  const rows=el("div","rows");
  if(!a[key].length)rows.appendChild(el("div","empty","No "+title.toLowerCase()+" events."));
  a[key].forEach((r,i)=>{
    const c=el("div","row");
    const rh=el("div","rowh");
    rh.innerHTML=`<span class="n">${esc(title)} ${i+1}</span>`;
    const d=el("button","del","×");d.type="button";d.setAttribute("aria-label","Remove row");
    d.onclick=()=>{a[key].splice(i,1);render();};
    rh.appendChild(d);c.appendChild(rh);

    const g=el("div","g2");
    g.appendChild(field("Event type",`${key}-et-${i}`,false,select(`${key}-et-${i}`,EVENT_TYPES,r.eventType,v=>{r.eventType=v;})));
    g.appendChild(quickField("Budget",`${key}-bd-${i}`,r.budget,"Whatever they said",v=>r.budget=v,QUICK.budget));
    c.appendChild(g);c.appendChild(el("div","f"));

    const g2=el("div","g2");
    g2.appendChild(quickField("Timeline",`${key}-tl-${i}`,r.timeline,"Quarter or month",v=>r.timeline=v,QUICK.timeline));
    g2.appendChild(quickField("Pax",`${key}-px-${i}`,r.pax,"Headcount",v=>r.pax=v,QUICK.pax));
    c.appendChild(g2);c.appendChild(el("div","f"));

    c.appendChild(field("Remarks",`${key}-rm-${i}`,false,textarea(`${key}-rm-${i}`,r.remarks,"Detail for the next call",v=>r.remarks=v)));
    rows.appendChild(c);
  });
  b.appendChild(rows);
  const add=el("button","add","+ Add "+title.toLowerCase()+" event");add.type="button";
  add.style.marginTop="10px";
  add.onclick=()=>{a[key].push(emptyRow());collapsed[key]=false;render();};
  b.appendChild(add);
  s.appendChild(b);return s;
}

/* ── duplicates ──────────────────────────── */
/* Three associates working shared lists will re-add the same person. Compare on
   the last 10 digits so +91/0 prefixes and spacing do not hide a match. */
const digits=v=>String(v||"").replace(/\D/g,"").slice(-10);
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
function findDupe(a){
  const mine=new Set(a.phones.map(p=>digits(p.value)).filter(d=>d.length===10));
  if(!mine.size)return null;
  for(let i=0;i<DATA.length;i++){
    if(i===cur)continue;
    const b=DATA[i];
    if(b.phones.some(p=>mine.has(digits(p.value))))return{i,b};
  }
  return null;
}
function renderDupe(){
  const host=document.getElementById("f-ph")?.closest(".f");
  document.querySelectorAll(".dupe").forEach(n=>n.remove());
  if(!host)return;
  const d=findDupe(rec());
  if(!d)return;
  const w=el("div","dupe");
  w.innerHTML=`<span>Already on <b>${esc(d.b.pocName||"another contact")}</b>${d.b.company?" · "+esc(d.b.company):""}</span>`;
  const go=el("button",null,"Open");go.type="button";
  go.onclick=()=>{cur=d.i;isNew=false;errFor=-1;stopTimer();secs=0;tmode="idle";render();resetScroll();};
  w.appendChild(go);
  host.appendChild(w);
}

/* ── validate + actions ──────────────────── */
function missing(){
  const a=rec(),m=[];
  if(!a.pocName.trim())m.push({label:"POC name",id:"f-poc"});
  if(!a.phones.some(p=>p.value.trim()))m.push({label:"phone",id:"f-ph"});
  if(!a.owner)m.push({label:"owner",id:"f-ow"});
  return m;
}
/* Red fields only after a save has actually been blocked — marking them while
   the name is still half-typed is just nagging. Tied to the record the save was
   attempted on, so moving to another contact clears it with no bookkeeping. */
let errFor=-1;
function validate(){
  const m=missing(),msg=document.getElementById("msg"),a=rec();
  document.getElementById("flagBtn").className="flagbtn"+(a.flagged?" on":"");

  document.querySelectorAll(".in.bad").forEach(n=>n.classList.remove("bad"));
  if(errFor===cur)m.forEach(x=>document.getElementById(x.id)?.classList.add("bad"));

  if(m.length){msg.textContent="Needs "+m.map(x=>x.label).join(", ");msg.className="msg bad";}
  else{msg.textContent=a.done?"Logged today.":"Ready to save.";msg.className="msg";}
  renderDupe();
}
function saveNext(){
  const m=missing();
  if(m.length){
    errFor=cur;
    validate();
    const first=document.getElementById(m[0].id);
    if(first){
      if(matchMedia("(max-width:900px)").matches)setTab("basic");
      first.focus();first.scrollIntoView({block:"center",behavior:"smooth"});
    }
    toast("Missing "+m.map(x=>x.label).join(", "));
    return;
  }
  errFor=-1;
  const a=rec(),was=a.done;
  const wasNew=isNew||!a.kid;
  const duration=secs||null, durationSource=secs?(tmode==="est"?"estimated":"dialed"):"none", outcome=lastOutcome;

  /* No Kylas id yet, so this record has to be created there rather than
     updated. Mark it and leave it marked until a sync clears it — that flag is
     what tells the writer POST /v1/contacts instead of PUT /v1/contacts/{id}. */
  if(wasNew)a.pendingCreate=true;
  a.done=true;stopTimer();secs=0;tmode="idle";lastOutcome=null;
  const from=cur;

  /* One entry per save, whether or not the stage moved — see kpi-spec.md §2. */
  a.lastCallAt=new Date().toISOString();
  Store.appendCall({
    kid:a.kid, pocName:a.pocName, company:a.company, owner:a.owner,
    outcome:outcome?outcome.t:null, stageSet:a.stage, duration, durationSource,
    createdHere:wasNew,
  }).then(n=>{const c=document.getElementById("logCount");if(c)c.textContent=n;});
  persist();
  if(a.kid)Store.clearDraft(a.kid);

  /* Push to Kylas. The UI has already moved on — an associate should not wait
     on a network round trip between calls. */
  syncToKylas(a,{outcome:outcome?outcome.t:null,duration,at:new Date().toISOString(),
                 note:(a.current||[]).map(r=>r.remarks).filter(Boolean).join(" · ")});
  const rows=visible().filter(r=>r.i!==from);
  const nxt=rows.length?rows[0].i:cur;
  cur=nxt;isNew=false;collapsed={past:false,current:false};
  render();resetScroll();setTab("basic");
  toast(wasNew?`${a.pocName} added`:`${a.pocName} saved`,
        ()=>{a.done=was;cur=from;render();});
}

/* Budget, timeline and pax are the only fields a connected call really needs,
   and they sit in the other pane. Jump straight into them, creating the current
   event row first if there is not one yet. */
const EVENT_KEYS={e:"et",b:"bd",t:"tl",x:"px",r:"rm"};
function focusEvent(k){
  const a=rec();
  if(a.stage==="Could Not Connect")return;       /* right pane is collapsed */
  if(!a.current.length){a.current.push(emptyRow());collapsed.current=false;render();}
  if(matchMedia("(max-width:900px)").matches)setTab("more");
  const n=document.getElementById(`current-${EVENT_KEYS[k]}-0`);
  if(!n)return;
  n.focus();
  n.scrollIntoView({block:"center"});
  if(n.setSelectionRange&&n.value)n.setSelectionRange(n.value.length,n.value.length);
}

/* ── sync ────────────────────────────────── */
async function syncToKylas(a,call){
  a.syncing=true;renderQueue();
  const res=await API.queueSave(a,call);
  a.syncing=false;
  if(res.ok){
    if(res.created&&res.kid){a.kid=res.kid;a.pendingCreate=false;}
    a.syncedAt=new Date().toISOString();
    a.syncError=null;
    if(res.callLogError)a.syncError="call log: "+res.callLogError;
  }else{
    a.syncError=res.error||"not sent";
  }
  persist();renderQueue();
  if(!res.ok)toast(`${a.pocName} saved locally — Kylas unreachable, queued`);
  else if(res.created)toast(`${a.pocName} created in Kylas`);
}

/* ── shortcuts sheet ─────────────────────── */
function openKb(){
  const s=el("div","scrim");
  s.innerHTML=`<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="kh">
    <div class="h"><h3 id="kh">Keyboard</h3><button class="gbtn" id="kx" type="button">Close</button></div>
    <div class="b">
      <div class="krow"><span class="kk"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd></span><span>Set the call outcome</span></div>
      <div class="krow"><span class="kk"><kbd>Enter</kbd></span><span>Save and jump to the next contact</span></div>
      <div class="krow"><span class="kk"><kbd>C</kbd></span><span>Dial the primary number</span></div>
      <div class="krow"><span class="kk"><kbd>E</kbd> <kbd>B</kbd> <kbd>T</kbd> <kbd>X</kbd></span><span>Jump to event type, budget, timeline, pax</span></div>
      <div class="krow"><span class="kk"><kbd>R</kbd></span><span>Jump to the event remarks</span></div>
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
document.querySelectorAll(".tabbar button").forEach(b=>b.addEventListener("click",()=>setTab(b.dataset.tab)));
function newContact(){
  const b=blank();
  /* Inside a company scope the new POC belongs to that company. */
  if(scope){b.company=scope.name;b.companyId=String(scope.id);}
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
    if(p&&p.value){startTimer("dial");window.location.href="tel:"+(p.cc+p.value).replace(/\s/g,"");}return;}
  if(k==="f"){document.getElementById("flagBtn").click();return;}
  if(EVENT_KEYS[k]){e.preventDefault();focusEvent(k);return;}
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
