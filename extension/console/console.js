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
  /* Sentence case. SHOUTING LABELS were a large part of why this read as an
     instrument panel rather than a page. */
  {label:"Right POC", test:a=>hasSignal(a)},
  {label:"Discovery", test:a=>isComplete(a)},
  {label:"SQL",       test:a=>a.stage==="SQL_SALES_QUALIFIED_LEAD"},
];
/* Replaced at runtime by whatever this Kylas account actually defines. */
/* EMPTY until Kylas says otherwise. This used to ship
   GOOGLE|FACEBOOK|LINKEDIN|EXHIBITION|COLD_CALLING — which is the STANDARD
   Source picklist, not this account's cfSourceOfData. docs/kylas-api-notes.md
   §11 says not to hardcode a custom field's values, and a list that looks
   plausible is worse than an empty one: an associate picks "Google" from it and
   writes a value the account does not use. */
let SOURCES=[""];
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
  /* cfSourceOfData only. Falling through to "source" is how the standard
     picklist got back in — that field is a different question with different
     values. */
  const src=take("cfSourceOfData","sourceOfData"); if(src)SOURCES=src;
  const off=take("cfOffsiteTimeline","offsiteTimeline");    if(off)OFFSITE_TIMELINE=off;
  for(const list of Object.values(picklists))
    for(const o of list) if(o.code&&o.label&&!LABEL[o.code])LABEL[o.code]=o.label;
}
const label=v=>LABEL[v]||v;
const priority=a=>STAGE_PRIORITY[a.stage]??99;
const rung=a=>STAGE_RUNG[a.stage]||0;
const rungLabel=r=>label(STAGES.find(c=>STAGE_RUNG[c]===r))||"Not reached";
/* NOT_CONNECTED now comes from stages.js, generated from docs/stages.json,
   so this rule cannot drift from the writer's copy again. */
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
/* `lid` is a LOCAL id, minted here and never sent anywhere as an identity — it
   exists so the outbox can tell two queued saves of the SAME not-yet-created
   contact apart from two different new contacts. Without it, dialling the same
   new POC twice during an outage drains as two POSTs and Kylas ends up with the
   contact twice. kid is the real identity the moment there is one. */
