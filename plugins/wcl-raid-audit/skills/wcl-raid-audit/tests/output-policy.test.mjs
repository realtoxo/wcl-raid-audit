import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(TEST_DIR, "..");
const SCRIPT_PATH = resolve(SKILL_DIR, "scripts/raid_audit.mjs");

function slot(spellName = "") {
  return {
    present: Boolean(spellName),
    uptimePercent: spellName ? 100 : 0,
    spellId: 0,
    spellName,
    isSuboptimal: false,
    suboptimalReason: "",
  };
}

function consumables({ flask = "", battleElixir = "", guardianElixir = "" } = {}) {
  return {
    flask: slot(flask),
    battleElixir: slot(battleElixir),
    guardianElixir: slot(guardianElixir),
    food: slot("Well Fed"),
    weaponEnhancement: slot("Weapon Enhancement (detected on gear)"),
    scrolls: [],
  };
}

function fightData(fightId, consumes) {
  return { fightId, consumables: consumables(consumes) };
}

function duplicateGearPlayer(spec) {
  return {
    name: "Dupecat",
    className: "Druid",
    spec,
    role: "Physical",
    sourceId: spec === "Feral" ? 5 : 6,
    fightData: [fightData(1, { flask: "Flask of Relentless Assault" })],
    gearIssues: [{ issueType: "missing_enchant", slotName: "Back" }],
    gearSnapshot: [
      {
        slotName: "Hands",
        itemId: 27531,
        itemName: "Wastewalker Gloves",
        gems: [
          { id: 23097, name: "Delicate Blood Garnet" },
          { id: 23097, name: "Delicate Blood Garnet" },
          { id: 99901, name: "Practice Stone" },
        ],
      },
    ],
  };
}

