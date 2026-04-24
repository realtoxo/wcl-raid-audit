# WCL Raid Audit

Guild-ready World of Warcraft TBC raid auditing for leadership workflows.

This package wraps the `wcl-raid-audit` skill so it can be distributed as a Codex plugin and a Claude Code plugin. The core implementation stays shared: one skill bundle, one Node script, one test suite.

## What it does

Generate Discord-ready raid audit reports from Parseforge URLs or report codes, with Warcraft Logs used where Parseforge is not enough.

Current sections:

- missing or suboptimal consumes
- boss debuff uptime
- Windfury / twisting
- sapper usage
- enchant flags
- green gem flags

## Inputs

- Parseforge analysis URL
- Parseforge report code
- Warcraft Logs API credentials via environment variables

Example:

```bash
node plugins/wcl-raid-audit/skills/wcl-raid-audit/scripts/raid_audit.mjs \
  "https://parseforge.vercel.app/analyze/cPwzZJ7xNGf3M1Bv" \
  --markdown
```

## Sample output

```md
**WCL Raid Audit**
Source: https://parseforge.vercel.app/analyze/cPwzZJ7xNGf3M1Bv

**Boss Debuff Uptime**
- Gruul the Dragonkiller:
  - Warlock curses: Curse of the Elements 97.7% (Tombaldini); Curse of Doom 83.1% (Juggathot, Rizzerz); Curse of Agony 13.3% (Juggathot, Rizzerz)
  - IEA / Expose Armor: 74.9% (Ironlion)
  - Expose Weakness: 82.0% (Folgrím)
```

## Environment

Set Warcraft Logs credentials in your shell. Do not commit secrets.

Canonical variables:

```bash
export WARCRAFTLOGS_API_KEY=your_key_here
export WARCRAFTLOGS_CLIENT_ID=your_client_id_here
export WARCRAFTLOGS_CLIENT_SECRET=your_client_secret_here
```

The runtime also accepts `WCL_*` aliases, but keep docs and automation on the canonical `WARCRAFTLOGS_*` names.

See [.env.example](./.env.example).

## Codex packaging

Plugin root:

```text
plugins/wcl-raid-audit/
```

Relevant files:

- `plugins/wcl-raid-audit/.codex-plugin/plugin.json`
- `.agents/plugins/marketplace.json`

For local testing, point Codex at the plugin root or the repo marketplace file, depending on how you manage local plugins.

## Claude Code packaging

Plugin root:

```text
plugins/wcl-raid-audit/
```

Relevant files:

- `plugins/wcl-raid-audit/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

Typical local validation:

```bash
claude plugin validate .
```

Typical marketplace flow:

```bash
claude plugin marketplace add ./path/to/wcl-raid-audit
claude plugin install wcl-raid-audit@wcl-raid-audit
```

## Development

Validate the shared skill:

```bash
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/wcl-raid-audit/skills/wcl-raid-audit
```

Run tests:

```bash
node --test plugins/wcl-raid-audit/skills/wcl-raid-audit/tests/*.test.mjs
```

Run the audit directly:

```bash
node plugins/wcl-raid-audit/skills/wcl-raid-audit/scripts/raid_audit.mjs <parseforge-url-or-report-code> --markdown
```

## Scope and limitations

- Optimized for WoW TBC raid audits.
- Parseforge remains the primary source for consume, gear, and encounter context.
- WCL is used for features Parseforge cannot provide reliably, including overall Windfury metrics and boss debuff uptime.
- Missing WCL credentials will reduce report coverage, but the audit still runs with the Parseforge-backed sections.

## Security and privacy

- Do not commit live API credentials.
- Review sample reports before publishing them outside your guild.
- Prefer redacted screenshots and examples if you publish this outside your raid environment.
