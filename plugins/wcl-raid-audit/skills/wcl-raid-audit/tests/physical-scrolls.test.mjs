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

function consumables(scrollNames = []) {
  return {
    flask: slot("Flask of Relentless Assault"),
    battleElixir: slot(),
    guardianElixir: slot(),
    food: slot("Well Fed"),
    weaponEnhancement: slot("Weapon Enhancement (detected on gear)"),
    scrolls: scrollNames.map((name) => slot(name)),
  };
}

function player({ name, className, spec, sourceId, scrolls }) {
  return {
    name,
    className,
    spec,
    role: "Physical",
    sourceId,
    fightData: [{ fightId: 1, consumables: consumables(scrolls) }],
    gearIssues: [],
    gearSnapshot: [],
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

test("physical scroll audit flags missing self scrolls and hunter pet scrolls per encounter", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "wcl-scroll-policy-"));
  const policyPath = join(tmp, "policy.json");
  await writeFile(policyPath, JSON.stringify({
    name: "test-policy",
    version: 1,
    reportTitle: "WCL Raid Audit",
    reportRules: [],
    general: {
      food: { expected: true },
      weaponEnhancement: { expected: true },
      physicalScrolls: { expected: true },
      casterMana: { acceptAnyFlask: true, requiresBattleAndGuardianIfNoFlask: true },
    },
    trackedDebuffs: { groups: [] },
    encounters: [
      {
        name: "Gruul the Dragonkiller",
        match: "gruul",
        physicalDps: {
          expectedFlasks: ["Flask of Relentless Assault"],
          hunter: {
            expectedText: "Flask of Relentless Assault",
            acceptableFlasks: ["Flask of Relentless Assault"],
          },
        },
      },
    ],
  }));

  await withMockServer((req, res) => {
    const url = new URL(req.url, "http://mock.local");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/report/scrolltest") {
      res.end(JSON.stringify({
        title: "scroll test",
        owner: "tester",
        zone: "Gruul's Lair",
        fights: [{ id: 1, name: "Gruul the Dragonkiller", kill: true, encounterID: 50650, duration: 60000 }],
      }));
      return;
    }

    if (url.pathname === "/api/cla") {
      res.end(JSON.stringify({
        fights: [{ id: 1, name: "Gruul the Dragonkiller" }],
        players: [
          player({ name: "Goodwar", className: "Warrior", spec: "Fury", sourceId: 1, scrolls: ["Scroll of Strength V"] }),
          player({ name: "Norogue", className: "Rogue", spec: "Combat", sourceId: 2, scrolls: [] }),
          player({ name: "Petmiss", className: "Hunter", spec: "BeastMastery", sourceId: 3, scrolls: ["Scroll of Intellect V"] }),
        ],
      }));
      return;
    }

    if (url.pathname === "/api/analyze") {
      res.end(JSON.stringify({ casts: [], abilities: [] }));
      return;
    }

    if (url.pathname === "/report/fights/scrolltest") {
      res.end(JSON.stringify({
        fights: [{ id: 1, name: "Gruul the Dragonkiller", start_time: 1000, end_time: 61000 }],
        friendlies: [{ id: 3, name: "Petmiss", type: "Hunter", fights: [{ id: 1 }] }],
        friendlyPets: [{ id: 30, name: "Bitey", type: "Pet", petOwner: 3, fights: [{ id: 1, instances: 1 }] }],
        enemies: [],
      }));
      return;
    }

    if (url.pathname === "/report/tables/buffs/scrolltest" && url.searchParams.get("targetid") === "30") {
      res.end(JSON.stringify({
        totalTime: 60000,
        auras: [{ name: "Scroll of Agility V", guid: 33081, totalUptime: 60000 }],
      }));
      return;
    }

    res.end(JSON.stringify({ auras: [], events: [] }));
  }, async (baseUrl) => {
    const { stdout } = await execFile("node", [
      SCRIPT_PATH,
      "scrolltest",
      "--markdown",
      "--skip-sappers",
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

    assert.doesNotMatch(stdout, /Goodwar: .*scroll/i);
    assert.match(stdout, /Norogue: \*\*Missing\*\* - expected Scroll of Agility IV\/V or Scroll of Strength IV\/V; no matching self scroll recorded/);
    assert.match(stdout, /Petmiss: \*\*Missing\*\* - expected Scroll of Agility IV\/V on self; no matching self scroll recorded/);
    assert.match(stdout, /Petmiss: \*\*Missing\*\* - pet Bitey expected Scroll of Agility IV\/V and Scroll of Strength IV\/V; missing Scroll of Strength IV\/V/);
  });
});