async function withMockServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test("output policy suppresses requested flags and reports compact potion usage", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "wcl-output-policy-"));
  const policyPath = join(tmp, "policy.json");
  await writeFile(policyPath, JSON.stringify({
    name: "test-policy",
    version: 1,
    reportTitle: "WCL Raid Audit",
    reportRules: [],
    general: {
      food: { expected: true },
      weaponEnhancement: { expected: true },
      enchants: { expected: true },
      casterMana: { acceptAnyFlask: true, requiresBattleAndGuardianIfNoFlask: true },
      physicalScrolls: { expected: false },
    },
    trackedDebuffs: {
      groups: [
        { label: "Warlock curses", kind: "pattern", namePattern: "^Curse of ", alwaysShow: true, emptyText: "none" },
        { label: "IEA / Expose Armor", kind: "ability", abilityId: 26866, abilityName: "Expose Armor", alwaysShow: true, emptyText: "0.0%" },
        { label: "Judgement of Wisdom", kind: "ability", abilityId: 20186, abilityName: "Judgement of Wisdom", alwaysShow: true, emptyText: "0.0%" },
      ],
    },
    encounters: [
      {
        name: "High King Maulgar",
        match: "maulgar",
        physicalDps: { expectedFlasks: ["Flask of Relentless Assault"] },
        casterMana: { acceptAnyFlask: true, requiresBattleAndGuardianIfNoFlask: true },
      },
      {
        name: "Magtheridon",
        match: "magtheridon",
        physicalDps: {
          expectedBattleElixirs: ["Elixir of Demonslaying"],
          ignoreMissingGuardian: true,
        },
        casterMana: { acceptAnyFlask: true, requiresBattleAndGuardianIfNoFlask: true },
      },
    ],
  }));

  const players = [
    {
      name: "Tankmage",
      className: "Mage",
      spec: "Arcane",
      role: "Caster",
      sourceId: 1,
      fightData: [fightData(1), fightData(2, { flask: "Flask of Relentless Assault" })],
      gearIssues: [{ issueType: "missing_enchant", slotName: "Chest" }],
      gearSnapshot: [],
    },
    {
      name: "Goodflask",
      className: "Warrior",
      spec: "Fury",
      role: "Physical",
      sourceId: 2,
      fightData: [
        fightData(1, { flask: "Flask of Relentless Assault" }),
        fightData(2, { flask: "Flask of Relentless Assault" }),
      ],
      gearIssues: [],
      gearSnapshot: [],
    },
    {
      name: "Zerodps",
      className: "Warlock",
      spec: "Destruction",
      role: "Caster",
      sourceId: 4,
      fightData: [
        fightData(1, { flask: "Flask of Pure Death" }),
        fightData(2, { flask: "Flask of Pure Death" }),
      ],
      gearIssues: [],
      gearSnapshot: [],
    },
    {
      name: "Healz",
      className: "Priest",
      spec: "Holy",
      role: "Healer",
      sourceId: 3,
      fightData: [fightData(1, { battleElixir: "Elixir of Healing Power", guardianElixir: "Elixir of Draenic Wisdom" })],
      gearIssues: [
        { issueType: "missing_enchant", slotName: "Back" },
        { issueType: "missing_enchant", slotName: "Wrist" },
      ],
      gearSnapshot: [],
    },
    duplicateGearPlayer("Feral"),
    duplicateGearPlayer("Guardian"),
  ];

  await withMockServer((req, res) => {
    const url = new URL(req.url, "http://mock.local");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/report/policytest") {
      res.end(JSON.stringify({
        title: "policy test",
        owner: "tester",
        zone: "Gruul / Magtheridon",
        fights: [
          { id: 1, name: "High King Maulgar", kill: true, encounterID: 50649, duration: 60000 },
          { id: 2, name: "Magtheridon", kill: true, encounterID: 50651, duration: 60000 },
        ],
      }));
      return;
    }

    if (url.pathname === "/api/cla") {
      res.end(JSON.stringify({ fights: [], players }));
      return;
    }

    if (url.pathname === "/api/analyze") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const request = JSON.parse(body || "{}");
        const castsBySource = {
          1: [{ name: "Destruction Potion", guid: 28508, playerCasts: 1 }],
          2: [{ name: "Haste", guid: 28507, playerCasts: 2 }],
          3: [],
          4: [],
        };
        const player = players.find((candidate) => candidate.sourceId === request.sourceId);
        res.end(JSON.stringify({
          playerName: player?.name,
          playerClass: player?.className,
          playerSpec: player?.spec,
          casts: castsBySource[request.sourceId] || [],
          abilities: [],
        }));
      });
      return;
    }

    if (url.pathname === "/report/fights/policytest") {
      res.end(JSON.stringify({
        fights: [
          { id: 1, name: "High King Maulgar", start_time: 1000, end_time: 61000 },
          { id: 2, name: "Magtheridon", start_time: 70000, end_time: 130000 },
        ],
        friendlies: [],
        friendlyPets: [],
        enemies: [{ id: 100, name: "Magtheridon", fights: [{ id: 2 }] }],
      }));
      return;
    }

    if (url.pathname === "/report/tables/debuffs/policytest") {
      if (url.searchParams.get("abilityid") === "26866") {
        res.end(JSON.stringify({
          totalTime: 60000,
          auras: [{ name: "Kojay", guid: 26866, totalUptime: 60000 }],
        }));
        return;
      }

      res.end(JSON.stringify({
        totalTime: 60000,
        auras: [
          { name: "Expose Armor", guid: 26866, totalUptime: 60000 },
          { name: "Expose Weakness", guid: 34501, totalUptime: 30000 },
          { name: "Judgement of Wisdom", guid: 20186, totalUptime: 45000 },
        ],
      }));
      return;
    }

    if (url.pathname === "/report/events/debuffs/policytest") {
      res.end(JSON.stringify({
        events: [
          { type: "applydebuff", timestamp: 70000, source: { name: "Kojay" }, ability: { guid: 20186, name: "Judgement of Wisdom" } },
          { type: "refreshdebuff", timestamp: 95000, source: { name: "Texz" }, ability: { guid: 20186, name: "Judgement of Wisdom" } },
        ],
      }));
      return;
    }

    if (url.pathname === "/23097") {
      res.end(JSON.stringify({ name: "Delicate Blood Garnet", quality: 2 }));
      return;
    }

    if (url.pathname === "/99901") {
      res.end(JSON.stringify({ name: "Practice Stone", quality: 1 }));
      return;
    }

    if (url.pathname === "/27531") {
      res.end(JSON.stringify({ name: "Wastewalker Gloves", quality: 3 }));
      return;
    }

    res.end(JSON.stringify({ auras: [], events: [] }));
  }, async (baseUrl) => {
    const { stdout } = await execFile("node", [
      SCRIPT_PATH,
      "policytest",
      "--markdown",
      "--policy",
      policyPath,
      "--skip-sappers",
    ], {
      env: {
        ...process.env,
        PARSEFORGE_BASE_URL: baseUrl,
        WARCRAFTLOGS_V1_BASE_URL: baseUrl,
        WARCRAFTLOGS_API_KEY: "test-key",
        WCL_API_KEY: "",
        WARCRAFTLOGS_CLIENT_ID: "",
        WARCRAFTLOGS_CLIENT_SECRET: "",
        WCL_CLIENT_ID: "",
        WCL_CLIENT_SECRET: "",
        WOWHEAD_TBC_TOOLTIP_BASE_URL: baseUrl,
      },
      maxBuffer: 1024 * 1024,
    });

    assert.doesNotMatch(stdout, /Tankmage: \*\*(Incomplete caster setup|Missing|Suboptimal)\*\*/);
    assert.doesNotMatch(stdout, /Goodflask: \*\*Suboptimal\*\* - expected Elixir of Demonslaying/);
    assert.doesNotMatch(stdout, /Healz: 2 missing - Back, Wrist/);
    assert.match(stdout, /Healz: 1 missing - Wrist/);
    assert.equal((stdout.match(/Dupecat: 1 missing - Back/g) || []).length, 1);
    assert.match(stdout, /- IEA \/ Expose Armor: 100\.0%/);
    assert.doesNotMatch(stdout, /Expose Weakness/);
    assert.match(stdout, /- Judgement of Wisdom: 75\.0% \(initial Kojay; reapplied by Texz\)/);
    assert.match(stdout, /\*\*Potion usage\*\*/);
    assert.match(stdout, /- High King Maulgar:/);
    assert.match(stdout, /  - No haste\/destruction potion: Zerodps/);
    assert.match(stdout, /  - Multiple potion uses: Goodflask 2x Haste/);
    assert.match(stdout, /  - Haste: Goodflask 2/);
    assert.match(stdout, /  - Destruction: none/);
    assert.doesNotMatch(stdout, /Dupecat, Dupecat/);
    const potionSection = stdout.split("**Potion usage**")[1].split("\n\n**Enchant flags**")[0];
    assert.doesNotMatch(potionSection, /Healz/);
    assert.doesNotMatch(stdout, /Tankmage 0/);
    assert.match(stdout, /- Magtheridon:/);
    assert.match(stdout, /  - No haste\/destruction potion: Zerodps/);
    assert.match(stdout, /  - Multiple potion uses: Goodflask 2x Haste/);
    assert.match(stdout, /  - Haste: Goodflask 2/);
    assert.match(stdout, /  - Destruction: Tankmage 1/);
    assert.match(stdout, /\*\*Green\/white gem flags\*\*/);
    assert.equal((stdout.match(/Dupecat: 3 green\/white gems - Hands \(Wastewalker Gloves\): Delicate Blood Garnet x2; Hands \(Wastewalker Gloves\): Practice Stone/g) || []).length, 1);
  });
});

