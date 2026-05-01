import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(TEST_DIR, "..", "SKILL.md");

test("skill contract requires report-body-only output without unsolicited follow-up suggestions", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");

  assert.match(
    skill,
    /Return the report body directly\./,
  );
  assert.match(
    skill,
    /Omit action items, audit rules, empty sections, explanatory prose, and follow-up suggestions unless the user asks for them\./,
  );
});

test("skill contract describes green and white gem reporting", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");

  assert.match(skill, /Green\/white gem flags/);
  assert.match(skill, /List green\/white gem offenders/);
});

test("skill contract documents request caching and rate-limit retry behavior", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");

  assert.match(skill, /cached in memory/);
  assert.match(skill, /exponential backoff/);
});
