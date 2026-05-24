# Boss Buff / Debuff Audit Method

Use WCL v1 for boss buff/debuff uptime and tank potion/death audit details. Parseforge is still useful for roster/spec context, but not as the source of truth for boss-target debuff coverage.

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

3. Resolve boss active/hittable windows from positive friendly damage events against the boss actor:

```text
/v1/report/events/damage-done/{code}
  ?start=<fight.start_time>
  &end=<fight.end_time>
  &targetid=<boss_actor_id>
```

4. Use summed active/hittable windows as the denominator. Use each aura band's overlap with those active windows as the numerator when bands are available; fall back to `auras[].totalUptime` only when bands are missing.

## Why tables over events

- `tables/debuffs` returns merged uptime windows and total uptime.
- It is cleaner than reconstructing uptime from raw `events/debuffs`.
- Raw debuff events are still useful for edge-case attribution debugging, but should not be the default path.
- Boss encounter duration is not the right denominator for bosses that are untargetable, submerged, shielded, or delayed by pre-adds. Normalize boss debuff percentages to the boss actor's active/hittable time instead.

## Tracked debuffs

Current default policy tracks:

- all `Curse of ...` debuffs under `Warlock curses`
- `IEA / Expose Armor`, including time until first active uptime after the boss becomes hittable
- `Judgement of Wisdom`
- `Faerie Fire`, unioning regular `Faerie Fire` and `Faerie Fire (Feral)` uptime
- `Demo Shout / Roar`, unioning Demoralizing Shout and Demoralizing Roar uptime
- `Ironshield Potion` usage by the two most likely tanks on each killed boss
- effective `Sunder Armor` and `IEA / Expose Armor` application counts per encounter target
- first-active-window effective Sunder counts before IEA on the primary boss target
- armor debuff falloffs per encounter target, naming whether `Sunder Armor` or `Expose Armor` fell off
- trash effective Sunder and IEA application counts, with IEA applications shown against the total trash mob count
- raid deaths at the bottom of the report for killed encounters only, including a five-second damage/debuff snapshot when the encounter has three or fewer deaths

## Attribution

To attribute a specific debuff to source players, rerun the same endpoint with `abilityid=<spell_id>`. `totalUses` is the source application count.

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
**Boss Buff / Debuff Audit**
- Encounter:
  - Warlock curses: Curse of the Elements 97.7% (Tombaldini); Curse of Doom 83.1% (Juggathot, Rizzerz)
  - IEA / Expose Armor: 82.0% (Kojay; first at 4.2s)
  - Judgement of Wisdom: 94.0% (initial Kojay; reapplied by Texz)
  - Faerie Fire: 99.1% (Boomkintwo, Feraltank)
  - Demo Shout / Roar: 96.0% (Warriorone, Druidtank)
  - Ironshield Potion: Tankone 1, Tanktwo missing
  - Effective Sunder applications: Warriorone 7 on Encounter Boss; Warriortwo 3 on Encounter Add
  - Effective IEA applications: Rogueone 2 on Encounter Boss; Rogueone 1 on Encounter Add
  - Opening effective Sunder before IEA: Warriorone 2/2, Warriortwo 1/2; boss had 3 before IEA (IEA at 4.2s)
  - Armor debuff falloffs: Sunder Armor on Encounter Add at 18.4s

**Trash Sunder / IEA Applications**
- Trash effective Sunder applications: Warriorone 31 on Trash Target; Warriortwo 11 on Trash Target
- Trash effective IEA applications: Rogueone 12 on Trash Target = 12 effective applications / 37 trash mobs

**Raid Deaths**
- Encounter:
  - Playerone at 2:14 - killed by Encounter Boss Crushing Blow 8,421; last 5s damage: Encounter Boss Crushing Blow 8,421, Encounter Boss Melee 4,220; debuffs applied: Mortal Wound
- Encounter With More Than Three Deaths:
  - Playerone, Playertwo, Playerthree, Playerfour
```

## Notes

- Prefer the primary boss actor whose WCL enemy actor name matches the encounter name.
- For multi-source curse types, list all unique source names, but do not sum per-source uptime.
- For Judgement of Wisdom, use debuff events to identify the first applier and refresh/reapply sources.
- For IEA / Expose Armor, report the first active uptime delay from the first boss active/hittable window, not from `fight.start_time`.
- For opening Sunder tracking, count each warrior's effective Sunder Armor applications from the first boss active/hittable timestamp until IEA first becomes active. Display each warrior as `count/2` and include the total pre-IEA Sunder applications on the boss.
- For Sunder and IEA application counts, use `tables/debuffs` with `abilityid` and `totalUses`. These are effective debuff applications, not raw casts. Cast events may be used only to discover target IDs for multi-target encounters or hidden trash/add actors before querying effective debuff tables.
- For falloffs, use Sunder/IEA aura bands by target and ignore a Sunder ending when IEA replaces it immediately. Do not count natural target death or target inactivity as a falloff.
- For Demo Shout / Roar, combine `Demoralizing Shout` and `Demoralizing Roar` bands and report union uptime against boss active/hittable time.
- For Faerie Fire, combine regular `Faerie Fire` and `Faerie Fire (Feral)` bands and report union uptime against boss active/hittable time. Improved Faerie Fire is a talent modifier, not the debuff name to track separately.
- For Ironshield Potion, resolve expected tanks from Parseforge role/spec/name plus WCL damage taken ordering. Report the top two expected tanks by default, but mark Ironshield as not expected when those tanks' hostile damage taken is mostly non-physical.
- For raid deaths, skip wipes. If a killed encounter has more than three friendly deaths, list only the player names. For three or fewer deaths, provide a quick cause digest from the last five seconds of positive damage taken and applied debuffs; fall back to the unfiltered damage stream if WCL target-filtered damage events are incomplete.
- If WCL credentials are unavailable, omit the section and surface a clear note instead of inventing values.
