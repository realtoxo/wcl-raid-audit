#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.PARSEFORGE_BASE_URL || "https://parseforge.vercel.app";
const WCL_V1_BASE_URL = process.env.WARCRAFTLOGS_V1_BASE_URL || "https://www.warcraftlogs.com/v1";
const WOWHEAD_TBC_TOOLTIP_BASE_URL = process.env.WOWHEAD_TBC_TOOLTIP_BASE_URL || "https://nether.wowhead.com/tooltip/item";
const WOWHEAD_TBC_DATA_ENV = process.env.WOWHEAD_TBC_DATA_ENV || "5";
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POLICY_PATH = resolve(SKILL_DIR, "references/default-guild-policy.json");
const WCL_WF_ABILITY_ID = 25587;
const WCL_GRACE_ABILITY_ID = 25359;
const WCL_WF_GAP_THRESHOLD_MS = 10000;
const UNCOMMON_QUALITY = 2;
const wowheadItemCache = new Map();
const wclFightDataCache = new Map();

function getWclConfig() {
  const clientId = process.env.WARCRAFTLOGS_CLIENT_ID || process.env.WCL_CLIENT_ID || "";
  const clientSecret = process.env.WARCRAFTLOGS_CLIENT_SECRET
    || process.env.WARCRAFTLOGS_CLIENT_KEY
    || process.env.WCL_CLIENT_SECRET
    || "";
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    apiUrl: process.env.WARCRAFTLOGS_API_URL || "https://www.warcraftlogs.com/api/v2/client",
  };
}

function getWclV1ApiKey() {
  return process.env.WARCRAFTLOGS_API_KEY
    || process.env.WCL_API_KEY
    || process.env.WARCRAFTLOGS_CLIENT_SECRET
    || process.env.WCL_CLIENT_SECRET
    || "";
}

function usage() {
  console.error(`Usage:
  node raid_audit.mjs <parseforge-url-or-report-code> [--markdown|--json] [--fight ID] [--policy PATH] [--include-tanks] [--skip-sappers]

Examples:
  node raid_audit.mjs "https://parseforge.vercel.app/analyze/npa31KVc8XgTfYrP?fight=12" --markdown
  node raid_audit.mjs npa31KVc8XgTfYrP --policy ./guild-policy.json --markdown
  node raid_audit.mjs npa31KVc8XgTfYrP --json
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    format: "markdown",
    fightIds: [],
    includeTanks: false,
    skipSappers: false,
    policyPath: DEFAULT_POLICY_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--markdown") args.format = "markdown";
    else if (arg === "--json") args.format = "json";
    else if (arg === "--include-tanks") args.includeTanks = true;
    else if (arg === "--skip-sappers") args.skipSappers = true;
    else if (arg === "--policy") {
      const value = argv[++i];
      if (!value) throw new Error("--policy requires a JSON file path");
      args.policyPath = resolve(process.cwd(), value);
    } else if (arg.startsWith("--policy=")) {
      const value = arg.slice("--policy=".length);
      if (!value) throw new Error("--policy requires a JSON file path");
      args.policyPath = resolve(process.cwd(), value);
    }
    else if (arg === "--fight") {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value)) throw new Error("--fight requires a numeric fight id");
      args.fightIds.push(Number(value));
    } else if (arg.startsWith("--fight=")) {
      const value = arg.slice("--fight=".length);
      if (!/^\d+$/.test(value)) throw new Error("--fight requires a numeric fight id");
      args.fightIds.push(Number(value));
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) throw new Error("Missing Parseforge URL or report code");
  return args;
}

async function loadPolicy(policyPath) {
  const text = await readFile(policyPath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse policy JSON at ${policyPath}: ${error.message}`);
  }
}

