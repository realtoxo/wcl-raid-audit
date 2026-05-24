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

function consumables({
  flask = "",
  battleElixir = "",
  guardianElixir = "",
  food = "Well Fed",
  weaponEnhancement = "Weapon Enhancement (detected on gear)",
} = {}) {
  return {
    flask: slot(flask),
    battleElixir: slot(battleElixir),
    guardianElixir: slot(guardianElixir),
    food: slot(food),
    weaponEnhancement: slot(weaponEnhancement),
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
        slotName: "Back",
        itemId: 29925,
        itemName: "Drape of the Duplicate",
        gems: [],
      },
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

function pilchDuplicate(spec, role) {
  return {
    name: "Pilch",
    className: "Shaman",
    spec,
    role,
    sourceId: 9,
    fightData: [
      fightData(1, {
        flask: "Flask of Blinding Light",
        food: "Well Fed",
        weaponEnhancement: "",
      }),
      fightData(2, {
        flask: "Flask of Blinding Light",
        food: "Well Fed",
        weaponEnhancement: "",
      }),
    ],
    gearIssues: [
      { issueType: "missing_enchant", slotName: "Back" },
      { issueType: "missing_enchant", slotName: "Hands" },
    ],
    gearSnapshot: [
      {
        slotName: "Back",
        itemId: 28764,
        itemName: "Cloak of Torn Specs",
        gems: [],
      },
      {
        slotName: "Hands",
        itemId: 30189,
        itemName: "Cataclysm Handgrips",
        gems: [],
      },
      {
        slotName: "Main Hand",
        itemId: 29988,
        itemName: "The Nexus Key",
        gems: [],
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
        { label: "Faerie Fire", kind: "pattern", namePattern: "^Faerie Fire( \\(Feral\\))?$", combine: "union", alwaysShow: true, emptyText: "0.0%" },
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
      gearSnapshot: [
        {
          slotName: "Back",
          itemId: 28570,
          itemName: "Shadow-Cloak of Dalaran",
          gems: [],
        },
        {
          slotName: "Wrist",
          itemId: 28511,
          itemName: "Bands of Indwelling",
          gems: [],
        },
      ],
    },
    {
      name: "Nooil",
      className: "Warlock",
      spec: "Destruction",
      role: "Caster",
      sourceId: 8,
      fightData: [
        fightData(1, {
          flask: "Flask of Pure Death",
          food: "Well Fed",
          weaponEnhancement: "",
        }),
      ],
      gearIssues: [],
      gearSnapshot: [
        {
          slotName: "Main Hand",
          itemId: 27538,
          itemName: "Item #27538",
          gems: [],
        },
      ],
    },
    {
      name: "Tankwar",
      className: "Warrior",
      spec: "Protection",
      role: "Tank",
      sourceId: 9,
      fightData: [fightData(1), fightData(2)],
      gearIssues: [],
      gearSnapshot: [],
    },
    {
      name: "Offwar",
      className: "Warrior",
      spec: "Protection",
      role: "Tank",
      sourceId: 10,
      fightData: [fightData(1), fightData(2)],
      gearIssues: [],
      gearSnapshot: [],
    },
    pilchDuplicate("Restoration", "Healer"),
    pilchDuplicate("Elemental", "Caster"),
    duplicateGearPlayer("Feral"),
    duplicateGearPlayer("Guardian"),
    {
      name: "Ghostdps",
      className: "Warlock",
      spec: "Destruction",
      role: "Caster",
      sourceId: 44,
      fightData: [fightData(1, { flask: "Flask of Pure Death" })],
      gearIssues: [],
      gearSnapshot: [],
    },
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
          { id: 1, name: "High King Maulgar", kill: true, encounterID: 50649, duration: 60000, zoneID: 565 },
          { id: 2, name: "Magtheridon", kill: true, encounterID: 50651, duration: 60000, zoneID: 565 },
          { id: 4, name: "Lady Vashj", kill: false, encounterID: 21212, duration: 40000, zoneID: 565 },
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
        if (request.sourceId === 44) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "Player not found in fight" }));
          return;
        }
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
          { id: 1, name: "High King Maulgar", start_time: 1000, end_time: 61000, zoneID: 565, boss: 50649 },
          { id: 2, name: "Magtheridon", start_time: 70000, end_time: 130000, zoneID: 565, boss: 50651 },
          { id: 3, name: "Lair Brute", start_time: 140000, end_time: 170000, zoneID: 565, boss: 0 },
          { id: 4, name: "Lady Vashj", start_time: 200000, end_time: 240000, zoneID: 565, boss: 50652, kill: false },
        ],
        friendlies: [
          { id: 2, name: "Goodflask", type: "Warrior", fights: [{ id: 1 }, { id: 2 }] },
          { id: 4, name: "Zerodps", type: "Warlock", fights: [{ id: 1 }, { id: 2 }] },
          { id: 9, name: "Tankwar", type: "Warrior" },
          { id: 10, name: "Offwar", type: "Warrior" },
          { id: 15, name: "Amilice", type: "Rogue" },
          { id: 21, name: "Thcdatank", type: "Warrior" },
          { id: 44, name: "Ghostdps", type: "Warlock", fights: [{ id: 3 }] },
        ],
        friendlyPets: [],
        enemies: [
          { id: 99, name: "High King Maulgar", fights: [{ id: 1 }] },
          { id: 100, name: "Magtheridon", fights: [{ id: 2 }] },
          { id: 202, name: "Channeler Add", type: "NPC", fights: [{ id: 2, instances: 1 }] },
          { id: 200, name: "Lair Brute", type: "NPC", fights: [{ id: 3, instances: 2 }] },
          { id: 201, name: "Cave Gronn", type: "NPC", fights: [{ id: 3, instances: 1 }] },
          { id: 203, name: "Vashj Add", type: "NPC", fights: [{ id: 4, instances: 1 }] },
        ],
      }));
      return;
    }

    if (url.pathname === "/report/tables/debuffs/policytest") {
      if (url.searchParams.get("abilityid") === "25203") {
        const targetId = url.searchParams.get("targetid");
        res.end(JSON.stringify({
          totalTime: 60000,
          auras: targetId === "99"
            ? [{ name: "Tankwar", type: "Warrior", totalUptime: 30000, totalUses: 1, bands: [{ startTime: 11000, endTime: 41000 }] }]
            : [],
        }));
        return;
      }

      if (url.searchParams.get("abilityid") === "26998") {
        res.end(JSON.stringify({ totalTime: 60000, auras: [] }));
        return;
      }

      if (url.searchParams.get("abilityid") === "26993") {
        res.end(JSON.stringify({
          totalTime: 60000,
          auras: [{ name: "Bobbearpig", type: "Druid", totalUses: 1 }],
        }));
        return;
      }

      if (url.searchParams.get("abilityid") === "27011") {
        res.end(JSON.stringify({
          totalTime: 60000,
          auras: [{ name: "Downshift", type: "Druid", totalUses: 1 }],
        }));
        return;
      }

      if (url.searchParams.get("abilityid") === "25225") {
        const targetId = url.searchParams.get("targetid");
        const start = Number(url.searchParams.get("start"));
        const end = Number(url.searchParams.get("end"));
        const usesByWindow = targetId === "99" && start === 11000 && end === 13500
          ? [
            { name: "Tankwar", type: "Warrior", totalUses: 2 },
            { name: "Offwar", type: "Warrior", totalUses: 1 },
          ]
          : targetId === "100" && start === 80000 && end === 82500
            ? [{ name: "Tankwar", type: "Warrior", totalUses: 1 }]
            : targetId === "202"
              ? [{ name: "Tankwar", type: "Warrior", totalUses: 3, bands: [{ startTime: 80000, endTime: 85000 }] }]
              : targetId === "203"
                ? [
                  { name: "Thcdatank", type: "Warrior", totalUses: 2, bands: [{ startTime: 210000, endTime: 220000 }] },
                  { name: "Tankwar", type: "Warrior", totalUses: 1, bands: [{ startTime: 221000, endTime: 230000 }] },
                ]
                : targetId === "204"
                  ? [{ name: "Thcdatank", type: "Warrior", totalUses: 4, bands: [{ startTime: 211000, endTime: 220000 }] }]
            : targetId === "99"
          ? [
            { name: "Tankwar", type: "Warrior", totalUses: 4 },
            { name: "Offwar", type: "Warrior", totalUses: 1 },
          ]
          : targetId === "100"
            ? [{ name: "Tankwar", type: "Warrior", totalUses: 2 }]
            : start === 1000
              ? [
                { name: "Tankwar", type: "Warrior", totalUses: 4 },
                { name: "Offwar", type: "Warrior", totalUses: 1 },
              ]
              : start === 70000
                ? [{ name: "Tankwar", type: "Warrior", totalUses: 2 }]
                : start === 140000
                  ? [
                    { name: "Tankwar", type: "Warrior", totalUses: 2 },
                    { name: "Offwar", type: "Warrior", totalUses: 1 },
                  ]
                  : [];
        res.end(JSON.stringify({ totalTime: 60000, auras: usesByWindow }));
        return;
      }

      if (url.searchParams.get("abilityid") === "26866") {
        const targetId = url.searchParams.get("targetid");
        const start = Number(url.searchParams.get("start"));
        if (targetId === "202") {
          res.end(JSON.stringify({
            totalTime: 60000,
            auras: [{ name: "Amilice", guid: 26866, totalUptime: 30000, totalUses: 1, bands: [{ startTime: 90000, endTime: 120000 }] }],
          }));
          return;
        }
        if (targetId === "203") {
          res.end(JSON.stringify({
            totalTime: 40000,
            auras: [{ name: "Amilice", guid: 26866, totalUptime: 10000, totalUses: 2, bands: [{ startTime: 230000, endTime: 240000 }] }],
          }));
          return;
        }
        if (targetId === "204") {
          res.end(JSON.stringify({
            totalTime: 40000,
            auras: [{ name: "Amilice", guid: 26866, totalUptime: 10000, totalUses: 1, bands: [{ startTime: 220000, endTime: 230000 }] }],
          }));
          return;
        }
        const totalUses = start === 140000 ? 2 : 3;
        res.end(JSON.stringify({
          totalTime: 60000,
          auras: [{ name: "Amilice", guid: 26866, totalUptime: 60000, totalUses }],
        }));
        return;
      }

      if (url.searchParams.has("targetid")) {
        const start = Number(url.searchParams.get("start"));
        res.end(JSON.stringify({
          totalTime: 60000,
          auras: [
            { name: "Expose Armor", guid: 26866, totalUptime: 45000, bands: [{ startTime: start + 12500, endTime: start + 57500 }] },
            { name: "Sunder Armor", guid: 25225, totalUptime: 15000 },
            { name: "Judgement of Wisdom", guid: 20186, totalUptime: 45000 },
            { name: "Faerie Fire", guid: 26993, totalUptime: 25000, bands: [{ startTime: start + 10000, endTime: start + 35000 }] },
            { name: "Faerie Fire (Feral)", guid: 27011, totalUptime: 30000, bands: [{ startTime: start + 30000, endTime: start + 60000 }] },
            { name: "Demoralizing Shout", guid: 25203, totalUptime: 30000, bands: [{ startTime: start + 10000, endTime: start + 40000 }] },
          ],
        }));
        return;
      }

      res.end(JSON.stringify({
        totalTime: 60000,
        auras: [
          { name: "Expose Armor", guid: 26866, totalUptime: 30000 },
          { name: "Sunder Armor", guid: 25225, totalUptime: 18000 },
        ],
      }));
      return;
    }

    if (url.pathname === "/report/events/casts/policytest") {
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      const abilityId = Number(url.searchParams.get("abilityid"));
      const abilityName = abilityId === 25225 ? "Sunder Armor" : "Expose Armor";
      const events = [];
      if (start <= 70000 && end >= 130000) {
        events.push(
          { type: "cast", timestamp: 81000, sourceID: 9, targetID: 202, sourceIsFriendly: true, targetIsFriendly: false, ability: { guid: abilityId, name: abilityName } },
          { type: "cast", timestamp: 81500, sourceID: 10, targetID: 202, sourceIsFriendly: true, targetIsFriendly: false, ability: { guid: abilityId, name: abilityName } },
        );
      }
      if (start <= 140000 && end >= 170000) {
        events.push(
          { type: "cast", timestamp: 145000, sourceID: 9, targetID: 200, sourceIsFriendly: true, targetIsFriendly: false, ability: { guid: abilityId, name: abilityName } },
          { type: "cast", timestamp: 146000, sourceID: 10, targetID: 200, sourceIsFriendly: true, targetIsFriendly: false, ability: { guid: abilityId, name: abilityName } },
        );
      }
      if (start <= 200000 && end >= 240000) {
        events.push(
          { type: "cast", timestamp: 210000, sourceID: 21, targetID: 203, sourceIsFriendly: true, targetIsFriendly: false, ability: { guid: abilityId, name: abilityName } },
          { type: "cast", timestamp: 221000, sourceID: 9, targetID: 203, sourceIsFriendly: true, targetIsFriendly: false, ability: { guid: abilityId, name: abilityName } },
          { type: "cast", timestamp: 222000, sourceID: 21, targetID: 204, sourceIsFriendly: true, targetIsFriendly: false, ability: { guid: abilityId, name: abilityName } },
        );
      }
      res.end(JSON.stringify({ events }));
      return;
    }

    if (url.pathname === "/report/tables/buffs/policytest") {
      if (url.searchParams.get("abilityid") === "28515") {
        const start = Number(url.searchParams.get("start"));
        res.end(JSON.stringify({
          totalTime: 60000,
          auras: start === 1000
            ? [{ name: "Tankwar", type: "Warrior", totalUses: 1, totalUptime: 120000, bands: [{ startTime: 2000, endTime: 122000 }] }]
            : [],
        }));
        return;
      }
      res.end(JSON.stringify({ totalTime: 60000, auras: [] }));
      return;
    }

    if (url.pathname === "/report/events/deaths/policytest") {
      const start = Number(url.searchParams.get("start"));
      const events = start === 1000
        ? [{
          type: "death",
          timestamp: 60000,
          targetID: 4,
          targetIsFriendly: true,
          killerID: 99,
          killingAbility: { name: "Crushing Blow", guid: 12345, type: 1 },
        }]
        : start === 70000
          ? [
            { type: "death", timestamp: 81000, targetID: 2, targetIsFriendly: true, killerID: 100, killingAbility: { name: "Shadow Bolt", guid: 11, type: 32 } },
            { type: "death", timestamp: 82000, targetID: 4, targetIsFriendly: true, killerID: 100, killingAbility: { name: "Shadow Bolt", guid: 11, type: 32 } },
            { type: "death", timestamp: 83000, targetID: 9, targetIsFriendly: true, killerID: 100, killingAbility: { name: "Shadow Bolt", guid: 11, type: 32 } },
            { type: "death", timestamp: 84000, targetID: 10, targetIsFriendly: true, killerID: 100, killingAbility: { name: "Shadow Bolt", guid: 11, type: 32 } },
          ]
          : start === 200000
            ? [{ type: "death", timestamp: 210000, targetID: 2, targetIsFriendly: true, killerID: 203, killingAbility: { name: "Poison Bolt", guid: 12, type: 8 } }]
            : [];
      res.end(JSON.stringify({
        events,
      }));
      return;
    }

    if (url.pathname === "/report/events/damage-taken/policytest") {
      const start = Number(url.searchParams.get("start"));
      const events = !url.searchParams.has("targetid") && start === 55000
        ? [
          { type: "damage", timestamp: 57000, sourceID: 99, sourceIsFriendly: false, targetID: 4, targetIsFriendly: true, amount: 1200, ability: { name: "Melee", guid: 1 } },
          { type: "damage", timestamp: 60000, sourceID: 99, sourceIsFriendly: false, targetID: 4, targetIsFriendly: true, amount: 4200, ability: { name: "Crushing Blow", guid: 12345 } },
        ]
        : [];
      res.end(JSON.stringify({ events }));
      return;
    }

    if (url.pathname === "/report/events/debuffs/policytest") {
      if (url.searchParams.get("targetid") === "4") {
        res.end(JSON.stringify({
          events: [
            { type: "applydebuff", timestamp: 58000, sourceID: 99, sourceIsFriendly: false, targetID: 4, targetIsFriendly: true, ability: { name: "Mortal Wound", guid: 54321 } },
          ],
        }));
        return;
      }

      if (url.searchParams.get("abilityid") === "26866") {
        const start = Number(url.searchParams.get("start"));
        res.end(JSON.stringify({
          events: [
            { type: "applydebuff", timestamp: start + 12500, source: { name: "Amilice" }, ability: { guid: 26866, name: "Expose Armor" } },
          ],
        }));
        return;
      }

      res.end(JSON.stringify({
        events: [
          { type: "applydebuff", timestamp: 70000, source: { name: "Kojay" }, ability: { guid: 20186, name: "Judgement of Wisdom" } },
          { type: "refreshdebuff", timestamp: 95000, source: { name: "Texz" }, ability: { guid: 20186, name: "Judgement of Wisdom" } },
        ],
      }));
      return;
    }

    if (url.pathname === "/report/events/damage-done/policytest") {
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      const targetId = Number(url.searchParams.get("targetid"));
      res.end(JSON.stringify({
        events: targetId > 0
          ? [start + 10000, start + 20000, start + 30000, start + 40000, start + 50000, end].map((timestamp) => ({
            type: "damage",
            timestamp,
            sourceIsFriendly: true,
            targetID: targetId,
            amount: 1,
            ability: { guid: 1, name: "Melee" },
          }))
          : [],
      }));
      return;
    }

    if (url.pathname === "/report/tables/damage-done/policytest") {
      const targetId = Number(url.searchParams.get("targetid"));
      res.end(JSON.stringify({
        entries: targetId === 204
          ? [{ name: "Hidden Elite 3", id: "204.3", guid: 22055, type: "NPC", instance: 3 }]
          : [],
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

    if (url.pathname === "/27538") {
      res.end(JSON.stringify({ name: "Lightsworn Hammer", quality: 3 }));
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
        RAID_AUDIT_DISABLE_DISK_CACHE: "1",
      },
      maxBuffer: 1024 * 1024,
    });

    assert.doesNotMatch(stdout, /Tankmage: \*\*(Incomplete caster setup|Missing|Suboptimal)\*\*/);
    assert.doesNotMatch(stdout, /Goodflask: \*\*Suboptimal\*\* - expected Elixir of Demonslaying/);
    assert.doesNotMatch(stdout, /Healz: 2 missing - Back, Wrist/);
    assert.match(stdout, /Healz: 1 missing - Wrist \(Bands of Indwelling\)/);
    assert.equal((stdout.match(/Dupecat: 1 missing - Back \(Drape of the Duplicate\)/g) || []).length, 1);
    assert.equal((stdout.match(/Pilch: \*\*Missing\*\* - missing weapon enhancement\/oil\/stone on Main Hand \(The Nexus Key\)/g) || []).length, 2);
    assert.match(stdout, /Nooil: \*\*Missing\*\* - missing weapon enhancement\/oil\/stone on Main Hand \(Lightsworn Hammer\)/);
    assert.doesNotMatch(stdout, /Item #27538/);
    assert.equal((stdout.match(/Pilch: 2 missing - Back \(Cloak of Torn Specs\), Hands \(Cataclysm Handgrips\)/g) || []).length, 1);
    assert.doesNotMatch(stdout, /Pilch: 1 missing - Hands \(Cataclysm Handgrips\)/);
    assert.match(stdout, /\*\*Boss Buff \/ Debuff Audit\*\*/);
    assert.doesNotMatch(stdout, /\*\*Boss Debuff Uptime\*\*/);
    assert.match(stdout, /- IEA \/ Expose Armor: 90\.0% \(Amilice; first at 2\.5s\)/);
    assert.doesNotMatch(stdout, /Expose Weakness/);
    assert.match(stdout, /- Judgement of Wisdom: 90\.0% \(initial Kojay; reapplied by Texz\)/);
    assert.match(stdout, /- Faerie Fire: 100\.0% \(Bobbearpig, Downshift\)/);
    assert.doesNotMatch(stdout, /- Faerie Fire: .*Faerie Fire \(Feral\)/);
    assert.match(stdout, /- Demo Shout \/ Roar: 60\.0% \(Tankwar\)/);
    assert.match(stdout, /- Ironshield Potion: Tankwar 1, Offwar missing/);
    assert.match(stdout, /  - Effective Sunder applications: Tankwar 4, Offwar 1/);
    assert.match(stdout, /  - Effective IEA applications: Amilice 3/);
    assert.match(stdout, /  - Opening effective Sunder before IEA: Tankwar 2\/2, Offwar 1\/2; boss had 3 before IEA \(IEA at 2\.5s\)/);
    assert.match(stdout, /  - Effective Sunder applications: Tankwar 2 on Magtheridon; Tankwar 3 on Channeler Add/);
    assert.doesNotMatch(stdout, /Offwar 1 on Channeler Add/);
    assert.match(stdout, /  - Effective IEA applications: Amilice 3 on Magtheridon; Amilice 1 on Channeler Add/);
    assert.match(stdout, /  - Opening effective Sunder before IEA: Tankwar 1\/2; boss had 1 before IEA \(IEA at 2\.5s\)/);
    assert.match(stdout, /  - Armor debuff falloffs: Sunder Armor on Channeler Add at 5\.0s/);
    assert.doesNotMatch(stdout, /Sunder applications incl trash/);
    assert.match(stdout, /\*\*Trash Sunder \/ IEA Applications\*\*/);
    assert.match(stdout, /- Trash effective Sunder applications: Thcdatank 4 on Hidden Elite; Tankwar 2 on Lair Brute, Offwar 1 on Lair Brute; Thcdatank 2 on Vashj Add, Tankwar 1 on Vashj Add/);
    assert.doesNotMatch(stdout, /target#204/);
    assert.match(stdout, /- Trash effective IEA applications: Amilice 1 on Hidden Elite; Amilice 2 on Lair Brute; Amilice 2 on Vashj Add = 5 effective applications \/ 4 trash mobs/);
    assert.match(stdout, /\*\*Potion usage\*\*/);
    assert.match(stdout, /- High King Maulgar:/);
    assert.match(stdout, /  - No haste\/destruction potion: .*Zerodps/);
    assert.match(stdout, /  - Multiple potion uses: Goodflask 2x Haste/);
    assert.match(stdout, /  - Haste: Goodflask 2/);
    assert.match(stdout, /  - Destruction: none/);
    assert.doesNotMatch(stdout, /Dupecat, Dupecat/);
    const potionSection = stdout.split("**Potion usage**")[1].split("\n\n**Enchant flags**")[0];
    assert.doesNotMatch(potionSection, /Healz/);
    assert.doesNotMatch(potionSection, /Ghostdps/);
    assert.doesNotMatch(stdout, /\*\*Data warnings\*\*/);
    assert.doesNotMatch(stdout, /Tankmage 0/);
    assert.match(stdout, /- Magtheridon:/);
    assert.match(stdout, /  - No haste\/destruction potion: .*Zerodps/);
    assert.match(stdout, /  - Multiple potion uses: Goodflask 2x Haste/);
    assert.match(stdout, /  - Haste: Goodflask 2/);
    assert.match(stdout, /  - Destruction: Tankmage 1/);
    assert.match(stdout, /\*\*Green\/white gem flags\*\*/);
    assert.equal((stdout.match(/Dupecat: 3 green\/white gems - Hands \(Wastewalker Gloves\): Delicate Blood Garnet x2; Hands \(Wastewalker Gloves\): Practice Stone/g) || []).length, 1);
    assert.match(stdout, /\*\*Raid Deaths\*\*\n- High King Maulgar:\n  - Zerodps at 0:59 - killed by High King Maulgar Crushing Blow 4,200; last 5s damage: High King Maulgar Crushing Blow 4,200, High King Maulgar Melee 1,200; debuffs applied: Mortal Wound/);
    assert.match(stdout, /\n- Magtheridon:\n  - Goodflask, Offwar, Tankwar, Zerodps/);
    assert.doesNotMatch(stdout, /Magtheridon Shadow Bolt/);
    assert.doesNotMatch(stdout, /- Lady Vashj:/);
    assert.ok(stdout.indexOf("**Raid Deaths**") > stdout.indexOf("**Green/white gem flags**"));
    assert.equal(stdout.trim().endsWith("- Goodflask, Offwar, Tankwar, Zerodps"), true);
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
        RAID_AUDIT_DISABLE_DISK_CACHE: "1",
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
        RAID_AUDIT_DISABLE_DISK_CACHE: "1",
      },
      maxBuffer: 1024 * 1024,
    });

    assert.equal(analyzeCalls, 1);
    assert.match(stdout, /\*\*Windfury \/ Twisting\*\*/);
    assert.match(stdout, /\*\*Sapper usage\*\*/);
    assert.match(stdout, /\*\*Potion usage\*\*/);
  });
});

