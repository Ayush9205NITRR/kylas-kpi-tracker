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
let OWNERS=[""];
/* NAME → KYLAS OWNER ID. The dropdown offers names because that is what a
   person recognises, but Kylas reassigns by id — and the card carried only the
   name, so picking a new owner changed the label and sent the OLD ownerId with
   the save. Re-assignment looked like it worked and did nothing.

   An owner whose id is not known is worse than useless here: sending no
   ownerId leaves the contact where it was (the payload replaces the record and
   the carry-over puts the old one back), so the UI has to refuse rather than
   pretend. ownerIdFor returns "" and the card says so. */
const OWNER_ID = Object.create(null);
function addOwners(names){
  for(const n of names){ if(n&&!OWNERS.includes(n))OWNERS.push(n); }
  OWNERS=[OWNERS[0],...OWNERS.slice(1).sort((a,b)=>a.localeCompare(b))];
}
/* The list as the server sends it: [{ id, name }]. */
function adoptOwners(list){
  /* Two shapes: [{ id, name }] from the server, and the bare names an older
     build wrote into storage. A name with no id still populates the dropdown;
     it just cannot be re-assigned TO until the server's list arrives. */
  const names=[];
  for(const o of list||[]){
    if(typeof o==="string"){ if(o)names.push(o); continue; }
    if(o?.name){ names.push(o.name); if(o.id!=null)OWNER_ID[o.name]=String(o.id); }
  }
  addOwners(names);
}
const ownerIdFor=(name)=>OWNER_ID[name]||"";
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
/* MQL IS NOT PRINTED (Ayush, 2026-09-30: "isme MQL kyon show hota hai, as in
   just state"). MQL is the ABSENCE of a signal, so on a roster where nearly
   every contact is one, the badge prints the same word on every row and says
   nothing — it is a label for "nothing has come back yet", taking the space
   next to the stage, which is the fact somebody is actually scanning for.
   "Right POC" is the news; MQL is the background.
   The derivation is untouched — rule 6 says MQL → Right POC is derived and
   never typed, not that it must always be on screen. It is still computed,
   still saved, still what the funnel counts. Only the chrome goes. */
const qualText=a=>hasSignal(a)?"Right POC":"";
/* swap just the badge — re-rendering the call bar would steal focus mid-typing.
   The element is always in the DOM, empty when there is nothing to say, so
   this stays a text swap and never has to insert a node mid-typing. */
function refreshQual(){
  const a=rec(),n=document.querySelector(".qual");
  if(!n)return;
  n.textContent=qualText(a);n.className="qual "+(hasSignal(a)?"poc":"mql");
  renderQueue();
}
const rec=()=>{const a=DATA[cur];
  for(const r of [...(a.past||[]),...(a.current||[])]) if(!r.rowKey)r.rowKey=rowKey();if(a.pastAsked===undefined)a.pastAsked=a.past.length?"yes":"";if(a.currAsked===undefined)a.currAsked=a.current.length?"yes":"";if(a.pitched===undefined)a.pitched=a.serviceOffering?"yes":"";return a;};
/* MIDNIGHT TO MIDNIGHT, ON THIS MACHINE. Both of these were toISOString(),
   which is the UTC day: in IST that is yesterday's date until 05:30, so a
   call logged at 02:00 was missing from Today and "tomorrow" on a call-back
   button was sometimes today. day.js. */
