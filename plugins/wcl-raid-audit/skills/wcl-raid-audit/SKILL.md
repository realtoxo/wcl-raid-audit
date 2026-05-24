---
name: wcl-raid-audit
description: Create officer-ready World of Warcraft TBC raid audit reports from Parseforge URLs or report codes and, when needed, Warcraft Logs data. Use when asked for Discord-ready leadership audits of raid logs, missing or suboptimal consumes, missing enchants, sappers, Windfury/twisting, boss buff/debuff uptime, green gems, or other raid compliance issues.
---

# WCL Raid Audit

## Quick Start

1. Extract the Parseforge report code from the user input.
2. Run the bundled script against all killed boss fights unless the user asks for specific fights:

```bash
node ~/.codex/skills/wcl-raid-audit/scripts/raid_audit.mjs "<parseforge-url-or-report-code>" --markdown
```

3. Use the markdown output as the report body. Rewrite only when the user asks for a different tone or structure.
4. Update persistent rules in `references/default-guild-policy.json` when the user wants policy changes to stick.

## Read These Files Only When Needed

- Read `references/default-guild-policy.json` when changing raid expectations or checking how the script should label `Missing`, `Suboptimal`, or `Incomplete caster setup`.
- Read `references/tbc-consume-policy.md` when class- or encounter-specific consume expectations are disputed.
- Read `references/windfury-cpm-method.md` when changing Windfury metrics, WCL usage, or combat-time denominator rules.
- Read `references/boss-debuff-uptime.md` when changing warlock curse, IEA / Expose Armor, Faerie Fire, Demo Shout / Roar, or other boss buff/debuff uptime tracking.

## Workflow

- Prefer the script output over manual reconstruction.
- Use Parseforge `/api/cla` as the consume source of truth; do not judge consumes from `/api/raid-overview` alone.
- Keep the report issue-focused by default:
  - title + source
  - encounter issue sections
  - `Boss Buff / Debuff Audit`
  - `Trash Sunder / IEA Applications`
  - `Windfury / Twisting`
  - `Sapper usage`
  - `Enchant flags`
  - `Green/white gem flags`
  - `Raid Deaths`
- For raid audit reports, answer with a single fenced markdown code block containing only the report body.
- Return the report body directly. Omit action items, audit rules, empty sections, explanatory prose, and follow-up suggestions unless the user asks for them.
- The code block is a transport wrapper for Codex copy/paste; do not include explanation before or after it.
- The user copies the code block contents into Discord so the literal markdown markers are preserved.
- Treat real but wrong consumes as `Suboptimal`, not `Missing`.
- List green/white gem offenders with `slot (item): gem` details and collapse repeated identical pairs into `xN`.

## WCL Rules

- Read WCL credentials from environment variables only. Primary variables:
  - `WARCRAFTLOGS_API_KEY`
  - `WARCRAFTLOGS_CLIENT_ID`
  - `WARCRAFTLOGS_CLIENT_SECRET`
- The script also accepts `WCL_*` aliases.
- Use WCL only for metrics Parseforge cannot provide reliably, such as boss buff/debuff timing normalized to boss active/hittable windows, effective Sunder/IEA debuff application counts, armor debuff falloffs, Ironshield Potion usage, raid death snapshots, overall trash-inclusive WF/Grace CPM, and WF gap detection.
- Do not use full report wall-clock time as the denominator for overall Windfury CPM. Use summed combat time across pulls.
- Network requests are cached in memory and persisted in a local SQLite database across runs. By default the cache lives at `${XDG_CACHE_HOME:-~/.cache}/wcl-raid-audit/raid-audit-cache.sqlite`; set `RAID_AUDIT_CACHE_PATH` to override it or `RAID_AUDIT_DISABLE_DISK_CACHE=1` to use memory-only caching. Rate-limited responses retry with exponential backoff and progress messages on stderr.

## Commands

```bash
node scripts/raid_audit.mjs <parseforge-url-or-report-code> --markdown
node scripts/raid_audit.mjs <parseforge-url-or-report-code> --json
node scripts/raid_audit.mjs <parseforge-url-or-report-code> --fight 12 --markdown
node scripts/raid_audit.mjs <parseforge-url-or-report-code> --policy references/default-guild-policy.json --markdown
node scripts/raid_audit.mjs <parseforge-url-or-report-code> --include-tanks --markdown
```

Use `--include-tanks` only when leadership wants tanks judged against the physical DPS consume policy.

## Validation

- Run:

```bash
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py ~/.codex/skills/wcl-raid-audit
```

- When changing report formatting or skill contract behavior, run:

```bash
node --test ~/.codex/skills/wcl-raid-audit/tests/*.test.mjs
```

- Forward-test substantial revisions with a fresh subagent using a normal user-style prompt, not a prompt that explains what you changed.