test("429 responses retry with progress logs before rendering report", async () => {
  let reportAttempts = 0;
  const tmp = await mkdtemp(join(tmpdir(), "wcl-retry-policy-"));
  const policyPath = join(tmp, "policy.json");
  await writeFile(policyPath, JSON.stringify({
    name: "retry-policy",
    version: 1,
    reportTitle: "WCL Raid Audit",
    reportRules: [],
    general: {
      food: { expected: true },
      weaponEnhancement: { expected: true },
      casterMana: { acceptAnyFlask: true, requiresBattleAndGuardianIfNoFlask: true },
      physicalScrolls: { expected: false },
    },
    trackedDebuffs: { groups: [] },
    encounters: [],
  }));

  await withMockServer((req, res) => {
    const url = new URL(req.url, "http://mock.local");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/report/retrytest") {
      reportAttempts += 1;
      if (reportAttempts < 3) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: "Too many requests" }));
        return;
      }
      res.end(JSON.stringify({
        title: "retry test",
        owner: "tester",
        zone: "Gruul's Lair",
        fights: [{ id: 1, name: "High King Maulgar", kill: true, encounterID: 50649, duration: 60000 }],
      }));
      return;
    }

    if (url.pathname === "/api/cla") {
      res.end(JSON.stringify({
        fights: [],
        players: [{
          name: "Healz",
          className: "Priest",
          spec: "Holy",
          role: "Healer",
          sourceId: 1,
          fightData: [fightData(1, { battleElixir: "Elixir of Healing Power", guardianElixir: "Elixir of Draenic Wisdom" })],
          gearIssues: [],
          gearSnapshot: [],
        }],
      }));
      return;
    }

    res.end(JSON.stringify({ auras: [], events: [] }));
  }, async (baseUrl) => {
    const { stdout, stderr } = await execFile("node", [
      SCRIPT_PATH,
      "retrytest",
      "--markdown",
      "--policy",
      policyPath,
      "--skip-sappers",
    ], {
      env: {
        ...process.env,
        PARSEFORGE_BASE_URL: baseUrl,
        WARCRAFTLOGS_API_KEY: "",
        WCL_API_KEY: "",
        WARCRAFTLOGS_CLIENT_ID: "",
        WARCRAFTLOGS_CLIENT_SECRET: "",
        WCL_CLIENT_ID: "",
        WCL_CLIENT_SECRET: "",
        RAID_AUDIT_RETRY_BASE_MS: "1",
        RAID_AUDIT_RETRY_MAX_MS: "2",
        RAID_AUDIT_MAX_RETRIES: "3",
      },
      maxBuffer: 1024 * 1024,
    });

    assert.equal(reportAttempts, 3);
    assert.match(stdout, /\*\*WCL Raid Audit\*\*/);
    assert.match(stderr, /Loading report metadata/);
    assert.match(stderr, /429.*retrying in \d+ms \(attempt 1\/3\)/);
    assert.match(stderr, /429.*retrying in \d+ms \(attempt 2\/3\)/);
  });
});

