# Boss Debuff Uptime Method

Use WCL v1 for boss debuff uptime. Parseforge is still useful for roster/spec context, but not as the source of truth for boss-target debuff coverage.

## Primary method

1. Resolve encounter windows and boss actor IDs from:

```text
/v1/report/fights/{code}
```

2. For each encounter, fetch boss debuff uptime from:

```text
/v1/report/tables/debuffs/{code}
  ?start=<fight.start_time>
  &end=<fight.end_time>
  &targetid=<boss_actor_id>
  &by=target
```

3. Use `totalTime` as the denominator and `auras[].totalUptime` as the numerator.

## Why tables over events

- `tables/debuffs` already returns merged uptime windows and total uptime.
- It is cleaner than reconstructing uptime from raw `events/debuffs`.
- Raw events are still useful for edge-case attribution debugging, but should not be the default path.

## Tracked debuffs

Current default policy tracks:

- all `Curse of ...` debuffs under `Warlock curses`
- `IEA / Expose Armor`
- `Judgement of Wisdom`

## Attribution

To attribute a specific debuff to source players, rerun the same endpoint with `abilityid=<spell_id>`.

Example:

```text
/v1/report/tables/debuffs/{code}
  ?start=<fight.start_time>
  &end=<fight.end_time>
  &targetid=<boss_actor_id>
  &by=target
  &abilityid=26866
```

This returns per-source rows for that debuff. Use those rows only for source names. Keep the overall uptime percentage from the aggregate query.

## Output shape

Render a single section:

```md
**Boss Debuff Uptime**
- Encounter:
  - Warlock curses: Curse of the Elements 97.7% (Tombaldini); Curse of Doom 83.1% (Juggathot, Rizzerz)
  - IEA / Expose Armor: 82.0% (Kojay)
  - Judgement of Wisdom: 94.0% (initial Kojay; reapplied by Texz)
```

## Notes

- Prefer the primary boss actor whose WCL enemy actor name matches the encounter name.
- For multi-source curse types, list all unique source names, but do not sum per-source uptime.
- For Judgement of Wisdom, use debuff events to identify the first applier and refresh/reapply sources.
- If WCL credentials are unavailable, omit the section and surface a clear note instead of inventing values.