function extractReportCode(input) {
  if (/^[A-Za-z0-9]+$/.test(input)) return input;
  const url = new URL(input);
  const match = url.pathname.match(/\/analyze\/([^/?#]+)/);
  if (!match) throw new Error("Could not find report code in URL path");
  return match[1];
}

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${path} failed ${res.status}: ${data.error || text.slice(0, 200)}`);
  return data;
}

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${path} failed ${res.status}: ${data.error || text.slice(0, 200)}`);
  return data;
}

async function wclV1GetJson(path, query = {}) {
  const apiKey = getWclV1ApiKey();
  if (!apiKey) throw new Error("Missing WARCRAFTLOGS_API_KEY / WCL_API_KEY for WCL v1 access");
  const url = new URL(`${WCL_V1_BASE_URL}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`WCL v1 ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`WCL v1 ${path} failed ${res.status}: ${data.error || text.slice(0, 200)}`);
  if (data?.error) throw new Error(`WCL v1 ${path}: ${data.error}`);
  return data;
}

async function getWclV1FightData(reportCode) {
  if (!wclFightDataCache.has(reportCode)) {
    wclFightDataCache.set(reportCode, wclV1GetJson(`/report/fights/${reportCode}`));
  }
  return wclFightDataCache.get(reportCode);
}

async function getWowheadTbcItemMeta(itemId) {
  if (!itemId) return null;
  if (wowheadItemCache.has(itemId)) return wowheadItemCache.get(itemId);
  const url = new URL(`${WOWHEAD_TBC_TOOLTIP_BASE_URL}/${itemId}`);
  url.searchParams.set("dataEnv", WOWHEAD_TBC_DATA_ENV);
  const promise = (async () => {
    const res = await fetch(url);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Wowhead tooltip returned non-JSON for item ${itemId}: ${text.slice(0, 200)}`);
    }
    return {
      id: itemId,
      name: data?.name || `Item #${itemId}`,
      quality: typeof data?.quality === "number" ? data.quality : null,
      icon: data?.icon || null,
    };
  })();
  wowheadItemCache.set(itemId, promise);
  try {
    return await promise;
  } catch (error) {
    wowheadItemCache.delete(itemId);
    throw error;
  }
}

function isPresent(slot) {
  return Boolean(slot && slot.present);
}

function spellName(slot) {
  return isPresent(slot) ? slot.spellName || "(unnamed)" : "MISSING";
}

function hasSpell(slot, pattern) {
  return isPresent(slot) && pattern.test(slot.spellName || "");
}

function nameMatches(actual, expected) {
  if (!actual || !expected) return false;
  return actual.toLowerCase() === expected.toLowerCase();
}

function slotMatches(slot, expectedNames = []) {
  return isPresent(slot) && expectedNames.some((name) => nameMatches(slot.spellName || "", name));
}

function isTank(player) {
  return player.role === "Tank";
}

function isHunter(player) {
  return player.className === "Hunter";
}

function isPhysical(player) {
  return player.role === "Physical" || player.role === "Tank";
}

function isProtectionPaladin(player) {
  return player.className === "Paladin" && /protection|justicar/i.test(player.spec || "");
}

function isSpellDamageRole(player) {
  if (isProtectionPaladin(player)) return true;
  if (player.role === "Caster" || player.role === "Healer") return true;
  return ["Mage", "Warlock", "Priest"].includes(player.className)
    || (player.className === "Druid" && /balance|restoration/i.test(player.spec || ""))
    || (player.className === "Shaman" && /elemental|restoration/i.test(player.spec || ""));
}

function encounterRuleFor(policy, fightName) {
  return (policy.encounters || []).find((rule) => new RegExp(rule.match, "i").test(fightName)) || null;
}

function trackedDebuffConfig(policy) {
  return policy.trackedDebuffs || null;
}

function hasAcceptableHunterSetup(c, hunterRule = {}) {
  if (slotMatches(c.flask, hunterRule.acceptableFlasks || [])) return true;
  return (hunterRule.acceptableBattleGuardianSetups || []).some((setup) => (
    slotMatches(c.battleElixir, [setup.battleElixir])
    && (!setup.requiresGuardian || isPresent(c.guardianElixir))
  ));
}

function hasAcceptableCasterSetup(player, c, casterRule = {}) {
  if (isPresent(c.flask)) {
    if (casterRule.acceptAnyFlask !== false) return true;
    return slotMatches(c.flask, casterRule.acceptableFlasks || []);
  }
  return isPresent(c.battleElixir) && isPresent(c.guardianElixir);
}

function physicalTextForExpected(rule) {
  if (rule.expectedBattleElixirs?.length) return rule.expectedBattleElixirs[0];
  if (rule.expectedFlasks?.length) return rule.expectedFlasks[0];
  return "expected consume";
}