const today=()=>Day.today();
const dateIn=n=>Day.shift(n);
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
     <span class="sub"><i class="qual ${q==="MQL"?"mql":"poc"}">${esc(qualText(a))}</i>
     ${a.designation?`<span>${esc(a.designation)}</span>`:""}</span>`);
  C.appendChild(who);
  /* THE FOCUS LIST, TOP LEFT, UNDER THE COMPANY IT IS ABOUT — all three
     choices spelled out and big enough to hit without looking (Ayush,
     2026-09-27; it sat beside Save & next before, and as a pill before that). */
  const fb=focusBar(a);
  if(fb){const atco=who.querySelector(".atco");if(atco)atco.after(fb);else who.prepend(fb);}
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
  const pn=prevNotes(a,HIST.get(String(a.kid||""))||[]);
  if(pn)C.appendChild(pn);
  loadHistory(a);
  const nb=el("div","nextbtn");
  const btn=el("button","pbtn",`Save &amp; next <kbd style="border-color:rgba(255,255,255,.35);background:transparent;color:inherit">⏎</kbd>`);
  btn.type="button";btn.onclick=saveNext;nb.appendChild(btn);
  C.appendChild(nb);
}
/* WHAT WAS SAID LAST TIME, BEFORE THE DIAL TONE.
   Ayush, 2026-10-06: "I also want to fetch remarks (as previous notes) — chota
   sa preview dikhana." The notes were already on the record and the only place
   they appeared was the "Notes from the call" textarea, three blocks down and
   below the fold — so the one thing worth knowing before the call was the one
   thing nobody saw until after it.

   Collapsed to a line, because this sits in the 85% path: a no-answer must not
   pay for it. Click to open the whole thing.

   THE AUTO BLOCK IS NOT A NOTE. Kylas' remarks field carries a machine-written
   summary under "--- BD CONSOLE (auto, do not edit below) ---" that the save
   rewrites every time. Showing it back would fill the preview with the stage
   and owner the screen already states, and push the human sentence out of
   view. Only what a person typed is shown. */
/* THE NOTE MAY BE UNDER THE BLOCK, NOT ONLY OVER IT. Ayush, 2026-10-08:
   "notes for a number of companies are not showing up." The block is written
   at the top of a field that starts empty, so somebody typing in Kylas puts
   their note at the END — and splitting on the opening marker threw away
   everything from there on, which is to say their note. The block is cut out
   between its two markers now and both sides are kept.
   This mirrors stripAuto() in scripts/kylas.mjs, which the save uses; the two
   must agree, and test-remarks checks that they do. */
const MARK_AUTO="--- BD CONSOLE (auto, do not edit below) ---";
const MARK_END="--- END ---";
const humanNote=s=>{
  const t=String(s||"");
  const i=t.indexOf(MARK_AUTO);
  if(i<0)return t.trim();
  /* No closing marker means a truncated or pre-marker block: there is no way
     to know where it ended, so everything after it goes, as it always did. */
  const b=t.indexOf(MARK_END,i+MARK_AUTO.length);
  const tail=b<0?"":t.slice(b+MARK_END.length);
  return `${t.slice(0,i)}\n${tail}`.replace(/\n{3,}/g,"\n\n").trim();
};
/* THE CALLS THEMSELVES ARE WHERE THE NOTES ARE. Ayush, 2026-10-09: "Previous
   remarks fetch nahi ho rahe hai." This strip read the contact's remarks
   field and the event rows — but an associate's update after a call is typed
   on the CALL, in Kylas' dialler or in this console (which puts it on the
   Kylas call log too). So the server reads every call log on the contact
   (/history) and the strip leads with the newest of those.

   Fetched after the contact is painted, never before: the 85% path is open,
   no answer, next, and it must not wait on a second request. When the notes
   arrive the strip is swapped in place, and only if the same contact is still
   on screen. */
const HIST=new Map(), HIST_WAIT=new Set();
function loadHistory(a){
  const kid=String(a?.kid||"");
  if(!kid||HIST.has(kid)||HIST_WAIT.has(kid)||typeof API==="undefined"||!API.history)return;
  HIST_WAIT.add(kid);
  API.history(kid).then(r=>HIST.set(kid,Array.isArray(r?.items)?r.items:[]))
    .catch(()=>HIST.set(kid,[]))
    .finally(()=>{
      HIST_WAIT.delete(kid);
      const cur=rec();
      if(String(cur?.kid||"")!==kid||!(HIST.get(kid)||[]).length)return;
      const C=document.getElementById("callbar");if(!C)return;
      const box=prevNotes(cur,HIST.get(kid));if(!box)return;
      const old=C.querySelector(".pnote");
      if(old)old.replaceWith(box);else C.appendChild(box);
    });
}
/* One text, said twice, is read once. The console writes a call's note into
   the event rows AND onto the Kylas call log, so the same sentence arrives
   from both — compared without case or spacing, and a call note made only of
   pieces already shown (it joins the rows' remarks with " · ") is dropped. */
const normNote=s=>String(s||"").toLowerCase().replace(/\s+/g," ").trim();
function prevNotes(a,hist=[]){
  const bits=[],seen=new Set();
  /* Earlier calls first, newest at the top: the last thing said is the one
     the associate needs before the ringing starts. */
  const owns=[];
  const own=humanNote(a.remarks);
  const rows=[];
  for(const r of [...(a.past||[]),...(a.current||[])]){
    const t=humanNote(r.remarks);
    if(t)rows.push([[r.eventType,r.period==="past"?"past":""].filter(Boolean).join(" · "),t]);
  }
  /* Rows and remarks are claimed before the calls so a call note repeating
     them is the one dropped, not the labelled original. */
  if(own)owns.push(["",own]);
  for(const [f,t] of [...owns,...rows])seen.add(normNote(t));
  for(const h of hist.slice(0,5)){
    const n=normNote(h.text);
    if(!n||(n.includes(" · ")?n.split(" · ").every(p=>seen.has(p.trim())):seen.has(n)))continue;
    seen.add(n);
    bits.push({from:[h.at?since(h.at):"",h.outcome&&h.outcome!=="connected"?h.outcome:"",h.by].filter(Boolean).join(" · "),text:h.text});
  }
  for(const [f,t] of [...owns,...rows])bits.push({from:f,text:t});
  if(!bits.length)return null;
  const box=el("div","pnote");
  /* WHEN, NOT JUST WHAT. "Wants a Goa venue" means one thing said last week
     and another said in March, and the associate is deciding in the second
     before the ringing starts. The contact's last call is the only date the
     record actually carries for a note, so it labels the whole strip rather
     than pretending each line has its own. */
  /* The newest dated thing on the strip: a call log's own time when there is
     one, the contact's last call otherwise. */
  const newest=[hist[0]?.at,a.lastCallAt].filter(Boolean).sort().pop();
  const when=newest?since(newest):"";
  const full=bits.map(b=>(b.from?b.from+": ":"")+b.text).join("  ·  ");
  const one=full.length>150?full.slice(0,150).replace(/\s+\S*$/,"")+"…":full;
  box.innerHTML=`<button type="button" class="pnx" aria-expanded="false">
      <em>Said before${when?` · ${esc(when)}`:""}</em><span class="pns">${esc(one)}</span>
      ${full.length>150?'<i class="pnmore">more</i>':""}</button>
    <div class="pnall" hidden>${bits.map(b=>`<p>${
      b.from?`<em>${esc(b.from)}</em>`:""}${esc(b.text)}</p>`).join("")}</div>`;
  const btn=box.querySelector(".pnx"),all=box.querySelector(".pnall"),
        mo=box.querySelector(".pnmore");
  btn.onclick=()=>{const open=all.hidden;all.hidden=!open;
    btn.setAttribute("aria-expanded",String(open));
    box.classList.toggle("open",open);
    /* It read "more" while already open, which is the one thing the word
       cannot mean there. */
    if(mo)mo.textContent=open?"less":"more";};
  return box;
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
/* The day the call fell on HERE, not its UTC date — a call at 02:00 IST
   belongs to this morning's list, and used to be filed under yesterday. */
const calledToday=a=>Day.isToday(a.lastCallAt);
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
  /* Repainted on its own whenever a save job moves, every few seconds while
     one is in flight — the list must stay where it was scrolled to. */
  const Q=document.querySelector(".queue"),qTop=Q?Q.scrollTop:0;
  try{paintQueue();}finally{if(Q)Q.scrollTop=qTop;}
}
function paintQueue(){
  renderMode();renderScope();renderFocusPane();renderFilters();
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
        ${q==="MQL"?"":`<span class="badge poc">${esc(q)}</span>`}
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
        ${last?`<i class="when" title="Last call ${esc(Day.dayOf(a.lastCallAt))}">${esc(last)}</i>`:""}
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
/* CALLS TODAY, THE SAME NUMBER THE PROGRESS TABLE SHOWS.
   Ayush, 2026-10-09: "The calling count is different in both the tab pane" —
   the header read "Calls 6" while Progress read 17 for the same day, same
   associate. They were counting different things:

     header    contacts in THIS browser's queue marked done today — one per
               CONTACT (two calls to one person counted once), only what this
               browser saved (a second laptop, or a profile that was reset,
               invisible), and keyed by Kylas id at boot, so a contact CREATED
               today had no id when its call was logged and dropped out of the
               count on the next reload
     Progress  every call row the server holds for this associate, today

   The header now shows the server's count for today — /report for "me", the
   same rows the Progress table's Day view is cut from — so the two cannot
   disagree once the server has caught up. Between refreshes this browser's
   own saves are the floor: max, never the sum, because every one of them is
   also in the server's number once it lands, and adding them would count it
   twice. */
/* THE SERVER'S NUMBER, PLUS EVERY SAVE IT CANNOT HAVE SEEN YET.
   A plain max(server, this browser's saves) was tried first and failed in the
   browser: with five calls on the server and one saved here, max read 5 — the
   associate pressed Save and the counter did not move. So each save made here
   is an entry that counts on top of the server's number until a refresh that
   STARTED after that save landed has brought the server's number back. Before
   then the server cannot include it; after, it must, and counting it again
   would show one call twice. */
const PACE={server:null,day:"",local:0,pend:[]};
function paceCount(){
  const t=today();
  if(PACE.day!==t){PACE.day=t;PACE.server=null;PACE.local=0;PACE.pend=[];}
  return PACE.server==null?PACE.local:PACE.server+PACE.pend.length;
}
/* A save made here: counted at once. `need` is the server count at which this
   save is certainly inside the server's number — what the server said when it
   was made, plus the saves ahead of it still on their way, plus itself. A
   "done" job is NOT enough on its own: the report reads a copy of the call
   log that trails a save by up to a minute, and retiring a save on the first
   answer after it landed made the header read 7, 6, 7. */
function paceSaved(a){
  paceCount();PACE.local++;
  /* WHOSE CALL. The server credits a call to the CONTACT'S owner (the Call
     Log row is written with c.owner), not to whoever pressed Save — so a call
     made on a colleague's contact is in THEIR number, and counting it on top
     of mine here put the header one ahead of the Progress table for two
     minutes, until it gave up waiting. Only a save the server will credit to
     me is counted ahead of it. Unknown either way, it is counted. */
  if(ME&&a?.owner&&String(a.owner).trim().toLowerCase()!==String(ME).trim().toLowerCase()){renderPace();return {job:"",doneAt:0,need:null,notMine:true};}
  const e={job:"",doneAt:0,need:PACE.server==null?null:PACE.server+PACE.pend.length+1};
  PACE.pend.push(e);renderPace();return e;
}
/* The oldest save not yet tied to anything — saves leave in the order made,
   which is the order the outbox drains them in. */
const paceLoose=()=>PACE.pend.find(e=>!e.job&&!e.doneAt);
const paceLanded=(e)=>{if(e&&!e.doneAt)e.doneAt=Date.now();};
const paceJob=(id)=>PACE.pend.find(e=>e.job===id);
/* NOT DROPPED ON A REFUSAL, because a refusal does not mean the server did
   not count it. A save that Kylas refuses still writes its call row to the KPI
   base first — performSave lets Airtable finish before it reports the failure
   — and the Progress table counts that row. Taking it off the header made the
   two disagree in exactly the way this exists to stop. So a refused or dead
   save is treated as landed, and the server's count decides: it retires when
   the count reaches it, or, if the server never wrote it, once it has had
   longer than the call-log copy takes to catch up. */
const PACE_SETTLE_MS=2*60*1000;
function renderPace(){
  const n=paceCount();
  document.getElementById("pcount").textContent=n;
  document.getElementById("ptarget").textContent="/ "+target;
  document.getElementById("pbar").style.width=Math.min(100,n/target*100)+"%";
}
let paceBusy=false;
async function refreshPace(){
  if(paceBusy||typeof API==="undefined"||!API.report)return;
  paceBusy=true;
  const t=today();
  const asked=Date.now();
  try{
    const r=await API.report("day","",t,t);
    const row=(r?.periods||[]).find(p=>p.key===t);
    if(row&&today()===t){
      const n=Number(row.calls)||0;
      if(PACE.server==null){
        /* The first answer of the day: a save that had already landed when
           it was asked is inside it; the rest are given their mark now. */
        PACE.pend=PACE.pend.filter(e=>!(e.doneAt&&e.doneAt<asked));
        PACE.pend.forEach((e,i)=>{if(e.need==null)e.need=n+i+1;});
      }else{
        /* Retired only once LANDED and once the server's count has reached
           the mark — never on "done" alone. */
        PACE.pend=PACE.pend.filter(e=>!(e.doneAt&&e.doneAt<asked&&
          ((e.need!=null&&n>=e.need)||asked-e.doneAt>PACE_SETTLE_MS)));
      }
      PACE.day=t;PACE.server=n;
      renderPace();
    }
  }catch{/* offline: what this browser counted stands */}
  finally{paceBusy=false;}
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
/* ── THE FOCUS PANE: WHAT YOU OWE YOUR FOCUS ACCOUNTS ────────────────────
   Once an account is picked (★ Focus) it stays in front of you until it is
   exhausted — it reaches SQL — or you drop it with a reason (Deprioritize).
   There is no third way off. Each one says what it is owed: overdue first,
   then due today, then those with no call-back set at all (which is its own
   kind of overdue — nothing is scheduled to happen). Under Today it is the
   full list; under Company it is one line pointing there, so it is never
   out of sight. */
const FOCUS_ORDER={overdue:0,today:1,"no-date":2,closed:3,later:4,done:5};
function myFocus(){
  if(typeof Focus==="undefined")return [];
  const u=API.state?.user||{},me=String(u.name||"").toLowerCase(),em=String(u.email||"").toLowerCase();
  return Object.entries(Focus.map)
    .filter(([,f])=>f.status==="focus")
    .filter(([,f])=>API.isAdmin||String(f.ownerName||"").toLowerCase()===me||String(f.setByEmail||"").toLowerCase()===em
      ||String(f.setByEmail||"").toLowerCase()===me)
    .map(([id,f])=>({id,f,s:f.standing||{state:"no-date"}}))
    .sort((x,y)=>(FOCUS_ORDER[x.s.state]??9)-(FOCUS_ORDER[y.s.state]??9)
      ||(x.s.nextCall||"").localeCompare(y.s.nextCall||"")||(y.s.daysOpen||0)-(x.s.daysOpen||0));
}
function focusStateText(s){
  return s.state==="overdue"?`Overdue ${-s.dueIn}d`
    :s.state==="today"?"Due today"
    :s.state==="no-date"?"No call-back set"
    :s.state==="closed"?"All POCs closed"
    :s.state==="done"?`SQL ✓${s.tatDays!=null?` in ${s.tatDays}d`:""}`
    :`In ${s.dueIn}d`;
}
function renderFocusPane(){
  const w=document.getElementById("qfocus");if(!w)return;
  if(typeof Focus==="undefined"){w.hidden=true;return;}
  Focus.load();
  const all=myFocus(),open=all.filter(x=>x.s.state!=="done");
  if(!all.length){w.hidden=true;w.innerHTML="";return;}
  w.hidden=false;w.innerHTML="";
  const n=k=>open.filter(x=>x.s.state===k).length;
  const owed=n("overdue")+n("today")+n("no-date");
  const head=el("div","qfh",`<b>★ Focus</b><span>${open.length} open${owed?` · <em>${owed} need a call</em>`:""}</span>`);
  w.appendChild(head);
  if(mode!=="session"){
    /* Company tab: never out of sight, one line. */
    if(owed){
      const go=el("button","qfgo",`${n("overdue")?`${n("overdue")} overdue · `:""}${n("today")?`${n("today")} due today · `:""}${n("no-date")?`${n("no-date")} with no call-back`:""}`.replace(/ · $/,"")+" — see Today →");
      go.type="button";go.onclick=()=>{mode="session";render();};
      w.appendChild(go);
    }
    return;
  }
  const ul=el("ul","qfl");
  const shown=[...open,...all.filter(x=>x.s.state==="done").slice(0,3)];
  shown.forEach(({id,f,s})=>{
    const li=el("li"),b=el("button","qfi "+s.state);b.type="button";
    b.innerHTML=`<span class="n">${esc(f.companyName||"#"+id)}</span>
      <span class="st">${esc(focusStateText(s))}</span>
      <span class="sub">${esc([label(s.stage)||"not called yet",s.daysOpen!=null?`day ${s.daysOpen}`:"",
        s.lastCallAt?`last call ${since(s.lastCallAt)}`:"",API.isAdmin&&f.ownerName?String(f.ownerName).split(" ")[0]:""].filter(Boolean).join(" · "))}</span>`;
    b.title=s.state==="closed"?"Every POC here is at a dead end: add a new POC or deprioritize with a reason"
      :s.state==="no-date"?"Nothing is scheduled: open it and set a day to call back":"Open this company";
    b.onclick=()=>window.openCompanyFromView?.(id,f.companyName||"");
    li.appendChild(b);ul.appendChild(li);
  });
  w.appendChild(ul);
  /* TAT, for the person looking (or the team, for an admin). */
  const T=Focus.tat||{},rows=Object.entries(T).filter(([o])=>API.isAdmin||o.toLowerCase()===String(API.state?.user?.name||"").toLowerCase());
  if(rows.length){
    const t=el("div","qft");
    t.innerHTML=rows.map(([o,v])=>`<div><b>${esc(API.isAdmin?o.split(" ")[0]:"Your pace")}</b>
      ${v.medianPickToSql!=null?`<span>pick → SQL <em>${v.medianPickToSql}d</em></span>`:""}
      ${v.medianDaysOpen!=null?`<span>open for <em>${v.medianDaysOpen}d</em></span>`:""}
      ${v.followups?.onTimePct!=null?`<span>call-backs on time <em>${v.followups.onTimePct}%</em></span>`:""}
      ${v.followups?.medianDelayDays?`<span>late by <em>${v.followups.medianDelayDays}d</em></span>`:""}</div>`).join("");
    t.title="Median days from ★ Focus to SQL; median days the open ones have been open; share of promised call-backs made on or before the day; median lateness of the rest.";
    w.appendChild(t);
  }
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

/* A REPAINT KEEPS THE PLACE; MOVING TO ANOTHER RECORD RESETS IT.
   render() rebuilds both panes from scratch, and it runs for reasons the
   associate did not cause — a company's contacts arriving from Kylas, a save
   job finishing, the notes of earlier calls landing. Each one put the panes
   back at the top and took the caret out of the field being typed in (Ayush,
   2026-10-10: "scroll baar baar vapas chale jaate hai"). So the scroll and the
   focused field come back after every paint, and the places that really do
   change record call resetScroll() after render(), as they always did. */
const SCROLLERS=["scrollL","scrollR","scrollX"];
function placeOf(){
  const q=document.querySelector(".queue");
  const act=document.activeElement,id=act&&act.id&&act!==document.body?act.id:"";
  let sel=null;try{if(id)sel=[act.selectionStart,act.selectionEnd];}catch{/* not a text box */}
  return{tops:SCROLLERS.map(i=>document.getElementById(i)?.scrollTop||0),q:q?q.scrollTop:0,id,sel};
}
function putPlace(p){
  SCROLLERS.forEach((i,n)=>{const e=document.getElementById(i);if(e)e.scrollTop=p.tops[n];});
  const q=document.querySelector(".queue");if(q)q.scrollTop=p.q;
  if(!p.id)return;
  const back=document.getElementById(p.id);
  if(!back||document.activeElement===back)return;
  back.focus({preventScroll:true});
  try{if(p.sel&&p.sel[0]!=null)back.setSelectionRange(p.sel[0],p.sel[1]);}catch{/* not a text box */}
}
function render(){
  const p=placeOf();
  renderCallbar();renderQueue();renderPace();renderBasic();renderRight();renderResearchPane();validate();
  putPlace(p);
}
/* Research has its own pane to the right of the events when the screen is
   wide enough (or as the third tab when it is narrow); in between it sits at
   the top of the events pane. */
const RES_PANE=matchMedia("(min-width:1281px), (max-width:960px)");
const researchInPane=()=>RES_PANE.matches;
RES_PANE.addEventListener?.("change",()=>{if(DATA[cur])render();});
function renderResearchPane(){
  const X=document.getElementById("formX");if(!X)return;
  X.innerHTML="";
  if(researchInPane())X.appendChild(researchCard(rec()));
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
  /* TWO OR MORE TAKE THE CARD'S FULL WIDTH. A multi-entry row is radio, type,
     code, number, dial and remove — about 400px — and a column of the two-up
     grid is about 230. The row ran out of its column: the number box shrank to
     nothing and the dial button slid under the LinkedIn field beside it
     (Ayush's screenshot, 2026-10-10). One entry still fits in a column. */
  const f=el("div",list.length>1?"f wide":"f");
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
  /* RE-ASSIGNING THE OWNER, and only on this contact.
     Ayush, 2026-09-30: re-assigning a COMPANY in Kylas drags its contacts with
     it and they land on Enout Super Admin. Nothing here writes a company —
     updateCompany exists in the client and no code path calls it — so this
     moves the one contact and nothing else.
     The id travels with the name, or the save would carry the old one. */
  grid.appendChild(field("Owner","f-ow",true,select("f-ow",OWNERS,a.owner,(v)=>{
    a.owner=v;
    a.ownerId=ownerIdFor(v);
    /* Picked a name this console has no id for: say it here rather than let
       the save quietly keep the previous owner. */
    const warn=document.getElementById("f-ow-warn");
    if(warn)warn.hidden=!(v&&!a.ownerId);
    touch("record");
  })));
  {
    const w=el("p","fwarn","This owner is not in the list Kylas sent, so the contact cannot be re-assigned to them. Refresh, or pick another.");
    /* Hidden until somebody PICKS an owner we cannot resolve. On first paint
       the ids may not have arrived yet, and a warning about the owner the
       contact already has would be a false alarm on every open. */
    w.id="f-ow-warn";w.hidden=true;
    grid.lastChild.appendChild(w);
  }
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
    b.onclick=()=>{a.nextCallDate=Day.shift(n);render();};
    qc.appendChild(b);
  });
  ncd.appendChild(qc);

  const sRow=el("div","g2");
  sRow.appendChild(field("Stage","f-stage",false,select("f-stage",STAGES,a.stage,v=>{a.stage=v;render();})));
  sRow.appendChild(ncd);

  const rRow=el("div","g2");
  /* humanNote, not a.remarks: Kylas' field carries a machine-written summary
     under the auto marker, and it was being handed to the associate to edit —
     stage, owner and call-back restated inside the box meant for what the
     prospect said. The save rewrites that block from the record anyway, so
     nothing is lost by never showing it. */
  rRow.appendChild(field("Notes from the call","f-rm",false,
    textarea("f-rm",humanNote(a.remarks),"Whatever they said",v=>a.remarks=v)));
  /* Offsite timeline moved to "Before you hang up" on the right. It is not
     where the account STANDS — it is something the prospect tells you, like
     who handles this for them today and whether the pitch got in, and those
     are already over there. Sitting next to the call notes it was also on
     screen for every no-answer call, which is the 65% that never gets near it. */

  /* ORDER: WHO, THEN WHERE THIS STANDS — Ayush's call, 2026-09-24.
     From 2026-09-19 to 1.16.3 "Where this stands" came first, on the argument
     that stage and call-back are filled on every call and identity is a copy
     of the header band. Ayush asked for the original order back: the person
     you are calling first, then what happened. Do not flip it again without
     asking. */
  W.appendChild(whoCard);
  W.appendChild(group("Where this stands",[sRow,rRow]));
}

/* ── THE ACCOUNT: FOCUS LIST (second pane) AND RESEARCH (third pane) ────
   Both are about the COMPANY, not the person on the line, so they are the
   same whichever contact at the company is open.

   Focus list: ★ Focus / Not picked / Deprioritize (with a reason), one status
   per company, kept in Airtable's Focus table (focus.js). In the second
   pane, beside the stage and call-back — it is a decision about the account.

   Research: the team's own curated row for the company — Company Database →
   "Company List", keyed by the Kylas company id: size, LinkedIn, source,
   funding, revenue, pipeline stage, the Boolean post. Read-only, in four sections, and
   edited in Airtable, so there is one copy of it, not two. Collapsed to one
   line, so the 85% no-answer case pays nothing for it. */
const RESEARCH_SECTIONS=[
  {t:"The company",f:[
    {l:"Employees",k:["No. of Employees (kylas)"]},
    {l:"LinkedIn",k:["linkedin - Appollo"],link:1,wide:1},
    {l:"Source",k:["Source - Concatenate"],wide:1}]},
  {t:"Funding",f:[
    {l:"Total funding",k:["Total Funding"],money:1},
    {l:"Latest round",k:["Latest Funding Type"]},
    {l:"Latest round amount",k:["Latest Funding Amount"],money:1}]},
  {t:"Revenue",f:[
    {l:"Annual revenue",k:["Annual Revenue"],money:1},
    {l:"Revenue per employee",k:["at_rev_per_employee"],money:1}]},
  {t:"Pipeline & signals",f:[
    {l:"Account pipeline stage",k:["Account Pipeline Stage"]},
    {l:"Boolean post",k:["Boolean Post link - kylas","Boolean - New","Boolean Post Link (Demand Team)"],link:1,wide:1}]}];
/* companyId -> { state: "loading"|"ok"|"error", data, error } */
const RES=new Map();
let RES_OPEN=false, RES_FOR="";
/* The Deprioritize form, open or not, and what is typed in it. */
let FOC_FORM=null, FOC_FOR="";
const hasAPI=()=>typeof API!=="undefined"&&API&&typeof API.research==="function";
function loadResearch(id){
  /* A failure is not kept: tried again after 15 s, or at once from the
     button. The first ask can land before the console has connected. */
  const had=RES.get(id);
  if(!id||(had&&!(had.state==="error"&&Date.now()-had.at>15000)))return;
  RES.set(id,{state:"loading"});
  if(!hasAPI()){RES.set(id,{state:"error",error:"Research needs the server."});return;}
  API.research(id).then(r=>{
    RES.set(id,r&&r.configured===false
      ?{state:"error",error:"The server has no research base configured (RESEARCH_BASE).",at:Date.now()}
      :r&&r.error?{state:"error",error:r.error,at:Date.now()}
      :{state:"ok",data:r||{}});
  }).catch(e=>{
    const tries=(had?.tries||0)+1;
    RES.set(id,{state:"error",error:e.message||String(e),at:Date.now(),tries});
    /* Once, by itself, a moment later: the usual cause is asking before the
       console has finished connecting. */
    if(tries===1)setTimeout(()=>{if(RES.get(id)?.state==="error"){RES.set(id,{...RES.get(id),at:0});paintResearch();}},3000);
  })
    .finally(()=>paintResearch());
}
/* Apollo's figures are dollars: $8.5M, $220K. */
const money=v=>{const n=Number(v);if(!isFinite(n)||String(v).trim()===""||/[a-z$₹]/i.test(String(v)))return String(v);
  if(!n)return "";const a=Math.abs(n);
  return "$"+(a>=1e9?(n/1e9).toFixed(1)+"B":a>=1e6?(n/1e6).toFixed(1)+"M":a>=1e3?Math.round(n/1e3)+"K":n);};
function rVal(F,f){
  let v=f.k.map(k=>F[k]).find(x=>x!==undefined&&String(x).trim()!=="");
  if(v===undefined)return "";
  v=String(v);
  if(f.money)v=money(v);
  return v;
}
const rHTML=(f,v)=>f.link&&/^https?:|^www\./i.test(v)
  ?`<a href="${esc(/^www\./i.test(v)?"https://"+v:v)}" target="_blank" rel="noopener">${esc(v.replace(/^https?:\/\/(www\.)?/i,"").slice(0,48))} ↗</a>`
  :esc(v);
