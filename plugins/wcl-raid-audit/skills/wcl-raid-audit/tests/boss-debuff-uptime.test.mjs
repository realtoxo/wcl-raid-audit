import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(TEST_DIR, "..");
const SCRIPT_PATH = resolve(SKILL_DIR, "scripts/raid_audit.mjs");
const REPORT_CODE = "cPwzZJ7xNGf3M1Bv";

test("boss debuff uptime section reports curse and expose armor uptimes", async () => {
  const { stdout } = await execFile("node", [SCRIPT_PATH, REPORT_CODE, "--markdown"], {
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });

  assert.match(stdout, /\*\*Boss Debuff Uptime\*\*/);
  assert.match(
    stdout,
    /- Warlock curses: Curse of the Elements 97\.7% \(Tombaldini\); Curse of Doom 83\.1% \(Juggathot, Rizzerz\); Curse of Agony 13\.3% \(Juggathot, Rizzerz\)/,
  );
  assert.match(stdout, /- IEA \/ Expose Armor:/);
  assert.doesNotMatch(stdout, /Expose Weakness/);
  assert.match(
    stdout,
    /- Judgement of Wisdom:/,
  );
});