function auditConsumes(report, fights, cla, options, policy) {
  const findingsByFight = [];

  for (const fight of fights) {
    const encounterRule = encounterRuleFor(policy, fight.name);
    const rows = [];

    for (const player of cla.players) {
      const fightData = (player.fightData || []).find((d) => d.fightId === fight.id);
      if (!fightData) continue;

      const c = fightData.consumables;
      const findings = [];
      const details = {
        flask: spellName(c.flask),
        battleElixir: spellName(c.battleElixir),
        guardianElixir: spellName(c.guardianElixir),
        food: spellName(c.food),
        weaponEnhancement: spellName(c.weaponEnhancement),
      };

      const applyPhysicalPolicy = isPhysical(player) && (options.includeTanks || !isTank(player));

      if (encounterRule && applyPhysicalPolicy && !isProtectionPaladin(player)) {
        const physicalRule = encounterRule.physicalDps || {};
        const expected = physicalTextForExpected(physicalRule);

        if (isHunter(player) && physicalRule.hunter) {
          if (!hasAcceptableHunterSetup(c, physicalRule.hunter)) {
            if (isPresent(c.flask) || isPresent(c.battleElixir)) {
              findings.push({
                label: "Suboptimal",
                text: `expected ${physicalRule.hunter.expectedText || expected}; used ${isPresent(c.flask) ? spellName(c.flask) : spellName(c.battleElixir)}`,
              });
            } else {
              findings.push({
                label: "Missing",
                text: `expected ${physicalRule.hunter.expectedText || expected}; no flask or battle elixir recorded`,
              });
            }
          }
        } else {
          const metExpectedFlask = !physicalRule.expectedFlasks?.length || slotMatches(c.flask, physicalRule.expectedFlasks);
          const metExpectedBattle = !physicalRule.expectedBattleElixirs?.length || slotMatches(c.battleElixir, physicalRule.expectedBattleElixirs);

          if (!metExpectedFlask || !metExpectedBattle) {
            const used = isPresent(c.battleElixir) ? spellName(c.battleElixir) : spellName(c.flask);
            findings.push({
              label: isPresent(c.flask) || isPresent(c.battleElixir) ? "Suboptimal" : "Missing",
              text: isPresent(c.flask) || isPresent(c.battleElixir)
                ? `expected ${expected}; used ${used}`
                : `expected ${expected}; no flask or battle elixir recorded`,
            });
          }
        }
      } else if (!isPhysical(player) || isSpellDamageRole(player)) {
        const casterRule = encounterRule?.casterMana || policy.general?.casterMana || {};
        if (!hasAcceptableCasterSetup(player, c, casterRule)) {
          const missing = [];
          if (!isPresent(c.flask)) missing.push("no flask");
          if (!isPresent(c.battleElixir)) missing.push("missing battle elixir");
          if (!isPresent(c.guardianElixir)) missing.push("missing guardian elixir");
          findings.push({
            label: "Incomplete caster setup",
            text: `expected flask or battle+guardian; ${missing.join(", ")}`,
          });
        }
      }

      if (!isPresent(c.food)) {
        findings.push({ label: "Missing", text: "missing food buff" });
      }
      if (!isPresent(c.weaponEnhancement)) {
        findings.push({ label: "Missing", text: "missing weapon enhancement/oil/stone" });
      }

      if (findings.length > 0) {
        rows.push({
          player: player.name,
          className: player.className,
          spec: player.spec,
          role: player.role,
          findings,
          details,
        });
      }
    }

    findingsByFight.push({
      fightId: fight.id,
      fightName: fight.name,
      rows: rows.sort((a, b) => a.player.localeCompare(b.player)),
    });
  }

  return findingsByFight;
}

function auditEnchants(cla) {
  return cla.players
    .map((player) => ({
      player: player.name,
      className: player.className,
      spec: player.spec,
      missing: (player.gearIssues || [])
        .filter((issue) => issue.issueType === "missing_enchant")
        .map((issue) => issue.slotName),
    }))
    .filter((row) => row.missing.length > 0)
    .sort((a, b) => b.missing.length - a.missing.length || a.player.localeCompare(b.player));
}

async function auditGreenGems(cla) {
  const gemIds = new Set();
  const itemIds = new Set();
  for (const player of cla.players) {
    for (const item of player.gearSnapshot || []) {
      if (typeof item.itemId === "number" && item.itemId > 0) itemIds.add(item.itemId);
      for (const gem of item.gems || []) {
        if (typeof gem.id === "number" && gem.id > 0) gemIds.add(gem.id);
      }
    }
  }

  const gemMeta = new Map();
  const itemMeta = new Map();
  const errors = [];
  const tasks = [
    ...Array.from(gemIds).map((gemId) => async () => {
      try {
        gemMeta.set(gemId, await getWowheadTbcItemMeta(gemId));
      } catch (error) {
        errors.push({ itemType: "gem", itemId: gemId, error: error.message || String(error) });
      }
    }),
    ...Array.from(itemIds).map((itemId) => async () => {
      try {
        itemMeta.set(itemId, await getWowheadTbcItemMeta(itemId));
      } catch (error) {
        errors.push({ itemType: "gear", itemId, error: error.message || String(error) });
      }
    }),
  ];
  await runLimited(tasks, 6);

  const rows = [];
  for (const player of cla.players) {
    const matches = [];
    for (const item of player.gearSnapshot || []) {
      for (const gem of item.gems || []) {
        const gemInfo = gemMeta.get(gem.id);
        const itemInfo = itemMeta.get(item.itemId);
        if (gemInfo?.quality === UNCOMMON_QUALITY) {
          matches.push({
            slotName: item.slotName,
            itemId: item.itemId,
            itemName: isPlaceholderItemName(item.itemName, item.itemId)
              ? (itemInfo?.name || `Item #${item.itemId}`)
              : item.itemName,
            gemId: gem.id,
            gemName: gemInfo.name || gem.name || `Item #${gem.id}`,
          });
        }
      }
    }
    if (matches.length > 0) {
      rows.push({
        player: player.name,
        className: player.className,
        spec: player.spec,
        gems: matches,
      });
    }
  }

  rows.sort((a, b) => b.gems.length - a.gems.length || a.player.localeCompare(b.player));
  return { rows, errors };
}