const RES_ALL=RESEARCH_SECTIONS.flatMap(s=>s.f);
function researchCard(a){
  const id=accountOf(a).id;
  const c=el("section","card");c.id="s-research";
  /* Its own pane has the room: open. Folded when it shares the events pane. */
  if(RES_FOR!==id){RES_FOR=id;RES_OPEN=researchInPane();}
  c.appendChild(el("div","cardH",`<h2>Account research</h2><span class="sub"></span>`));
  const b=el("div","cardB grp");c.appendChild(b);
  if(!id){b.appendChild(el("p","rs-note","Link this contact to a company to see its research."));return c;}
  loadResearch(id);
  const st=RES.get(id)||{state:"loading"};
  if(st.state==="loading"){b.appendChild(el("p","rs-note","Reading this company's research…"));return c;}
  if(st.state==="error"){
    b.appendChild(el("p","rs-note",esc(st.error)));
    const again=el("button","gbtn sm","Try again");again.type="button";
    again.onclick=()=>{RES.delete(id);paintResearch();};
    const f=el("div","rs-foot");f.appendChild(again);b.appendChild(f);
    return c;
  }
  const d=st.data||{},F=d.fields||{};
  if(!d.found){
    b.appendChild(el("p","rs-note",`This company has no row in the Company List yet.`));
    return c;
  }
  const filled=RES_ALL.filter(f=>rVal(F,f)).length;
  c.querySelector(".sub").textContent=`${filled} of ${RES_ALL.length} known`;
  if(RES_OPEN){
    for(const sec of RESEARCH_SECTIONS){
      const rows=sec.f.map(f=>[f,rVal(F,f)]);
      const n=rows.filter(([,v])=>v).length;
      b.appendChild(el("h3","rsec-h",`${esc(sec.t)}<span>${n} of ${sec.f.length}</span>`));
      b.appendChild(el("dl","rlist",rows.map(([f,v])=>
        `<div class="${f.wide?"wide":""}"><dt>${esc(f.l)}</dt><dd class="${v?"":"no"}">${v?rHTML(f,v):"—"}</dd></div>`).join("")));
    }
  }else{
    const g=(l)=>rVal(F,RES_ALL.find(f=>f.l===l));
    const top=[g("Employees")&&g("Employees")+" employees",g("Account pipeline stage")].filter(Boolean).map(esc).join(" · ");
    const more=[["Funding",g("Total funding")],["Latest",[g("Latest round"),g("Latest round amount")].filter(Boolean).join(" ")],
      ["Revenue",g("Annual revenue")],["Per employee",g("Revenue per employee")]]
      .filter(([,v])=>v!=="").map(([k,v])=>`<span><b>${k}:</b> ${esc(v)}</span>`).join("");
    b.appendChild(el("div","rsnap",(top?`<p class="rs-top">${top}</p>`:"")+(more?`<p class="rs-more">${more}</p>`:"")||`<p class="rs-note">Nothing filled in yet.</p>`));
    b.appendChild(el("p","rsec-meter",RESEARCH_SECTIONS.map(sec=>{const n=sec.f.filter(f=>rVal(F,f)).length;
      return `<span class="${n===sec.f.length?"full":n?"some":""}">${esc(sec.t)} ${n}/${sec.f.length}</span>`;}).join("")));
  }
  const acts=el("div","rs-foot");
  const more=el("button","gbtn sm",RES_OPEN?"Show less":"Show all research");more.type="button";
  more.onclick=()=>{RES_OPEN=!RES_OPEN;paintResearch();};
  acts.appendChild(more);
  if(d.url){const o=el("a","gbtn sm","Open in Airtable ↗");o.href=d.url;o.target="_blank";o.rel="noopener";acts.appendChild(o);}
  b.appendChild(acts);
  return c;
}
function paintResearch(){
  const old=document.getElementById("s-research");
  if(!old||cur==null||!DATA[cur])return;
  old.replaceWith(researchCard(rec()));
}

