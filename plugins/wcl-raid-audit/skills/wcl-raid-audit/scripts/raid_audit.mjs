#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.PARSEFORGE_BASE_URL || "https://parseforge.vercel.app";
const WCL_V1_BASE_URL = process.env.WARCRAFTLOGS_V1_BASE_URL || "https://www.warcraftlogs.com/v1";
const WOWHEAD_TBC_TOOLTIP_BASE_URL = process.env.WOWHEAD_TBC_TOOLTIP_BASE_URL || "https://nether.wowhead.com/tooltip/item";
const WOWHEAD_TBC_DATA_ENV = process.env.WOWHEAD_TBC_DATA_ENV || "5";
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POLICY_PATH = resolve(SKILL_DIR, "references/default-guild-policy.json");
const WCL_WF_ABILITY_ID = 25587;
const WCL_GRACE_ABILITY_ID = 25359;
const WCL_EXPOSE_ARMOR_ABILITY_ID = 26866;
const WCL_SUNDER_ARMOR_ABILITY_ID = 25225;
const WCL_JUDGEMENT_CAST_ABILITY_ID = 20271;
const WCL_IRONSHIELD_POTION_ABILITY_ID = 28515;
const WCL_DEMORALIZING_SHOUT_ABILITY_ID = 25203;
const WCL_DEMORALIZING_ROAR_ABILITY_ID = 26998;
const WCL_WF_GAP_THRESHOLD_MS = 10000;
const WCL_BOSS_ACTIVE_GAP_MS = 10000;
const WCL_ARMOR_DEBUFF_REPLACEMENT_GRACE_MS = 1500;
const WCL_JUDGEMENT_INITIAL_GRACE_MS = 2000;
const WCL_DEATH_SNAPSHOT_WINDOW_MS = 5000;
const WCL_DEATH_DAMAGE_ROWS = 3;
const WCL_PHYSICAL_SCHOOL_ID = 1;
const WCL_IRONSHIELD_MIN_PHYSICAL_SHARE = 0.2;
const COMMON_QUALITY = 1;
const UNCOMMON_QUALITY = 2;
const SCROLL_RANK_PATTERN = "(?:IV|V)";
const wowheadItemCache = new Map();
const wclFightDataCache = new Map();
const requestCache = new Map();
let diskCacheDb = null;
let diskCacheDisabled = false;

function retryConfig() {
  return {
    maxAttempts: Number.parseInt(process.env.RAID_AUDIT_MAX_RETRIES || "5", 10),
    baseDelayMs: Number.parseInt(process.env.RAID_AUDIT_RETRY_BASE_MS || "1000", 10),
    maxDelayMs: Number.parseInt(process.env.RAID_AUDIT_RETRY_MAX_MS || "30000", 10),
  };
}