const blank=()=>({lid:rowKey(),kid:"",salutation:"",pocName:"",company:"",linkedin:"",designation:"",
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
  try{
    const p=new URL(u);
    if(!/(^|\.)linkedin\.com$/i.test(p.hostname))return null;
    /* Always https. The only reason to accept http:// above is that people
       paste it; there is no reason to then send them over plaintext. */
    p.protocol="https:";
    return p.href;
  }catch(e){return null;}
}

/* ── helpers ─────────────────────────────── */
const fmtD=d=>d?new Date(d+"T00:00:00").toLocaleDateString("en-IN",{day:"numeric",month:"short"}):"";
const el=(t,c,h)=>{const n=document.createElement(t);if(c)n.className=c;if(h!=null)n.innerHTML=h;return n;};
/* Fallback when the host page has no dialler for this number: one paste beats
   retyping it, and the toast says which happened so a dead click is never
   silent again. */
function copyNumber(num){
  const plain=String(num).replace(/\s/g,"");
  navigator.clipboard?.writeText(plain)
    .then(()=>toast(plain+" copied — no dialler on the page, paste it in"))
    .catch(()=>toast("Could not reach a dialler for "+plain));
}
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
  /* Read it the way a person reads a number, dial it the way a dialler wants
     it. One source for both, shared with the writers (fields.js). */
  const num=ph?Fields.prettyPhone(ph):"";
  const dialNum=ph?Fields.e164(ph):"";

  const q=qualOf(a);
  /* Company ABOVE the person, on its own line. An associate 80 calls into a
     day needs to know which account they are on before they know who they are
     speaking to — and it was previously a fragment of the small grey subline,
     after the qualification chip. */
  const coName=scope?.name||a.company||"";
  const who=el("div","who",
    `${coName?`<span class="atco">${esc(coName)}${
       scope?.id?`<em>#${esc(scope.id)}</em>`:""}</span>`:""}
     <b>${esc(a.pocName||"New contact")}</b>
     <span class="sub"><i class="qual ${q==="MQL"?"mql":"poc"}">${esc(q)}</i>
     ${a.designation?`<span>${esc(a.designation)}</span>`:""}</span>`);
  C.appendChild(who);

  const d=el("div","dial");
  /* A BUTTON, not a link. While this carried href="tel:..." a stray default —
     middle-click, cmd-click, or any path that skipped preventDefault — sent the
     frame to a tel: URL, and Chrome answers that with a full "This content is
     blocked" page. With no href there is nothing to navigate to. */
  const link=el("button",null,`<span class="ico">☎</span><span>${esc(num||"no number")}</span>`);
  link.type="button";
  link.setAttribute("aria-label",num?"Call "+a.pocName+" on "+num:"No number on file");
  link.onclick=e=>{
    if(!dialNum){toast("No number on file for "+a.pocName);return;}
    /* Never follow the tel: href. From inside the iframe that goes to the OS,
       and on a Mac with no softphone registered nothing happens at all — which
       is exactly the dead click Ayush reported. Kylas' dialler is a control in
       the HOST page, so ask the content script to find and click it. It replies
       with "dialled"; only if it finds nothing do we fall back to the
       clipboard. */
    link.classList.add("calling");
    setTimeout(()=>link.classList.remove("calling"),2600);
    if(typeof requestDial==="function")requestDial(dialNum);
    else copyNumber(dialNum);
  };
  d.appendChild(link);C.appendChild(d);

  renderAccount();

  /* Email, callback and record id were one flat grey row in the middle of the
     bar — three unlabelled values competing with the dial button for the same
     attention. They are reference, not action: they go after the button, each
     labelled, and the id (developer information) is last and quietest. */
  const em=(a.emails.find(x=>x.primary)||a.emails[0]||{}).value;
  const meta=el("div","cbmeta");
  const bits=[];
  /* Plain text, not mailto:. There is no send-from-here flow, so the link
     promised an action the console cannot perform — and mailto: has the same
     failure mode as tel:, handing off to whatever the OS registered. Still
     selectable, so it can be copied. Revisit when templates exist. */
  if(em)bits.push(`<span class="mi mail"><em>Email</em><span class="sel">${esc(em)}</span></span>`);
  if(a.nextCallDate)bits.push(`<span class="mi due"><em>Call back</em><span>${esc(fmtD(a.nextCallDate))}${
    a.nextCallTime?" · "+esc(a.nextCallTime):""}</span></span>`);
  bits.push(`<span class="mi kid" title="Kylas contact id"><em>ID</em><span>${esc(a.kid||"unsaved")}</span></span>`);
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
  /* THE MODE WAS TAKEN AND THROWN AWAY. tmode stayed "idle" for the life of
     the console, and three things quietly depended on it:
       durationSource = secs ? (tmode==="est" ? "estimated" : "dialed") : "none"
         -> "idle" is not "est", so EVERY call with a duration was labelled
            "dialed". Measured Seconds counts only "dialed", so once the field
            started reaching Airtable it would have counted keypress estimates
            as measured talk time — worse than the zero it replaced.
       paintTimer's "~" prefix and its title
         -> an estimate looked identical to a measured call on screen.
       setOutcome's `if(tmode==="dial"&&ringing)stopTimer()`
         -> never true, so pressing an outcome after a real dial RESTARTED the
            timer as an estimate and discarded the measured duration.
     One dropped assignment, three faults. */
  tmode=mode||"dial";
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
  /* These three narrow the COMPANY roster. In Today mode they have no effect at
     all — visible() ignores them, because "what is left to do" means nothing
     over a list of calls already made — so three buttons sat there looking
     live and doing nothing. Hidden where they do nothing, and carrying their
     count where they do, so "To call" and "Flagged" explain themselves instead
     of needing to be tried. */
  if(mode==="session"||!scope){w.hidden=true;return;}
  w.hidden=false;
  const roster=DATA.filter(a=>String(a.companyId)===String(scope.id));
  const n={todo:roster.filter(a=>!a.done).length,
           flag:roster.filter(a=>a.flagged).length,
           all:roster.length};
  FILTERS.forEach(([k,l])=>{
    const b=el("button","qf",`${l} <i>${n[k]}</i>`);b.type="button";
    b.setAttribute("aria-pressed",filter===k?"true":"false");
    b.title=k==="todo"?"Contacts at this company not yet logged today"
      :k==="flag"?"Contacts you flagged for end-of-day cleanup"
      :"Every contact at this company";
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
  const rows=DATA.map((a,i)=>({a,i}))
    /* The record you are ON is always in the list. Today is a log of calls
       made, and a contact opened from its Kylas page has not been called yet —
       without this it would be missing from the very list it is selected in. */
    .filter(({a,i})=>mode==="session"?(calledToday(a)||i===cur):(!scope||String(a.companyId)===String(scope.id)))
    /* Done/flagged narrowing is about what is left to do, so it has no meaning
       over a list of calls already made. */
    .filter(({a})=>mode==="session"||filter==="all"||(filter==="flag"?a.flagged:!a.done));
  return mode==="session"?rows.sort(byRecentCall):rows;
}
function renderQueue(){
  renderMode();renderScope();renderFilters();
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
    /* WHO, AND WHERE THEY STAND. Ayush, 2026-09-19: "I can see all the POCs
       but I cannot clearly identify which POC I actually interacted with...
       showing Who -> Where they stand would make the information much clearer."

       Everything below is already on the record — event rows carry the type,
       the budget, the timeline and the pax, past and current — it was just
       never shown anywhere except inside the open card. So a roster of ten
       POCs looked identical whether you had spoken to nine of them or none.

       Four facts, in the order somebody scanning a roster wants them:
         spoken to?      a tick and the stage, or "not spoken to" in grey
         when            last call, relative, because "12d ago" is the question
         what event      the types they have mentioned, past and current
         what was asked  which of budget/timeline/pax came back */
    const evs=[...new Set(rowsOf(a).map(r=>r.eventType).filter(Boolean))];
    const past=(a.past||[]).map(r=>r.eventType).filter(Boolean);
    const sig=["budget","timeline","pax"].filter(k=>rowsOf(a).some(r=>filled(r[k])));
    const spoke=connected(a);
    const last=a.lastCallAt?since(a.lastCallAt):"";

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
      </span>
      <span class="told">
        <i class="spoke${spoke?"":" no"}">${spoke?"spoken to":"not spoken to"}</i>
        ${last?`<i class="when" title="Last call ${esc(String(a.lastCallAt).slice(0,10))}">${esc(last)}</i>`:""}
        ${evs.length?evs.slice(0,2).map(e=>
            `<i class="ev${past.includes(e)?" past":""}" title="${
              past.includes(e)?"Ran this before":"On the table now"}">${esc(label(e))}</i>`).join(""):""}
        ${evs.length>2?`<i class="ev more" title="${esc(evs.slice(2).map(label).join(", "))}">+${evs.length-2}</i>`:""}
        ${sig.length?`<i class="asked" title="Asked and answered: ${esc(sig.join(", "))}">${
            esc(sig.join(" · "))}</i>`:""}
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
  /* scope.name is the fetched company; a.company can still be a pre-fetch
     placeholder, so the scope wins when there is one. */
  W.innerHTML=`<span class="scope">${esc(scope?.name||a.company||"No company")}</span>
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
/* "3d ago". Relative, because on a roster the question is always how long it
   has been, never what the date was — the date is in the title attribute for
   the one time somebody needs it. */
function since(iso){
  const t=Date.parse(iso||"");
  if(!Number.isFinite(t))return "";
  const d=Math.floor((Date.now()-t)/86400000);
  return d<=0?"today":d===1?"yesterday":d<30?`${d}d ago`:d<365?`${Math.floor(d/30)}mo ago`:`${Math.floor(d/365)}y ago`;
}
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
      const num=Fields.e164(e);
      if(!num)return;
      startTimer("dial");
      /* Same route as the big button in the call bar. This one still did
         window.open("tel:…","_self"), which from inside the iframe navigates
         the frame to a tel: URL and does nothing — the dead dialler Ayush
         found beside the phone field. Fixing the call bar and leaving this
         one is exactly the kind of miss a link audit catches. */
      if(typeof requestDial==="function")requestDial(num); else copyNumber(num);
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
      const sp=Fields.splitPhone(v.target.value,e.cc);
      if(!sp.value)return;
      /* The country code moves to the box that is FOR the country code. A
         number pasted as +918319585041 used to stay whole in this field and go
         to Kylas as dialCode "+91" plus value "+918319585041" — the 400. */
      if(sp.cc&&sp.cc!==e.cc){e.cc=sp.cc;const c=v.target.closest(".entry")?.querySelector(".cc");if(c)c.value=sp.cc;}
      if(sp.value!==v.target.value){v.target.value=sp.value;e.value=sp.value;}
      renderCallbar();validate();persist();
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

/* localPart() used to live here — a second, weaker splitPhone with a bug of its
   own (it stripped EVERY leading zero, and a bare "91" prefix, so a real
   10-digit number starting 91 lost two digits). There is one implementation
   now, in fields.js, shared with the proxy and the writers. */

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

  /* SOURCE AND OWNER LIVE HERE NOW, not under a header band of their own.
     "Where they came from" was a whole card — header, border, its own block of
     vertical space — for two selects that are read on every call and changed on
     almost none. On a screen an associate looks at 200 times a day, a card is
     the most expensive thing you can spend on a field, and the left column is
     the half that must stay short: the 85% case is a stage and a call-back
     date, and every band above those is scrolling. They are identity, same as
     the company and the role beside them, so they sit with them. */
  /* Say so when the account's list has not arrived, rather than showing one
     bare "Choose" that reads as "this account has no sources". */
  grid.appendChild(field("Came from","f-src",false,
    SOURCES.filter(Boolean).length||a.source
      ? select("f-src",SOURCES,a.source,v=>a.source=v)
      : el("div","locked",`<b>waiting</b><span>Source of Data comes from Kylas — connect the proxy to load it.</span>`)));
  grid.appendChild(field("Owner","f-ow",true,select("f-ow",OWNERS,a.owner,v=>a.owner=v)));
  const whoCard=group("Who you're calling",[grid]);

  /* Stage & follow-up */
  const ncd=el("div","f");ncd.id="f-next";
  ncd.innerHTML=`<label>Call them back on${isReq(a,"f-next")?' <span class="req">*</span>':""}</label>`;
  const ncr=el("div","mrow");
  /* validate() ON INPUT, like input() and select() do. These two were
     hand-rolled and updated the record without re-running the gate, and
     nextCallDate is REQUIRED by two rules — so after booking a meeting and
     typing the date, the footer still read "Still needed: Meeting date" and
     Save stayed disabled. The associate is told to enter the date they have
     just entered, on the most valuable call of the day.
     It survived testing because the Tomorrow / +3 days / Next week chips below
     call render(), so anyone using those never saw it. validate() and not
     render(): re-rendering the form on each keystroke would take the focus out
     of the field being typed into. */
  const d1=el("input","in dt");d1.type="date";d1.value=a.nextCallDate;d1.setAttribute("aria-label","Next call date");
  d1.oninput=e=>{a.nextCallDate=e.target.value;validate();};ncr.appendChild(d1);
  const t1=el("input","in dt");t1.type="time";t1.value=a.nextCallTime;t1.setAttribute("aria-label","Next call time");
  t1.oninput=e=>{a.nextCallTime=e.target.value;validate();};ncr.appendChild(t1);
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
  /* Offsite timeline moved to "Before you hang up" on the right. It is not
     where the account STANDS — it is something the prospect tells you, like
     who handles this for them today and whether the pitch got in, and those
     are already over there. Sitting next to the call notes it was also on
     screen for every no-answer call, which is the 65% that never gets near it. */

  /* ORDER: WHAT YOU TOUCH, THEN WHAT YOU READ.
     Identity sat first and pushed the stage and the call-back date below the
     fold, so the two fields that are filled on EVERY call — including the 65%
     where nobody picks up — could not be reached without scrolling. And it is
     all a second copy: the header band above already carries the name, the
     number, the email, the company and the role. Scrolling past a duplicate to
     reach the only thing you came for is the cost paid 200 times a day.

     The identity card keeps every field, because that is where they are
     EDITED. It just stops being the thing in the way. */
  W.appendChild(group("Where this stands",[sRow,rRow]));
  W.appendChild(whoCard);
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
  g3.appendChild(field("Offsite timeline","f-ot",false,
    select("f-ot",OFFSITE_TIMELINE,a.offsiteTimeline,v=>a.offsiteTimeline=v)));

  const lab=el("label","cb1"+(a.serviceOffering?" on":""));
  lab.style.marginBottom="0";
  const c=el("input");c.type="checkbox";c.checked=a.serviceOffering;
  c.onchange=()=>{a.serviceOffering=c.checked;lab.className="cb1"+(c.checked?" on":"");};
  lab.appendChild(c);
  lab.appendChild(el("span",null,"I pitched what Enout does<em>Tick it if you got the pitch in.</em>"));
  g3.appendChild(lab);

  /* Always present. It used to appear only at a meeting stage, with a "later"
     placeholder otherwise — but a complete event row now makes it REQUIRED,
     and a stage below booked left it required and invisible at the same time.
     "Still needed: Mode of meeting" pointing at a field that was not on screen
     is a save nobody can complete. Per Ayush: it should appear always, and
     become mandatory once one row is complete. */
  g3.appendChild(field("How are you meeting them?","f-mm",isReq(a,"f-mm"),
    select("f-mm",MODE_OF_MEETING,a.modeOfMeeting,v=>a.modeOfMeeting=v)));
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
  /* Deduped by ANCHOR as well as label. Two rules can want the same BOX under
     different names — at Activation the engaged rule says "A day to call back"
     and the meeting rule says "Meeting date", both pointing at f-next — and
     "Still needed: A day to call back, Offsite timeline, Meeting date" reads as
     three jobs when it is two. First rule to claim a field names it. */
  const need=(cond,lbl,anc)=>{
    if(!cond)return;
    if(m.some(([l,a])=>l===lbl||a===anc))return;
    m.push([lbl,anc]);
  };

  need(!a.pocName.trim(),"Name","f-poc");
  need(!a.phones.some(p=>p.value.trim()),"Phone number","f-poc");
  need(!a.owner,"Owner","f-ow");

  /* VALUES KYLAS WILL REJECT, caught here rather than as a 400 after the save.
     Kylas answers a malformed phone number with
     `002008 Invalid Mobile Number` — no field, no rule — and the whole save is
     lost with it. The same rules run in the proxy (fields.js is generated for
     both), so this is the version that can point at the offending box.
     Reported with the real reason, not a generic "invalid": "9 digits after
     +91, needs 10 digits" is fixable, "invalid phone" is not. */
  a.phones.forEach(p=>{
    if(!String(p.value||"").trim())return;
    const r=Fields.checkPhone(p.value,{cc:p.cc,type:p.type});
    if(!r.ok)need(true,`Phone ${String(p.value).trim()} — ${r.why}`,"f-ph");
  });
  a.emails.forEach(e=>{
    if(!String(e.value||"").trim())return;
    const r=Fields.checkEmail(e.value);
    if(!r.ok)need(true,`Email ${String(e.value).trim()} — ${r.why}`,"f-em");
  });
  /* NAME AND LINKEDIN ARE NOT BLOCKING. They were, and that was overreach:
     Kylas accepts a contact called "temp" and a LinkedIn field holding a
     website, so neither can cause the 400 this gate exists to prevent. Blocking
     on them meant a record ALREADY IN KYLAS, with a placeholder name somebody
     else typed, could not be saved at all — the associate could not record the
     call they had just made until they renamed a stranger's contact.

     The rule: block only what the API would reject. Everything else is advice,
     and advice belongs next to the field, not across the Save button. */

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

  /* ONCE THE ACCOUNT IS LIVE, THE FOLLOW-UP IS NOT OPTIONAL.
     Ayush, 2026-09-19: "whenever someone selects a stage at or above
     Activation, Next Call Date must be filled... otherwise we cannot properly
     fix the next follow-up." The same for the offsite timeline — those are the
     two things that decide when this account is worth touching again, and an
     account at MQL with neither is one nobody will pick back up.

     EXIT STAGES ARE EXCLUDED even though they sit above the floor. Closing
     Loops - Low Value is rung 21 and Not Interested is a dead end; demanding a
     call-back date to record that somebody said no would make the gate
     something to be worked around, and a gate people work around stops
     collecting anything. */
  if (rung(a) >= MILESTONE.engaged.floor && !EXIT_STAGES.includes(a.stage)) {
    need(!a.nextCallDate, "A day to call back", "f-next");
    need(!a.offsiteTimeline, "Offsite timeline", "f-ot");
  }
  return m;
}
/* ADVICE, not a gate. Things worth fixing that Kylas would accept anyway, so
   the save is never held for them — they sit under the footer message in grey
   and can be clicked to jump to the field, same as a blocker. */
function advisories(){
  const a=rec(),out=[];
  if(a.pocName.trim()){
    const r=Fields.checkName(a.pocName);
    if(r.warn)out.push([`Name — ${r.warn}`,"f-poc"]);
  }
  if(String(a.linkedin||"").trim()){
    const r=Fields.checkUrl(a.linkedin,{host:"linkedin.com"});
    if(r.warn)out.push([`LinkedIn — ${r.warn}`,"f-li"]);
  }
  return out;
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

  /* Advisories go BELOW, in their own quiet line, and never touch sv.disabled. */
  document.querySelectorAll(".advice").forEach(n=>n.remove());
  const adv=advisories();
  if(adv.length){
    const w=el("div","advice");
    w.append("Worth fixing: ");
    adv.forEach(([lbl,anc],i)=>{
      if(i)w.append(", ");
      const b=el("button",null,esc(lbl));b.type="button";b.onclick=()=>jump(anc);
      w.appendChild(b);
    });
    msg.parentNode.insertBefore(w,msg.nextSibling);
  }
}
function jump(anc){
  const t=document.getElementById(anc);if(!t)return;
  /* Below 920px the card is two tabs, so jumping to a field has to open the
     one it is actually on — f-ot moved right with the other things a prospect
     tells you, and a jump that opens the wrong tab scrolls to nothing. */
  if(matchMedia("(max-width:920px)").matches)
    setTab(anc==="s-events"||anc==="f-vi"||anc==="f-mm"||anc==="f-ot"?"more":"basic");
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
  /* durationSource AND createdHere travel too. They were logged to the local
     store above and then dropped from the payload that actually leaves the
     browser, so Airtable received undefined for both on every save:

       Duration Source -> "none"  on every row, whatever really happened
       Created Here    -> false   on every row

     Duration Source is not cosmetic. Call Log.Measured Seconds is
     IF({Duration Source} = "dialed", {Duration}, 0), which feeds Contacts.Talk
     Seconds, Measured Calls and Avg Call Seconds, and Companies.Talk Seconds
     above those. With the field never arriving, every one of them was pinned
     to zero for ever — the dashboard's talk-time tile read 0m because the
     provenance never made the trip, not because nobody dialled. */
  syncToKylas(a,{outcome:outcome?outcome.t:null,duration,durationSource,createdHere:wasNew,
                 at:new Date().toISOString(),
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
      <div class="krow"><span class="kk"><kbd>Esc</kbd></span><span>Leave the field you are in</span></div>
      <div class="krow"><span class="kk"><kbd>?</kbd></span><span>This sheet</span></div>
    </div></div>`;
  document.body.appendChild(s);
  s.onclick=e=>{if(e.target===s)s.remove();};
  document.getElementById("kx").onclick=()=>s.remove();
}

/* ── wiring ──────────────────────────────── */
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
  /* EVERY SHORTCUT BELOW IS A BARE KEY. Cmd, Ctrl and Alt belong to the
     browser, and outside a field this handler was reading them as its own:
     Cmd+C on the email selected in the call bar ran the "c" shortcut, so
     copying an address started the call timer, asked the host page to dial,
     and — when no dialler was found — wrote the PHONE NUMBER to the clipboard
     over the address that had just been copied. Cmd+F flagged the record for
     cleanup, Cmd+J and Cmd+K moved to a different one, and Cmd+1 through
     Cmd+4, which on a Mac switch browser tabs, each SET A STAGE on whatever
     record was open. */
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  const o=OUTCOMES.find(x=>x.k===e.key);
  if(o){e.preventDefault();setOutcome(o);return;}
  const k=e.key.toLowerCase();
  if(k==="c"){const a=rec(),p=a.phones.find(x=>x.primary)||a.phones[0];
    if(p&&p.value){
      startTimer("dial");   /* the keyboard shortcut IS a dial, like the button */
      /* window.location.href="tel:…" navigated the whole console frame away.
         Third of three tel: navigations; all now go through the host page. */
      const num=(p.cc+p.value).replace(/\s/g,"");
      if(typeof requestDial==="function")requestDial(num); else copyNumber(num);
    }
    return;}
  if(k==="f"){document.getElementById("flagBtn").click();return;}
  if(k==="j"||k==="k"){
    const rows=visible();const at=rows.findIndex(r=>r.i===cur);
    const nx=k==="j"?at+1:at-1;
    if(rows[nx]){cur=rows[nx].i;stopTimer();secs=0;render();resetScroll();}
    return;}
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
/* THE OUTBOX ONLY WORKS IF SOMETHING EMPTIES IT.
   queueSave held a failed save and told the associate it was "queued", and
   nothing in the extension ever called API.drain — not on the next save, not on
   boot, not when the proxy came back. The queue was a place saves went to be
   forgotten, with a toast promising the opposite. This is the missing half.

   It runs before the save that triggers it, so an outage's calls reach Kylas in
   the order they were made, and it hands back the kid a create earned so the
   live record stops being "pending" and the NEXT save updates it. */
async function flushOutbox(){
  if(!(await API.outboxSize()))return 0;
  const find=(job)=>DATA.find(a=>(job.lid&&a.lid===job.lid))
    ||DATA.find(a=>job.contact.kid&&String(a.kid)===String(job.contact.kid));
  const n=await API.drain(
    (job,res)=>{
      const a=find(job);if(!a)return;
      if(res?.kid&&!a.kid){a.kid=String(res.kid);a.pendingCreate=false;}
      a.syncError=res?.rejected
        ?"rejected: "+((res.problems||[]).filter(p=>p.blocking!==false).map(p=>p.why).join(" · ")||res.error)
        :null;
      if(!res?.rejected)a.syncedAt=new Date().toISOString();
    },
    /* Answers "was this contact created after the job was queued?" — the record
       is still on screen and carries the id the earlier save brought back. */
    (lid)=>DATA.find(a=>a.lid===lid&&a.kid)?.kid||"");
  if(n){persist();renderQueue();toast(`${n} queued save${n>1?"s":""} sent to Kylas`);}
  return n;
}

async function syncToKylas(a,call){
  a.syncing=true;renderQueue();
  await flushOutbox().catch(()=>{});
  const res=await API.queueSave(a,call);
  a.syncing=false;
  if(res.ok){
    /* ANY id coming back, not only one from a create. When the proxy recognises
       a retry of a save it already carried out, it answers with the id it made
       last time and `created:false` — and a record that took that answer as
       "no id for you" stayed pending and offered itself for creation again on
       the next save. The question is whether this record has an id, not which
       request earned it. */
    if(res.kid&&!a.kid){a.kid=String(res.kid);a.pendingCreate=false;}
    a.syncedAt=new Date().toISOString();
    /* Airtable is where the KPIs come from, so its failure has to surface even
       though Kylas took the write. */
    a.syncError=res.airtableError?("airtable: "+res.airtableError)
      :res.callLogError?("call log: "+res.callLogError):null;
  }else{
    a.syncError=res.error||"not sent";
  }
  persist();renderQueue();
  /* THREE outcomes, not two. A rejected VALUE is not an outage: telling the
     associate it is "queued" is a lie that never resolves, because every retry
     earns the same rejection. Name the field and say it is not queued. */
  if(res.rejected){
    const why=(res.problems||[]).filter(p=>p.blocking!==false).map(p=>p.why).join(" · ")||res.error;
    a.syncError="rejected: "+why;
    toast(`${a.pocName} NOT saved to Kylas — ${why}`,()=>{cur=DATA.indexOf(a);render();jump("f-ph");});
  }
  else if(!res.ok)toast(`${a.pocName} saved locally — Kylas unreachable, queued`);
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
  /* Yesterday's outage is this morning's queue. Draining on boot is what makes
     "keep dialling, it will go when the link is back" true without the
     associate having to save something else to trigger it. */
  flushOutbox().catch(()=>{});
}
boot();