function isEnhancementShaman(player) {
  return player.className === "Shaman" && /enhancement/i.test(player.spec || "");
}

function isPlaceholderItemName(name, itemId) {
  if (!name) return true;
  return name === `Item #${itemId}` || /^Item #\d+$/.test(name);
}

function findCastMetric(casts, name) {
  return casts.find((cast) => cast.name === name) || null;
}

async function countWclV1CastMetrics(reportCode, { sourceId, start, end, abilityIds = [] }) {
  const counts = new Map(abilityIds.map((id) => [id, 0]));
  const timestampsByAbility = new Map(abilityIds.map((id) => [id, []]));
  let cursor = start;
  let totalEvents = 0;

  while (true) {
    const data = await wclV1GetJson(`/report/events/casts/${reportCode}`, {
      sourceid: sourceId,
      start: cursor,
      end,
    });
    const events = Array.isArray(data.events) ? data.events : [];
    totalEvents += events.length;
    for (const event of events) {
      const guid = event?.ability?.guid;
      if (counts.has(guid)) {
        counts.set(guid, counts.get(guid) + 1);
        if (typeof event.timestamp === "number") {
          timestampsByAbility.get(guid).push(event.timestamp);
        }
      }
    }
    const next = typeof data.nextPageTimestamp === "number" ? data.nextPageTimestamp : null;
    if (!next || next <= cursor || next >= end) break;
    cursor = next;
  }

  return {
    totalEvents,
    counts: Object.fromEntries(counts),
    timestamps: Object.fromEntries(
      Array.from(timestampsByAbility.entries()).map(([guid, timestamps]) => [guid, timestamps.sort((a, b) => a - b)]),
    ),
  };
}

function computeGapStats(timestamps, thresholdMs = WCL_WF_GAP_THRESHOLD_MS) {
  let gapCount = 0;
  let longestGapMs = 0;
  for (let i = 1; i < timestamps.length; i += 1) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > thresholdMs) {
      gapCount += 1;
      if (gap > longestGapMs) longestGapMs = gap;
    }
  }
  return { gapCount, longestGapMs };
}

async function computeWclV1OverallWindfury(reportCode, enhancementShamans, selectedFightIds = new Set()) {
  if (!getWclV1ApiKey()) {
    return { rows: [], pullCount: 0, fightDetails: [], errors: [] };
  }

  const fightsData = await getWclV1FightData(reportCode);
  const pulls = (fightsData.fights || []).filter((fight) => (
    typeof fight.start_time === "number"
    && typeof fight.end_time === "number"
    && fight.end_time > fight.start_time
  ));
  const friendliesByName = new Map(
    (fightsData.friendlies || []).map((friendly) => [String(friendly.name || "").toLowerCase(), friendly]),
  );

  const rows = [];
  const fightDetails = [];
  const errors = [];
  const tasks = enhancementShamans.map((player) => async () => {
    const actor = friendliesByName.get(player.name.toLowerCase());
    if (!actor) {
      errors.push({ player: player.name, error: "No matching WCL actor found" });
      return;
    }

    try {
      let wfCasts = 0;
      let graceCasts = 0;
      let activeCombatMs = 0;
      let activePulls = 0;
      let overallGapCount = 0;
      let overallLongestGapMs = 0;

      for (const pull of pulls) {
        const metrics = await countWclV1CastMetrics(reportCode, {
          sourceId: actor.id,
          start: pull.start_time,
          end: pull.end_time,
          abilityIds: [WCL_WF_ABILITY_ID, WCL_GRACE_ABILITY_ID],
        });
        if (metrics.totalEvents === 0) continue;
        activeCombatMs += (pull.end_time - pull.start_time);
        activePulls += 1;
        wfCasts += metrics.counts[WCL_WF_ABILITY_ID] || 0;
        graceCasts += metrics.counts[WCL_GRACE_ABILITY_ID] || 0;
        const wfTimestamps = metrics.timestamps[WCL_WF_ABILITY_ID] || [];
        const gapStats = computeGapStats(wfTimestamps);
        overallGapCount += gapStats.gapCount;
        overallLongestGapMs = Math.max(overallLongestGapMs, gapStats.longestGapMs);
        if (selectedFightIds.has(pull.id)) {
          fightDetails.push({
            player: player.name,
            fightId: pull.id,
            fightName: pull.name,
            wfCasts: metrics.counts[WCL_WF_ABILITY_ID] || 0,
            graceCasts: metrics.counts[WCL_GRACE_ABILITY_ID] || 0,
            gapCount: gapStats.gapCount,
            longestGapMs: gapStats.longestGapMs,
          });
        }
      }

      rows.push({
        player: player.name,
        sourceId: actor.id,
        totalPulls: pulls.length,
        activePulls,
        activeCombatMs,
        activeCombatMinutes: activeCombatMs / 60000,
        wfCasts,
        graceCasts,
        overallGapCount,
        overallLongestGapMs,
        overallWfCpm: activeCombatMs > 0 ? wfCasts / (activeCombatMs / 60000) : 0,
        overallGraceCpm: activeCombatMs > 0 ? graceCasts / (activeCombatMs / 60000) : 0,
      });
    } catch (error) {
      errors.push({ player: player.name, error: error.message || String(error) });
    }
  });

  await runLimited(tasks, 2);

  return {
    rows: rows.sort((a, b) => b.overallWfCpm - a.overallWfCpm || a.player.localeCompare(b.player)),
    pullCount: pulls.length,
    fightDetails: fightDetails.sort((a, b) => a.fightId - b.fightId || a.player.localeCompare(b.player)),
    errors,
  };
}