function logProgress(message) {
  console.error(`[raid-audit] ${message}`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRetryableRateLimit(status, data, text) {
  const message = `${data?.error || ""} ${text || ""}`;
  return status === 429 || /\b429\b|too many requests/i.test(message);
}

function delayForAttempt(attemptIndex, { baseDelayMs, maxDelayMs }) {
  return Math.min(maxDelayMs, baseDelayMs * (2 ** attemptIndex));
}

function diskCachePath() {
  if (process.env.RAID_AUDIT_DISABLE_DISK_CACHE === "1") return null;
  if (process.env.RAID_AUDIT_CACHE_PATH) return resolve(process.env.RAID_AUDIT_CACHE_PATH);
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "wcl-raid-audit", "raid-audit-cache.sqlite");
}

function diskCache() {
  if (diskCacheDisabled) return null;
  if (diskCacheDb) return diskCacheDb;

  const cachePath = diskCachePath();
  if (!cachePath) {
    diskCacheDisabled = true;
    return null;
  }

  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    diskCacheDb = new DatabaseSync(cachePath);
    diskCacheDb.exec(`
      CREATE TABLE IF NOT EXISTS http_cache (
        cache_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    return diskCacheDb;
  } catch (error) {
    diskCacheDisabled = true;
    logProgress(`Persistent cache unavailable: ${error.message || String(error)}`);
    return null;
  }
}

function persistentCacheKey(cacheKey) {
  const match = cacheKey.match(/^(GET|POST) (https?:\/\/\S+)(.*)$/);
  if (!match) return cacheKey;

  try {
    const url = new URL(match[2]);
    url.searchParams.delete("api_key");
    return `${match[1]} ${url.toString()}${match[3] || ""}`;
  } catch {
    return cacheKey.replace(/([?&]api_key=)[^&\s]+/i, "$1<redacted>");
  }
}

function getDiskCachedJson(cacheKey) {
  const db = diskCache();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT payload FROM http_cache WHERE cache_key = ?").get(cacheKey);
    return row?.payload ? JSON.parse(row.payload) : null;
  } catch (error) {
    logProgress(`Persistent cache read failed: ${error.message || String(error)}`);
    return null;
  }
}

function setDiskCachedJson(cacheKey, data) {
  const db = diskCache();
  if (!db) return;
  try {
    db.prepare(`
      INSERT OR REPLACE INTO http_cache (cache_key, created_at, payload)
      VALUES (?, ?, ?)
    `).run(cacheKey, Date.now(), JSON.stringify(data));
  } catch (error) {
    logProgress(`Persistent cache write failed: ${error.message || String(error)}`);
  }
}

async function readJsonResponse(res, errorPrefix) {
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const error = new Error(`${errorPrefix} returned non-JSON: ${text.slice(0, 200)}`);
    error.status = res.status;
    error.bodyText = text;
    throw error;
  }

  return { data, text };
}

async function fetchJsonWithRetry({ label, errorPrefix, fetcher }) {
  const config = retryConfig();
  logProgress(label);

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const res = await fetcher();
    const { data, text } = await readJsonResponse(res, errorPrefix);
    const retryable = isRetryableRateLimit(res.status, data, text);

    if (res.ok && !data?.error) return data;

    if (retryable && attempt < config.maxAttempts) {
      const delayMs = delayForAttempt(attempt - 1, config);
      logProgress(`${errorPrefix} hit ${res.status}; retrying in ${delayMs}ms (attempt ${attempt}/${config.maxAttempts})`);
      await sleep(delayMs);
      continue;
    }

    if (!res.ok) throw new Error(`${errorPrefix} failed ${res.status}: ${data.error || text.slice(0, 200)}`);
    throw new Error(`${errorPrefix}: ${data.error}`);
  }

  throw new Error(`${errorPrefix} exhausted retries`);
}

function cachedJsonRequest(cacheKey, options) {
  if (requestCache.has(cacheKey)) return requestCache.get(cacheKey);
  const diskKey = persistentCacheKey(cacheKey);
  const diskCached = getDiskCachedJson(diskKey);
  if (diskCached) {
    const promise = Promise.resolve(diskCached);
    requestCache.set(cacheKey, promise);
    return promise;
  }

  const promise = fetchJsonWithRetry(options).then((data) => {
    setDiskCachedJson(diskKey, data);
    return data;
  }).catch((error) => {
    requestCache.delete(cacheKey);
    throw error;
  });
  requestCache.set(cacheKey, promise);
  return promise;
}

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
  return cachedJsonRequest(`GET ${BASE_URL}${path}`, {
    label: path.startsWith("/api/report/")
      ? "Loading report metadata"
      : `GET ${path}`,
    errorPrefix: path,
    fetcher: () => fetch(`${BASE_URL}${path}`),
  });
}

async function postJson(path, body) {
  const bodyText = JSON.stringify(body);
  return cachedJsonRequest(`POST ${BASE_URL}${path} ${stableStringify(body)}`, {
    label: path === "/api/cla"
      ? "Loading Parseforge consume data"
      : `POST ${path}`,
    errorPrefix: path,
    fetcher: () => fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyText,
    }),
  });
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
  return cachedJsonRequest(`GET ${url.toString()}`, {
    label: `Loading WCL v1 ${path}`,
    errorPrefix: `WCL v1 ${path}`,
    fetcher: () => fetch(url),
  });
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
      name: data?.name || null,
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

function auraName(aura) {
  return aura?.spellName || aura?.name || "";
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

function isMage(player) {
  return player.className === "Mage";
}

function isPhysical(player) {
  return player.role === "Physical" || player.role === "Tank";
}

function isDps(player) {
  return player.role === "Physical" || player.role === "Caster";
}

function isProtectionPaladin(player) {
  return player.className === "Paladin" && /protection|justicar/i.test(player.spec || "");
}

function isSpellDamageRole(player) {
  if (isProtectionPaladin(player)) return true;
  if (player.role === "Caster" || player.role === "Healer") return true;
  return ["Mage", "Warlock", "Priest"].includes(player.className)
    || (player.className === "Druid" && /balance|dreamstate|restoration/i.test(player.spec || ""))
    || (player.className === "Shaman" && /elemental|restoration/i.test(player.spec || ""));
}

function isMeleeDpsOrHunter(player) {
  if (isHunter(player)) return true;
  if (player.className === "Rogue") return true;
  if (player.className === "Warrior") return !/protection/i.test(player.spec || "");
  if (player.className === "Shaman") return /enhancement/i.test(player.spec || "");
  if (player.className === "Druid") return /feral|cat/i.test(player.spec || "");
  if (player.className === "Paladin") return /retribution/i.test(player.spec || "");
  return false;
}

function encounterRuleFor(policy, fightName) {
  return (policy.encounters || []).find((rule) => new RegExp(rule.match, "i").test(fightName)) || null;
}

function isMaulgarFight(fight) {
  return /maulgar/i.test(fight.name || "");
}

function trackedDebuffConfig(policy) {
  return policy.trackedDebuffs || null;
}

function normalizedPlayerName(player) {
  return String(player?.name || "").trim().toLowerCase();
}

function consumablePresenceScore(fightData) {
  const c = fightData?.consumables || {};
  const slots = [c.flask, c.battleElixir, c.guardianElixir, c.food, c.weaponEnhancement];
  const presentSlots = slots.filter(isPresent).length;
  const scrollCount = Array.isArray(c.scrolls) ? c.scrolls.filter(isPresent).length : 0;
  return presentSlots + scrollCount + ((typeof c.averageUptime === "number" ? c.averageUptime : 0) / 1000);
}

function playerRepresentativeScore(player) {
  if (isDps(player)) return 3;
  if (isTank(player)) return 2;
  if (player?.role === "Healer") return 1;
  return 0;
}

function uniqueBySignature(values, signatureForValue) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const signature = signatureForValue(value);
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(value);
  }
  return unique;
}

function consolidatePlayersByName(players = []) {
  const groups = new Map();
  for (const player of players) {
    const key = normalizedPlayerName(player) || `source:${player?.sourceId || groups.size}`;
    const group = groups.get(key) || [];
    group.push(player);
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((group) => {
    if (group.length === 1) return group[0];

    const representative = [...group].sort((left, right) => (
      playerRepresentativeScore(right) - playerRepresentativeScore(left)
      || String(left.name || "").localeCompare(String(right.name || ""))
    ))[0];

    const fightDataById = new Map();
    for (const player of group) {
      for (const fightData of player.fightData || []) {
        const existing = fightDataById.get(fightData.fightId);
        if (!existing || consumablePresenceScore(fightData) > consumablePresenceScore(existing)) {
          fightDataById.set(fightData.fightId, fightData);
        }
      }
    }

    const gearIssues = uniqueBySignature(
      group.flatMap((player) => player.gearIssues || []),
      (issue) => JSON.stringify([issue.issueType, issue.slotName, issue.itemId || "", issue.itemName || ""]),
    );
    const gearSnapshot = uniqueBySignature(
      group.flatMap((player) => player.gearSnapshot || []),
      (item) => JSON.stringify([
        item.slotName,
        item.itemId || "",
        item.itemName || "",
        (item.gems || []).map((gem) => [gem.id || "", gem.name || ""]),
      ]),
    );

    return {
      ...representative,
      fightData: Array.from(fightDataById.values()).sort((left, right) => left.fightId - right.fightId),
      gearIssues,
      gearSnapshot,
    };
  });
}

function itemForSlot(player, slotName) {
  const expected = String(slotName || "").toLowerCase();
  return (player.gearSnapshot || []).find((item) => String(item.slotName || "").toLowerCase() === expected) || null;
}

function formatSlotWithItem(slotName, item) {
  const itemName = reportItemName(item);
  return itemName ? `${slotName} (${itemName})` : slotName;
}

function weaponEnhancementTargetText(player) {
  const weaponSlots = ["Main Hand", "Off Hand", "Ranged"];
  const weapons = weaponSlots
    .map((slotName) => {
      const item = itemForSlot(player, slotName);
      return item ? formatSlotWithItem(slotName, item) : null;
    })
    .filter(Boolean);
  return weapons.length > 0 ? ` on ${weapons.join(", ")}` : "";
}

function reportItemName(item) {
  const itemName = item?.itemName || item?.name || "";
  if (!itemName || isPlaceholderItemName(itemName, item?.itemId)) return "";
  return itemName;
}

async function hydratePlayerGearItemNames(players = []) {
  const itemIds = new Set();
  for (const player of players) {
    for (const item of player.gearSnapshot || []) {
      if (typeof item.itemId === "number" && item.itemId > 0 && isPlaceholderItemName(item.itemName, item.itemId)) {
        itemIds.add(item.itemId);
      }
    }
  }

  const itemMeta = new Map();
  const tasks = Array.from(itemIds).map((itemId) => async () => {
    try {
      const meta = await getWowheadTbcItemMeta(itemId);
      if (meta?.name) itemMeta.set(itemId, meta.name);
    } catch {
      // Missing metadata should not block the report; unresolved placeholders are omitted from display.
    }
  });
  await runLimited(tasks, 6);

  for (const player of players) {
    for (const item of player.gearSnapshot || []) {
      const name = itemMeta.get(item.itemId);
      if (name) item.itemName = name;
    }
  }
}

function hasAcceptableHunterSetup(c, hunterRule = {}) {
  if (isPresent(c.flask)) return true;
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

function hasScroll(scrolls = [], stat) {
  const pattern = new RegExp(`^Scroll of ${stat} ${SCROLL_RANK_PATTERN}$`, "i");
  return scrolls.some((scroll) => pattern.test(auraName(scroll)));
}

function scrollRequirementText(stat) {
  return `Scroll of ${stat} IV/V`;
}

function shouldAuditPhysicalScrolls(policy) {
  return policy.general?.physicalScrolls?.expected === true;
}

function hasPhysicalConsumeExpectation(rule = null) {
  return Boolean(
    rule
      && (rule.expectedBattleElixirs?.length || rule.expectedFlasks?.length || rule.hunter),
  );
}

function auditSelfScrolls(player, c) {
  const scrolls = c.scrolls || [];
  if (isHunter(player)) {
    if (hasScroll(scrolls, "Agility")) return null;
    return {
      label: "Missing",
      text: `expected ${scrollRequirementText("Agility")} on self; no matching self scroll recorded`,
    };
  }

  if (hasScroll(scrolls, "Agility") || hasScroll(scrolls, "Strength")) return null;
  return {
    label: "Missing",
    text: `expected ${scrollRequirementText("Agility")} or ${scrollRequirementText("Strength")}; no matching self scroll recorded`,
  };
}

async function getWclV1BuffTable(reportCode, { start, end, targetId }) {
  return wclV1GetJson(`/report/tables/buffs/${reportCode}`, {
    start,
    end,
    targetid: targetId,
    by: "target",
  });
}

async function getWclV1BuffTableByAbility(reportCode, { start, end, abilityId }) {
  return wclV1GetJson(`/report/tables/buffs/${reportCode}`, {
    start,
    end,
    by: "source",
    abilityid: abilityId,
  });
}

function petParticipatedInFight(pet, fightId) {
  return (pet.fights || []).some((ref) => ref.id === fightId);
}

async function auditHunterPetScrolls(reportCode, fight, fightMeta, hunterPets) {
  const findings = [];
  for (const pet of hunterPets.filter((candidate) => petParticipatedInFight(candidate, fight.id))) {
    let table;
    try {
      table = await getWclV1BuffTable(reportCode, {
        start: fightMeta.start_time,
        end: fightMeta.end_time,
        targetId: pet.id,
      });
    } catch (error) {
      findings.push({
        label: "Data unavailable",
        text: `pet ${pet.name} scroll check failed: ${error.message || String(error)}`,
      });
      continue;
    }
    const auras = Array.isArray(table.auras) ? table.auras : [];
    const missing = [];
    if (!hasScroll(auras, "Agility")) missing.push(scrollRequirementText("Agility"));
    if (!hasScroll(auras, "Strength")) missing.push(scrollRequirementText("Strength"));
    if (missing.length > 0) {
      findings.push({
        label: "Missing",
        text: `pet ${pet.name} expected ${scrollRequirementText("Agility")} and ${scrollRequirementText("Strength")}; missing ${missing.join(" and ")}`,
      });
    }
  }
  return findings;
}

async function auditConsumes(reportCode, report, fights, cla, options, policy) {
  const findingsByFight = [];
  const auditScrolls = shouldAuditPhysicalScrolls(policy);
  let fightsData = null;
  let friendlyPetsByOwner = new Map();
  let fightMetaById = new Map();

  if (auditScrolls && getWclV1ApiKey()) {
    fightsData = await getWclV1FightData(reportCode);
    fightMetaById = new Map((fightsData.fights || []).map((fight) => [fight.id, fight]));
    for (const pet of fightsData.friendlyPets || []) {
      const pets = friendlyPetsByOwner.get(pet.petOwner) || [];
      pets.push(pet);
      friendlyPetsByOwner.set(pet.petOwner, pets);
    }
  }

  for (const fight of fights) {
    const encounterRule = encounterRuleFor(policy, fight.name);
    const fightMeta = fightMetaById.get(fight.id);
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
        scrolls: (c.scrolls || []).map((scroll) => auraName(scroll)).filter(Boolean),
      };

      const applyPhysicalPolicy = isMeleeDpsOrHunter(player) && (options.includeTanks || !isTank(player));
      const exemptMageTank = isMaulgarFight(fight) && isMage(player);

      if (exemptMageTank) {
        // Mage tank assignments on Maulgar are intentionally reviewed manually.
      } else if (applyPhysicalPolicy && !isProtectionPaladin(player)) {
        const physicalRule = encounterRule?.physicalDps || null;

        if (hasPhysicalConsumeExpectation(physicalRule)) {
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
            const metExpectedBattle = !physicalRule.expectedBattleElixirs?.length
              || isPresent(c.flask)
              || slotMatches(c.battleElixir, physicalRule.expectedBattleElixirs);

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
        }

        if (auditScrolls) {
          const scrollFinding = auditSelfScrolls(player, c);
          if (scrollFinding) findings.push(scrollFinding);

          if (isHunter(player) && fightMeta && friendlyPetsByOwner.has(player.sourceId)) {
            findings.push(...await auditHunterPetScrolls(
              reportCode,
              fight,
              fightMeta,
              friendlyPetsByOwner.get(player.sourceId),
            ));
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
        findings.push({
          label: "Missing",
          text: `missing weapon enhancement/oil/stone${weaponEnhancementTargetText(player)}`,
        });
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

function auditEnchants(cla, fights) {
  const hasMaulgar = fights.some(isMaulgarFight);
  const rows = cla.players
    .map((player) => ({
      player: player.name,
      className: player.className,
      spec: player.spec,
      role: player.role,
      missing: (player.gearIssues || [])
        .filter((issue) => issue.issueType === "missing_enchant")
        .filter((issue) => !(player.role === "Healer" && issue.slotName === "Back"))
        .map((issue) => formatSlotWithItem(issue.slotName, itemForSlot(player, issue.slotName))),
    }))
    .filter((row) => !(hasMaulgar && row.className === "Mage"))
    .filter((row) => row.missing.length > 0);

  return uniqueRowsBy(rows, (row) => JSON.stringify([
    row.player,
    row.className,
    row.missing,
  ]))
    .sort((a, b) => b.missing.length - a.missing.length || a.player.localeCompare(b.player));
}

function uniqueRowsBy(rows, keyForRow) {
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = keyForRow(row);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
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
        if (isLowQualityGem(gemInfo)) {
          matches.push({
            slotName: item.slotName,
            itemId: item.itemId,
            itemName: isPlaceholderItemName(item.itemName, item.itemId)
              ? (itemInfo?.name || null)
              : item.itemName,
            gemId: gem.id,
            gemName: gemInfo.name || gem.name || "unknown gem",
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

  const uniqueRows = uniqueRowsBy(rows, (row) => JSON.stringify([
    row.player,
    row.className,
    greenGemSignature(row.gems),
  ]));

  uniqueRows.sort((a, b) => b.gems.length - a.gems.length || a.player.localeCompare(b.player));
  return { rows: uniqueRows, errors };
}

function isLowQualityGem(gemInfo) {
  return gemInfo?.quality === COMMON_QUALITY || gemInfo?.quality === UNCOMMON_QUALITY;
}

function isEnhancementShaman(player) {
  return player.className === "Shaman" && /enhancement/i.test(player.spec || "");
}

function isPlaceholderItemName(name, itemId) {
  if (!name) return true;
  return name === `Item #${itemId}` || /^Item #\d+$/.test(name);
}

function greenGemSignature(gems) {
  return gems
    .map((gem) => JSON.stringify([
      gem.slotName,
      gem.itemId,
      gem.itemName,
      gem.gemId,
      gem.gemName,
    ]))
    .sort();
}

function findCastMetric(casts, name) {
  return casts.find((cast) => cast.name === name) || null;
}

function castCount(cast) {
  return typeof cast?.playerCasts === "number" ? cast.playerCasts : 0;
}

function countPotionCasts(casts, matcher) {
  return casts
    .filter((cast) => matcher(cast.name || "", cast.guid))
    .reduce((total, cast) => total + castCount(cast), 0);
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

async function getWclV1CastEvents(reportCode, { start, end, abilityId, targetId }) {
  const events = [];
  let cursor = start;
  while (true) {
    const data = await wclV1GetJson(`/report/events/casts/${reportCode}`, {
      start: cursor,
      end,
      abilityid: abilityId,
      targetid: targetId,
    });
    events.push(...(Array.isArray(data.events) ? data.events : []));
    const next = typeof data.nextPageTimestamp === "number" ? data.nextPageTimestamp : null;
    if (!next || next <= cursor || next >= end) break;
    cursor = next;
  }
  return events;
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

function actorNameById(fightsData) {
  const actors = new Map();
  for (const group of ["friendlies", "friendlyPets", "enemies", "enemyPets"]) {
    for (const actor of fightsData?.[group] || []) {
      if (typeof actor.id === "number" && actor.name) actors.set(actor.id, actor.name);
    }
  }
  return actors;
}

function friendlyFightPresenceBySourceId(fightsData) {
  const presence = new Map();
  for (const actor of fightsData?.friendlies || []) {
    if (typeof actor.id !== "number") continue;
    const fights = actor.fights || [];
    if (fights.length === 0) continue;
    presence.set(actor.id, new Set(fights.map((fight) => fight.id)));
  }
  return presence;
}

async function getWclFriendlyFightPresence(reportCode) {
  if (!getWclV1ApiKey()) return null;
  try {
    return friendlyFightPresenceBySourceId(await getWclV1FightData(reportCode));
  } catch {
    return null;
  }
}

function isWclFriendlyPresentInFight(presenceBySourceId, player, fight) {
  if (!presenceBySourceId) return true;
  const fightIds = presenceBySourceId.get(player.sourceId);
  if (!fightIds) return true;
  return fightIds.has(fight.id);
}

async function getWclV1DamageDoneTable(reportCode, { start, end, targetId }) {
  return wclV1GetJson(`/report/tables/damage-done/${reportCode}`, {
    start,
    end,
    targetid: targetId,
    by: "target",
  });
}

function normalizeTargetTableName(entry, targetId) {
  const name = entry?.name || "";
  if (!name) return "";
  if (entry?.id === `${targetId}.${entry?.instance}` && typeof entry.instance === "number") {
    return name.replace(new RegExp(` ${entry.instance}$`), "");
  }
  return name;
}

async function fallbackTargetName(reportCode, fightMeta, targetId) {
  try {
    const table = await getWclV1DamageDoneTable(reportCode, {
      start: fightMeta.start_time,
      end: fightMeta.end_time,
      targetId,
    });
    const entry = (Array.isArray(table?.entries) ? table.entries : [])
      .find((candidate) => candidate?.name && (
        String(candidate.id || "").startsWith(`${targetId}.`) || candidate.id === targetId
      ));
    return normalizeTargetTableName(entry, targetId) || null;
  } catch {
    return null;
  }
}

async function armorDebuffTargetRefs(reportCode, fightsData, fightMeta, { includePrimaryBoss = true } = {}) {
  const names = actorNameById(fightsData);
  const targets = new Map();
  const primaryBoss = fightMeta.boss ? findPrimaryBossActor(fightsData, fightMeta) : null;

  function addTarget(targetId) {
    if (typeof targetId !== "number" || targetId <= 0) return;
    if (!includePrimaryBoss && primaryBoss?.id === targetId) return;
    if (!targets.has(targetId)) {
      targets.set(targetId, {
        id: targetId,
        name: names.get(targetId) || `target#${targetId}`,
        isPrimaryBoss: primaryBoss?.id === targetId,
      });
    }
  }

  if (includePrimaryBoss && primaryBoss) addTarget(primaryBoss.id);

  for (const abilityId of [WCL_SUNDER_ARMOR_ABILITY_ID, WCL_EXPOSE_ARMOR_ABILITY_ID]) {
    const events = await getWclV1CastEvents(reportCode, {
      start: fightMeta.start_time,
      end: fightMeta.end_time,
      abilityId,
    });
    for (const event of events) {
      if (event.targetIsFriendly === true) continue;
      addTarget(event.targetID);
    }
  }

  for (const target of targets.values()) {
    if (!/^target#\d+$/.test(target.name)) continue;
    const resolvedName = await fallbackTargetName(reportCode, fightMeta, target.id);
    if (resolvedName) target.name = resolvedName;
  }

  return Array.from(targets.values())
    .sort((left, right) => {
      if (left.isPrimaryBoss !== right.isPrimaryBoss) return left.isPrimaryBoss ? -1 : 1;
      return left.name.localeCompare(right.name, "en", { sensitivity: "base" }) || left.id - right.id;
    });
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

async function getWclV1DebuffEvents(reportCode, { start, end, targetId, abilityId }) {
  return wclV1GetJson(`/report/events/debuffs/${reportCode}`, {
    start,
    end,
    targetid: targetId,
    abilityid: abilityId,
  });
}

function sourceNameForEvent(event, sourceNamesById = new Map()) {
  return event?.source?.name || event?.sourceName || sourceNamesById.get(event?.sourceID) || null;
}

async function getWclV1PagedEvents(reportCode, eventType, { start, end, targetId, abilityId }) {
  const events = [];
  let cursor = start;
  while (true) {
    const data = await wclV1GetJson(`/report/events/${eventType}/${reportCode}`, {
      start: cursor,
      end,
      targetid: targetId,
      abilityid: abilityId,
    });
    events.push(...(Array.isArray(data.events) ? data.events : []));
    const next = typeof data.nextPageTimestamp === "number" ? data.nextPageTimestamp : null;
    if (!next || next <= cursor || next >= end) break;
    cursor = next;
  }
  return events;
}

async function getWclV1DeathEvents(reportCode, { start, end }) {
  return getWclV1PagedEvents(reportCode, "deaths", { start, end });
}

async function getWclV1DamageTakenEvents(reportCode, { start, end, targetId }) {
  return getWclV1PagedEvents(reportCode, "damage-taken", { start, end, targetId });
}

async function getWclV1DebuffEventList(reportCode, { start, end, targetId, abilityId }) {
  return getWclV1PagedEvents(reportCode, "debuffs", { start, end, targetId, abilityId });
}

async function getWclV1DamageDoneEvents(reportCode, { start, end, targetId }) {
  const events = [];
  let cursor = start;
  while (true) {
    const data = await wclV1GetJson(`/report/events/damage-done/${reportCode}`, {
      start: cursor,
      end,
      targetid: targetId,
    });
    events.push(...(Array.isArray(data.events) ? data.events : []));
    const next = typeof data.nextPageTimestamp === "number" ? data.nextPageTimestamp : null;
    if (!next || next <= cursor || next >= end) break;
    cursor = next;
  }
  return events;
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

async function judgementOfWisdomDetail(reportCode, fight, targetId, aura, activeWindows, fightsData) {
  const sourceNamesById = actorNameById(fightsData);
  const abilityId = aura.guid;
  const data = await getWclV1DebuffEvents(reportCode, {
    start: fight.start_time,
    end: fight.end_time,
    targetId,
    abilityId,
  });
  const events = (data.events || [])
    .filter((event) => event?.ability?.guid === abilityId || nameMatches(event?.ability?.name || "", "Judgement of Wisdom"))
    .filter((event) => ["applydebuff", "refreshdebuff"].includes(event.type))
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));

  const initial = sourceNameForEvent(events[0], sourceNamesById);
  const reapplications = uniqueSortedNames(events.slice(1).map((event) => ({
    name: sourceNameForEvent(event, sourceNamesById),
  })));
  if (initial) {
    return [
      `initial ${initial}`,
      ...(reapplications.length > 0 ? [`reapplied by ${reapplications.join(", ")}`] : []),
    ].join("; ");
  }

  const firstTimestamp = firstAuraActiveTimestamp(aura, activeWindows);
  const firstDelayMs = firstAuraBandDelayMs(aura, fight, activeWindows);
  const casts = await getWclV1CastEvents(reportCode, {
    start: fight.start_time,
    end: fight.end_time,
    targetId,
    abilityId: WCL_JUDGEMENT_CAST_ABILITY_ID,
  });
  const judgementCasts = casts
    .filter((event) => event.type === "cast")
    .filter((event) => event.targetID === targetId)
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
  const sourceRows = judgementCasts.map((event) => ({ name: sourceNameForEvent(event, sourceNamesById) }));
  const castSources = uniqueSortedNames(sourceRows);
  const initialCast = typeof firstTimestamp === "number"
    ? judgementCasts
      .map((event) => ({ event, delta: Math.abs((event.timestamp || 0) - firstTimestamp) }))
      .filter((row) => row.delta <= WCL_JUDGEMENT_INITIAL_GRACE_MS)
      .sort((left, right) => left.delta - right.delta)[0]?.event
    : null;
  const inferredInitial = sourceNameForEvent(initialCast, sourceNamesById);
  const details = [
    ...(inferredInitial ? [`initial ${inferredInitial}`] : []),
    ...(!inferredInitial && firstDelayMs !== null ? [`first at ${formatSeconds(firstDelayMs)}`] : []),
    ...(castSources.length > 0 ? [`casts by ${castSources.join(", ")}`] : []),
  ];
  return details.join("; ");
}

async function demoShoutRoarText(reportCode, fight, targetId, table, activeWindows, totalTime) {
  const demoAuras = (Array.isArray(table.auras) ? table.auras : [])
    .filter((aura) => /Demoralizing (?:Shout|Roar)/i.test(aura.name || ""));
  if (demoAuras.length === 0) return "0.0%";

  const sources = [];
  for (const abilityId of [WCL_DEMORALIZING_SHOUT_ABILITY_ID, WCL_DEMORALIZING_ROAR_ABILITY_ID]) {
    sources.push(...await attributionNamesForDebuff(reportCode, fight, targetId, abilityId));
  }
  const sourceSuffix = uniqueSortedNames(sources.map((name) => ({ name })));
  const uptime = activeUptimeForAuraUnion(demoAuras, activeWindows, totalTime);
  return `${formatPercent(uptime, totalTime)}${sourceSuffix.length > 0 ? ` (${sourceSuffix.join(", ")})` : ""}`;
}

async function firstDebuffApplicationTimestamp(reportCode, fight, targetId, abilityId, abilityName) {
  const data = await getWclV1DebuffEvents(reportCode, {
    start: fight.start_time,
    end: fight.end_time,
    targetId,
    abilityId,
  });
  const first = (data.events || [])
    .filter((event) => event?.ability?.guid === abilityId || nameMatches(event?.ability?.name || "", abilityName || ""))
    .filter((event) => ["applydebuff", "refreshdebuff"].includes(event.type))
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0))[0];
  if (typeof first?.timestamp !== "number") return null;
  return first.timestamp;
}

async function firstDebuffApplicationDelayMs(reportCode, fight, targetId, abilityId, abilityName, baselineTime = fight.start_time) {
  const timestamp = await firstDebuffApplicationTimestamp(reportCode, fight, targetId, abilityId, abilityName);
  if (typeof timestamp !== "number") return null;
  return Math.max(0, timestamp - baselineTime);
}

function isExposeArmorGroup(group, aura) {
  return aura?.guid === WCL_EXPOSE_ARMOR_ABILITY_ID
    || group?.abilityId === WCL_EXPOSE_ARMOR_ABILITY_ID
    || /expose armor/i.test(group?.abilityName || "")
    || /IEA \/ Expose Armor/i.test(group?.label || "");
}

function windowsFromDamageTimestamps(timestamps, gapMs = WCL_BOSS_ACTIVE_GAP_MS) {
  const sorted = Array.from(new Set(timestamps))
    .filter((timestamp) => typeof timestamp === "number")
    .sort((left, right) => left - right);
  if (sorted.length < 2) return [];

  const windows = [];
  let start = sorted[0];
  let end = sorted[0];
  for (const timestamp of sorted.slice(1)) {
    if (timestamp - end > gapMs) {
      if (end > start) windows.push({ start, end });
      start = timestamp;
    }
    end = timestamp;
  }
  if (end > start) windows.push({ start, end });
  return windows;
}

function windowDuration(windows = []) {
  return windows.reduce((total, window) => total + Math.max(0, window.end - window.start), 0);
}

function overlapDuration(left, right) {
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
}

function activeUptimeForAura(aura, activeWindows, fallbackTotalTime) {
  if (!activeWindows?.length) return aura.totalUptime || 0;
  const denominator = windowDuration(activeWindows) || fallbackTotalTime;
  const bands = Array.isArray(aura.bands) ? aura.bands : [];
  if (bands.length === 0) return Math.min(aura.totalUptime || 0, denominator);

  const uptime = bands.reduce((total, band) => {
    if (typeof band.startTime !== "number" || typeof band.endTime !== "number") return total;
    const bandWindow = { start: band.startTime, end: band.endTime };
    return total + activeWindows.reduce((bandTotal, activeWindow) => (
      bandTotal + overlapDuration(bandWindow, activeWindow)
    ), 0);
  }, 0);
  return Math.min(uptime, denominator);
}

function activeUptimeForAuraUnion(auras, activeWindows, fallbackTotalTime) {
  const denominator = windowDuration(activeWindows) || fallbackTotalTime;
  const windows = activeWindows?.length ? activeWindows : [{ start: 0, end: denominator }];
  const segments = [];
  for (const aura of auras || []) {
    const bands = Array.isArray(aura.bands) ? aura.bands : [];
    if (bands.length === 0 && typeof aura.totalUptime === "number") {
      segments.push({ start: 0, end: Math.min(aura.totalUptime, denominator) });
      continue;
    }
    for (const band of bands) {
      if (typeof band.startTime !== "number" || typeof band.endTime !== "number") continue;
      for (const activeWindow of windows) {
        const start = Math.max(band.startTime, activeWindow.start);
        const end = Math.min(band.endTime, activeWindow.end);
        if (end > start) segments.push({ start, end });
      }
    }
  }
  if (segments.length === 0) return 0;
  segments.sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let current = { ...segments[0] };
  for (const segment of segments.slice(1)) {
    if (segment.start <= current.end) {
      current.end = Math.max(current.end, segment.end);
      continue;
    }
    total += current.end - current.start;
    current = { ...segment };
  }
  total += current.end - current.start;
  return Math.min(total, denominator);
}

function firstAuraActiveTimestamp(aura, activeWindows = []) {
  const bands = (aura?.bands || [])
    .filter((band) => typeof band.startTime === "number" && typeof band.endTime === "number")
    .sort((left, right) => left.startTime - right.startTime);
  if (bands.length === 0) return null;

  if (activeWindows.length > 0) {
    for (const band of bands) {
      for (const activeWindow of activeWindows) {
        const overlapStart = Math.max(band.startTime, activeWindow.start);
        if (overlapStart < Math.min(band.endTime, activeWindow.end)) {
          return overlapStart;
        }
      }
    }
  }

  return bands[0].startTime;
}

function firstAuraBandDelayMs(aura, fight, activeWindows = []) {
  const timestamp = firstAuraActiveTimestamp(aura, activeWindows);
  if (typeof timestamp !== "number") return null;
  return Math.max(0, timestamp - (activeWindows[0]?.start || fight.start_time));
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatFightTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

async function bossActiveWindows(reportCode, fight, targetId) {
  const events = await getWclV1DamageDoneEvents(reportCode, {
    start: fight.start_time,
    end: fight.end_time,
    targetId,
  });
  const timestamps = events
    .filter((event) => event.type === "damage")
    .filter((event) => event.sourceIsFriendly !== false)
    .filter((event) => (event.amount || 0) > 0)
    .map((event) => event.timestamp);
  return windowsFromDamageTimestamps(timestamps);
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

    let activeWindows = [];
    try {
      activeWindows = await bossActiveWindows(reportCode, fightMeta, bossActor.id);
    } catch (error) {
      errors.push({ fightId: fight.id, targetId: bossActor.id, error: error.message || String(error) });
    }

    const totalTime = windowDuration(activeWindows) || table.totalTime || (fightMeta.end_time - fightMeta.start_time);
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

        if (group.combine === "union") {
          const sources = [];
          for (const aura of matches) {
            try {
              sources.push(...await attributionNamesForDebuff(reportCode, fightMeta, bossActor.id, aura.guid));
            } catch (error) {
              errors.push({ fightId: fight.id, abilityId: aura.guid, error: error.message || String(error) });
            }
          }
          const sourceNames = uniqueSortedNames(sources.map((name) => ({ name })));
          const sourceSuffix = sourceNames.length > 0 ? ` (${sourceNames.join(", ")})` : "";
          rows.push({
            label: group.label,
            text: `${formatPercent(activeUptimeForAuraUnion(matches, activeWindows, totalTime), totalTime)}${sourceSuffix}`,
          });
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
          parts.push(`${aura.name} ${formatPercent(activeUptimeForAura(aura, activeWindows, totalTime), totalTime)}${sourceSuffix}`);
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

        let sourceSuffix = "";
        if (nameMatches(group.abilityName || "", "Judgement of Wisdom") || aura.guid === 20186) {
          try {
            const wisdomDetail = await judgementOfWisdomDetail(reportCode, fightMeta, bossActor.id, aura, activeWindows, fightsData);
            sourceSuffix = wisdomDetail ? ` (${wisdomDetail})` : "";
          } catch (error) {
            errors.push({ fightId: fight.id, abilityId: aura.guid, error: error.message || String(error) });
          }
        } else {
          let sources = [];
          let firstDelayMs = null;
          try {
            sources = await attributionNamesForDebuff(reportCode, fightMeta, bossActor.id, aura.guid);
          } catch (error) {
            errors.push({ fightId: fight.id, abilityId: aura.guid, error: error.message || String(error) });
          }
          if (isExposeArmorGroup(group, aura)) {
            firstDelayMs = firstAuraBandDelayMs(aura, fightMeta, activeWindows);
            if (firstDelayMs === null) {
              try {
                firstDelayMs = await firstDebuffApplicationDelayMs(
                  reportCode,
                  fightMeta,
                  bossActor.id,
                  aura.guid,
                  group.abilityName,
                  activeWindows[0]?.start || fightMeta.start_time,
                );
              } catch (error) {
                errors.push({ fightId: fight.id, abilityId: aura.guid, error: error.message || String(error) });
              }
            }
          }
          const details = [
            ...(sources.length > 0 ? [sources.join(", ")] : []),
            ...(firstDelayMs !== null ? [`first at ${formatSeconds(firstDelayMs)}`] : []),
          ];
          sourceSuffix = details.length > 0 ? ` (${details.join("; ")})` : "";
        }
        rows.push({ label: group.label, text: `${formatPercent(activeUptimeForAura(aura, activeWindows, totalTime), totalTime)}${sourceSuffix}` });
      }
    }

    try {
      rows.push({
        label: "Demo Shout / Roar",
        text: await demoShoutRoarText(reportCode, fightMeta, bossActor.id, table, activeWindows, totalTime),
      });
    } catch (error) {
      errors.push({ fightId: fight.id, abilityId: WCL_DEMORALIZING_SHOUT_ABILITY_ID, error: error.message || String(error) });
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

function scopedWclPulls(fightsData, selectedFightMetas) {
  const selectedZoneIds = new Set(selectedFightMetas.map((fight) => fight.zoneID).filter(Boolean));
  const selectedFightIds = new Set(selectedFightMetas.map((fight) => fight.id));
  return (fightsData.fights || []).filter((fight) => (
    typeof fight.start_time === "number"
    && typeof fight.end_time === "number"
    && fight.end_time > fight.start_time
    && (
      selectedZoneIds.size > 0
        ? selectedZoneIds.has(fight.zoneID)
        : selectedFightIds.has(fight.id)
    )
  ));
}

function applicationCountRowsFromTable(table, typePattern = null, target = null) {
  return (Array.isArray(table.auras) ? table.auras : [])
    .filter((aura) => !typePattern || typePattern.test(aura.type || ""))
    .map((aura) => ({
      player: aura.name || "Unknown",
      className: aura.type || "",
      count: typeof aura.totalUses === "number" ? aura.totalUses : 0,
      targetId: target?.id || null,
      targetName: target?.name || "",
      targetIsPrimary: Boolean(target?.isPrimaryBoss),
    }))
    .filter((row) => row.count > 0);
}

function mergeApplicationCounts(...rowGroups) {
  const byPlayer = new Map();
  for (const rows of rowGroups) {
    for (const row of rows || []) {
      const key = row.player.toLowerCase();
      const existing = byPlayer.get(key) || {
        player: row.player,
        className: row.className,
        count: 0,
      };
      existing.count += row.count;
      if (!existing.className && row.className) existing.className = row.className;
      byPlayer.set(key, existing);
    }
  }
  return Array.from(byPlayer.values())
    .sort((left, right) => right.count - left.count || left.player.localeCompare(right.player));
}

function mergeApplicationCountsByTarget(...rowGroups) {
  const byPlayerTarget = new Map();
  for (const rows of rowGroups) {
    for (const row of rows || []) {
      const key = `${row.player.toLowerCase()}::${row.targetId || row.targetName || ""}`;
      const existing = byPlayerTarget.get(key) || {
        player: row.player,
        className: row.className,
        count: 0,
        targetId: row.targetId || null,
        targetName: row.targetName || "",
        targetIsPrimary: Boolean(row.targetIsPrimary),
      };
      existing.count += row.count;
      if (!existing.className && row.className) existing.className = row.className;
      if (!existing.targetName && row.targetName) existing.targetName = row.targetName;
      existing.targetIsPrimary = existing.targetIsPrimary || Boolean(row.targetIsPrimary);
      byPlayerTarget.set(key, existing);
    }
  }
  return Array.from(byPlayerTarget.values())
    .sort((left, right) => (
      (left.targetIsPrimary === right.targetIsPrimary ? 0 : left.targetIsPrimary ? -1 : 1)
      ||
      (left.targetName || "").localeCompare(right.targetName || "", "en", { sensitivity: "base" })
      || right.count - left.count
      || left.player.localeCompare(right.player)
    ));
}

async function debuffApplicationRows(reportCode, { start, end, targetId, abilityId, typePattern = null }) {
  const table = await getWclV1DebuffTable(reportCode, {
    start,
    end,
    targetId,
    abilityId,
  });
  return applicationCountRowsFromTable(table, typePattern);
}

async function debuffApplicationDetail(reportCode, { start, end, target, abilityId, typePattern = null }) {
  const table = await getWclV1DebuffTable(reportCode, {
    start,
    end,
    targetId: target?.id,
    abilityId,
  });
  return {
    table,
    rows: applicationCountRowsFromTable(table, typePattern, target),
  };
}

function exposeArmorAuraFromTable(table) {
  return (Array.isArray(table?.auras) ? table.auras : []).find((aura) => (
    aura.guid === WCL_EXPOSE_ARMOR_ABILITY_ID || nameMatches(aura.name || "", "Expose Armor")
  )) || null;
}

function totalApplicationCount(rows = []) {
  return rows.reduce((total, row) => total + row.count, 0);
}

function auraBands(table, abilityName) {
  return (Array.isArray(table?.auras) ? table.auras : [])
    .flatMap((aura) => (Array.isArray(aura.bands) ? aura.bands : [])
      .filter((band) => typeof band.startTime === "number" && typeof band.endTime === "number" && band.endTime > band.startTime)
      .map((band) => ({ start: band.startTime, end: band.endTime, abilityName })));
}

function mergeBands(bands) {
  const sorted = [...bands].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const band of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && band.start <= previous.end + WCL_ARMOR_DEBUFF_REPLACEMENT_GRACE_MS) {
      previous.end = Math.max(previous.end, band.end);
    } else {
      merged.push({ ...band });
    }
  }
  return merged;
}

function activeWindowForTimestamp(activeWindows, timestamp) {
  return activeWindows.find((window) => timestamp >= window.start && timestamp <= window.end) || null;
}

function detectArmorDebuffFalloffs({ sunderTable, ieaTable, activeWindows, fightMeta, target }) {
  const windows = activeWindows.length > 0 ? activeWindows : [{ start: fightMeta.start_time, end: fightMeta.end_time }];
  const sunderBands = mergeBands(auraBands(sunderTable, "Sunder Armor"));
  const ieaBands = mergeBands(auraBands(ieaTable, "Expose Armor"));
  const allBands = [...sunderBands, ...ieaBands].sort((left, right) => left.start - right.start || left.end - right.end);
  const falloffs = [];

  for (const band of allBands) {
    const activeWindow = activeWindowForTimestamp(windows, band.end);
    if (!activeWindow) continue;
    if (activeWindow.end - band.end <= WCL_ARMOR_DEBUFF_REPLACEMENT_GRACE_MS) continue;

    const replacement = allBands.find((candidate) => (
      candidate !== band
      && candidate.start >= band.end
      && candidate.start - band.end <= WCL_ARMOR_DEBUFF_REPLACEMENT_GRACE_MS
    ));
    if (replacement) continue;

    falloffs.push({
      abilityName: band.abilityName,
      targetId: target.id,
      targetName: target.name,
      timestamp: band.end,
      delayMs: Math.max(0, band.end - activeWindow.start),
    });
  }

  return falloffs;
}

async function openingSunderBeforeIea(reportCode, fightMeta, bossActor) {
  const activeWindows = await bossActiveWindows(reportCode, fightMeta, bossActor.id);
  const firstActiveWindow = activeWindows[0] || { start: fightMeta.start_time, end: fightMeta.end_time };
  const table = await getWclV1DebuffTable(reportCode, {
    start: fightMeta.start_time,
    end: fightMeta.end_time,
    targetId: bossActor.id,
  });
  const ieaAura = exposeArmorAuraFromTable(table);
  let ieaTime = firstAuraActiveTimestamp(ieaAura, activeWindows);

  if (ieaTime === null && ieaAura) {
    ieaTime = await firstDebuffApplicationTimestamp(
      reportCode,
      fightMeta,
      bossActor.id,
      WCL_EXPOSE_ARMOR_ABILITY_ID,
      "Expose Armor",
    );
  }

  const ieaInFirstWindow = typeof ieaTime === "number"
    && ieaTime >= firstActiveWindow.start
    && ieaTime <= firstActiveWindow.end;
  const windowEnd = ieaInFirstWindow ? ieaTime : firstActiveWindow.end;
  const rows = windowEnd > firstActiveWindow.start
    ? await debuffApplicationRows(reportCode, {
      start: firstActiveWindow.start,
      end: windowEnd,
      targetId: bossActor.id,
      abilityId: WCL_SUNDER_ARMOR_ABILITY_ID,
      typePattern: /warrior/i,
    })
    : [];

  return {
    rows,
    total: totalApplicationCount(rows),
    ieaDelayMs: typeof ieaTime === "number" ? Math.max(0, ieaTime - firstActiveWindow.start) : null,
    ieaInFirstWindow,
  };
}

function trashMobCount(fightsData, trashPulls) {
  let total = 0;
  const trashPullIds = new Set(trashPulls.map((pull) => pull.id));
  const primaryBossIdByPull = new Map();
  for (const pull of trashPulls) {
    const primaryBoss = pull.boss ? findPrimaryBossActor(fightsData, pull) : null;
    if (primaryBoss) primaryBossIdByPull.set(pull.id, primaryBoss.id);
  }
  for (const enemy of fightsData.enemies || []) {
    if (/pet/i.test(enemy.type || "")) continue;
    for (const ref of enemy.fights || []) {
      if (!trashPullIds.has(ref.id)) continue;
      if (primaryBossIdByPull.get(ref.id) === enemy.id) continue;
      total += typeof ref.instances === "number" && ref.instances > 0 ? ref.instances : 1;
    }
  }
  return total;
}

async function auditSunderApplications(reportCode, fights) {
  if (!getWclV1ApiKey()) {
    return {
      overall: [],
      fights: [],
      trash: null,
      errors: [],
      note: "Sunder and IEA application counts are unavailable without WCL API access.",
    };
  }

  const fightsData = await getWclV1FightData(reportCode);
  const errors = [];
  const fightRows = [];
  const selectedFightMetas = fights
    .map((fight) => (fightsData.fights || []).find((candidate) => candidate.id === fight.id))
    .filter(Boolean);

  for (const fight of fights) {
    const fightMeta = selectedFightMetas.find((candidate) => candidate.id === fight.id);
    const bossActor = fightMeta ? findPrimaryBossActor(fightsData, fightMeta) : null;
    if (!fightMeta || !bossActor) {
      errors.push({ fightId: fight.id, error: `Could not resolve boss actor for ${fight.name}` });
      continue;
    }

    try {
      const targets = await armorDebuffTargetRefs(reportCode, fightsData, fightMeta, { includePrimaryBoss: true });
      const sunderRows = [];
      const ieaRows = [];
      const falloffs = [];

      for (const target of targets) {
        const sunder = await debuffApplicationDetail(reportCode, {
          start: fightMeta.start_time,
          end: fightMeta.end_time,
          target,
          abilityId: WCL_SUNDER_ARMOR_ABILITY_ID,
          typePattern: /warrior/i,
        });
        const iea = await debuffApplicationDetail(reportCode, {
          start: fightMeta.start_time,
          end: fightMeta.end_time,
          target,
          abilityId: WCL_EXPOSE_ARMOR_ABILITY_ID,
        });
        sunderRows.push(...sunder.rows);
        ieaRows.push(...iea.rows);

        try {
          const activeWindows = await bossActiveWindows(reportCode, fightMeta, target.id);
          falloffs.push(...detectArmorDebuffFalloffs({
            sunderTable: sunder.table,
            ieaTable: iea.table,
            activeWindows,
            fightMeta,
            target,
          }));
        } catch (error) {
          errors.push({ fightId: fight.id, targetId: target.id, phase: "falloff", error: error.message || String(error) });
        }
      }

      let openingSunder = null;
      try {
        openingSunder = await openingSunderBeforeIea(reportCode, fightMeta, bossActor);
      } catch (error) {
          errors.push({ fightId: fight.id, abilityId: WCL_SUNDER_ARMOR_ABILITY_ID, phase: "opening", error: error.message || String(error) });
      }
      fightRows.push({
        fightId: fight.id,
        fightName: fight.name,
        sunderRows: mergeApplicationCountsByTarget(sunderRows),
        ieaRows: mergeApplicationCountsByTarget(ieaRows),
        falloffs,
        openingSunder,
      });
    } catch (error) {
      errors.push({ fightId: fight.id, error: error.message || String(error) });
    }
  }

  const pulls = scopedWclPulls(fightsData, selectedFightMetas);
  const selectedFightIds = new Set(selectedFightMetas.map((fight) => fight.id));
  const trashPulls = pulls.filter((pull) => !selectedFightIds.has(pull.id) && (!pull.boss || pull.kill === false));
  const trashSunderRows = [];
  const trashIeaRows = [];
  const tasks = [];

  for (const pull of trashPulls) {
    tasks.push(async () => {
      try {
        const targets = await armorDebuffTargetRefs(reportCode, fightsData, pull, { includePrimaryBoss: false });
        for (const target of targets) {
          const detail = await debuffApplicationDetail(reportCode, {
            start: pull.start_time,
            end: pull.end_time,
            target,
            abilityId: WCL_SUNDER_ARMOR_ABILITY_ID,
            typePattern: /warrior/i,
          });
          trashSunderRows.push(...detail.rows);
        }
      } catch (error) {
        errors.push({ fightId: pull.id, abilityId: WCL_SUNDER_ARMOR_ABILITY_ID, error: error.message || String(error) });
      }
    });
    tasks.push(async () => {
      try {
        const targets = await armorDebuffTargetRefs(reportCode, fightsData, pull, { includePrimaryBoss: false });
        for (const target of targets) {
          const detail = await debuffApplicationDetail(reportCode, {
            start: pull.start_time,
            end: pull.end_time,
            target,
            abilityId: WCL_EXPOSE_ARMOR_ABILITY_ID,
          });
          trashIeaRows.push(...detail.rows);
        }
      } catch (error) {
        errors.push({ fightId: pull.id, abilityId: WCL_EXPOSE_ARMOR_ABILITY_ID, error: error.message || String(error) });
      }
    });
  }
  await runLimited(tasks, 4);

  const trash = {
    pullCount: trashPulls.length,
    mobCount: trashMobCount(fightsData, trashPulls),
    sunderRows: mergeApplicationCountsByTarget(trashSunderRows),
    ieaRows: mergeApplicationCountsByTarget(trashIeaRows),
  };

  return {
    overall: [],
    fights: fightRows,
    trash,
    errors,
    note: null,
  };
}

function isIronshieldTankCandidate(player) {
  if (player.role === "Tank") return true;
  if (isProtectionPaladin(player)) return true;
  if (player.className === "Druid" && /guardian/i.test(player.spec || "")) return true;
  if (/tank/i.test(player.name || "") && ["Druid", "Paladin", "Warrior"].includes(player.className)) return true;
  return false;
}

function hasFightData(player, fightId) {
  return (player.fightData || []).some((fightData) => fightData.fightId === fightId);
}

async function damageTakenTotal(reportCode, fightMeta, playerId) {
  const schoolTotals = damageTakenSchoolTotalsFromEvents(await fightDamageTakenEvents(reportCode, fightMeta), playerId);
  return schoolTotals.total;
}

function schoolName(schoolId) {
  return ({
    1: "Physical",
    2: "Holy",
    4: "Fire",
    8: "Nature",
    16: "Frost",
    32: "Shadow",
    64: "Arcane",
  })[schoolId] || `School ${schoolId}`;
}

async function fightDamageTakenEvents(reportCode, fightMeta) {
  return getWclV1DamageTakenEvents(reportCode, {
    start: fightMeta.start_time,
    end: fightMeta.end_time,
  });
}

function damageTakenSchoolTotalsFromEvents(events, playerId) {
  const totals = new Map();
  const total = events
    .filter((event) => event.type === "damage")
    .filter((event) => event.targetID === playerId)
    .filter((event) => event.sourceIsFriendly !== true)
    .reduce((sum, event) => {
      const amount = event.amount || 0;
      const schoolId = event.ability?.type || 0;
      totals.set(schoolId, (totals.get(schoolId) || 0) + amount);
      return sum + amount;
    }, 0);
  return { total, totals };
}

function formatSchoolMix(totals, total) {
  const parts = Array.from(totals.entries())
    .filter(([, amount]) => amount > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([schoolId, amount]) => `${schoolName(schoolId)} ${formatPercent(amount, total)}`);
  return parts.length > 0 ? parts.join(", ") : "no damage";
}

async function ironshieldUsesByPlayer(reportCode, fightMeta, fightsData) {
  const uses = new Map();
  const sourceNamesById = actorNameById(fightsData);

  try {
    const table = await getWclV1BuffTableByAbility(reportCode, {
      start: fightMeta.start_time,
      end: fightMeta.end_time,
      abilityId: WCL_IRONSHIELD_POTION_ABILITY_ID,
    });
    for (const aura of table.auras || []) {
      if (!aura.name) continue;
      uses.set(aura.name, Math.max(
        uses.get(aura.name) || 0,
        aura.totalUses || (Array.isArray(aura.bands) ? aura.bands.length : 0) || 1,
      ));
    }
  } catch {
    // Some WCL reports do not expose potion buffs in tables; casts are checked below.
  }

  const casts = await getWclV1CastEvents(reportCode, {
    start: fightMeta.start_time,
    end: fightMeta.end_time,
    abilityId: WCL_IRONSHIELD_POTION_ABILITY_ID,
  });
  for (const event of casts.filter((candidate) => candidate.type === "cast")) {
    const name = sourceNameForEvent(event, sourceNamesById);
    if (!name) continue;
    uses.set(name, (uses.get(name) || 0) + 1);
  }

  return uses;
}

async function auditIronshieldPotions(reportCode, fights, cla) {
  if (!getWclV1ApiKey()) return { fights: [], errors: [], note: "Ironshield Potion tracking is unavailable without WCL API access." };
  const fightsData = await getWclV1FightData(reportCode);
  const presenceBySourceId = friendlyFightPresenceBySourceId(fightsData);
  const errors = [];
  const rows = [];

  for (const fight of fights) {
    const fightMeta = (fightsData.fights || []).find((candidate) => candidate.id === fight.id);
    if (!fightMeta) continue;

    const candidates = (cla.players || [])
      .filter(isIronshieldTankCandidate)
      .filter((player) => hasFightData(player, fight.id))
      .filter((player) => isWclFriendlyPresentInFight(presenceBySourceId, player, fight));

    let damageEvents = [];
    try {
      damageEvents = await fightDamageTakenEvents(reportCode, fightMeta);
    } catch (error) {
      errors.push({ fightId: fight.id, phase: "tank-damage", error: error.message || String(error) });
    }

    const scored = [];
    for (const player of candidates) {
      const schoolTotals = damageTakenSchoolTotalsFromEvents(damageEvents, player.sourceId);
      scored.push({
        player,
        damageTaken: schoolTotals.total,
        physicalDamage: schoolTotals.totals.get(WCL_PHYSICAL_SCHOOL_ID) || 0,
        schoolTotals: schoolTotals.totals,
        roleScore: player.role === "Tank" ? 2 : 1,
      });
    }

    scored.sort((left, right) => (
      right.damageTaken - left.damageTaken
      || right.roleScore - left.roleScore
      || left.player.sourceId - right.player.sourceId
      || left.player.name.localeCompare(right.player.name)
    ));

    let uses = new Map();
    try {
      uses = await ironshieldUsesByPlayer(reportCode, fightMeta, fightsData);
    } catch (error) {
      errors.push({ fightId: fight.id, abilityId: WCL_IRONSHIELD_POTION_ABILITY_ID, error: error.message || String(error) });
    }

    const expectedRows = scored.slice(0, 2);
    const expectedDamage = expectedRows.reduce((total, row) => total + row.damageTaken, 0);
    const expectedPhysicalDamage = expectedRows.reduce((total, row) => total + row.physicalDamage, 0);
    const physicalShare = expectedDamage > 0 ? expectedPhysicalDamage / expectedDamage : null;
    if (physicalShare !== null && physicalShare < WCL_IRONSHIELD_MIN_PHYSICAL_SHARE) {
      const mergedSchools = new Map();
      for (const row of expectedRows) {
        for (const [schoolId, amount] of row.schoolTotals.entries()) {
          mergedSchools.set(schoolId, (mergedSchools.get(schoolId) || 0) + amount);
        }
      }
      rows.push({
        fightId: fight.id,
        fightName: fight.name,
        notExpected: true,
        reason: `not expected (${formatSchoolMix(mergedSchools, expectedDamage)} tank damage; Physical ${formatPercent(expectedPhysicalDamage, expectedDamage)})`,
        expected: [],
        otherTanks: [],
      });
      continue;
    }

    rows.push({
      fightId: fight.id,
      fightName: fight.name,
      expected: expectedRows.map(({ player }) => ({
        player: player.name,
        uses: uses.get(player.name) || 0,
      })),
      otherTanks: scored.slice(2).map(({ player }) => ({
        player: player.name,
        uses: uses.get(player.name) || 0,
      })),
    });
  }

  return { fights: rows, errors, note: null };
}

function eventAbilityName(event) {
  return event?.ability?.name || event?.killingAbility?.name || "Unknown";
}

async function actorNameForId(reportCode, fightMeta, actorId, fightsData) {
  if (typeof actorId !== "number") return null;
  const names = actorNameById(fightsData);
  if (names.has(actorId)) return names.get(actorId);
  return fallbackTargetName(reportCode, fightMeta, actorId);
}

async function deathDamageEvents(reportCode, fightMeta, death) {
  const start = Math.max(fightMeta.start_time, death.timestamp - WCL_DEATH_SNAPSHOT_WINDOW_MS);
  const end = death.timestamp + 1;
  const events = await getWclV1DamageTakenEvents(reportCode, {
    start,
    end,
    targetId: death.targetID,
  });
  const targetEvents = events.filter((candidate) => candidate.type === "damage" && candidate.targetID === death.targetID);
  if (targetEvents.length > 0) return targetEvents;

  const fallbackEvents = await getWclV1DamageTakenEvents(reportCode, { start, end });
  return fallbackEvents.filter((candidate) => candidate.type === "damage" && candidate.targetID === death.targetID);
}

async function damageSummaryRows(reportCode, fightMeta, death, fightsData) {
  const events = await deathDamageEvents(reportCode, fightMeta, death);
  const grouped = new Map();
  for (const event of events) {
    if ((event.amount || 0) <= 0 && !(event.overkill > 0)) continue;
    const sourceName = await actorNameForId(reportCode, fightMeta, event.sourceID, fightsData)
      || sourceNameForEvent(event, actorNameById(fightsData))
      || "Unknown";
    const abilityName = eventAbilityName(event);
    const key = `${sourceName}\0${abilityName}`;
    const existing = grouped.get(key) || {
      sourceName,
      abilityName,
      amount: 0,
      lastTimestamp: 0,
      latestAmount: null,
      latestOverkill: null,
    };
    existing.amount += event.amount || 0;
    if ((event.timestamp || 0) >= existing.lastTimestamp) {
      existing.lastTimestamp = event.timestamp || 0;
      existing.latestAmount = event.amount || 0;
      existing.latestOverkill = event.overkill || null;
    }
    grouped.set(key, existing);
  }
  return Array.from(grouped.values())
    .sort((left, right) => right.amount - left.amount || right.lastTimestamp - left.lastTimestamp)
    .slice(0, WCL_DEATH_DAMAGE_ROWS);
}

async function deathDebuffs(reportCode, fightMeta, death) {
  const events = await getWclV1DebuffEventList(reportCode, {
    start: Math.max(fightMeta.start_time, death.timestamp - WCL_DEATH_SNAPSHOT_WINDOW_MS),
    end: death.timestamp + 1,
    targetId: death.targetID,
  });
  return uniqueSortedNames(events
    .filter((event) => event.targetID === death.targetID)
    .filter((event) => event.type === "applydebuff" || event.type === "applydebuffstack")
    .map((event) => ({ name: eventAbilityName(event) })));
}

async function deathDetail(reportCode, fightMeta, death, fightsData) {
  const targetName = await actorNameForId(reportCode, fightMeta, death.targetID, fightsData) || `player#${death.targetID}`;
  const killerId = typeof death.killerID === "number" ? death.killerID : death.killer?.id;
  const killerName = death.killer?.name && death.killer.name !== "Environment"
    ? death.killer.name
    : await actorNameForId(reportCode, fightMeta, killerId, fightsData) || "Environment";
  const killingAbility = death.killingAbility?.name || eventAbilityName(death);
  const damageRows = await damageSummaryRows(reportCode, fightMeta, death, fightsData);
  const killingRow = damageRows.find((row) => row.sourceName === killerName && row.abilityName === killingAbility)
    || damageRows.find((row) => row.abilityName === killingAbility)
    || null;
  const killingDamage = killingRow?.latestAmount ?? null;
  const killingOverkill = killingRow?.latestOverkill ?? null;
  const debuffs = await deathDebuffs(reportCode, fightMeta, death);
  return {
    player: targetName,
    timestamp: death.timestamp,
    delayMs: Math.max(0, death.timestamp - fightMeta.start_time),
    killerName,
    killingAbility,
    killingDamage,
    killingOverkill,
    damageRows,
    debuffs,
  };
}

function isContextlessDuplicateDeath(death, seenPlayers) {
  return seenPlayers.has(death.player)
    && death.damageRows.length === 0
    && death.debuffs.length === 0
    && death.killerName === "Environment"
    && /unknown/i.test(death.killingAbility || "");
}

function omitContextlessDuplicateDeaths(deaths) {
  const seenPlayers = new Set();
  const filtered = [];
  for (const death of deaths) {
    if (!isContextlessDuplicateDeath(death, seenPlayers)) {
      filtered.push(death);
    }
    seenPlayers.add(death.player);
  }
  return filtered;
}

async function auditRaidDeaths(reportCode, fights) {
  if (!getWclV1ApiKey()) return { fights: [], errors: [], note: "Raid death snapshots are unavailable without WCL API access." };
  const fightsData = await getWclV1FightData(reportCode);
  const errors = [];
  const rows = [];

  for (const fight of fights) {
    const fightMeta = (fightsData.fights || []).find((candidate) => candidate.id === fight.id);
    if (fight.kill === false || !fightMeta || fightMeta.kill === false) continue;

    try {
      const deaths = (await getWclV1DeathEvents(reportCode, {
        start: fightMeta.start_time,
        end: fightMeta.end_time,
      }))
        .filter((death) => death.type === "death" && death.targetIsFriendly === true)
        .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
      if (deaths.length === 0) continue;

      if (deaths.length > 3) {
        const names = uniqueSortedNames(await Promise.all(deaths.map(async (death) => ({
          name: await actorNameForId(reportCode, fightMeta, death.targetID, fightsData) || `player#${death.targetID}`,
        }))));
        rows.push({ fightId: fight.id, fightName: fight.name, collapsed: true, count: deaths.length, players: names, deaths: [] });
        continue;
      }

      const details = [];
      for (const death of deaths) {
        details.push(await deathDetail(reportCode, fightMeta, death, fightsData));
      }
      const filteredDetails = omitContextlessDuplicateDeaths(details);
      if (filteredDetails.length === 0) continue;
      rows.push({ fightId: fight.id, fightName: fight.name, collapsed: false, count: filteredDetails.length, players: [], deaths: filteredDetails });
    } catch (error) {
      errors.push({ fightId: fight.id, phase: "deaths", error: error.message || String(error) });
    }
  }

  return { fights: rows, errors, note: null };
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
  const wclPresenceBySourceId = await getWclFriendlyFightPresence(reportCode);

  for (const fight of fights) {
    for (const player of cla.players) {
      const hasFight = (player.fightData || []).some((d) => d.fightId === fight.id);
      if (!hasFight) continue;
      if (!isWclFriendlyPresentInFight(wclPresenceBySourceId, player, fight)) continue;
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

async function auditPotionUsage(reportCode, report, fights, cla) {
  const rows = [];
  const errors = [];
  const tasks = [];
  const wclPresenceBySourceId = await getWclFriendlyFightPresence(reportCode);

  for (const fight of fights) {
    for (const player of cla.players) {
      if (!isDps(player)) continue;
      if (isMaulgarFight(fight) && isMage(player)) continue;
      const hasFight = (player.fightData || []).some((d) => d.fightId === fight.id);
      if (!hasFight) continue;
      if (!isWclFriendlyPresentInFight(wclPresenceBySourceId, player, fight)) continue;
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
          rows.push({
            fightId: fight.id,
            fightName: fight.name,
            player: data.playerName || player.name,
            className: data.playerClass || player.className,
            spec: data.playerSpec || player.spec,
            haste: countPotionCasts(casts, (name, guid) => guid === 28507 || /^Haste(?: Potion)?$/i.test(name)),
            destruction: countPotionCasts(casts, (name, guid) => guid === 28508 || /^Destruction Potion$/i.test(name)),
          });
        } catch (error) {
          errors.push({ fight: fight.name, player: player.name, error: error.message || String(error) });
        }
      });
    }
  }

  await runLimited(tasks, 4);

  return {
    fights: fights.map((fight) => ({
      fightId: fight.id,
      fightName: fight.name,
      rows: mergePotionRows(rows.filter((row) => row.fightId === fight.id))
        .sort((a, b) => a.player.localeCompare(b.player)),
    })),
    errors,
  };
}

function mergePotionRows(rows) {
  const byPlayer = new Map();
  for (const row of rows) {
    const key = `${row.player}\0${row.className}`;
    const existing = byPlayer.get(key);
    if (!existing) {
      byPlayer.set(key, { ...row });
      continue;
    }
    existing.haste = Math.max(existing.haste, row.haste);
    existing.destruction = Math.max(existing.destruction, row.destruction);
  }
  return Array.from(byPlayer.values());
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

function formatPotionGroup(rows, key) {
  const users = rows.filter((row) => row[key] > 0);
  return users.length > 0
    ? users.map((row) => `${row.player} ${row[key]}`).join(", ")
    : "none";
}

function formatNoPotionUsers(rows) {
  const zeroes = rows.filter((row) => row.haste === 0 && row.destruction === 0);
  return zeroes.length > 0 ? zeroes.map((row) => row.player).join(", ") : "none";
}

function formatMultiplePotionUsers(rows) {
  const parts = [];
  for (const row of rows) {
    const playerParts = [];
    if (row.haste > 1) playerParts.push(`${row.haste}x Haste`);
    if (row.destruction > 1) playerParts.push(`${row.destruction}x Destruction`);
    if (playerParts.length > 0) parts.push(`${row.player} ${playerParts.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "none";
}

function formatGreenGemDetails(gems) {
  const grouped = new Map();
  for (const gem of gems) {
    const itemName = isPlaceholderItemName(gem.itemName, gem.itemId) ? "" : gem.itemName || "";
    const key = JSON.stringify([gem.slotName, itemName, gem.gemName]);
    const current = grouped.get(key);
    if (current) {
      current.count += 1;
    } else {
      grouped.set(key, {
        slotName: gem.slotName,
        itemName,
        gemName: gem.gemName,
        count: 1,
      });
    }
  }

  return Array.from(grouped.values())
    .map((entry) => `${entry.slotName}${entry.itemName ? ` (${entry.itemName})` : ""}: ${entry.gemName}${entry.count > 1 ? ` x${entry.count}` : ""}`)
    .join("; ");
}

function formatGapSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

function formatApplicationCounts(rows, emptyText = "none") {
  return rows?.length
    ? rows.map((row) => `${row.player} ${row.count}`).join(", ")
    : emptyText;
}

function formatApplicationPhrase(rows) {
  if (!rows?.length) return "none";
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return `${formatApplicationCounts(rows)} ${total === 1 ? "application" : "applications"}`;
}

function formatEffectiveApplicationCounts(rows, { alwaysShowTarget = false } = {}) {
  if (!rows?.length) return "none";
  const targetNames = Array.from(new Set(rows.map((row) => row.targetName).filter(Boolean)));
  if (!alwaysShowTarget && targetNames.length <= 1) return formatApplicationCounts(rows);

  const byTarget = new Map();
  for (const row of rows) {
    const targetName = row.targetName || "unknown target";
    if (!byTarget.has(targetName)) byTarget.set(targetName, []);
    byTarget.get(targetName).push(row);
  }

  return Array.from(byTarget.entries())
    .map(([targetName, targetRows]) => targetRows
      .map((row) => `${row.player} ${row.count} on ${targetName}`)
      .join(", "))
    .join("; ");
}

function formatEffectiveApplicationPhrase(rows, denominator) {
  if (!rows?.length) return `none / ${denominator} trash mobs`;
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const noun = total === 1 ? "effective application" : "effective applications";
  return `${formatEffectiveApplicationCounts(rows, { alwaysShowTarget: true })} = ${total} ${noun} / ${denominator} trash mobs`;
}

function formatArmorDebuffFalloffs(falloffs = []) {
  if (!falloffs.length) return "none";
  return falloffs
    .sort((left, right) => left.timestamp - right.timestamp || left.abilityName.localeCompare(right.abilityName))
    .map((falloff) => `${falloff.abilityName} on ${falloff.targetName} at ${formatSeconds(falloff.delayMs)}`)
    .join("; ");
}

function formatOpeningSunder(openingSunder) {
  const rows = openingSunder?.rows || [];
  const playerCounts = rows.length > 0
    ? rows.map((row) => `${row.player} ${row.count}/2`).join(", ")
    : "none";
  const total = openingSunder?.total || 0;
  if (openingSunder?.ieaInFirstWindow && openingSunder.ieaDelayMs !== null) {
    return `${playerCounts}; boss had ${total} before IEA (IEA at ${formatSeconds(openingSunder.ieaDelayMs)})`;
  }
  if (openingSunder?.ieaDelayMs !== null) {
    return `${playerCounts}; first active window had ${total} before IEA later at ${formatSeconds(openingSunder.ieaDelayMs)}`;
  }
  return `${playerCounts}; first active window had ${total}; IEA not found`;
}

function formatIronshield(ironshieldFight) {
  if (ironshieldFight?.notExpected) return ironshieldFight.reason || "not expected";
  const expected = ironshieldFight?.expected || [];
  if (expected.length === 0) return "no expected tanks resolved";
  const requiredText = expected
    .map((row) => `${row.player} ${row.uses > 0 ? row.uses : "missing"}`)
    .join(", ");
  const otherRows = (ironshieldFight.otherTanks || [])
    .filter((row) => row.uses > 0);
  const otherText = otherRows.length > 0
    ? `; other tanks: ${otherRows.map((row) => `${row.player} ${row.uses}`).join(", ")}`
    : "";
  return `${requiredText}${otherText}`;
}

function formatDamageRows(rows = []) {
  if (rows.length === 0) return "none";
  return rows
    .map((row) => `${row.sourceName} ${row.abilityName} ${formatDamage(row.amount)}`)
    .join(", ");
}

function formatDeathDetail(row) {
  const overkill = row.killingOverkill ? ` (${formatDamage(row.killingOverkill)} overkill)` : "";
  const killingDamage = row.killingDamage !== null ? ` ${formatDamage(row.killingDamage)}${overkill}` : "";
  const debuffs = row.debuffs.length > 0 ? row.debuffs.join(", ") : "none";
  return `${row.player} at ${formatFightTime(row.delayMs)} - killed by ${row.killerName} ${row.killingAbility}${killingDamage}; last 5s damage: ${formatDamageRows(row.damageRows)}; debuffs applied: ${debuffs}`;
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
    lines.push(`**${result.policy.trackedDebuffs?.title || "Boss Buff / Debuff Audit"}**`);
    for (const fight of result.bossDebuffUptime.fights) {
      lines.push(`- ${fight.fightName}:`);
      for (const row of fight.rows) {
        lines.push(`  - ${row.label}: ${row.text}`);
      }
      const ironshieldFight = result.ironshieldPotions?.fights?.find((candidate) => candidate.fightId === fight.fightId);
      if (ironshieldFight) {
        lines.push(`  - Ironshield Potion: ${formatIronshield(ironshieldFight)}`);
      }
      const sunderFight = result.sunderApplications?.fights?.find((candidate) => candidate.fightId === fight.fightId);
      if (sunderFight) {
        lines.push(`  - Effective Sunder applications: ${formatEffectiveApplicationCounts(sunderFight.sunderRows)}`);
        lines.push(`  - Effective IEA applications: ${formatEffectiveApplicationCounts(sunderFight.ieaRows)}`);
        if (sunderFight.openingSunder) {
          lines.push(`  - Opening effective Sunder before IEA: ${formatOpeningSunder(sunderFight.openingSunder)}`);
        }
        lines.push(`  - Armor debuff falloffs: ${formatArmorDebuffFalloffs(sunderFight.falloffs)}`);
      }
    }
    if (result.bossDebuffUptime.note) {
      lines.push(`- ${result.bossDebuffUptime.note}`);
    }
    if (result.sunderApplications?.note) {
      lines.push(`- ${result.sunderApplications.note}`);
    }
  }

  if (result.sunderApplications?.trash) {
    lines.push("");
    lines.push("**Trash Sunder / IEA Applications**");
    lines.push(`- Trash effective Sunder applications: ${formatEffectiveApplicationCounts(result.sunderApplications.trash.sunderRows, { alwaysShowTarget: true })}`);
    const ieaApplications = formatEffectiveApplicationPhrase(result.sunderApplications.trash.ieaRows, result.sunderApplications.trash.mobCount);
    lines.push(`- Trash effective IEA applications: ${ieaApplications}`);
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

  const potionFights = result.potionUsage.fights.filter((fight) => fight.rows.length > 0);
  if (potionFights.length > 0) {
    lines.push("");
    lines.push("**Potion usage**");
    for (const fight of potionFights) {
      lines.push(`- ${fight.fightName}:`);
      lines.push(`  - No haste/destruction potion: ${formatNoPotionUsers(fight.rows)}`);
      lines.push(`  - Multiple potion uses: ${formatMultiplePotionUsers(fight.rows)}`);
      lines.push(`  - Haste: ${formatPotionGroup(fight.rows, "haste")}`);
      lines.push(`  - Destruction: ${formatPotionGroup(fight.rows, "destruction")}`);
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
    lines.push("**Green/white gem flags**");
    for (const row of result.greenGemFindings.rows) {
      const details = formatGreenGemDetails(row.gems);
      lines.push(`- ${row.player}: ${row.gems.length} green/white gem${row.gems.length === 1 ? "" : "s"} - ${details}`);
    }
  }

  const warningLines = [];
  if (result.sappers.errors.length > 0) {
    warningLines.push(`- Sapper analysis had ${result.sappers.errors.length} player/fight fetch errors; rerun if exact sapper counts matter.`);
  }
  if (result.windfury?.errors?.length > 0) {
    warningLines.push(`- Windfury analysis had ${result.windfury.errors.length} fetch errors; rerun if exact CPM counts matter.`);
  }
  if (result.potionUsage?.errors?.length > 0) {
    warningLines.push(`- Potion analysis had ${result.potionUsage.errors.length} player/fight fetch errors; rerun if exact potion counts matter.`);
  }
  if (result.bossDebuffUptime?.errors?.length > 0) {
    warningLines.push(`- Boss debuff uptime analysis had ${result.bossDebuffUptime.errors.length} WCL fetch errors; rerun if exact uptime values matter.`);
  }
  if (result.sunderApplications?.errors?.length > 0) {
    warningLines.push(`- Sunder / IEA application analysis had ${result.sunderApplications.errors.length} WCL fetch errors; rerun if exact application counts matter.`);
  }
  if (result.ironshieldPotions?.errors?.length > 0) {
    warningLines.push(`- Ironshield Potion analysis had ${result.ironshieldPotions.errors.length} WCL fetch errors; rerun if exact tank potion counts matter.`);
  }
  if (result.raidDeaths?.errors?.length > 0) {
    warningLines.push(`- Raid death analysis had ${result.raidDeaths.errors.length} WCL fetch errors; rerun if exact death snapshots matter.`);
  }
  if (result.greenGemFindings.errors.length > 0) {
    warningLines.push(`- Green/white gem analysis had ${result.greenGemFindings.errors.length} gem lookup errors; rerun if exact gem flags matter.`);
  }
  if (warningLines.length > 0) {
    lines.push("");
    lines.push("**Data warnings**");
    lines.push(...warningLines);
  }

  if (result.raidDeaths?.fights?.length > 0) {
    lines.push("");
    lines.push("**Raid Deaths**");
    for (const fight of result.raidDeaths.fights) {
      lines.push(`- ${fight.fightName}:`);
      if (fight.collapsed) {
        lines.push(`  - ${fight.players.join(", ")}`);
      } else {
        for (const death of fight.deaths) {
          lines.push(`  - ${formatDeathDetail(death)}`);
        }
      }
    }
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

  const rawCla = await postJson("/api/cla", {
    reportCode,
    fightIds: fights.map((fight) => fight.id),
  });
  const players = consolidatePlayersByName(rawCla.players || []);
  await hydratePlayerGearItemNames(players);
  const cla = {
    ...rawCla,
    players,
  };

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
      trackedDebuffs: policy.trackedDebuffs,
      path: options.policyPath,
    },
    wcl: {
      configured: Boolean(getWclConfig()),
      apiUrl: getWclConfig()?.apiUrl || null,
    },
    consumeFindings: await auditConsumes(reportCode, report, fights, cla, options, policy),
    enchantFindings: auditEnchants(cla, fights),
    greenGemFindings: await auditGreenGems(cla),
    bossDebuffUptime: await auditBossDebuffUptime(reportCode, fights, policy),
    ironshieldPotions: await auditIronshieldPotions(reportCode, fights, cla),
    sunderApplications: await auditSunderApplications(reportCode, fights),
    raidDeaths: await auditRaidDeaths(reportCode, fights),
    windfury: await auditWindfury(reportCode, report, fights, cla),
    potionUsage: await auditPotionUsage(reportCode, report, fights, cla),
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
