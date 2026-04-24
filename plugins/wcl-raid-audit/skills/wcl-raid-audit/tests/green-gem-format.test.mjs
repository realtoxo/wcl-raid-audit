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

test("green gem section collapses duplicate item and gem pairs into counts", async () => {
  const { stdout } = await execFile("node", [SCRIPT_PATH, REPORT_CODE, "--markdown"], {
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });

  assert.match(
    stdout,
    /Shoulder \(Ragesteel Shoulders\): Inscribed Flame Spessarite x2/,
  );
  assert.match(
    stdout,
    /Hands \(Wastewalker Gloves\): Delicate Blood Garnet x2/,
  );
  assert.doesNotMatch(
    stdout,
    /Shoulder \(Ragesteel Shoulders\): Inscribed Flame Spessarite; Shoulder \(Ragesteel Shoulders\): Inscribed Flame Spessarite/,
  );
});
