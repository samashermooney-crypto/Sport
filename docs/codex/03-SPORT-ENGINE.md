# 03 — Sport Engine

The sport engine is what makes Athlentry work for "any sport". It lives in `shared/src/sport/` (pure TypeScript, no I/O, 100% unit-tested) and is used by the server for validation/computation and by the web app for forms and display.

## 1. SportProfile schema

```ts
type SportProfile = {
  key: string;                    // "soccer", "swimming"
  name: I18nText;                 // { en: "Soccer", es: "Fútbol" }
  category: "team" | "individual" | "hybrid"; // hybrid = individual results that also roll up to team scores (swim, track, wrestling duals, gymnastics teams)
  participantTerms: { athlete: I18nText; athletes: I18nText; team: I18nText; coach: I18nText; contest: I18nText; practice: I18nText; venue: I18nText };
      // e.g. volleyball contest = "Match", swimming contest = "Meet", wrestling contest = "Dual"/"Tournament", venue = "Field"|"Court"|"Rink"|"Pool"|"Mat"
  contestFormats: ContestFormatConfig[];   // one or more; a program picks one as default, a contest may pick another
  positions: { key: string; label: I18nText; group?: string }[];  // may be empty
  maxPositionsPerAthlete: number;
  roster: { defaultMax: number; defaultMin: number; onFieldCount?: number; jerseyNumbers: "required" | "optional" | "none"; jerseyRange?: [number, number] };
  stats: StatDefinition[];          // optional per-athlete/team stats captured per contest
  minimumPlayRule?: { unit: "periods" | "minutes" | "innings"; defaultRequirement: number }; // rec leagues
  ageGroup: AgeGroupConfig;         // default method, overridable per org/program
  defaultDurations: { contestMinutes: number; practiceMinutes: number; bufferMinutes: number }; // buffer = field turnover
  spaceKinds: SpaceKind[];          // suitable space kinds, e.g. ["field"], ["pool","lanes"]
  officials: { key: string; label: I18nText; required: boolean }[];
  evaluationRubric: RubricCriterion[]; // default tryout rubric
  uniformItems: { key: string; label: I18nText; sizes: string[] }[];
  defaultStandings?: StandingsConfig;
  skillLevels?: { name: I18nText; skills: I18nText[] }[]; // academy sports: e.g. swim levels, gymnastics levels, belt ranks
  disciplineTypes: { key: string; label: I18nText; defaultSuspensionGames: number }[]; // yellow/red cards, technical fouls, ejections
};
```

Every field is validated by Zod. Org profiles (`sport_profiles.profile`) use the same schema; the editor UI exposes all of it with sensible grouping. Profiles are versioned; contests record `profile_version`.

## 2. Contest formats and results

```ts
type ContestFormatConfig =
  | { format: "head_to_head_score"; periods: PeriodConfig; scoreLabel: I18nText; allowTie: boolean; overtime?: { label: I18nText; maxPeriods?: number }; shootout?: boolean;
      scoreDirection: "higher_wins"; mercyRule?: { margin: number; afterPeriod: number } }
  | { format: "head_to_head_sets"; bestOf: number; pointsPerSet: number; decidingSetPoints: number; winBy: number; cap?: number; scoringUnit: "points" | "games"; tiebreakAt?: number }
  | { format: "head_to_head_bout"; methods: { key: string; label: I18nText; teamPoints?: number }[]; periods: PeriodConfig; weightClasses?: string[] }
  | { format: "multi_timed"; events: EventDefinition[]; lowerIsBetter: true; precision: "hundredths" | "tenths" | "seconds"; heats: boolean; lanes: number; placePoints?: number[] }
  | { format: "multi_measured"; events: EventDefinition[]; lowerIsBetter: boolean; unit: "m" | "cm" | "ft_in" | "strokes" | "points" | "pins"; attempts?: number; placePoints?: number[] }
  | { format: "judged"; apparatusOrRoutines: EventDefinition[]; panel: { judges: number; dropHighLow: boolean; components: { key: string; label: I18nText; max?: number }[]; combine: "sum" | "average" }; placePoints?: number[] }
  | { format: "placement_only"; events?: EventDefinition[]; placePoints?: number[] };

type PeriodConfig = { label: I18nText; count: number; minutes?: number }; // "Half"x2, "Quarter"x4, "Period"x3, "Inning"x6/7/9
type EventDefinition = { key: string; label: I18nText; distance?: number; unit?: string; relay?: boolean; ageGenderSplit?: boolean };
```

**Result entry and computation rules (implement in `shared/src/sport/results.ts`):**