function findPrimaryBossActor(fightsData, fight) {
  const enemies = Array.isArray(fightsData?.enemies) ? fightsData.enemies : [];
  return enemies.find((enemy) => enemy.name === fight.name && (enemy.fights || []).some((ref) => ref.id === fight.id)) || null;
}

async function getWclV1DebuffTable(reportCode, { start, end, targetId, abilityId }) {
  return wclV1GetJson(`/report/tables/debuffs/${reportCode}`, {
    start,
    end,
    targetid: targetId,
    by: "target",
    abilityid: abilityId,
  });
}

function uniqueSortedNames(rows = []) {
  return Array.from(new Set(rows.map((row) => row.name).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
}

function formatPercent(value, total) {
  if (!total) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

async function attributionNamesForDebuff(reportCode, fight, targetId, abilityId) {
  const data = await getWclV1DebuffTable(reportCode, {
    start: fight.start_time,
    end: fight.end_time,
    targetId,
    abilityId,
  });
  return uniqueSortedNames(data.auras || []);
}

async function auditBossDebuffUptime(reportCode, fights, policy) {
  const config = trackedDebuffConfig(policy);
  if (!config?.groups?.length) return { fights: [], errors: [], note: null };
  if (!getWclV1ApiKey()) return { fights: [], errors: [], note: "Boss debuff uptime is unavailable without WCL API access." };

  const fightsData = await getWclV1FightData(reportCode);
  const errors = [];
  const fightRows = [];

  for (const fight of fights) {
    const fightMeta = (fightsData.fights || []).find((candidate) => candidate.id === fight.id);
    const bossActor = fightMeta ? findPrimaryBossActor(fightsData, fightMeta) : null;
    if (!fightMeta || !bossActor) {
      errors.push({ fightId: fight.id, error: `Could not resolve boss actor for ${fight.name}` });
      continue;
    }

    let table;
    try {
      table = await getWclV1DebuffTable(reportCode, {
        start: fightMeta.start_time,
        end: fightMeta.end_time,
        targetId: bossActor.id,
      });
    } catch (error) {
      errors.push({ fightId: fight.id, error: error.message || String(error) });
      continue;
    }

    const totalTime = table.totalTime || (fightMeta.end_time - fightMeta.start_time);
    const auras = Array.isArray(table.auras) ? table.auras : [];
    const rows = [];

    for (const group of config.groups) {
      if (group.kind === "pattern") {
        const pattern = new RegExp(group.namePattern, "i");
        const matches = auras
          .filter((aura) => pattern.test(aura.name || ""))
          .sort((left, right) => (right.totalUptime - left.totalUptime) || left.name.localeCompare(right.name));

        if (matches.length === 0) {
          if (group.alwaysShow) rows.push({ label: group.label, text: group.emptyText || "none" });
          continue;
        }

        const parts = [];
        for (const aura of matches) {
          let sources = [];
          try {
            sources = await attributionNamesForDebuff(reportCode, fightMeta, bossActor.id, aura.guid);
          } catch (error) {
            errors.push({ fightId: fight.id, abilityId: aura.guid, error: error.message || String(error) });
          }
          const sourceSuffix = sources.length > 0 ? ` (${sources.join(", ")})` : "";
          parts.push(`${aura.name} ${formatPercent(aura.totalUptime, totalTime)}${sourceSuffix}`);
        }
        rows.push({ label: group.label, text: parts.join("; ") });
        continue;
      }

      if (group.kind === "ability") {
        const aura = auras.find((candidate) => candidate.guid === group.abilityId || nameMatches(candidate.name || "", group.abilityName || ""));
        if (!aura) {
          if (group.alwaysShow) rows.push({ label: group.label, text: group.emptyText || "0.0%" });
          continue;
        }

        let sources = [];
        try {
          sources = await attributionNamesForDebuff(reportCode, fightMeta, bossActor.id, aura.guid);
        } catch (error) {
          errors.push({ fightId: fight.id, abilityId: aura.guid, error: error.message || String(error) });
        }
        const sourceSuffix = sources.length > 0 ? ` (${sources.join(", ")})` : "";
        rows.push({ label: group.label, text: `${formatPercent(aura.totalUptime, totalTime)}${sourceSuffix}` });
      }
    }

    if (rows.length > 0) {
      fightRows.push({
        fightId: fight.id,
        fightName: fight.name,
        rows,
      });
    }
  }

  return {
    fights: fightRows,
    errors,
    note: null,
  };
}

async function auditWindfury(reportCode, report, fights, cla) {
  const enhancementShamans = cla.players.filter(isEnhancementShaman);
  const rows = [];
  const errors = [];
  const tasks = [];

  for (const fight of fights) {
    for (const player of enhancementShamans) {
      const hasFight = (player.fightData || []).some((d) => d.fightId === fight.id);
      if (!hasFight) continue;
      tasks.push(async () => {
        try {
          const data = await postJson("/api/analyze", {
            reportCode,
            fightId: fight.id,
            sourceId: player.sourceId,
            encounterID: fight.encounterID,
            encounterName: fight.name,
            zoneName: report.zone,
          });
          const casts = Array.isArray(data.casts?.casts)
            ? data.casts.casts
            : Array.isArray(data.casts)
              ? data.casts
              : [];
          const wf = findCastMetric(casts, "Windfury Totem");
          const grace = findCastMetric(casts, "Grace of Air Totem");
          const strength = findCastMetric(casts, "Strength of Earth Totem");
          rows.push({
            fightId: fight.id,
            fightName: fight.name,
            player: data.playerName || player.name,
            className: data.playerClass || player.className,
            spec: data.playerSpec || player.spec,
            wfCasts: wf?.playerCasts || 0,
            wfCpm: typeof wf?.playerCpm === "number" ? wf.playerCpm : 0,
            graceCasts: grace?.playerCasts || 0,
            graceCpm: typeof grace?.playerCpm === "number" ? grace.playerCpm : 0,
            strengthCasts: strength?.playerCasts || 0,
            strengthCpm: typeof strength?.playerCpm === "number" ? strength.playerCpm : 0,
            twistPairs: Math.min(wf?.playerCasts || 0, grace?.playerCasts || 0),
          });
        } catch (error) {
          errors.push({ fight: fight.name, player: player.name, error: error.message || String(error) });
        }
      });
    }
  }

  await runLimited(tasks, 4);
  let overall = { rows: [], pullCount: 0, errors: [] };
  try {
    overall = await computeWclV1OverallWindfury(reportCode, enhancementShamans, new Set(fights.map((fight) => fight.id)));
  } catch (error) {
    overall.errors = [{ player: "overall", error: error.message || String(error) }];
  }

  const overallFightStats = new Map(
    (overall.fightDetails || []).map((row) => [`${row.player}:${row.fightId}`, row]),
  );

  return {
    note: overall.rows.length === 0
      ? "Overall incl trash WF CPM is unavailable. Current section is boss-pull CPM from Parseforge."
      : null,
    overall,
    fights: fights.map((fight) => ({
      fightId: fight.id,
      fightName: fight.name,
      rows: rows
        .filter((row) => row.fightId === fight.id)
        .map((row) => ({
          ...row,
          wcl: overallFightStats.get(`${row.player}:${fight.id}`) || null,
        }))
        .sort((a, b) => a.player.localeCompare(b.player)),
    })),
    errors: [...errors, ...overall.errors],
  };
}

async function auditSappers(reportCode, report, fights, cla) {
  const rows = [];
  const errors = [];
  const tasks = [];

  for (const fight of fights) {
    for (const player of cla.players) {
      const hasFight = (player.fightData || []).some((d) => d.fightId === fight.id);
      if (!hasFight) continue;
      tasks.push(async () => {
        try {
          const data = await postJson("/api/analyze", {
            reportCode,
            fightId: fight.id,
            sourceId: player.sourceId,
            encounterID: fight.encounterID,
            encounterName: fight.name,
            zoneName: report.zone,
          });
          const casts = Array.isArray(data.casts?.casts)
            ? data.casts.casts
            : Array.isArray(data.casts)
              ? data.casts
              : [];
          const abilities = Array.isArray(data.abilities) ? data.abilities : [];
          for (const cast of casts.filter((c) => /sapper/i.test(c.name || ""))) {
            const ability = abilities.find((a) => a.guid === cast.guid || a.name === cast.name);
            rows.push({
              fightId: fight.id,
              fightName: fight.name,
              player: data.playerName || player.name,
              className: data.playerClass || player.className,
              spec: data.playerSpec || player.spec,
              type: cast.name,
              spellId: cast.guid,
              casts: cast.playerCasts || 0,
              damage: typeof ability?.playerTotal === "number" ? ability.playerTotal : null,
            });
          }
        } catch (error) {
          errors.push({ fight: fight.name, player: player.name, error: error.message || String(error) });
        }
      });
    }
  }

  await runLimited(tasks, 4);

  const byPlayer = new Map();
  for (const row of rows) {
    const existing = byPlayer.get(row.player) || {
      player: row.player,
      className: row.className,
      spec: row.spec,
      totalCasts: 0,
      totalDamage: 0,
      types: new Map(),
    };
    existing.totalCasts += row.casts;
    if (typeof row.damage === "number") existing.totalDamage += row.damage;
    const type = existing.types.get(row.type) || { casts: 0, damage: 0 };
    type.casts += row.casts;
    if (typeof row.damage === "number") type.damage += row.damage;
    existing.types.set(row.type, type);
    byPlayer.set(row.player, existing);
  }

  return {
    rows: rows.sort((a, b) => a.fightId - b.fightId || a.player.localeCompare(b.player)),
    summary: Array.from(byPlayer.values())
      .map((row) => ({
        ...row,
        types: Array.from(row.types.entries()).map(([type, value]) => ({ type, ...value })),
      }))
      .sort((a, b) => b.totalCasts - a.totalCasts || a.player.localeCompare(b.player)),
    errors,
  };
}

async function runLimited(tasks, limit) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      await task();
    }
  }));
}