test("successful requests are persisted to disk across script runs", async () => {
  let remoteCalls = 0;
  let rejectRemote = false;
  const tmp = await mkdtemp(join(tmpdir(), "wcl-disk-cache-policy-"));
  const policyPath = join(tmp, "policy.json");
  const cachePath = join(tmp, "raid-audit-cache.sqlite");
  await writeFile(policyPath, JSON.stringify({
    name: "disk-cache-policy",
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
    remoteCalls += 1;

    if (rejectRemote) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "remote should not be called after cache warmup" }));
      return;
    }

    if (url.pathname === "/api/report/diskcachetest") {
      res.end(JSON.stringify({
        title: "disk cache test",
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
          name: "Cachelock",
          className: "Warlock",
          spec: "Destruction",
          role: "Caster",
          sourceId: 10,
          fightData: [fightData(1, { flask: "Flask of Pure Death" })],
          gearIssues: [],
          gearSnapshot: [],
        }],
      }));
      return;
    }

    if (url.pathname === "/api/analyze") {
      res.end(JSON.stringify({
        playerName: "Cachelock",
        playerClass: "Warlock",
        playerSpec: "Destruction",
        casts: [{ name: "Destruction Potion", guid: 28508, playerCasts: 1 }],
        abilities: [],
      }));
      return;
    }

    res.end(JSON.stringify({ auras: [], events: [] }));
  }, async (baseUrl) => {
    const args = [
      SCRIPT_PATH,
      "diskcachetest",
      "--markdown",
      "--policy",
      policyPath,
      "--skip-sappers",
    ];
    const env = {
      ...process.env,
      PARSEFORGE_BASE_URL: baseUrl,
      WARCRAFTLOGS_API_KEY: "",
      WCL_API_KEY: "",
      WARCRAFTLOGS_CLIENT_ID: "",
      WARCRAFTLOGS_CLIENT_SECRET: "",
      WCL_CLIENT_ID: "",
      WCL_CLIENT_SECRET: "",
      RAID_AUDIT_CACHE_PATH: cachePath,
    };

    const first = await execFile("node", args, { env, maxBuffer: 1024 * 1024 });
    assert.match(first.stdout, /\*\*WCL Raid Audit\*\*/);
    assert.ok(remoteCalls > 0);

    rejectRemote = true;
    remoteCalls = 0;
    const second = await execFile("node", args, { env, maxBuffer: 1024 * 1024 });

    assert.equal(remoteCalls, 0);
    assert.match(second.stdout, /\*\*WCL Raid Audit\*\*/);
    assert.match(second.stdout, /Cachelock/);
  });
});
