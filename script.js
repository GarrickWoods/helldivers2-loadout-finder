let DATA=[];
const $=sel=>document.querySelector(sel);
const factionSel=$("#faction");
const difficultySel=$("#difficulty");
const objectiveSel=$("#objective");
const results=$("#results");
const compNote=$("#compNote");

const keyMap={
  faction:"Faction",
  difficulty:"Difficulty",
  objective:"Objective",
  note:"Recommended_Team_Composition_Notes",
  class:["Class_1","Class_2","Class_3","Class_4","Class_5","Class_6"],
  weapons:["C1_Primary_Weapons","C2_Primary_Weapons","C3_Primary_Weapons","C4_Primary_Weapons","C5_Primary_Weapons","C6_Primary_Weapons"],
  armor:["C1_Armor_Perks","C2_Armor_Perks","C3_Armor_Perks","C4_Armor_Perks","C5_Armor_Perks","C6_Armor_Perks"],
  strats:["C1_Stratagems","C2_Stratagems","C3_Stratagems","C4_Stratagems","C5_Stratagems","C6_Stratagems"],
};

async function load(){
  const res=await fetch('data.json');
  DATA=await res.json();
  initSelectors();
  const url=new URL(window.location);
  const F=url.searchParams.get('faction')||DATA[0][keyMap.faction];
  const D=url.searchParams.get('difficulty')||DATA[0][keyMap.difficulty];
  const O=url.searchParams.get('objective')||DATA[0][keyMap.objective];
  factionSel.value=F; difficultySel.value=D; objectiveSel.value=O;
  render();
  loadItems();
}

function uniqueBy(field){ return [...new Set(DATA.map(r=>r[field]).filter(Boolean))]; }
function optionize(sel, values){ sel.innerHTML = values.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join(''); }

function initSelectors(){
  optionize(factionSel, uniqueBy(keyMap.faction));
  optionize(difficultySel, uniqueBy(keyMap.difficulty));
  optionize(objectiveSel, uniqueBy(keyMap.objective));
  [factionSel,difficultySel,objectiveSel].forEach(el=>el.addEventListener('change',render));
  $("#shareBtn").addEventListener('click',shareLink);
  $("#copyBtn").addEventListener('click',copyText);
}

// Finder
function findRow(f,d,o){ return DATA.find(r=>r[keyMap.faction]===f && r[keyMap.difficulty]===d && r[keyMap.objective]===o); }

function render(){
  const f=factionSel.value, d=difficultySel.value, o=objectiveSel.value;
  const row=findRow(f,d,o);
  const params=new URLSearchParams({ faction:f, difficulty:d, objective:o });
  history.replaceState(null,"","?"+params.toString());
  if(!row){ results.innerHTML='<p>No data found.</p>'; compNote.textContent=''; return; }
  compNote.textContent = row[keyMap.note] || '';
  const cards=[];
  for(let i=0;i<6;i++){
    cards.push(card(row[keyMap.class[i]], row[keyMap.weapons[i]], row[keyMap.armor[i]], row[keyMap.strats[i]]));
  }
  results.innerHTML = cards.join('');
}

function card(role,weapons,armor,strats){
  return `<article class="card">
    <div class="role">${escapeHtml(role||"Role")}</div>
    <div class="kv"><b>Primary Weapons</b><div>${escapeHtml(weapons||"-")}</div></div>
    <div class="kv"><b>Armor / Perks</b><div>${escapeHtml(armor||"-")}</div></div>
    <div class="kv"><b>Stratagems</b><div>${escapeHtml(strats||"-")}</div></div>
  </article>`;
}

function shareLink(){ navigator.clipboard.writeText(location.href).then(()=>alert('Shareable link copied!')); }
function copyText(){
  const f=factionSel.value, d=difficultySel.value, o=objectiveSel.value;
  const row=findRow(f,d,o);
  if(!row) return;
  let out=`${f} | ${d} | ${o}\n${row[keyMap.note]||''}\n\n`;
  for(let i=0;i<6;i++){
    out += `• ${row[keyMap.class[i]]}\n   - Weapons: ${row[keyMap.weapons[i]]}\n   - Armor/Perks: ${row[keyMap.armor[i]]}\n   - Stratagems: ${row[keyMap.strats[i]]}\n\n`;
  }
  navigator.clipboard.writeText(out).then(()=>alert('Loadout copied!'));
}