function formatDamage(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : "unknown";
}

function typeSummary(types) {
  return types.map((type) => `${type.casts}x ${type.type}`).join(", ");
}

function formatGreenGemDetails(gems) {
  const grouped = new Map();
  for (const gem of gems) {
    const key = JSON.stringify([gem.slotName, gem.itemName || `Item #${gem.itemId}`, gem.gemName]);
    const current = grouped.get(key);
    if (current) {
      current.count += 1;
    } else {
      grouped.set(key, {
        slotName: gem.slotName,
        itemName: gem.itemName || `Item #${gem.itemId}`,
        gemName: gem.gemName,
        count: 1,
      });
    }
  }

  return Array.from(grouped.values())
    .map((entry) => `${entry.slotName} (${entry.itemName}): ${entry.gemName}${entry.count > 1 ? ` x${entry.count}` : ""}`)
    .join("; ");
}

function formatGapSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

function renderMarkdown(result) {
  const lines = [];
  lines.push(`**${result.policy.reportTitle || "Leadership Consume / Enchant / Sapper Report"}**`);
  lines.push(`Source: ${result.source}`);

  for (const fight of result.consumeFindings.filter((fight) => fight.rows.length > 0)) {
    lines.push("");
    lines.push(`**${fight.fightName}**`);
    for (const row of fight.rows) {
      for (const finding of row.findings) {
        lines.push(`- ${row.player}: **${finding.label}** - ${finding.text}`);
      }
    }
  }

  if (result.bossDebuffUptime.fights.length > 0 || result.bossDebuffUptime.note) {
    lines.push("");
    lines.push("**Boss Debuff Uptime**");
    for (const fight of result.bossDebuffUptime.fights) {
      lines.push(`- ${fight.fightName}:`);
      for (const row of fight.rows) {
        lines.push(`  - ${row.label}: ${row.text}`);
      }
    }
    if (result.bossDebuffUptime.note) {
      lines.push(`- ${result.bossDebuffUptime.note}`);
    }
  }

  const windfuryFights = result.windfury.fights.filter((fight) => fight.rows.length > 0);
  const overallWindfury = result.windfury.overall?.rows || [];
  if (windfuryFights.length > 0 || overallWindfury.length > 0 || result.windfury.note) {
    lines.push("");
    lines.push("**Windfury / Twisting**");
    if (overallWindfury.length > 0) {
      lines.push("- Overall incl trash:");
      for (const row of overallWindfury) {
        const pullsSuffix = row.activePulls !== row.totalPulls
          ? `; active in ${row.activePulls}/${row.totalPulls} pulls`
          : "";
        const gapSuffix = row.overallGapCount > 0
          ? `; gaps >10s ${row.overallGapCount}, longest ${formatGapSeconds(row.overallLongestGapMs)}s`
          : "; gaps >10s 0";
        lines.push(`  - ${row.player}: WF ${row.wfCasts} (${row.overallWfCpm.toFixed(1)} CPM), Grace ${row.graceCasts} (${row.overallGraceCpm.toFixed(1)} CPM)${pullsSuffix}${gapSuffix}`);
      }
    }
    for (const fight of windfuryFights) {
      lines.push(`- ${fight.fightName}:`);
      for (const row of fight.rows) {
        const gapSuffix = row.wcl
          ? `, gaps >10s ${row.wcl.gapCount}${row.wcl.longestGapMs > 0 ? `, longest ${formatGapSeconds(row.wcl.longestGapMs)}s` : ""}`
          : "";
        lines.push(`  - ${row.player}: WF ${row.wfCasts} (${row.wfCpm.toFixed(1)} CPM), Grace ${row.graceCasts} (${row.graceCpm.toFixed(1)} CPM), twist pairs ${row.twistPairs}${gapSuffix}`);
      }
    }
    if (result.windfury.note) {
      lines.push(`- ${result.windfury.note}`);
    }
  }

  if (result.sappers.summary.length > 0) {
    lines.push("");
    lines.push("**Sapper usage**");
    for (const row of result.sappers.summary) {
      const castLabel = row.totalCasts === 1 ? "cast" : "casts";
      lines.push(`- ${row.player}: ${row.totalCasts} total ${castLabel} - ${typeSummary(row.types)}; ${formatDamage(row.totalDamage)} dmg logged`);
    }
  }

  if (result.enchantFindings.length > 0) {
    lines.push("");
    lines.push("**Enchant flags**");
    for (const row of result.enchantFindings) {
      lines.push(`- ${row.player}: ${row.missing.length} missing - ${row.missing.join(", ")}`);
    }
  }

  if (result.greenGemFindings.rows.length > 0) {
    lines.push("");
    lines.push("**Green gem flags**");
    for (const row of result.greenGemFindings.rows) {
      const details = formatGreenGemDetails(row.gems);
      lines.push(`- ${row.player}: ${row.gems.length} green gem${row.gems.length === 1 ? "" : "s"} - ${details}`);
    }
  }

  const warningLines = [];
  if (result.sappers.errors.length > 0) {
    warningLines.push(`- Sapper analysis had ${result.sappers.errors.length} player/fight fetch errors; rerun if exact sapper counts matter.`);
  }
  if (result.windfury?.errors?.length > 0) {
    warningLines.push(`- Windfury analysis had ${result.windfury.errors.length} fetch errors; rerun if exact CPM counts matter.`);
  }
  if (result.bossDebuffUptime?.errors?.length > 0) {
    warningLines.push(`- Boss debuff uptime analysis had ${result.bossDebuffUptime.errors.length} WCL fetch errors; rerun if exact uptime values matter.`);
  }
  if (result.greenGemFindings.errors.length > 0) {
    warningLines.push(`- Green gem analysis had ${result.greenGemFindings.errors.length} gem lookup errors; rerun if exact green gem flags matter.`);
  }
  if (warningLines.length > 0) {
    lines.push("");
    lines.push("**Data warnings**");
    lines.push(...warningLines);
  }

  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = await loadPolicy(options.policyPath);
  const reportCode = extractReportCode(options.input);
  const report = await getJson(`/api/report/${reportCode}`);
  const selectedFightIds = new Set(options.fightIds);
  const fights = report.fights
    .filter((fight) => fight.kill)
    .filter((fight) => selectedFightIds.size === 0 || selectedFightIds.has(fight.id));

  if (fights.length === 0) throw new Error("No matching killed fights found");

  const cla = await postJson("/api/cla", {
    reportCode,
    fightIds: fights.map((fight) => fight.id),
  });

  const result = {
    source: options.input,
    reportCode,
    report: {
      title: report.title,
      owner: report.owner,
      zone: report.zone,
    },
    fights: fights.map((fight) => ({
      id: fight.id,
      name: fight.name,
      duration: fight.duration,
      encounterID: fight.encounterID,
    })),
    policy: {
      name: policy.name,
      version: policy.version,
      reportTitle: policy.reportTitle,
      reportRules: policy.reportRules,
      path: options.policyPath,
    },
    wcl: {
      configured: Boolean(getWclConfig()),
      apiUrl: getWclConfig()?.apiUrl || null,
    },
    consumeFindings: auditConsumes(report, fights, cla, options, policy),
    enchantFindings: auditEnchants(cla),
    greenGemFindings: await auditGreenGems(cla),
    bossDebuffUptime: await auditBossDebuffUptime(reportCode, fights, policy),
    windfury: await auditWindfury(reportCode, report, fights, cla),
    sappers: options.skipSappers ? { rows: [], summary: [], errors: [] } : await auditSappers(reportCode, report, fights, cla),
  };

  if (options.format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderMarkdown(result));
  }
}

main().catch((error) => {
  console.error(`raid_audit: ${error.message || error}`);
  usage();
  process.exit(1);
});
