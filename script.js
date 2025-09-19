/* =========================================================================
   Helldivers 2 — Loadout Finder + Squad Challenge Generator
   ========================================================================= */

(() => {
  // --------------------------
  // Constants & Defaults
  // --------------------------
  const DEFAULTS = {
    faction: "Terminids (Bugs)",
    difficulty: "Challenging",
    synergy: "balanced",
    objective: "Destroy Nests",
    roles: [
      { id: "heavy", name: "Heavy / Anti-Armor" },
      { id: "assault", name: "Assault (Versatile)" },
      { id: "recon", name: "Recon / Scout" },
      { id: "support", name: "Support Specialist" },
      { id: "medic", name: "Medic / Sustain" },
      { id: "demo", name: "Demolitions Expert" },
    ],
    // Safe fallback objectives if none are found in curated/dataset
    fallbackObjectives: [
      "Destroy Nests",
      "Eliminate Bile Titans",
      "Sabotage Facilities",
      "Escort Convoy",
      "Radiotower Uplink",
      "Extract Samples",
    ],
  };

  // Stratagems we must never accidentally exclude (ensure presence)
  const MUST_INCLUDE_STRATAGEMS = [
    "Quasar Cannon",
    "Orbital Napalm Strike", // sometimes also "Orbital Napalm"
    "Emancipator Exosuit",   // Emancipator line, ensure presence
  ];

  // Faction-specific grenade hints
  const GRENADE_HINTS = {
    "Terminids (Bugs)": ["Incendiary Grenade", "Incendiary Impact", "Stun Grenade"],
    "Automatons (Bots)": ["Thermite Grenade", "EMP Grenade", "Anti-Armor Grenade"],
    "Illuminate (Squids)": ["EMP Grenade", "Stun Grenade", "Fragmentation Grenade"],
  };

  // Data cache
  const STATE = {
    curated: null,           // data.json
    items: null,             // items.json
    usage: null,             // helldive_live_merged_dataset.json (community)
    usageWeights: {},        // name -> 0..1
    isReady: false,
  };

  // DOM refs
  const el = {
    tabs: null,
    panels: null,
    faction: null,
    difficulty: null,
    objective: null,
    synergy: null,
    reroll: null,
    finderGrid: null,
    challengeGrid: null,
    randomizeChallenge: null,
    enforceBoosters: null,
    factionGrenades: null,
    visitorCount: null,
  };

  // --------------------------
  // Utilities
  // --------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.json();
  }

  function uniq(arr) {
    return [...new Set(arr)];
  }

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  // Build a quick whitelist from items.json so we never render mismatched names
  function buildWhitelist(items) {
    const set = new Set();
    const addCat = (obj) => {
      if (!obj) return;
      Object.values(obj).forEach((arr) => {
        if (Array.isArray(arr)) arr.forEach((n) => set.add(n));
        else if (arr && typeof arr === "object")
          Object.values(arr).forEach((inner) => {
            if (Array.isArray(inner)) inner.forEach((n) => set.add(n));
          });
      });
    };
    addCat(items.primaries);
    addCat(items.sidearms);
    addCat(items.explosives);
    addCat(items.boosters);
    addCat(items.armor);
    addCat(items.stratagems);
    return set;
  }

  function sanitizeNames(list, whitelist) {
    if (!Array.isArray(list)) return [];
    return list.filter((n) => whitelist.has(n));
  }

  function ensureMustIncludeStratagems(strats, whitelist) {
    const out = [...strats];
    for (const req of MUST_INCLUDE_STRATAGEMS) {
      // allow loose matches (e.g., "Orbital Napalm" vs "Orbital Napalm Strike")
      const has = out.some((s) => s.toLowerCase().includes(req.toLowerCase().replace(/ strike| exosuit/g, "").trim()));
      if (!has) {
        // add if whitelist has an exact looking candidate
        const found = [...whitelist].find((w) =>
          w.toLowerCase().includes(req.toLowerCase().replace(/ strike| exosuit/g, "").trim())
        );
        if (found) out.push(found);
      }
    }
    return uniq(out);
  }

  // Build normalized usage weights (name -> 0..1)
  function buildUsageWeights(usageJson) {
    const counts = new Map(); // name -> count/score
    const bump = (name, v) => counts.set(name, (counts.get(name) || 0) + (v || 1));

    // We try to be schema-flexible:
    // Accept arrays of {name, count|uses|usage_rate}, or nested categories.
    const traverse = (node) => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach((e) => {
          if (e && typeof e === "object") {
            if (e.name) {
              const v = Number(e.count ?? e.uses ?? e.usage ?? e.usage_rate ?? 1);
              bump(e.name, isFinite(v) ? Math.max(1, v) : 1);
            } else {
              traverse(e);
            }
          }
        });
      } else if (typeof node === "object") {
        Object.values(node).forEach(traverse);
      }
    };

    traverse(usageJson);

    // Normalize 0..1
    let max = 0;
    for (const v of counts.values()) max = Math.max(max, v);
    const weights = {};
    for (const [k, v] of counts.entries()) {
      weights[k] = max > 0 ? v / max : 0;
    }
    return weights;
  }

  // Rank a list of candidate names by usage weight + an optional base bias
  function rankByUsage(candidates, weights, baseBias = 0.1) {
    return [...candidates]
      .map((n) => ({ n, w: (weights[n] || 0) + baseBias }))
      .sort((a, b) => b.w - a.w)
      .map((x) => x.n);
  }

  // Pick a grenade respectful of faction if requested
  function pickGrenadeForFaction(faction, availableExplosives, enforceFaction) {
    if (!enforceFaction) return availableExplosives[0] || null;
    const hints = GRENADE_HINTS[faction] || [];
    for (const h of hints) {
      const found = availableExplosives.find((g) => g.toLowerCase().includes(h.toLowerCase()));
      if (found) return found;
    }
    return availableExplosives[0] || null;
  }

  // Enforce ≤ 2 duplicate boosters in the squad by swapping to next-ranked
  function enforceBoosterRule(squad, rankedBoosters) {
    const counts = new Map();
    const maxDup = 2;

    for (const member of squad) {
      const b = member.booster;
      if (!b) continue;
      counts.set(b, (counts.get(b) || 0) + 1);
      if (counts.get(b) > maxDup) {
        // swap to next
        const currentIdx = rankedBoosters.indexOf(b);
        let swapped = false;
        for (let i = currentIdx + 1; i < rankedBoosters.length; i++) {
          const alt = rankedBoosters[i];
          if ((counts.get(alt) || 0) < maxDup) {
            member.booster = alt;
            counts.set(alt, (counts.get(alt) || 0) + 1);
            swapped = true;
            break;
          }
        }
        if (!swapped) {
          // last-ditch: pick any not yet used >2
          const any = rankedBoosters.find((x) => (counts.get(x) || 0) < maxDup);
          if (any) {
            member.booster = any;
            counts.set(any, (counts.get(any) || 0) + 1);
          }
        }
      }
    }
  }

  // Simple synergy nudges: return bias per role tags
  function synergyBiases(synergyMode) {
    switch (synergyMode) {
      case "anti-armor":
        return { antiArmor: 0.25, control: 0.05, sustain: 0.05, recon: 0.05 };
      case "control":
        return { control: 0.25, sustain: 0.05 };
      case "sustain":
        return { sustain: 0.25, control: 0.05 };
      case "recon":
        return { recon: 0.25, control: 0.05 };
      default:
        return { };
    }
  }

  // Blend curated role picks with usage weights (+synergy bias)
  function pickForRole({ roleId, curatedRole, items, weights, faction, difficulty, synergyMode, whitelist, enforceFactionGrenades }) {
    // Gather candidates from curated (role block) & expand with entire category (to remain exhaustive)
    const roleBlock = curatedRole || {};
    const primaries = uniq([
      ...(roleBlock.primaries || []),
      ...((items.primaries && items.primaries.all) || []),
    ]).filter((n) => whitelist.has(n));

    const sidearms = uniq([
      ...(roleBlock.sidearms || []),
      ...((items.sidearms && items.sidearms.all) || []),
    ]).filter((n) => whitelist.has(n));

    const explosives = uniq([
      ...(roleBlock.grenades || []),
      ...((items.explosives && items.explosives.grenades) || []),
      ...((items.explosives && items.explosives.all) || []),
    ]).filter((n) => whitelist.has(n));

    // Stratagems: consolidate categories, ensure must-include
    let stratCandidates = uniq([
      ...((roleBlock.stratagems || [])),
      ...((items.stratagems && items.stratagems.turrets) || []),
      ...((items.stratagems && items.stratagems.bombardments) || []),
      ...((items.stratagems && items.stratagems.deployables) || []),
      ...((items.stratagems && items.stratagems.backpacks) || []),
      ...((items.stratagems && items.stratagems.all) || []),
    ]).filter((n) => whitelist.has(n));

    stratCandidates = ensureMustIncludeStratagems(stratCandidates, whitelist);

    const boosters = uniq([
      ...(roleBlock.boosters || []),
      ...((items.boosters && items.boosters.all) || []),
    ]).filter((n) => whitelist.has(n));

    const armor = uniq([
      ...(roleBlock.armor || []),
      ...((items.armor && items.armor.all) || []),
    ]).filter((n) => whitelist.has(n));

    // Synergy biases: very light nudge by category tags we "pretend" exist in curated role metadata
    // For simplicity, apply small additive bias if roleId implies a tag:
    const bias = synergyBiases(synergyMode);
    const baseBias = 0.10;
    const roleBias =
      roleId === "heavy" ? (bias.antiArmor || 0) :
      roleId === "demo" ? (bias.antiArmor || 0.05) :
      roleId === "support" ? (bias.sustain || 0.05) :
      roleId === "medic" ? (bias.sustain || 0.10) :
      roleId === "recon" ? (bias.recon || 0.10) :
      roleId === "assault" ? (bias.control || 0.05) : 0;

    // Rank lists by usage
    const rankedPrimaries = rankByUsage(primaries, weights, baseBias + roleBias);
    const rankedSidearms = rankByUsage(sidearms, weights, baseBias);
    const rankedStrats = rankByUsage(stratCandidates, weights, baseBias + (bias.control || 0));
    const rankedBoosters = rankByUsage(boosters, weights, baseBias + (bias.sustain || 0));
    const rankedArmor = rankByUsage(armor, weights, baseBias);
    const rankedGrenades = rankByUsage(explosives, weights, baseBias + (bias.control || 0.02));

    // Pick top choices
    const primary = rankedPrimaries[0] || null;
    const sidearm = rankedSidearms[0] || null;
    const booster = rankedBoosters[0] || null;
    const armorPick = rankedArmor[0] || null;

    // Choose 3-4 stratagems per role with diversity (turret/bombard/deployable/backpack if possible)
    const chosenStrats = rankedStrats.slice(0, 4);

    // Grenade with faction logic
    const grenade = pickGrenadeForFaction(faction, rankedGrenades, enforceFactionGrenades);

    return {
      roleId,
      primary,
      sidearm,
      grenade,
      booster,
      armor: armorPick,
      stratagems: chosenStrats,
    };
  }

  // Build a squad for Finder (deterministic-ish with current selectors)
  function buildFinderSquad({ faction, difficulty, synergyMode, objective, curated, items, weights, whitelist, enforceFactionGrenades }) {
    // Identify curated role blocks under curated[faction][difficulty][objective]
    let roleBlocks = {};
    try {
      roleBlocks = (((curated[faction] || {})[difficulty] || {})[objective] || {}).roles || {};
    } catch (e) { roleBlocks = {}; }

    const squad = DEFAULTS.roles.map((r) =>
      pickForRole({
        roleId: r.id,
        curatedRole: roleBlocks[r.id],
        items,
        weights,
        faction,
        difficulty,
        synergyMode,
        whitelist,
        enforceFactionGrenades,
      })
    );

    // Enforce booster rule across the squad
    const allBoostersRanked = rankByUsage((items.boosters && items.boosters.all) || [], weights, 0.1);
    enforceBoosterRule(squad, allBoostersRanked);

    return squad;
  }

  // Build a random (but structured) squad for the Challenge tab
  function buildChallengeSquad({ faction, enforceFactionGrenades, items, weights, whitelist }) {
    const randPick = (arr) => arr[Math.floor(Math.random() * arr.length)] || null;

    const primaries = ((items.primaries && items.primaries.all) || []).filter((n) => whitelist.has(n));
    const sidearms = ((items.sidearms && items.sidearms.all) || []).filter((n) => whitelist.has(n));
    const grenades = ((items.explosives && items.explosives.all) || []).filter((n) => whitelist.has(n));
    const boosters = ((items.boosters && items.boosters.all) || []).filter((n) => whitelist.has(n));
    const armor = ((items.armor && items.armor.all) || []).filter((n) => whitelist.has(n));
    const stratPool = uniq([
      ...((items.stratagems && items.stratagems.turrets) || []),
      ...((items.stratagems && items.stratagems.bombardments) || []),
      ...((items.stratagems && items.stratagems.deployables) || []),
      ...((items.stratagems && items.stratagems.backpacks) || []),
      ...((items.stratagems && items.stratagems.all) || []),
    ]).filter((n) => whitelist.has(n));

    const rankedBoosters = rankByUsage(boosters, weights, 0.1);

    const squad = DEFAULTS.roles.map((r) => {
      const primary = randPick(primaries);
      const sidearm = randPick(sidearms);
      const chosenGrenade = pickGrenadeForFaction(faction, rankByUsage(grenades, weights, 0.05), enforceFactionGrenades);

      const stratagems = uniq([
        randPick(stratPool),
        randPick(stratPool),
        randPick(stratPool),
        randPick(stratPool),
      ]).slice(0, 4);

      return {
        roleId: r.id,
        primary,
        sidearm,
        grenade: chosenGrenade,
        booster: randPick(rankedBoosters),
        armor: randPick(armor),
        stratagems,
      };
    });

    enforceBoosterRule(squad, rankedBoosters);
    return squad;
  }

  // --------------------------
  // Rendering
  // --------------------------
  function roleLabel(roleId) {
    const found = DEFAULTS.roles.find((r) => r.id === roleId);
    return found ? found.name : roleId;
  }

  function renderSquadCards(container, squad) {
    if (!container) return;
    container.innerHTML = "";
    squad.forEach((m) => {
      const card = document.createElement("div");
      card.className = "card";

      const h = document.createElement("h3");
      h.textContent = roleLabel(m.roleId);
      card.appendChild(h);

      const row1 = document.createElement("div");
      row1.className = "row";
      const badge = (txt) => {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = txt;
        return b;
      };
      row1.appendChild(badge("Optimized by Community + Curation"));
      card.appendChild(row1);

      const kv = (k, v) => {
        const wrap = document.createElement("div");
        wrap.className = "kv";
        const key = document.createElement("div");
        key.className = "key";
        key.textContent = k;
        const val = document.createElement("div");
        val.className = "val";
        val.textContent = Array.isArray(v) ? v.join(", ") : (v || "—");
        wrap.appendChild(key);
        wrap.appendChild(val);
        return wrap;
      };

      card.appendChild(kv("Primary", m.primary));
      card.appendChild(kv("Sidearm", m.sidearm));
      card.appendChild(kv("Grenade", m.grenade));
      card.appendChild(kv("Booster", m.booster));
      card.appendChild(kv("Armor", m.armor));
      card.appendChild(kv("Stratagems", m.stratagems));

      container.appendChild(card);
    });
  }

  function showSkeletons(container, count = 4) {
    if (!container) return;
    container.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const c = document.createElement("div");
      c.className = "card skeleton";
      container.appendChild(c);
    }
  }

  // Populate objective select from curated & usage (if present)
  function populateObjectivesSelect(curated, usage, faction, difficulty, selEl) {
    const fromCurated = new Set();
    try {
      const factionNode = curated[faction] || {};
      const diffNode = factionNode[difficulty] || {};
      Object.keys(diffNode).forEach((obj) => fromCurated.add(obj));
    } catch (e) {}

    const fromUsage = new Set();
    const scanUsage = (node) => {
      if (!node) return;
      if (Array.isArray(node)) node.forEach(scanUsage);
      else if (typeof node === "object") {
        if (node.objective && typeof node.objective === "string") {
          fromUsage.add(node.objective);
        }
        Object.values(node).forEach(scanUsage);
      }
    };
    scanUsage(usage);

    const merged = uniq([
      ...Array.from(fromCurated),
      ...Array.from(fromUsage),
      ...DEFAULTS.fallbackObjectives,
    ]);

    selEl.innerHTML = "";
    merged.forEach((o) => {
      const opt = document.createElement("option");
      opt.textContent = o;
      selEl.appendChild(opt);
    });

    // Ensure a stable default selection
    const desired = merged.find((x) => x.toLowerCase().includes("nest")) || merged[0];
    selEl.value = desired || merged[0] || DEFAULTS.objective;
  }

  // --------------------------
  // Tabs & Controls
  // --------------------------
  function initTabs() {
    el.tabs = Array.from(document.querySelectorAll(".tab"));
    el.panels = Array.from(document.querySelectorAll(".panel"));

    el.tabs.forEach((t) => {
      t.addEventListener("click", () => {
        el.tabs.forEach((x) => x.classList.remove("active"));
        el.panels.forEach((p) => p.classList.remove("active"));
        t.classList.add("active");
        const id = t.dataset.tab;
        document.getElementById(id).classList.add("active");
      });
    });
  }

  function bindControls() {
    el.faction = document.getElementById("faction");
    el.difficulty = document.getElementById("difficulty");
    el.objective = document.getElementById("objective");
    el.synergy = document.getElementById("team-synergy");
    el.reroll = document.getElementById("reroll");
    el.finderGrid = document.getElementById("finder-squad");
    el.challengeGrid = document.getElementById("challenge-squad");
    el.randomizeChallenge = document.getElementById("randomize-challenge");
    el.enforceBoosters = document.getElementById("enforce-boosters");
    el.factionGrenades = document.getElementById("faction-grenades");
    el.visitorCount = document.getElementById("visitor-count");

    // defaults on first load
    el.faction.value = DEFAULTS.faction;
    el.difficulty.value = DEFAULTS.difficulty;
    el.synergy.value = "balanced";

    const onChangeFinder = () => {
      if (!STATE.isReady) return;
      showSkeletons(el.finderGrid, 4);
      // minor debounce to keep UI smooth
      queueMicrotask(async () => {
        const whitelist = buildWhitelist(STATE.items);
        const squad = buildFinderSquad({
          faction: el.faction.value,
          difficulty: el.difficulty.value,
          synergyMode: el.synergy.value,
          objective: el.objective.value,
          curated: STATE.curated,
          items: STATE.items,
          weights: STATE.usageWeights,
          whitelist,
          enforceFactionGrenades: true,
        });
        renderSquadCards(el.finderGrid, squad);
      });
    };

    el.faction.addEventListener("change", () => {
      populateObjectivesSelect(STATE.curated, STATE.usage, el.faction.value, el.difficulty.value, el.objective);
      onChangeFinder();
    });
    el.difficulty.addEventListener("change", () => {
      populateObjectivesSelect(STATE.curated, STATE.usage, el.faction.value, el.difficulty.value, el.objective);
      onChangeFinder();
    });
    el.objective.addEventListener("change", onChangeFinder);
    el.synergy.addEventListener("change", onChangeFinder);
    el.reroll.addEventListener("click", onChangeFinder);

    el.randomizeChallenge.addEventListener("click", () => {
      if (!STATE.isReady) return;
      showSkeletons(el.challengeGrid, 4);
      queueMicrotask(() => {
        const whitelist = buildWhitelist(STATE.items);
        const squad = buildChallengeSquad({
          faction: el.faction.value,
          enforceFactionGrenades: el.factionGrenades.checked,
          items: STATE.items,
          weights: STATE.usageWeights,
          whitelist,
        });
        if (el.enforceBoosters.checked) {
          const ranked = rankByUsage((STATE.items.boosters && STATE.items.boosters.all) || [], STATE.usageWeights, 0.1);
          enforceBoosterRule(squad, ranked);
        }
        renderSquadCards(el.challengeGrid, squad);
      });
    });
  }

  // --------------------------
  // Data Load & First Render
  // --------------------------
  async function loadAll() {
    // Show skeletons immediately (prevents blank on first paint)
    showSkeletons(document.getElementById("finder-squad"), 4);
    showSkeletons(document.getElementById("challenge-squad"), 4);

    // Fetch all JSON in parallel
    const [curated, items, usage] = await Promise.all([
      fetchJSON("data.json"),
      fetchJSON("items.json"),
      fetchJSON("helldive_live_merged_dataset.json"),
    ]);

    STATE.curated = curated || {};
    STATE.items = items || {};
    STATE.usage = usage || {};
    STATE.usageWeights = buildUsageWeights(STATE.usage);
    STATE.isReady = true;

    // Populate objective select & render default squads
    populateObjectivesSelect(STATE.curated, STATE.usage, el.faction.value, el.difficulty.value, el.objective);

    const whitelist = buildWhitelist(STATE.items);

    const finderSquad = buildFinderSquad({
      faction: el.faction.value,
      difficulty: el.difficulty.value,
      synergyMode: el.synergy.value,
      objective: el.objective.value,
      curated: STATE.curated,
      items: STATE.items,
      weights: STATE.usageWeights,
      whitelist,
      enforceFactionGrenades: true,
    });
    renderSquadCards(el.finderGrid, finderSquad);

    const challengeSquad = buildChallengeSquad({
      faction: el.faction.value,
      enforceFactionGrenades: el.factionGrenades.checked,
      items: STATE.items,
      weights: STATE.usageWeights,
      whitelist,
    });
    if (el.enforceBoosters.checked) {
      const ranked = rankByUsage((STATE.items.boosters && STATE.items.boosters.all) || [], STATE.usageWeights, 0.1);
      enforceBoosterRule(challengeSquad, ranked);
    }
    renderSquadCards(el.challengeGrid, challengeSquad);
  }

  // --------------------------
  // Visitor Counter (hits.sh)
  // --------------------------
  (function initVisitorCounter() {
    const elNum = document.getElementById("visitor-count");
    if (!elNum) return;

    // IMPORTANT: Set this to your public host+path (no trailing slash).
    // Example: 'woodshedtv.github.io/helldivers2-loadouts' or 'mouthbreathertv.com/helldivers'
    const PROD_SLUG = "mouthbreathertv.com/helldivers"; // <-- update me to your deployed URL

    // For real HTTP(S) pages, use the actual path; for file:// fallback to PROD_SLUG
    const isHttp = location.protocol.startsWith("http");
    const runtimeSlug = isHttp
      ? (location.hostname + location.pathname).replace(/\/$/, "")
      : PROD_SLUG;

    const LS_KEY = "visitorCountCache:" + runtimeSlug;
    const cached = localStorage.getItem(LS_KEY);
    if (cached && /^\d+$/.test(cached)) elNum.textContent = cached;

    function ping() {
      const img = new Image();
      img.referrerPolicy = "no-referrer-when-downgrade";
      img.src = `https://hits.sh/${encodeURIComponent(runtimeSlug)}.svg?view=total&_=${Date.now()}`;
    }

    function applyCountFromSvg(svgText) {
      const matches = svgText.match(/>(\d[\d,]*)<\/text>/g);
      if (!matches) throw new Error("No numeric <text> in hits SVG");
      const last = matches[matches.length - 1].replace(/[^\d]/g, "");
      if (/^\d+$/.test(last)) {
        elNum.textContent = last;
        localStorage.setItem(LS_KEY, last);
      }
    }

    function fetchCount(tryNum = 0) {
      fetch(`https://hits.sh/${encodeURIComponent(runtimeSlug)}.svg?view=total&_=${Date.now()}`, {
        cache: "no-store",
      })
        .then((r) => r.text())
        .then(applyCountFromSvg)
        .catch(() => {
          if (tryNum < 3) setTimeout(() => fetchCount(tryNum + 1), 250 * (tryNum + 1));
        });
    }

    ping();
    setTimeout(() => fetchCount(0), 300);
  })();

  // --------------------------
  // Boot
  // --------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    initTabs();
    bindControls();
    try {
      await loadAll();
    } catch (err) {
      console.error(err);
      // Show a friendly error state in cards
      const showErr = (container) => {
        if (!container) return;
        container.innerHTML = "";
        const c = document.createElement("div");
        c.className = "card";
        const p = document.createElement("p");
        p.textContent = "Failed to load data. Please refresh.";
        c.appendChild(p);
        container.appendChild(c);
      };
      showErr(document.getElementById("finder-squad"));
      showErr(document.getElementById("challenge-squad"));
    }
  });
})();