/* ★ Focus / Not picked / Deprioritize, for the company this contact is at. */
/* The account this card is about: the company the console is open on, else
   the contact's own. The header's ★ uses the same, so the two cannot disagree. */
const accountOf=a=>({id:String((typeof scope!=="undefined"&&scope?.id)||a.companyId||""),
  name:(typeof scope!=="undefined"&&scope?.name)||a.company||""});
function focusBar(a){
  const {id,name}=accountOf(a);
  if(!id||typeof Focus==="undefined")return null;
  if(FOC_FOR!==id){FOC_FOR=id;FOC_FORM=null;}
  Focus.load();
  const st=Focus.of(id),E=Focus.entry(id);
  const w=el("div","hfocus "+st);
  /* What the status says, on the caption line — a line of its own made the
     whole header jump in height every time the status changed. */
  const said=st==="depri"&&E?`Dropped: ${E.reason||"no reason given"}${E.note?` — “${E.note}”`:""}`
    :st==="focus"&&E?.setAt?`since ${dayAgo(E.setAt)}`:"";
  const cap=said?el("span","hfl",esc(said)):null;
  if(cap)cap.title=said;
  const seg=el("div","hseg");seg.setAttribute("role","group");seg.setAttribute("aria-label","Focus list for "+(name||"this company"));
  [["focus","★ Focus"],["normal","Not picked"],["depri","Deprioritize"]].forEach(([k,l])=>{
    const bb=el("button",k,l);bb.type="button";
    bb.setAttribute("aria-pressed",String(FOC_FORM?k==="depri":st===k));
    bb.title=k==="focus"?"Put this company on your focus list":k==="normal"?"Not on any list":"Drop this company — you will be asked why";
    bb.onclick=()=>{
      if(k==="depri"){FOC_FORM=FOC_FORM?null:{reason:E?.reason||Focus.REASONS[0],note:E?.note||""};renderCallbar();
        document.querySelector(".hfocus .fform select")?.focus();return;}
      FOC_FORM=null;
      if(st===k){renderCallbar();return;}
      setFocusFor(a,id,{status:k});
    };
    seg.appendChild(bb);
  });
  w.appendChild(seg);
  if(cap)w.appendChild(cap);
  if(FOC_FORM){
    const f=el("div","fform");
    const r=el("select","in");r.setAttribute("aria-label","Why deprioritize");
    r.innerHTML=Focus.REASONS.map(x=>`<option${x===FOC_FORM.reason?" selected":""}>${esc(x)}</option>`).join("");
    r.onchange=e=>FOC_FORM.reason=e.target.value;
    const n=el("input","in");n.type="text";n.placeholder="One line on why (optional)";n.value=FOC_FORM.note;
    n.setAttribute("aria-label","Note");n.oninput=e=>FOC_FORM.note=e.target.value;
    n.onkeydown=e=>{if(e.key==="Enter")go.click();if(e.key==="Escape")no.click();};
    const go=el("button","pbtn","Deprioritize");go.type="button";
    go.onclick=()=>{const {reason,note}=FOC_FORM;FOC_FORM=null;setFocusFor(a,id,{status:"depri",reason,note});};
    const no=el("button","gbtn","Cancel");no.type="button";no.onclick=()=>{FOC_FORM=null;renderCallbar();};
    f.append(r,n,no,go);w.appendChild(f);
  }
  return w;
}
async function setFocusFor(a,id,{status,reason="",note=""}){
  try{
    await Focus.set(id,{status,reason,note,companyName:accountOf(a).name||a.company||"",ownerName:a.owner||"",setBy:ME||""});
    toast(status==="focus"?"On the focus list.":status==="depri"?"Deprioritized.":"Taken off the list.");
  }catch(e){toast("Not saved — "+(e.message||e));}
}
/* The header only, so an answer arriving mid-call never moves the caret. */
if(typeof Focus!=="undefined")Focus.onChange(()=>{if(DATA[cur])renderCallbar();renderFocusPane();});
function dayAgo(iso){
  const d=Math.floor((Date.now()-new Date(iso).getTime())/864e5);
  return isNaN(d)?"":d<=0?"today":d===1?"yesterday":d+" days ago";
}