function escapeHtml(s){ return (s??'').toString().replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

// --- Tabs ---
document.addEventListener('click', (e)=>{
  const tab = e.target.closest('.tab');
  if(!tab) return;
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  tab.classList.add('active');
  const t=tab.dataset.tab;
  document.querySelector('#challenge').classList.toggle('hidden', t!=='challenge');
  document.querySelector('.controls').classList.toggle('hidden', t!=='finder');
  document.querySelector('.note').classList.toggle('hidden', t!=='finder');
  document.querySelector('#results').classList.toggle('hidden', t!=='finder');
});

// --- Challenge ---
let ITEMS={};
async function loadItems(){
  const res=await fetch('items.json');
  ITEMS=await res.json();
  optionize($("#challengeFaction"), ["Random", ...ITEMS.factions]);
  optionize($("#challengeDifficulty"), ["Random", ...ITEMS.difficulties]);
}

function rand(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function pickOrdered(pool){
  const shuffled=[...pool].sort(()=>Math.random()-0.5);
  const main = shuffled[0] ?? '';
  const alts = shuffled.slice(1,3);
  return { main, alts };
};
}

function genPlayerBuild(){
  const primary = pickOrdered(ITEMS.primaries);
  const sidearm = pickOrdered(ITEMS.sidearms);
  const explosive = pickOrdered(ITEMS.explosives);
  const armor = rand(ITEMS.armor_weights);
  const perk = rand(ITEMS.perks);
  const allStrats = [...(ITEMS.stratagems.turrets||[]), ...(ITEMS.stratagems.bombardment||[]), ...(ITEMS.stratagems.deployables||[])];
  const shuffled = allStrats.sort(()=>Math.random()-0.5);
  const stratMain = shuffled.slice(0,4);
  const stratAlt = shuffled.slice(4,7);
  return { primary, sidearm, explosive, armor, perk, stratMain, stratAlt };
}

function renderChallenge(){
  const n = parseInt($("#players").value,10);
  let fSel = $("#challengeFaction").value;
  let dSel = $("#challengeDifficulty").value;
  if(fSel==='Random'){ fSel = rand(ITEMS.factions); }
  if(dSel==='Random'){ dSel = rand(ITEMS.difficulties); }
  $("#challengeHeader").textContent = `${escapeHtml(fSel)} • ${escapeHtml(dSel)}`;
  const out = [];
  for(let p=1;p<=n;p++){
    const b = genPlayerBuild();
    out.push(challengeCard(p,b));
  }
  $("#challengeResults").innerHTML = out.join('');
}
function orderedBlock(title, picks){
  const main = escapeHtml((picks.main||'').toString());
  const alts = (picks.alts||[]).map(x=>escapeHtml(x)).join(', ') || '-';
  return `<div class="kv"><b>${title}</b>
    <div>${main}</div>
    <div class="small"><b>Alternates:</b> ${alts}</div>
  </div>`;
}

function challengeCard(idx,b){
  return `<article class="card">
    <div class="role">Player ${idx}</div>
    ${orderedBlock('Primary Weapons', b.primary)}
    ${orderedBlock('Sidearms', b.sidearm)}
    ${orderedBlock('Explosives', b.explosive)}
    <><div class="kv"><b>Armor Weight</b><div>${escapeHtml(b.armor)}</div></div><div class="kv"><b>Perk</b><div>${escapeHtml(b.perk)}</div></div><div class="kv"><b>Stratagems (4 required)</b><div>${escapeHtml((b.stratMain || []).join(', '))}</div>
  <div class="small"><b>Alternates:</b> ${escapeHtml((b.stratAlt || []).join(', ') || '-')}</div>
</div></>
  </article>`;
}

document.addEventListener('click', (e)=>{
  if(e.target && e.target.id==='rollBtn'){ renderChallenge(); }
  });

load();