test("duplicate player fight analysis requests are cached within a run", async () => {
  let analyzeCalls = 0;
  const tmp = await mkdtemp(join(tmpdir(), "wcl-cache-policy-"));
  const policyPath = join(tmp, "policy.json");
  await writeFile(policyPath, JSON.stringify({
    name: "cache-policy",
    version: 1,
    reportTitle: "WCL Raid Audit",
    reportRules: [],
    general: {
      food: { expected: true },
      weaponEnhancement: { expected: true },
      casterMana: { acceptAnyFlask: true, requiresBattleAndGuardianIfNoFlask: true },
      physicalScrolls: { expected: false },
    },
    trackedDebuffs: { groups: [] },
    encounters: [],
  }));

  await withMockServer((req, res) => {
    const url = new URL(req.url, "http://mock.local");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/report/cachetest") {
      res.end(JSON.stringify({
        title: "cache test",
        owner: "tester",
        zone: "Gruul's Lair",
        fights: [{ id: 1, name: "Gruul the Dragonkiller", kill: true, encounterID: 50650, duration: 60000 }],
      }));
      return;
    }

    if (url.pathname === "/api/cla") {
      res.end(JSON.stringify({
        fights: [],
        players: [{
          name: "Pestilian",
          className: "Shaman",
          spec: "Enhancement",
          role: "Physical",
          sourceId: 10,
          fightData: [fightData(1, { flask: "Flask of Relentless Assault" })],
          gearIssues: [],
          gearSnapshot: [],
        }],
      }));
      return;
    }

    if (url.pathname === "/api/analyze") {
      analyzeCalls += 1;
      res.end(JSON.stringify({
        playerName: "Pestilian",
        playerClass: "Shaman",
        playerSpec: "Enhancement",
        casts: [
          { name: "Windfury Totem", guid: 25587, playerCasts: 3, playerCpm: 3 },
          { name: "Grace of Air Totem", guid: 25359, playerCasts: 3, playerCpm: 3 },
          { name: "Haste", guid: 28507, playerCasts: 1 },
          { name: "Goblin Sapper Charge", guid: 13241, playerCasts: 1 },
        ],
        abilities: [{ name: "Goblin Sapper Charge", guid: 13241, playerTotal: 1000 }],
      }));
      return;
    }

    if (url.pathname === "/report/fights/cachetest") {
      res.end(JSON.stringify({
        fights: [{ id: 1, name: "Gruul the Dragonkiller", start_time: 1000, end_time: 61000 }],
        friendlies: [{ id: 10, name: "Pestilian", type: "Shaman", fights: [{ id: 1 }] }],
        friendlyPets: [],
        enemies: [],
      }));
      return;
    }

    if (url.pathname === "/report/events/casts/cachetest") {
      res.end(JSON.stringify({ events: [] }));
      return;
    }

    res.end(JSON.stringify({ auras: [], events: [] }));
  }, async (baseUrl) => {
    const { stdout } = await execFile("node", [
      SCRIPT_PATH,
      "cachetest",
      "--markdown",
      "--policy",
      policyPath,
    ], {
      env: {
        ...process.env,
        PARSEFORGE_BASE_URL: baseUrl,
        WARCRAFTLOGS_V1_BASE_URL: baseUrl,
        WARCRAFTLOGS_API_KEY: "test-key",
        WCL_API_KEY: "",
        WARCRAFTLOGS_CLIENT_ID: "",
        WARCRAFTLOGS_CLIENT_SECRET: "",
        WCL_CLIENT_ID: "",
        WCL_CLIENT_SECRET: "",
      },
      maxBuffer: 1024 * 1024,
    });

    assert.equal(analyzeCalls, 1);
    assert.match(stdout, /\*\*Windfury \/ Twisting\*\*/);
    assert.match(stdout, /\*\*Sapper usage\*\*/);
    assert.match(stdout, /\*\*Potion usage\*\*/);
  });
});