- `head_to_head_score`: per-period scores optional; total required. Winner = higher total; tie allowed only if `allowTie` and not a bracket match (bracket matches require overtime/shootout result recorded in `score_detail.shootout`). Forfeits record `forfeit_win/forfeit_loss` with configurable forfeit score (standings config).
- `head_to_head_sets`: validate each set (reaches target, win-by, cap; deciding set uses `decidingSetPoints`). Match winner = first to `ceil(bestOf/2)` sets. Store sets won, set points for/against for tiebreakers (set ratio, point ratio).
- `head_to_head_bout`: winner + method (e.g. wrestling fall/tech fall/major decision/decision; judo ippon/waza-ari; BJJ submission/points; fencing touches). Team dual score = sum of `teamPoints` by method.
- `multi_timed`: time stored as integer milliseconds; display per precision. Places by ascending time; equal times share the place and the next place is skipped (1,2,2,4). DQ/DNF/DNS unplaced. `placePoints` (e.g. `[6,4,3,2,1]` individual; relays configurable separately) roll up to team scores.
- `multi_measured`: best of attempts; direction by `lowerIsBetter` (golf strokes lower; distance higher). Same tie/place rules.
- `judged`: per judge per component scores; if `dropHighLow` and judges ≥ 4, drop one highest and one lowest per component; `combine` sum or average; final = sum of components (e.g. gymnastics D + E − penalties via a component with negative sign `penalty`). Places by descending final.
- `placement_only`: record place directly (cross-country with chip results imported, cheer/dance competitions with external scoring).

## 3. Age groups and eligibility

```ts
type AgeGroupConfig =
  | { method: "age_on_date"; monthDay: "MM-DD"; yearBasis: "season_start" | "season_end" | "calendar_year_of_start" }
  | { method: "birth_year"; label: "U{n}" | "{n}U" | "{year}"; seasonYearBasis: "season_start" | "season_end" }
  | { method: "school_grade"; schoolYearCutoff: "MM-DD" }
  | { method: "none" };
```

Implement in `shared/src/sport/age.ts` with exhaustive tests including leap-day birthdays and season spanning two calendar years:

- `age_on_date`: age in whole years on the given month/day of the basis year. Used by leagues that publish an "age determination date" (the org configures the actual date; do not hard-code any governing body's rule).
- `birth_year`: `n = seasonYear − birthYear`; label formatted per config (`U12`, `12U`, or `2014`). For a season spanning 2026–27 with `season_end` basis, a 2015 birth year is U12.
- `school_grade`: `grade = 12 − (graduationYear − schoolYearEndYear)` where the school year containing the program start date ends in `schoolYearEndYear` (determined by the cutoff month-day). K = 0, Pre-K = −1. Display `K`, `1st`, …, `12th`. Families enter graduation year ("Class of 2033"), never the grade.
- Eligibility check returns structured reasons (`AGE_BELOW_MIN`, `AGE_ABOVE_MAX`, `GRADE_OUT_OF_RANGE`, `GENDER_MISMATCH`, `MEMBERSHIP_REQUIRED`, `RETURNING_ONLY`, `INVITE_ONLY`, `RESIDENCY`, `HOUSEHOLD_LIMIT`), each with a family-readable message. Staff may override with a recorded reason ("play-up approved"); overrides are audited and shown on the registration.

## 4. Stats

```ts
type StatDefinition = { key: string; label: I18nText; abbreviation: string; level: "athlete" | "team"; valueType: "integer" | "decimal" | "time_ms" | "percentage";
  aggregate: "sum" | "max" | "min" | "average"; derived?: { formula: "ratio" | "percentage"; numerator: string; denominator: string }; public: boolean };
```

Stats are optional per program (`ProgramSettings.statsEnabled`, list of enabled keys). Leaders boards per program/division; youth programs default `public: false` for athlete stats (only team and guardians see them). No stat entry is required to finalize a result.

## 5. Standings

```ts
type StandingsConfig = {
  basis: "match" | "set" | "points_table";       // most sports: match
  points: { win: number; overtimeWin: number; tie: number; overtimeLoss: number; loss: number; forfeitWin: number; forfeitLoss: number; forfeitDeduction: number };
  rankBy: "points" | "win_percentage" | "wins";
  winPercentageTieValue: 0.5 | 0;                   // ties count as half a win or not
  forfeitScore: { winner: number; loser: number }; // e.g. soccer 1–0 or 3–0; configurable
  maxGoalDifferential?: number;                     // rec leagues cap differential (e.g. 5) to discourage running up scores
  tiebreakers: Tiebreaker[];                        // ordered, 1..8
  include: { stages: ContestStage[]; crossDivision: boolean };
  columns: StandingsColumn[];
  publicVisibility: "public" | "members" | "hidden"; // many rec U8 programs hide standings
};
type Tiebreaker = "head_to_head_points" | "head_to_head_differential" | "wins" | "fewest_losses" | "differential" | "scored" | "fewest_allowed"
  | "set_ratio" | "point_ratio" | "sets_won" | "fewest_forfeits" | "fewest_discipline_points" | "coin_toss_manual";
```

Algorithm in `20-ALGORITHMS.md §7` (multi-team ties use a mini-table among tied teams and restart the tiebreaker list when a subgroup separates).

## 6. Built-in sport templates (seed all of these)

Implement each as a TypeScript file in `shared/src/sport/templates/`. Values below are defaults the org can edit; they are not claims about any governing body's rules. Where a value is uncertain, choose a reasonable default and keep it editable.

| key | category | default format | periods | positions (short) | roster default max | age method default | notable |
|---|---|---|---|---|---|---|---|
| soccer | team | h2h_score, tie allowed | Half ×2 | GK, DEF, MID, FWD | 18 | birth_year (U{n}, season_end) | min-play, cards (yellow/red), field sizes by age |
| futsal | team | h2h_score | Half ×2 | GK, Field | 14 | birth_year | accumulated fouls stat |
| basketball | team | h2h_score, no tie, OT | Quarter ×4 | PG, SG, SF, PF, C | 12 | school_grade | technical fouls, fouls stat |
| baseball | team | h2h_score, no tie (rec allows tie) | Inning ×6 | P, C, 1B, 2B, 3B, SS, LF, CF, RF, DH | 14 | age_on_date | pitch count stat + rest-day rule setting, run-rule (mercy) |
| softball | team | h2h_score | Inning ×7 | same as baseball + DP/FLEX | 15 | age_on_date | run-rule |
| tball | team | placement_only (no score) | Inning ×3 | none | 12 | age_on_date | standings hidden by default |
| volleyball | team | h2h_sets best of 3, 25 pts, deciding 15, win by 2 | — | S, OH, MB, OPP, L, DS | 12 | age_on_date (club age), editable | set/point ratio tiebreakers |
| beach_volleyball | team (pairs) | h2h_sets best of 3, 21/15 | — | none | 2 | age_on_date | |
| flag_football | team | h2h_score | Half ×2 | QB, C, WR, RB, DEF | 12 | school_grade | |
| tackle_football | team | h2h_score | Quarter ×4 | QB, RB, WR, TE, OL, DL, LB, DB, K | 40 | age_on_date + weight option (custom field) | concussion emphasis |
| ice_hockey | team | h2h_score, OT + shootout | Period ×3 | C, LW, RW, D, G | 20 | birth_year ({n}U) | penalty minutes stat, suspensions |
| roller_hockey | team | h2h_score | Half ×2 | F, D, G | 14 | birth_year | |
| field_hockey | team | h2h_score | Quarter ×4 | GK, DEF, MID, FWD | 18 | school_grade | cards (green/yellow/red) |
| lacrosse | team | h2h_score | Quarter ×4 | A, M, D, G, LSM, FO | 25 | birth_year (grad-year option) | |
| rugby | team | h2h_score, bonus points option | Half ×2 | Forwards 1–8, Backs 9–15 | 26 | school_grade | bonus-point standings preset |
| water_polo | team | h2h_score | Quarter ×4 | GK, Field | 15 | birth_year | exclusions stat |
| ultimate | team | h2h_score (to 15) | Half ×2 | Handler, Cutter | 20 | school_grade | spirit score stat |
| handball | team | h2h_score | Half ×2 | GK, LW, LB, CB, RB, RW, P | 16 | birth_year | |
| cricket | team | h2h_score (runs) with detail (wickets, overs) | Innings ×2 | Batter, Bowler, All-rounder, WK | 15 | age_on_date | net run rate tiebreaker added |
| tennis | individual/hybrid | h2h_sets best of 3, games to 6, tiebreak at 6–6 | — | Singles, Doubles | 12 | age_on_date | dual-match team scoring by lines |
| pickleball | individual | h2h_sets best of 3, 11 pts, win by 2 | — | Singles, Doubles | 2 | none | skill-rating custom field |
| badminton | individual | h2h_sets best of 3, 21, cap 30 | — | Singles, Doubles | 2 | age_on_date | |
| table_tennis | individual | h2h_sets best of 5, 11, win by 2 | — | — | 2 | age_on_date | |
| swimming | hybrid | multi_timed (hundredths), heats, 8 lanes | — | Stroke specialties | 200 | age_on_date | events: 25/50/100/200 free, back, breast, fly, IM, relays; place points 6-4-3-2-1 (individual) / 8-4-2 (relay) editable; skill levels for lessons |
| diving | individual | judged (5–7 judges, drop high/low, × degree of difficulty) | — | — | 30 | age_on_date | component "dd" multiplier |
| track_field | hybrid | multi_timed + multi_measured | — | Sprints, Distance, Jumps, Throws | 80 | age_on_date | field events use measured; place points |
| cross_country | hybrid | multi_timed; team score = sum of top 5 places (lower wins) | — | — | 40 | school_grade | team scoring variant "sum_of_places_top_n" |
| gymnastics | hybrid | judged (D + E − penalty) per apparatus | — | Apparatus: VT, UB, BB, FX (women); FX, PH, SR, VT, PB, HB (men) | 30 | age_on_date | levels 1–10 + Xcel skill levels; all-around = sum |
| cheer | team | judged (routine score) or placement_only | — | Flyer, Base, Backspot, Tumbler | 36 | age_on_date | |
| dance | team/individual | judged or placement_only | — | — | 30 | none | recital events |
| figure_skating | individual | judged | — | — | 20 | age_on_date | skill levels |
| wrestling | hybrid | h2h_bout (fall 6, tech fall 5, major 4, decision 3, forfeit 6), weight classes | Period ×3 | weight classes | 40 | school_grade | dual team score; tournament brackets |
| martial_arts | individual | h2h_bout (points) + placement_only (forms) | Round ×1–3 | — | 50 | none | belt ranks as skill levels; testing events |
| judo_bjj | individual | h2h_bout (ippon/submission/points) | Round ×1 | weight classes | 50 | age_on_date | belt ranks |
| boxing | individual | h2h_bout (decision/stoppage) | Round ×3 | weight classes | 30 | age_on_date | |
| fencing | individual/hybrid | h2h_bout (touches to 5/15) | Period ×3 | Foil, Épée, Sabre | 30 | birth_year | pools → DE bracket |
| golf | individual/hybrid | multi_measured (strokes, lower better) | Holes 9/18 | — | 12 | school_grade | team score = best N of M |
| bowling | individual/hybrid | multi_measured (pins, higher better), 3 games | — | — | 10 | age_on_date | handicap custom setting |
| archery | individual | multi_measured (points) | Ends | — | 20 | age_on_date | |
| cycling | individual | multi_timed | — | — | 30 | age_on_date | |
| skiing_snowboard | individual | multi_timed (runs combined) | Runs ×2 | Disciplines | 30 | birth_year | |
| rowing | team/individual | multi_timed | — | Seats 1–8, Cox | 30 | age_on_date | |
| esports | team | h2h_sets (best of N maps/games) | — | game-specific roles | 10 | school_grade | |
| chess | individual | h2h_bout (win/draw/loss 1/0.5/0) | — | Boards | 10 | school_grade | Swiss pairing out of scope; round robin supported |
| climbing | individual | multi_measured (tops/zones/attempts) | — | — | 30 | birth_year | |
| general_activity | individual | placement_only / none | — | — | 100 | none | camps, clinics, fitness, multi-sport |

For each template also provide: default evaluation rubric (4–6 criteria relevant to the sport; e.g. soccer: first touch, passing, dribbling, defending, game IQ, athleticism; goalkeeper-specific criteria flagged position-specific), uniform items (jersey, shorts, socks; swim: cap, suit; hockey: home/away jersey, socks; martial arts: uniform, belt), official positions, discipline types, and `participantTerms`.

## 7. Where sport-awareness must show up in the product

Every place below reads the program's sport profile instead of hard-coded text or logic. Write a test that renders each screen with at least `soccer`, `volleyball`, `swimming`, `wrestling` and `gymnastics` profiles:

- Terminology in UI (Game/Match/Meet/Dual/Competition; Field/Court/Pool/Mat; Coach/Instructor/Sensei).
- Program creation wizard defaults (age method, durations, roster sizes, standings visibility).
- Roster positions, jersey number rules, uniform add-on sizes.
- Space suitability in scheduling and generator buffers.
- Result entry forms (score/sets/bout/time/marks/judges) and result display.
- Standings/rankings and tiebreakers; meet team scores; brackets for bouts and sets.
- Stats entry and leaderboards.
- Evaluation rubric defaults.
- Official positions required per contest.
- Discipline types and suspension defaults.
- Skill levels for academy mode.