function renderRight(){
  const a=rec(),F=document.getElementById("formR");F.innerHTML="";
  const n=a.past.length+a.current.length;
  document.getElementById("phR").textContent=n?n+(n===1?" event":" events"):"nothing yet";
  document.getElementById("tabCount").textContent=n?String(n):"";

  /* Account research lives in its own pane to the right (renderResearchPane).
     Only when there is no room for that pane does it sit here, first, folded
     to one line so it costs the empty call almost nothing. */
  if(!researchInPane())F.appendChild(researchCard(a));

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
  /* No Offsite timeline here (Ayush, 2026-09-24): it is an ACCOUNT fact,
     read from the event rows' "when?" and Kylas' own company field, and shown
     on the Accounts view — not one more field on a contact's card. */

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

/* ── WHEN IS IT · quarter, then month, then week ───────────────────────
   Ayush, 2026-09-29: "Timeline (Quarter) — Jan-Mar, Apr-June … once selected
   quarter can lower down on month and week", on Past rows as well as Now.

   The quarters are the CALENDAR ones, because those are the four buckets
   Kylas' Offsite Timeline field holds and the four the accounts filter counts
   — not the financial year. (The old chips said "Q3 FY27", which is a
   different thing said in the same number of characters, and the quarter that
   reaches Kylas has to be the one Kylas means.)

   THE FIELD IS STILL FREE TEXT. That is non-negotiable #2 and it is right: a
   prospect says "August, maybe the second week, not signed off" and all of
   that has to survive. So a chip does not own the field — it writes a phrase
   into it and remembers the phrase, so the next chip REPLACES that phrase and
   leaves everything else the associate typed exactly where it was.

   What lands in Kylas follows from the text, not from the chips: offsite.js
   reads the quarter back out of whatever is written, so "Aug" and "second
   week of August" and "Q3" all derive JUL_SEP without the picker being in the
   loop at all. */
const QTRS=[{k:"JAN_MAR",t:"Jan–Mar",m:[0,1,2]},{k:"APR_JUN",t:"Apr–Jun",m:[3,4,5]},
            {k:"JUL_SEP",t:"Jul–Sep",m:[6,7,8]},{k:"OCT_DEC",t:"Oct–Dec",m:[9,10,11]}];
const MON3=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/* Write the phrase into the free text, replacing the one the picker put there
   last. Never touches anything else in the field. */
function putPhrase(i,r,next,size){
  const old=r.tlPhrase||"";
  let v=String(r.timeline||"");
  if(old&&v.includes(old))v=v.replace(old,next);
  else v=v.trim()?next+", "+v.trim():next;
  r.timeline=v.replace(/^[,\s]+|[,\s]+$/g,"").replace(/,\s*,/g,",");
  r.tlPhrase=next;i.value=r.timeline;size();
}

function timelineStrip(strip,i,r,size){
  strip.innerHTML="";
  const tl=r.tl||(r.tl={q:"",m:null,w:0});
  const row=(label)=>{const d=el("div","qrow");d.appendChild(el("span","lbl",label));strip.appendChild(d);return d;};
  const chip=(parent,text,on,fn)=>{
    const b=el("button","qc"+(on?" on":""),esc(text));b.type="button";b.tabIndex=-1;
    b.setAttribute("aria-pressed",on?"true":"false");
    b.onmousedown=e=>e.preventDefault();
    b.onclick=()=>{fn();touch("record");refreshQual();validate();timelineStrip(strip,i,r,size);i.focus();};
    parent.appendChild(b);return b;
  };
  const write=()=>{
    const next=tl.m==null?(QTRS.find(q=>q.k===tl.q)||{}).t||"":MON3[tl.m]+(tl.w?", week "+tl.w:"");
    if(next)putPhrase(i,r,next,size);
  };

  const r1=row("Quarter:");
  QTRS.forEach(q=>chip(r1,q.t,tl.q===q.k,()=>{
    if(tl.q===q.k){tl.q="";tl.m=null;tl.w=0;}      /* tapping it again clears it */
    else{tl.q=q.k;tl.m=null;tl.w=0;}
    write();
  }));
  chip(r1,"Not decided",false,()=>{tl.q="";tl.m=null;tl.w=0;putPhrase(i,r,"Not decided",size);});

  if(tl.q){
    const q=QTRS.find(x=>x.k===tl.q);
    const r2=row("Month:");
    q.m.forEach(m=>chip(r2,MON3[m],tl.m===m,()=>{tl.m=tl.m===m?null:m;tl.w=0;write();}));
    chip(r2,"Whole quarter",tl.m==null,()=>{tl.m=null;tl.w=0;write();});
  }
  if(tl.q&&tl.m!=null){
    const r3=row("Week:");
    [1,2,3,4].forEach(w=>chip(r3,"Week "+w,tl.w===w,()=>{tl.w=tl.w===w?0:w;write();}));
    chip(r3,"Any week",!tl.w,()=>{tl.w=0;write();});
  }
  /* The rest of what an associate says about timing, still one tap away. */
  const r4=row("Add:");
  ["Tentative","Not signed off","Same as last year"].forEach(t=>chip(r4,t,false,()=>{
    const v=(i.value||"").trim();
    i.value=v?v+(/[,;]$/.test(v)?" ":", ")+t:t;r.timeline=i.value;size();
  }));
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
      if(chips===QUICK.timeline){timelineStrip(strip,i,r,size);return;}
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
  /* THE NEXT CALL DATE, ONE RULE. Ayush, 2026-10-10: required on the stages
     where the account is still moving — NEXT_CALL_STAGES, from stages.json —
     and on nothing else. It used to be three rules (the CNC ladder, the meeting
     stages, and everything from Activation up) which between them demanded a
     date on SQL and Active Requirement Call Done, where nobody calls again,
     and on CNC 3, where the ladder ends; and did not ask for one on Connect
     Later, which is a promise to call. On a meeting stage the date IS the
     meeting, so it is asked for by that name. */
  need(NEXT_CALL_STAGES.includes(a.stage)&&!a.nextCallDate,
       MEETING_STAGES.includes(a.stage)?"Meeting date":"A day to call back","f-next");

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

  if(MEETING_STAGES.includes(a.stage))need(!a.modeOfMeeting,"Mode of meeting","f-mm");

  /* "Once the account is live the follow-up is not optional" (2026-09-19) is
     kept by NEXT_CALL_STAGES above: Activation and everything that still moves
     from there is on it. */
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

  /* This save becomes a call log; the next time this contact is opened its
     history has to be asked for again, not served from before the call. */
  if(a.kid)HIST.delete(String(a.kid));
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
  /* NOT WHILE A VIEW COVERS THE CARD. The accounts view and the dashboard sit
     over the call form, and every key below acts on the record underneath it:
     Enter SAVED a contact nobody was looking at, 1-4 set its stage, C dialled
     it. A keystroke meant for the search box that landed a moment after a
     repaint took its focus did exactly that. */
  const vp=document.getElementById("viewport");
  if(vp&&!vp.hidden)return;
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
      if(res?.queued){a.syncError=null;a.syncedAt=new Date().toISOString();trackJob(a,res);
        const e=paceLoose();if(e)e.job=res.job||"";return;}
      paceLanded(paceLoose());
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

/* ── saves the server has taken but not yet carried out ───────────────
   The server now answers a save as soon as it is stored, and sends it on to
   Kylas and Airtable behind the reply — 3.5 s of waiting at two rate-limited
   APIs that the associate no longer sits through. What that reply cannot carry
   is the outcome: the new contact's Kylas id, an Airtable column it had to
   drop, a value Kylas refused after all. So each queued save is remembered
   here, by the job id the server gave it, and asked about until it settles.
   Kept on disk, so closing the console does not lose track of one. */
let JOBS={};
const saveJobs=()=>Store.setSetting("saveJobs",JOBS).catch(()=>{});
const recordFor=(j)=>DATA.find(a=>j.lid&&a.lid===j.lid)||DATA.find(a=>j.kid&&String(a.kid)===String(j.kid));
function trackJob(a,res){
  if(!res?.queued||!res.job)return false;
  JOBS[res.job]={lid:a?.lid||"",kid:a?.kid||"",name:a?.pocName||"",at:Date.now()};
  saveJobs();watchJobs();
  return true;
}
let watching=false;
async function watchJobs(){
  if(watching)return;
  watching=true;
  try{
    while(Object.keys(JOBS).length){
      /* Quick at first — a save lands in about a second, and asking is a
         7 ms read — then patient, for one that is waiting out a retry.
         Timed by the NEWEST job, so a fresh save is not polled slowly just
         because an older one is stuck in a retry. */
      const newest=Math.max(...Object.values(JOBS).map(j=>j.at));
      const age=Date.now()-newest;
      await new Promise(r=>setTimeout(r,age<10e3?750:age<30e3?2000:age<5*60e3?15e3:60e3));
      let res;
      try{res=await API.saveStatus(Object.keys(JOBS));}catch{continue;}
      let changed=false;
      for(const [id,st] of Object.entries(res.jobs||{})){
        const j=JOBS[id];if(!j)continue;
        const a=recordFor(j);
        if(st.state==="done"){
          if(a)applySaved(a,st.result||{});
          delete JOBS[id];changed=true;
          /* The call is on the server now; its count can be asked for. */
          paceLanded(paceJob(id));
          setTimeout(refreshPace,1500);
        }else if(st.state==="dead"){
          paceLanded(paceJob(id));
          const e=st.error||{};
          const why=(e.problems||[]).filter(p=>p.blocking!==false).map(p=>p.why).join(" · ")||e.message||"Kylas refused it";
          if(a)a.syncError=(e.status>=400&&e.status<500?"rejected: ":"not saved to Kylas: ")+why;
          toast(`${j.name||"A contact"} NOT saved to Kylas — ${why}`,a?()=>{cur=DATA.indexOf(a);render();}:undefined);
          delete JOBS[id];changed=true;
        }else if(st.state==="queued"&&st.retryAt){
          /* Kylas or Airtable did not answer; the server will try again. Said
             on the row, not as an error — nothing is lost. */
          if(a){a.syncError=`waiting for Kylas — retrying at ${new Date(st.retryAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}`;changed=true;}
        }else if(st.state==="unknown"&&Date.now()-j.at>24*3600e3){
          delete JOBS[id];changed=true;
        }
      }
      if(changed){saveJobs();persist();renderQueue();}
    }
  }finally{watching=false;}
}

let warnedMissing=false;
/* What a finished save tells the record — from a direct reply, or from the
   status of a queued one. */
/* THE ONE PLACE A SAVE IS KNOWN TO HAVE LANDED — both the direct reply and a
   queued job finishing come through here. If the dashboard is open, it is now
   showing numbers that predate this save, so it is told. */
function savedLanded(){ try{ Views?.savedLanded?.(); }catch{ /* views not loaded */ } }

function applySaved(a,res){
    /* ANY id coming back, not only one from a create. When the proxy recognises
       a retry of a save it already carried out, it answers with the id it made
       last time and `created:false` — and a record that took that answer as
       "no id for you" stayed pending and offered itself for creation again on
       the next save. The question is whether this record has an id, not which
       request earned it. */
    if(res.kid&&!a.kid){
      a.kid=String(res.kid);a.pendingCreate=false;
      /* A queued save learns its Kylas id seconds after the reply, and the
         company may have been re-read from the server in between — bringing
         the new contact in as a second record. Keep this one (it carries what
         the associate typed) and drop the copy. */
      const dup=DATA.findIndex(x=>x!==a&&String(x.kid)===a.kid);
      if(dup>-1){DATA.splice(dup,1);if(cur>dup)cur--;}
    }
    a.syncedAt=new Date().toISOString();
    /* Airtable is where the KPIs come from, so its failure has to surface even
       though Kylas took the write. */
    a.syncError=res.airtableError?("airtable: "+res.airtableError)
      :res.callLogError?("call log: "+res.callLogError):null;
    /* The save went through WITHOUT a column the base does not have. Not an
       error — the call is safe — but the field it dropped is one the console
       shows, so silence would leave somebody hunting for a value that was never
       stored. Said ONCE a session: at 200 calls a day a per-save toast is
       noise, and the fix (run repair-base) is the same every time. */
    if(res.airtable?.missing?.length&&!warnedMissing){
      warnedMissing=true;
      toast(`Airtable is missing ${res.airtable.missing.join(", ")} — saved without it. Run repair-base.mjs.`);
    }
    if(res.created)toast(`${a.pocName} created in Kylas`);
    /* The dashboard, if it is open, is now a save behind. */
    savedLanded();
}

async function syncToKylas(a,call){
  /* Counted the moment Save is pressed — the header is the associate's pace,
     and a counter that waits on the network reads as a missed call. */
  const pe=paceSaved(a);
  a.syncing=true;renderQueue();
  await flushOutbox().catch(()=>{});
  const res=await API.queueSave(a,call);
  a.syncing=false;
  if(res.ok&&res.queued){
    /* Stored on the server, which is what "saved" means to the associate. The
       outcome follows in a few seconds; watchJobs() writes it onto the row. */
    a.syncedAt=new Date().toISOString();a.syncError=null;
    trackJob(a,res);
    pe.job=res.job||"";
  }else if(res.ok){
    applySaved(a,res);
    paceLanded(pe);setTimeout(refreshPace,1500);
  }else{
    /* Refused outright: that call will never be on the server, so it does not
       count. An outage leaves it counted — the outbox sends it later. */
    if(res.rejected){paceLanded(pe);setTimeout(refreshPace,1500);}
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
}

async function boot(){
  ME=(await Store.getSetting("me"))||"";
  adoptOwners((await Store.getSetting("owners"))||[]);
  const saved=await Store.loadContacts();
  if(saved&&saved.length)DATA=saved;
  const log=await Store.loadLog();
  const c=document.getElementById("logCount");
  if(c)c.textContent=log.length;
  /* done means "logged today", derived from the log — not a stored field. */
  const t=today();
  const loggedToday=new Set(log.filter(e=>Day.dayOf(e.at)===t).map(e=>e.kid));
  DATA.forEach(a=>{a.done=loggedToday.has(a.kid);});
  /* Every call logged in this browser today — entries, not distinct contacts,
     and not looked up by Kylas id, which a contact created today did not have
     when its call was logged. */
  PACE.day=t;PACE.local=log.filter(e=>Day.dayOf(e.at)===t).length;
  addOwners(DATA.map(a=>a.owner));
  renderFilters();render();
  /* Yesterday's outage is this morning's queue. Draining on boot is what makes
     "keep dialling, it will go when the link is back" true without the
     associate having to save something else to trigger it. */
  flushOutbox().catch(()=>{});
  /* Saves queued on the server before the console was last closed. */
  JOBS=(await Store.getSetting("saveJobs"))||{};
  watchJobs();
  wirePanes(await Store.getSetting("panes"));
  renderPace();
  refreshPace();
  /* Other devices and the day's earlier sessions arrive this way. Two minutes
     is often enough to feel current and rare enough to cost nothing: the
     report is held for a minute on the server and dropped on every save. */
  setInterval(refreshPace,2*60*1000);
}
boot();

/* ── the panes are the associate's to size ──────────────────────────────
   The split was fixed at 1fr / 1fr / .72fr, and which pane needs the room
   depends on the call: a discovery call with four event rows wants the middle
   one wide, a first dial wants the contact fields. So the two borders drag.

   Widths are stored as FRACTIONS, not pixels — a px layout looks right on the
   screen it was dragged on and wrong on the next one, and the console is also
   resizable now. Double-click a border to put it back. Below 1280px the third
   pane is not there and below 960 they are tabs, so this only binds where
   there is something to drag. */
const PANE_MIN=260;
function wirePanes(saved){
  const split=document.getElementById("split");
  if(!split)return;
  const panes=[...split.querySelectorAll(".pane")];
  /* THREE PANES ONLY. Below 1280px the research pane is hidden and below 960
     they are tabs, and both of those are done with grid-template-columns in a
     media query — which an inline style silently beats, leaving an empty
     third column where the hidden pane used to be. So the stored widths are
     applied only at the size they were measured at, and dropped otherwise. */
  const wide=window.matchMedia("(min-width:1281px)");
  let want=Array.isArray(saved)&&saved.length===panes.length
    &&saved.every(n=>Number.isFinite(n)&&n>0)?saved.slice():null;
  const apply=(fr)=>{split.style.gridTemplateColumns=fr.map(n=>n.toFixed(4)+"fr").join(" ");};
  const sync=()=>{ if(wide.matches&&want)apply(want); else split.style.gridTemplateColumns=""; };
  wide.addEventListener?.("change",sync);
  sync();

  panes.slice(0,-1).forEach((p,i)=>{
    const g=el("div","pgrip");
    g.title="Drag to resize · double-click to reset";
    g.onpointerdown=(e)=>{
      /* The pane that shrinks and the pane that grows are the two either side
         of THIS border; the rest keep their width, so a drag is local and the
         far pane does not jump. */
      const w=panes.map(n=>n.getBoundingClientRect().width);
      const x0=e.clientX,a=i,b=i+1,total=w[a]+w[b];
      g.setPointerCapture(e.pointerId);
      document.body.classList.add("colresize");
      const move=(ev)=>{
        let d=ev.clientX-x0;
        d=Math.max(PANE_MIN-w[a],Math.min(w[b]-PANE_MIN,d));
        const next=w.slice();next[a]=w[a]+d;next[b]=total-next[a];
        apply(next);
      };
      const up=()=>{
        g.removeEventListener("pointermove",move);g.removeEventListener("pointerup",up);
        document.body.classList.remove("colresize");
        want=panes.map(n=>n.getBoundingClientRect().width);
        Store.setSetting("panes",want).catch(()=>{});
      };
      g.addEventListener("pointermove",move);g.addEventListener("pointerup",up);
    };
    g.ondblclick=()=>{want=null;sync();Store.setSetting("panes",null).catch(()=>{});};
    p.appendChild(g);
  });
}
