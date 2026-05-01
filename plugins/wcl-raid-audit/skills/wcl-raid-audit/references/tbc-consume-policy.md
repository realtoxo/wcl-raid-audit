# TBC Consume Policy Reference

Use this reference when auditing Parseforge reports for leadership.

The script loads `default-guild-policy.json` for encounter-by-encounter rules. Keep this file as the plain-English rationale behind that JSON policy.

## General Rules

- A flask counts as the flask choice and replaces both battle and guardian elixir slots.
- If no flask is present, evaluate battle/offensive elixir and guardian elixir separately.
- Low uptime is not a failure by default. Only flag 0% / fully missing food or weapon enhancement unless the user asks for uptime analysis.
- A real battle elixir is not Missing. It can be Suboptimal if it does not match the encounter expectation.
- During report generation, repeated network requests are cached in memory and 429 rate limits are retried with exponential backoff.

## Physical DPS

For Maulgar and Gruul:

- Expected: Flask of Relentless Assault.
- Elixir of Major Agility and Elixir of Major Strength are valid offensive consumes but are Suboptimal when the leadership standard is flasking.
- Missing means no flask and no battle/offensive elixir.
- Do not flag missing guardian elixir for melee/physical DPS.
- Physical DPS are expected to have Scroll of Agility IV/V or Scroll of Strength IV/V on self each encounter.

For Magtheridon:

- Expected: Elixir of Demonslaying.
- Elixir of Major Agility, Elixir of Major Strength, or Flask of Relentless Assault are Suboptimal for physical DPS on Magtheridon unless the user changes the policy.
- A flask is acceptable and should not be flagged for missing Elixir of Demonslaying.
- Missing means no Elixir of Demonslaying, flask, or other offensive/battle consume.
- Physical DPS are expected to have Scroll of Agility IV/V or Scroll of Strength IV/V on self each encounter.

## Hunters

- Treat hunters as physical DPS on Magtheridon: Elixir of Demonslaying is expected.
- On Maulgar and Gruul, Flask of Relentless Assault OR Elixir of Major Agility + a guardian/mana elixir is acceptable.
- Do not mark Major Agility + guardian/mana elixir as Suboptimal for hunters on non-demon fights.
- Hunters are expected to have Scroll of Agility IV/V on self.
- Active hunter pets are expected to have both Scroll of Agility IV/V and Scroll of Strength IV/V each encounter.

## Casters, Healers, and Mana Users

- Expected: appropriate flask OR battle elixir + guardian elixir.
- If they have a battle elixir but no flask and no guardian, mark Incomplete caster setup.
- Flask of Blinding Light is acceptable for spell-damage casters where appropriate, including Arcane Mage style roles.

## Protection Paladin and Spell-Tank Cases

- Flask of Blinding Light is acceptable for Protection Paladin.
- Do not flag Flask of Blinding Light as Suboptimal for Protection Paladin or clear spell-damage caster roles.
- Do not flag mage tank assignments for consumes or enchants on High King Maulgar.
- If a role classification looks wrong, surface it as a manual review note rather than making a hard accusation.

## Other Checks

- Food buffs are expected. Only flag fully missing food by default.
- Weapon enhancements, oils, stones, poisons, and similar enhancements are expected where applicable. Assume Windfury totem can cover melee main-hand expectations; only flag clean missing cases.
- Gear enchants are expected and missing enchant findings should be reported.
- Green and white quality gems should be reported with slot, item, and gem details.
- Do not flag healer cloak enchants.
- DPS are expected to use Haste Potion or Destruction Potion on each boss.
- Report potion usage by encounter with the DPS players who used neither potion first, followed by compact Haste and Destruction user summaries.
- Call out DPS players who used 2+ Haste Potions or 2+ Destruction Potions on the same encounter.
- Sapper usage is encouraged. Report only users by type and count unless the user asks for non-users or encounter-level detail.

## Boss Debuffs

- Track curse uptime and Expose Weakness uptime.
- Track Judgement of Wisdom uptime on each boss.
- For Judgement of Wisdom, include the initial applier and whether it was reapplied/refreshed by another player.
- Do not track IEA / Expose Armor uptime by default.
