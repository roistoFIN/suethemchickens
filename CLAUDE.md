# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Sue Them Chickens" — a multiplayer, server-authoritative business strategy game. Players
run companies for 120s rounds, deploy decisions from a shared, admin-editable decision library, sue
each other over risky moves, buy up rivals' shares to force a hostile takeover, and get
eliminated the instant their cash goes negative or another player crosses 50% ownership of
their company. Last player standing wins. Real-time via Socket.IO; React/Vite client;
Express/Prisma/PostgreSQL server; npm workspaces monorepo (`client`, `server`, `shared`).

The full design spec — every game mechanic, phase flow, socket event, and Zustand store
method — is documented in `README.md`. Read it before making non-trivial changes; this
file only covers what the README doesn't (commands and architecture orientation).

**There is no separate design-spec document for game math anymore.** A
`definitionDocumentation/FORMULAS.md` used to be the source of truth but has been retired:
the pure, scalar, named-input math it described (competitiveness, P&L, balance sheet,
legal-risk/risk-gauge formulas) now lives in Postgres (`Formula` table, seeded from
`server/src/engine/defaultFormulas.ts` — that file is the closest thing to a fixed
reference for the *default* expressions, though `/admin` can change what's actually
running) and is editable live from `/admin`; the *procedural* half (execution order,
depreciation ledger, bankruptcy/merger waterfall, FIFO tie-breaking) was never
data-driven and lives directly in the code that implements it — `gameLoop.ts`'s
`resolveTurn` (the numbered `// ── Step N ──` comments are the current, accurate
execution order) and `calcEngine.ts`/`decisionEngine.ts`/`legalEngine.ts`'s own doc
comments. Trust those inline comments and this file over any memory of the old
document — the decision library/config are similarly DB-backed, not static files; see
*"Decisions/config are DB-backed"* and *"Formulas are DB-backed"* below.

## Working conventions

**If a prompt leaves anything open or underspecified, ask for the details — do not
guess.** This includes ambiguous scope ("fix the modal" when there are several modals),
unclear intent (does "remove X" mean delete the code or just hide it in the UI?),
unstated defaults (a new admin-editable number with no default given), or a request that
could reasonably be implemented two different ways with materially different behavior.
Guessing and building the wrong thing costs more of the user's time than asking up front;
a wrong assumption silently shipped is worse than a clarifying question. Use judgment for
trivial details with an obvious answer from context/convention, but default to asking
when genuinely unsure.

**After every change, write tests for it and update documentation** — README.md and/or
this file, whichever actually describes the area touched.

## Commands

```bash
# Install (run once, from repo root — this is an npm workspaces monorepo)
npm install

# Dev servers (client :5173, server :3001), both with hot reload
npm run dev
npm run dev:server   # server only
npm run dev:client   # client only

# Type-check / lint everything
npm run type-check
npm run lint

# Build
npm run build           # both packages
npm run build:client
npm run build:server

# Backend unit tests (Vitest, no DB needed — GameLoop is pure, other suites mock Prisma)
npm test --workspace=server
npm test --workspace=server -- calcEngine        # single file/pattern

# Frontend unit tests (Vitest — Zustand stores, GamePhase utils)
npm --workspace=client exec vitest run
npm --workspace=client exec vitest run gameStore  # single file/pattern

# API interface tests — needs Docker (spins up real Postgres via testcontainers,
# runs `prisma migrate deploy`); verifies actual socket event contracts + Prisma schema
npm run test:api
npm run test:api:watch

# E2E tests (Playwright; needs the client dev server + a running backend)
npm run test:e2e
npm run test:e2e:ui       # UI mode
npm run test:e2e:headed   # visible browser
npx playwright test tests/e2e/gamePhase.spec.ts   # single spec

# Everything (API + E2E)
npm run test:all

# Database (Prisma, from repo root — proxies to server workspace)
npm run db:generate   # after schema.prisma changes
npm run db:migrate
npm run db:studio
npm run db:seed
npx prisma migrate reset   # drop and recreate all tables

# Docker
docker-compose up -d postgres     # just the DB, for local dev
docker-compose up -d llm          # local LLM (llama.cpp) for AI-generated annual report text —
                                   # optional, requires ./models/Qwen3-1.7B-Q4_K_M.gguf (not committed)
docker-compose up -d --build      # full stack
docker-compose down               # stop
docker-compose down -v            # stop + wipe DB volume
```

No test script exists at the root that runs backend + frontend unit tests together —
run `npm test --workspace=server` and `npm --workspace=client exec vitest run`
separately, or use `test:all` for the Docker-dependent API+E2E suites.

**`npm run dev:server` uses `nodemon` (polling), not bare `tsx watch`.** Native-OS-
file-event watching (both `tsx watch` and Vite's default chokidar watcher) was found to
silently go stale after the dev server had been running a while — no restart/HMR on
further edits, no error, no indication anything was wrong. Root cause was never pinned to
one deterministic trigger, so the fix is to stop depending on native file-change events at
all: `server/nodemon.json` runs `nodemon` with `legacyWatch: true` (polling), watching
both `src` and `../shared/src`; `client/vite.config.ts`'s `server.watch: { usePolling:
true, interval: 300 }` is the client-side equivalent. If you're ever tempted to simplify
back to plain `tsx watch`, know this is exactly the failure mode that reintroduces.

## Architecture

### Two-layer server split: room/DB/broadcast lifecycle vs. pure turn math

- **`GameEngine`** (`server/src/socket/gameEngine.ts`) — Socket.IO room/phase lifecycle:
  create/join/kick, phase advancement (`WAITING → GAME_PHASE → AFTERMATH`), and *all*
  Prisma/Socket.IO I/O for turn resolution. Holds rooms in an in-memory `Map` in addition
  to Postgres, and guards concurrent turn resolution per-room with a `Set<string>` lock
  (`advancingRooms`). `resolveGameTurn`/`broadcastInitialSnapshot` load each active
  player's `Company` row into `GameLoop`'s input shape, call `GameLoop`, then persist the
  returned updates and emit `player:bankrupt`/`turn:resolved` themselves.
- **`GameLoop`** (`server/src/engine/gameLoop.ts`) — the authoritative turn-resolution
  engine, loaded via `GameEngine.loadGameData()` from the `Decision`/`GameConfigRow`
  tables. **It is a pure computation engine** — no Prisma, no Socket.IO, no
  `async`/`await` anywhere in it. `resolveTurn(roomId, round, players)` and
  `getInitialSnapshot(...)` take plain input and return plain data; they never write to
  the DB or emit a socket event — the caller (`GameEngine`) does both. Delegates to
  `calcEngine.ts` (P&L, balance sheet, market share, risk gauge), `decisionEngine.ts`
  (deployment rules, maturity, mutual-exclusion), and `legalEngine.ts` (lawsuit
  filing/pricing). `resolveTurn` runs the full per-round calculation described in the
  README's *Business Decisions* section; the numbered `// ── Step N ──` comments in it
  are the current, accurate execution order.

When changing turn-resolution logic, the engine files under `server/src/engine/` are
where it lives — `gameEngine.ts` never touches game math directly. This split makes
`GameLoop`'s tests (`gameLoop.test.ts`) plain input-in/output-out assertions with no
mocking — a test needing a Prisma/`Server` double is testing `GameEngine`, not `GameLoop`.

`GameLoop` persists each active decision as a `PersistedDecisionInstance`
(`{ id, definitionName, deployedYear, elapsedYears, isMatured, targetId?, everSued?,
voidedByLawsuit? }`) rather than the full `DeployedDecision` — `definitionName` is looked
back up against the loaded decision library on read. Keep persisted instances in this
serialized, name-keyed form; don't reintroduce embedding the full definition into
`Company.engineState`. `targetId` (set when a decision like Bot Attack is deployed
against a chosen opponent) drives `target.*` impacts each turn and `buildIncomingAttacks`'s
attack-hint surfacing — never derive one without the other; they read the same `targetId`.

### Incoming attacks — hints, dismissal, indirect effects, heads-up shortcut

`buildIncomingAttacks` rebuilds the incoming-attacks list fresh every turn from "is there
still another active player whose active `target.*`-bearing decision targets me" — it has
no memory of past state. `GamePhase.tsx`'s `isAttackAlreadySuedOver` filters the list
client-side, hiding a hint once a real case exists against that exact attacking instance —
matched by `c.defendantDecisionInstanceId === attack.attackId` (the specific instance, any
ground, regardless of investigation level), not by requiring the ground to match a
suggested one. `dismissedAttackIds: Set<string>` (plain `useState` in `GamePhase`, keyed
by the same `attackId`, reset on reload) is a third, purely client-side way a hint stops
showing — a player can dismiss a hint they don't want to act on.

**Indirect effects**: a decision with no `target.*` impacts but with `legalRisks` (roughly
two-thirds of the library — New Factory, Water Pumping, etc.) still generates a hint,
broadcast to *every* other active player rather than one target — `GameLoop.
isIndirectEffect(def, targetImpacts, targetId)` is the classifier (`targetImpacts.size ===
0 && legalRisks.length > 0 && targetId === undefined`; Buy Shares is excluded from this
despite having no `target.*` impacts, since it has a real `targetId`). Deliberately not
based on the `offensiveAction` flag, which is unreliable/narrative-only. The headline reads
"indirectly affects you" (calm blue) vs. "did something to you" (alarmed orange); `digDeeper`
and the plaintiff-investigation stamp both drop their "must literally target me" gate for
the indirect case. This was a deliberate, discussed scope decision (mirroring direct-attack
detection inverted) — expect several hint cards per turn in a 3-4 player game; that's by
design, not a bug to throttle without a further product decision.

**Heads-up shortcut**: `GameLoop.effectiveInvestigationLevel(rawLevel, activePlayerCount)`
adds +1 (capped) to every raw investigation level whenever exactly 2 active players
remain, since "who attacked me" is never actually in question with one possible attacker —
the persisted level is still a plain per-dig counter; only what a given level *reveals*
shifts. `activePlayerCount` must always include the investigating player themselves.

**A hint stops appearing entirely once its instance is past `statuteOfLimitationsYears`** —
a user-reported gap: both the direct ("did something to you") and indirect ("did something
that indirectly affects you") hint shapes used to keep showing up every turn forever, even
though suing over that instance is already forced to 0% (`LegalEngine.fileLawsuit`/
`pickAllGrounds`) and, for a direct attack, its own `target.*` effect has already stopped
re-applying every turn (see the "Root historical bug" note above — `collectTargetImpacts`'
own statute cutoff) — nothing left to warn about or act on, so it's a stale,
un-actionable notification rather than real information. `buildIncomingAttacks` now skips
any instance with `elapsedYears >= statuteOfLimitationsYears` outright, same exclusion
point as the existing `voidedByLawsuit` check, applied uniformly to both hint shapes.
Deliberately scoped to just the hint card, not `digDeeper` itself — a player who was
already mid-investigation (say, level 2) before the instance aged out can still complete
their final dig and see the correctly-zeroed odds (a separate, already-existing, still-
intentional behavior — see `gameLoop.test.ts`'s "dig 3 still names a suggested ground but
quotes 0%..." test); only the ability to *discover or continue watching* an attack that's
already expired disappears, not an in-flight investigation's own completion.

### Four exceptions to "everything happens in resolveTurn" — plus settlement negotiation as a fifth/sixth

Almost every gameplay effect only happens inside the turn-timer-driven `resolveTurn`/
`resolveGameTurn` cycle. Five things deliberately don't, each mutating `Company`/`Player`
state instantly, outside the turn cycle: `GameLoop.digDeeper` (pay `digDeeperCost` to
reveal the next investigation tier), `GameEngine.rejoinRoom`/`markPlayerDisconnected`/
`finalizePlayerRemoval` (reconnection), `GameEngine.forfeitGame` (voluntary instant
bankruptcy — writes `bankrupt: true` directly, not via a turn's normal check),
`GameLoop.chargeLawsuitFilingFee` (pay `lawsuitFilingCost` the instant a player files via
SueModal — never refunded even if Step 8 later rejects the case; capped by
`maxLawsuitsPerPlayerPerTurn` against `GameLoop`'s in-memory submission map, same cap
Step 8 itself enforces), and **live settlement negotiation** (`GameLoop.makeOffer`/
`acceptOffer`/`goToCourt` — see below). `digDeeper`/`chargeLawsuitFilingFee`/negotiation
keep `GameLoop` pure; `GameEngine` does the one-off Prisma writes.

`forfeitGame` can't call `resolveGameTurn` directly from inside itself (it's still holding
`advancingRooms`, which would make the inner call silently no-op) — when a forfeit makes
every remaining active player ready, it returns `{ triggerImmediateResolution: true }` and
the *caller*, after `forfeitGame`'s lock is released, triggers resolution. Follow this
"return a flag, let the caller trigger it" shape for any other early-resolution path that
itself needs `advancingRooms`.

`finalizePlayerRemoval` (the heartbeat sweep's grace-period cleanup) must never run
concurrently with `resolveGameTurn` for the same room — both mutate overlapping
room/player state (a previously-reported bug: deleting a player mid-resolution crashed the
persistence loop for the whole room, requiring a manual refresh to recover). Fixed two
ways: the sweep skips finalizing a player whose room is in `advancingRooms` (retried next
tick), and `resolveGameTurn`'s per-player persistence loops each wrap their own writes in
try/catch so one missing row can't abort the room's turn. Keep both if you touch
`advancingRooms` or either persistence loop again.

The four instant, out-of-band settlement-negotiation actions (`makeOffer`/`acceptOffer`/
`goToCourt`/`digDeeperOnCase` — see *Settlement negotiation* below) have the same class of
race, fixed the same way: each rejects outright with `reason: 'turn_resolving'`, before
reading anything, while `advancingRooms.has(roomId)` — a real, reported bug where a
player's `goToCourt` landing at the same moment their room's turn happened to resolve
could be silently overwritten by that same turn's own Step 8b stale-offer auto-settle,
since neither side knew about the other. Unlike `finalizePlayerRemoval`'s retry-next-tick
fix, there's no natural "next tick" for a player-initiated socket action, so this is a
flat rejection (`CASE_ACTION_ERROR_COPY`'s `turn_resolving` copy on the client: "try again
in a moment") rather than a queue — deliberately the simpler of two considered fixes; a
full fix closing the race completely would need a real per-room mutex/queue instead of a
check-and-reject (the lock could still be acquired a moment after the check, before the
call's own persistence write lands), but that's judged not worth the complexity against a
window this narrow (a live click landing in the same instant an independent multi-second
turn timer expires).

### Settlement negotiation

A filed case starts `status: 'negotiating'`. **Live negotiation** (`makeOffer`/
`acceptOffer`/`goToCourt`, via `game:makeOffer` etc.) is instant and two-party — a case is
persisted into *both* plaintiff's and defendant's `Company.engineState.legalCases`, so
every action reads/writes both parties' rows and `GameEngine.emitLegalCaseUpdate` sends
the result directly to both parties' sockets, never a room-wide broadcast. The defendant
always moves first; after that, only the role that did *not* make the most recent offer
may counter or accept. `goToCourt` is never turn-gated (either party can force a trial any
time) but only sets `status: 'awaiting_trial'` — the verdict is drawn later, by the normal
trial-resolution loop inside the next `resolveTurn`. The valid offer range narrows inward
with every move (`GameLoop.computeOfferBracket` — a new offer can only tighten its own
side of the bracket, mirrored client-side in `NegotiationPanel` for slider bounds only;
server is authoritative).

**Step 8b** inside `resolveTurn` catches whatever live negotiation doesn't resolve by a
turn boundary: a pending offer left standing after GENUINE back-and-forth (`offers.length
> 1` — both sides have been heard from at least once) is treated as accepted (settles at
that amount). A case with either no offer at all, OR only a single, one-sided offer
nobody ever responded to, is treated identically: `turnsNegotiating` increments each
boundary and forces `status: 'awaiting_trial'` once it reaches
`gameSettings.negotiationPeriodTurns` (default 2), resolving to a verdict that same turn
via the normal trial loop. The one-sided-offer case was a real, reported bug: a lone
defendant opening offer (e.g. a rational $0 move on a provably-hopeless, time-barred
ground) used to auto-settle at the very next boundary purely because SOME offer object
existed — even though the plaintiff never accepted, countered, or forced a trial, this
read to them as "Settled" for an agreement they never made. `offers.length > 1` (not
`> 0`) is the fix — a single unanswered opening move no longer counts as "engaged with."

**Dig deeper on an open lawsuit** (`digDeeperOnCase`, `game:digDeeperCase`) reuses this
same two-party persist/emit shape: the defendant pays `digDeeperCost` to flip
`LegalCaseData.defendantInvestigated`, a one-shot (not tiered) reveal of that case's odds.

### A `LegalCaseData` lives in two players' `engineState` at once — dedupe by id

Since a filed case is persisted into both parties' `engineState.legalCases`, `resolveTurn`'s
Step 7 reconstructs `allCases` via a `Map<id, LegalCaseData>` — a naive concatenation
double-counts every case, and since Step 12 re-persists whatever's in `allCases` back into
both parties, an undeduped list doubles again every subsequent turn. Keep the dedup if you
touch how `allCases` is assembled. A resolved case is only re-persisted for the one turn it
resolves in — Step 7's `c.status !== 'resolved'` filter drops it from persisted history the
turn after, so anything wanting to remember "this case existed" longer than that can't scan
`engineState.legalCases` for it (see `everSued`, below, for why this matters).

### Only one lawsuit per decision instance, ever

By product decision, a specific decision *instance* can be sued at most once, for its
entire lifetime — the instant a genuine case (not a wrong guess, not time-barred) is filed
against it, `DeployedDecision.everSued` is set `true` permanently, and every later filing
against that same instance (this turn or any future one) gets the same "real but hopeless"
0%-probability shape a wrong guess gets. Scoped to the *instance*, not the decision name —
a redeployed instance after voiding/expiry is independent and cleanly un-sued. Deliberately
a flag on the instance, not derived from scanning case history, since resolved cases don't
survive in persisted state long enough to answer "was this ever sued" reliably (see above).
Within one filing, `targetActiveDecisions` is rebuilt fresh from the target's current state
on every filing processed in the loop, so first-come-first-served falls out for free when
multiple filings target the same instance in the same turn.

**Which instance a filing actually attaches to, when the target has two live, un-sued
instances of the same decision at once** (normal, intended play — stacking a
permanent-effect decision is explicitly allowed, see `canDeploy`) is a separate question
from the above, and was a real, reported bug: `LegalEngine.fileLawsuit` used to always
resolve `targetActiveDecisions.find(d => d.decisionName === decisionName)` — the *first*
name match, regardless of which specific instance the plaintiff actually investigated.
Symptom: a plaintiff who fully "Dig Deeper"-investigated and sued a *newer* instance would
have their case silently attach to an *older*, unrelated instance instead — the older one
gets `everSued`, the one they actually meant to sue keeps reappearing turn after turn,
already at full investigation level, indistinguishable from a freshly-redeployed instance
that's somehow "already known." Fixed by threading the specific instance id through the
whole chain: `IncomingAttackInfo.attackId` → `AttackHintCard`'s "Sue Now" →
`SueModal`'s `handleFile` (only actually sent if the player files over the *exact*
prefilled target/ground, derived fresh at file-time rather than kept as separate state, so
it can never go stale if they change the selection) → `SubmittedLawsuitEntry.attackId` →
`GameLoop.resolveTurn`'s Step 8 → `LegalEngine.fileLawsuit`'s new optional `attackId`
parameter. When present, matching requires an EXACT id hit (plus a same-`decisionName`
sanity check against a tampered/mismatched id) — deliberately **not** falling back to a
name match if the id doesn't resolve, since that would silently reintroduce the exact same
bug through a different door; instead it resolves to the same "real but hopeless"
0%-probability shape as a wrong guess. `attackId` is left `undefined` for the general
"sue over any ground, on a hunch" SueModal flow (no specific instance in mind by design),
which keeps the original name-only match unchanged. The `plaintiffFullyInvestigated`
lookup right above Step 8's `fileLawsuit` call had the identical bug (independently
re-deriving "the" attacking instance by name+targeting only) and got the same fix.

### Winning a case voids the sued decision instance; a permanent effect also naturally expires

Whenever the defendant pays out on a case (trial loss, or any settlement where they pay —
not the bankruptcy/merger waterfall's `'waterfall_payout'`/`'cancelled'`), `GameLoop.voidSuedDecisionInstance`
cancels the instance's *forthcoming* effects, forces `isMatured: true` (freeing it for
redeployment via `canDeploy`'s existing maturity rule), and flags `voidedByLawsuit: true`
(shown as a gray **VOIDED — SUED** badge). Matched by instance id
(`LegalCaseData.defendantDecisionInstanceId`, stamped at filing time), not by name, since a
voided decision can be redeployed and both the old and new instance can coexist.

Separately, any decision whose impacts fall through to a non-zero `'default'` schedule
value forever (`DecisionEngine.hasPermanentEffect`) stops re-applying its own effects (and
`target.*` effects, via `hasPermanentImpactMap`) once an instance has been active
`gameSettings.statuteOfLimitationsYears` (default 10) — the same age past which it can no
longer be sued. Forces `isMatured: true` on expiry too. Not flagged `voidedByLawsuit`; the
client recomputes "expired" purely from data (`hasPermanentEffect(def) && elapsedYears >=
statuteOfLimitationsYears`) and shows a gray **EXPIRED** badge instead.

**`canDeploy`'s permanent-effect redeploy lock uses a separate, shorter clock**:
`gameSettings.permanentEffectCooldownYears` (default 3), not `statuteOfLimitationsYears`.
They used to share the statute, which made a permanent-effect decision (New Factory,
Venture Capital Shadow Money, Bot Attack, etc.) effectively one-time-per-game given typical
game lengths of 12-14 rounds — the statute still governs suability/natural-expiry
unchanged; the cooldown governs only "how soon can I redeploy this," tunable independently.

**Root historical bug, worth remembering the shape of**: `advanceAndApply` used to
re-apply a matured decision's `'default'` schedule value *every turn forever* (no memory
of "already applied this instance's final value"), compounding a `relative` field's
multiplier against itself indefinitely and accumulating an `absolute` field's addend on
top of itself every turn — this was the real root cause of runaway exponential growth and
"certain doom" death spirals in random-play testing (single `New Factory`'s
`installedCapacity` went 350→2635 over 7 turns from one instance alone). Fixed by applying
a decision's own (non-`target.*`) impacts only through its maturity threshold, then
skipping it — `target.*` effects on the *victim* were left deliberately re-applying every
turn until the statute, unchanged, on the reasoning that this was attack/defense balance,
not the same bug (see below for why that reasoning had a gap). If you touch
`advanceAndApply`/`collectTargetImpacts`, this invariant — a matured decision's own effect
is applied once, not compounded — is the one most likely to silently regress.

**The exact same compounding bug existed on the `target.*` side too — the "attack/defense
balance" carve-out above didn't account for RELATIVE fields.** Found via live play: an
idle player (never submitted a decision) went bankrupt by round 12 against a bot that
deployed exactly one `Union Agitation` (`target.capacityUtilization`, relative,
`{1: -0.3, default: -0.15}`) against them in round 5 and nothing else. `collectTargetImpacts`
genuinely does keep re-feeding an active attacking instance's `target.*` impacts into
`applyTargetImpacts` every turn — that part is correct, deliberate design (see above). The
bug was `applyTargetImpacts` itself: for a `relative` field it multiplied `currentVal * (1
+ multiplier)` — the field's own **already-shrunk** value — every single call, with no
memory of "already applied this instance's effect." Reapplying the same percentage against
an ever-shrinking base every turn, forever (until `statuteOfLimitationsYears`, or a lawsuit
voids the instance), is exponential decay: the victim's `capacityUtilization` went
1.0→0.7→0.595→0.506→0.430→0.365→0.311→0.264 over six turns — an ABSOLUTE field
(`target.outrage`, `+25`/turn observed in the same game) has no such problem, since it's
bounded, linear accumulation, not compounding. A scan of the seeded library found **18 of
~53 targeting decisions** carry a relative target field with a non-zero `default`
(`target.capacityUtilization`/`target.supplySecurity`/`target.processingLevel` decaying
toward 0, `target.logisticsCostPerTon` inflating toward infinity, no ceiling) — a
third of the whole attacking library was exposed to this. It went unnoticed for so long
because the bot never correctly attached `targetId` to any of these decisions until the
`botService.ts` targeting fix earlier in this file's own history — before that fix, none
of these 18 decisions' `target.*` effects had ever actually landed via bot play, live or
in casual testing.

Fixed the same way as the own-effect case above: `applyTargetImpacts`
(`calcEngine.ts`) now gates a RELATIVE field's own re-application on
`elapsedYears <= singleFieldMaturityYears(schedule)` (a new per-field helper, since one
decision can mix an absolute and a relative target field on different schedules — e.g. Bot
Attack's `target.outrage` alongside `target.capacityUtilization`) — apply through the
field's own explicit years, plus once more when `'default'` is first reached, then hold
forever after, exactly mirroring `advanceAndApply`'s own-effect semantics. An ABSOLUTE
target field is completely unaffected — no gate, keeps accumulating every turn exactly as
before; changing that behavior was never the ask (see above's "attack/defense balance").
Client-side, `summarizeEffects`'s "Every turn until Yr N" vs. "Permanent" label (see the
EFFECTS panel section below) now also checks `impact.type`, not just `isTarget` — a
RELATIVE target field reads "Permanent" too, matching its new hold-after-maturity
behavior; an ABSOLUTE target field keeps its original "Every turn until Yr N" label.
Regression-tested at both layers: `calcEngine.test.ts`'s `applyTargetImpacts` describe
block (a default-only relative field applies once and holds across three more calls; a
two-stage schedule like Union Agitation's applies through its own explicit year then
holds; an absolute field on the same decision keeps accumulating independently),
`gameLoop.test.ts`'s full `resolveTurn`-across-three-turns regression reproducing the
exact Bot Attack scenario, and both `GamePhase.utils.test.ts`/`GameTimelineView.utils.test.ts`
asserting the new "Permanent" label for a relative target field.

### Statute of limitations & relative-type legal-risk stakes

Beyond spec: a decision can be sued over only within `gameSettings.statuteOfLimitationsYears`
of deployment (`targetInstance.elapsedYears >= statuteOfLimitationsYears` forces
`baseProbability` to 0 in both `LegalEngine.fileLawsuit` and `pickAllGrounds`'s pre-filing
estimates, so a suggestion never quotes odds a real filing would immediately zero out).
Independent of `isMatured` — governs legal liability, not schedule-locking.

A legal risk's `impact.type` matters for stakes, not just for the defendant's effect: an
`absolute` ground's stakes are the raw schedule value; a `relative` ground's stakes must
be scaled against the defendant's *own current* value of `impact.target` (read generically
off `PlayerVariables`, e.g. `equity`/`revenue` — never hardcoded to one field). Reading a
relative schedule value directly as dollars was a real, reported bug (near-zero stakes,
"You paid $0"). `fileLawsuit` takes the defendant's `PlayerVariables` for this reason; at
the Step 8 call site, `revenue` specifically has to be read from that turn's freshly
computed P&L map (`plMap`), not `ctx.vars.revenue`, since revenue is never written back
onto `PlayerVariables` the way `equity` is. The whole library only ever uses `relative`
grounds against `revenue` (60) or `equity` (48) — nothing else, confirmed by scanning
every seeded ground — so these two are the *only* fields this fix needs to cover; `equity`
is always safe already (`ctx.vars.equity` is written back every turn at Step 7).

**The Step 8 fix above only covers the actual filing.** Two *other* call sites price the
same relative-type grounds for DISPLAY, before a player ever files, and both had the exact
same "$0" bug independently: `GameLoop.buildIncomingAttacks` (populates every incoming-
attack hint card's `suggestedGrounds[].stakes`, every turn) and `GameLoop.digDeeper` (the
immediate reveal at the moment of clicking Dig Deeper) both fed `revealAttack`'s
`pickAllGrounds` call raw `PlayerVariables` with no `revenue` patch at
all — a real, reported bug (Venture Capital Shadow Money's hint showing $0 stakes, but
affecting all 60 revenue-relative grounds identically). Fixed the same way as Step 8:
`buildIncomingAttacks` now takes `plMap` and patches `revenue` from it before calling
`revealAttack` (it runs inside `resolveTurn`, so a live `plMap` is available). `digDeeper`
has no live turn in progress to compute a `plMap` from at all — it's fixed via
`GameEngine.latestKnownRevenueByPlayer`, a best-effort read of each player's latest
`KpiSnapshot.derived.revenue`, patched onto the players array before calling `GameLoop.
digDeeper` (which itself stays pure/Prisma-free, per its own design). Approximate
(last-turn's figure, not "right now"), same tradeoff as every other out-of-band action
that needs a P&L-derived number it can't afford to live-recompute.

**A fully-investigated hint suggests EVERY viable ground, not just the strongest one.**
`DecisionEngine.pickAllGrounds` (`decisionEngine.ts`) replaced the old `pickBestGround` —
a real, reported gap: a decision with several `legalRisks` entries (e.g. "Risky
Fundraising"'s two revenue/equity-relative grounds) used to only ever surface the single
highest-probability one via `IncomingAttackInfo.suggestedGroundName` (a scalar field),
silently hiding every other genuinely viable ground from a fully-investigated player.
`IncomingAttackInfo.suggestedGrounds` is now an array (still sorted probability-descending,
so `[0]` is still "the best one" for any caller that only wants that), and
`AttackHintCard` (`GamePhase.tsx`) renders one suggestion box — description, estimated
success, stakes, and its own "SUE NOW" button — per ground, since filing is always over
one specific ground name. `botService.ts`'s own suing strategy (`shouldFileLawsuit`,
`pickAttacksToInvestigate`) deliberately still only ever weighs `suggestedGrounds[0]` —
showing every option is a human-facing information upgrade, not a bot-strategy change.
`GameLoop.resolveTurn`'s `plaintiffFullyInvestigated` stamp (Step 8, filing time) was
updated the same way: a plaintiff who sued over ANY of the grounds `pickAllGrounds`
surfaced counts as having "known the odds," not just the one that happened to sort first.

### A bankruptcy/merger waterfall payout is not a settlement — `'waterfall_payout'`, distinct from `'settled'`

A user-reported bug: a case they had explicitly sent to trial via **"Go to Court"** (the
defendant had made one opening offer, the plaintiff deliberately declined to negotiate
further and forced a probability verdict instead) showed up as **"Settled"** once the
defendant went bankrupt from an unrelated cash problem before the trial could draw its
verdict — with no offer ever having been accepted, or in other cases, no offer ever having
been made at all (a lawsuit filed the very same turn the defendant happened to go
bankrupt). Root cause: `GameLoop.distributeCaseWaterfall` (the bankruptcy/merger
elimination payout — see *Share Ownership & Takeover* above for why the same function
serves both) paid out every unresolved case against the falling player and stamped
`verdict: 'settled'` on every one it paid, regardless of how (or whether) negotiation had
ever happened — a real, pre-existing inconsistency: the client's own doc comments already
assumed `'settled'` meant "a real negotiated agreement" (`GamePhase.tsx`'s
`detectNewlySettledCases`), while `LegalCaseData`'s own type comment described `'settled'`
as a bankruptcy-waterfall outcome — two contradictory ideas of what the same string meant,
neither of which anyone had reconciled until a live game exposed the gap.

Fixed by giving the waterfall's paid branch its own distinct verdict, `'waterfall_payout'`
— `'settled'` now means ONLY a real negotiated agreement (an explicit `acceptOffer`, or
Step 8b's stale-offer auto-accept, both genuinely requiring an offer someone made and the
other side implicitly or explicitly accepted). `LegalCaseData.waterfallPayoutAmount`
tracks the actual amount paid (which the waterfall's own `Math.min(case_.stakes,
remaining)` can make LESS than `stakes` if the pool runs dry partway through paying it) —
`GameEngine.resolvedCaseAmount` reads this the same way it reads `offers[...]` for a real
settlement. The waterfall's other branch (cases the pool never reached at all) is
unchanged — still `'cancelled'`, still no payment, still no `waterfallPayoutAmount`. Client
surfaces this as its own distinct News item ("⚰️ CASE CLOSED — OPPONENT ELIMINATED", never
"🤝 CASE SETTLED") via a new `detectNewlyWaterfallPaidCases` (mirroring
`detectNewlySettledCases`'s exact shape) and its own `GameTimelineView.tsx`
`happeningLabel` branch ("closed — X was eliminated ($Y paid)"). `voidSuedDecisionInstance`
was never called from the waterfall to begin with (matches the pre-existing "not the
bankruptcy-waterfall forced settle/cancel" exclusion) — this fix only renames/separates
the *label*, it doesn't change which mechanisms trigger a voided decision instance.

Regression-tested at both layers, same convention as the rest of this file: server-side,
`gameLoop.test.ts`'s waterfall tests assert `verdict: 'waterfall_payout'` (with the actual
`waterfallPayoutAmount`, including a partial-payment case where the pool runs out mid-case
rather than between cases) instead of `'settled'`, and a dedicated case confirming the
UNPAID tail still gets `'cancelled'` with no payout amount; client-side,
`GamePhase.utils.test.ts`/`GameTimelineView.utils.test.ts` each assert `'waterfall_payout'`
is excluded from the real-settlement detector/label and produces its own distinct one.

### A normal trial WIN is also capped to the defendant's actual cash — not just the waterfall

A user-reported bug, distinct from (but adjacent to) the waterfall/`'settled'` mislabeling
above: if a player went bankrupt the SAME turn a court case against them resolved 'won' by
trial, the plaintiff could receive the full nominal `stakes` even though the defendant's
own cash couldn't cover it — effectively being paid money that didn't exist. Root cause:
Step 9 (`GameLoop.resolveTurn`, "process resolved cases & apply cash settlements") used to
do an unconditional `defCtx.vars.cash -= trial.stakes; pltCtx.vars.cash += trial.stakes;`
for every case that resolved 'won' via a normal probability-draw trial *this turn* — with
no cap of any kind. This is exactly the problem `distributeCaseWaterfall` (Step 10b,
above) already solves for a case still *open* when its defendant is eliminated — but a
case that resolves via a normal trial verdict THIS turn is marked `status: 'resolved'`
before Step 9 even runs, so the waterfall (which only touches `status !== 'resolved'`
cases) never sees it and never caps it — a gap between the two mechanisms, not overlap.

Fixed by capping each 'won' verdict's payment to `Math.max(0, defendant's current cash)`
at the moment Step 9 processes it — "only positive cash of the bankrupted player is
shared," per the report. Cases resolving 'won' against the SAME defendant in the same turn
share that defendant's available cash in filing order (oldest `createdAt` first, the same
FIFO tie-break convention `distributeCaseWaterfall` already uses), rather than each one
independently driving cash further negative as if the others didn't exist.
`LegalCaseData.actualAmountPaid` (new, optional — deliberately distinct from
`waterfallPayoutAmount`, since these are two different code paths with two different
triggers) is set only when the cap actually bit; left `undefined` for the ordinary
full-payment case, so nothing downstream has to distinguish "capped to the full amount" from
"never capped." `GameEngine.resolvedCaseAmount` and `GamePhase.tsx`'s News item both read
`actualAmountPaid ?? stakes` for a 'won' verdict now, matching how they already read
`waterfallPayoutAmount ?? stakes` for `'waterfall_payout'` and `offers[...] ?? stakes` for
`'settled'` — the same "the nominal `stakes` is only an estimate, read the real paid-amount
field when one exists" pattern used everywhere else a case's dollar figure is displayed.
`LegalCaseHistory.resolvedAmount`'s own doc comment (`prisma/schema.prisma`) was updated to
describe this too, alongside the pre-existing 'waterfall_payout'/'settled' cases it already
documented.

Regression-tested in `gameLoop.test.ts` ("a WON trial verdict is capped to the defendant's
actual available cash"): the ordinary full-payment case is unaffected
(`actualAmountPaid` stays `undefined`); a single case with insufficient defendant cash caps
the payment and drains the defendant to exactly zero (never negative from the payment
alone); two simultaneous 'won' verdicts against the same defendant pay the older-filed case
first and leave nothing for the newer one; and a defendant whose cash is already negative
before this payment (and who also goes bankrupt the same turn, from an unrelated cash
problem — read back off the *plaintiff's* copy of the case, since a bankrupted defendant is
excluded from `outcome.result.players` per `BankruptedPlayer`'s own doc comment) pays out
exactly $0, never a negative "payment" the other direction.

### A case's probability is earned separately by each side, and displayed as a 5-band verbal likelihood

`CaseCard`'s probability chip only renders once `knowsOdds` is true: for the *plaintiff*,
`LegalCaseData.plaintiffFullyInvestigated` (stamped once, at filing time, by matching a
fully-dug-in — level 3 — attack against the exact ground sued over; not recomputed later,
so it survives the attacking instance later disappearing from `incomingAttacks`); for the
*defendant*, `defendantInvestigated` (earned via the dig-deeper-on-case flow above).
Otherwise shows a gray "Unknown" chip.

Displayed probability is a fixed 5-band verbal label (`likelihoodLabel` in `GamePhase.tsx`:
0–20% Highly Unlikely, 20–40% Unlikely, 40–60% Moderate, 60–80% Likely, 80–100% Highly
Likely), not a raw percentage — deliberate, since the pre-filing estimate is a snapshot
that reliably drifts *upward* by trial time (the case itself joins the defendant's own
`legalExposureRatio` the moment it's filed, and other plaintiffs can pile on before trial),
so an exact-looking number overstates precision. `semaphoreLevel`'s green/yellow/red dot
color is unaffected and still config-driven. `RiskBreakdownView` (opened by clicking the
chip) deliberately stays numeric — it recomputes live from current state every time it
opens, so it isn't stale the way the snapshot is.

**The Dig Deeper button states its payoff, not just its price** — a real, externally
reported discoverability gap (r/playmygame, 2026-08-11), and the first unsolicited
feedback this game ever got from a stranger. A player asked for "a tiny evidence log
during negotiations: what they did, your chance of winning and the possible damages", so
losing a trial would feel "like a risk you chose instead of RNG punching you". Every one
of those three already existed behind Dig Deeper; told so, they replied they'd never found
it and that the button should be more obvious "because that's exactly the info I wanted
before risking a trial". Nothing was missing — the path to it was unlabelled, and the one
place that DID explain it (`CaseCard`'s gray "Unknown" chip) explained it in a `title`
tooltip, i.e. hover-only, i.e. nonexistent on the touch devices most inbound traffic
arrives on. Fixed cosmetically only, no logic touched: `GamePhase.tsx`'s new pure
`nextDigRevealLabel(hasDecisionName, hasGrounds)` renders a visible line above
`AttackHintCard`'s button ("Reveals what they actually did" → "Reveals your grounds to sue
— and your odds of winning"), `CaseCard`'s defendant-side button gained the equivalent
visible line, and both buttons went `variant="outline"` → `"filled"`. Keyed off what the
card has actually been GIVEN rather than a raw `investigationLevel`, deliberately —
`effectiveInvestigationLevel` silently +1s every tier in a two-player game (see *heads-up
shortcut* above), so a level number doesn't reliably predict what the next dig reveals but
"do I have the decision name / the grounds yet" does. Regression-tested in
`GamePhase.utils.test.ts`'s `nextDigRevealLabel` describe block, including the
never-promise-odds-a-tier-early case.

### `SUE THEM CHICKENS` offers the whole decision library's grounds, not just a target's actual ones

`getGroundsAgainst` returns every `legalRisks` entry across the *entire* library,
regardless of who has actually deployed it — a player can sue on a hunch. `LegalEngine.
fileLawsuit` still creates a real case for a wrong guess, just with `baseProbability`
forced to 0 (never `null`/no-case) — a wrong guess is real but hopeless, same shape as a
time-barred ground. `fileLawsuit` still returns `null` only for a genuinely malformed
request (unknown decision/ground name). `chargeLawsuitFilingFee`/`digDeeper` both need the
same "first turn hasn't resolved yet" `readVariables` fallback `resolveTurn` already has
(`Company.variables` is `{}` until round 1 resolves) — filing/digging in round 1 is now a
realistic, encouraged action, so this fallback is load-bearing, not defensive-only.

### Share ownership & majority-ownership takeover

`shareOwnership: Record<string, number>` (fractions summing to 1.0) uses two sentinel keys
— `SELF_OWNERSHIP_KEY` ('self', the founder's own stake) and `EXTERNAL_MARKET_KEY`
('EXTERNAL_MARKET', the public float); any other key is a real player id who bought in via
Buy Shares. `GameLoop.startingVars()` must spread a fresh copy of the seeded
`shareOwnership` object per player — an earlier version shared one object reference across
every player's starting snapshot, harmless until something started mutating it.

**Trades execute in a new Step 1b**, between `processNewDecisions` and `advanceAndApply`,
priced off `stockValue` as it stood at the *start* of the turn (recomputed later in the
balance-sheet step; using last turn's closing price avoids a circular dependency).

**A genuinely never-yet-computed `stockValue` (round 1) must not be priced as a real $0**
— a real, reported bug: a bot bought 100% of a human player's company on round 1 for a
trivial spend. `stockValue` is a `"derived"` field (`playerStartingValues`' own comment) —
`GameLoop.startingVars()` never seeds it, so it's genuinely `undefined` before a company's
first turn has ever resolved, not a real computed 0. `applyShareTransaction` has a
deliberate rule that a price of exactly 0 means "distressed company, free takeover" (see
below) — the old `targetCtx.vars.stockValue ?? 0` fallback silently folded "never
computed" into that same 0-price case, so the free-takeover rule fired for EVERY company
on round 1, regardless of how little was spent. Fixed via `GameLoop.startingStockValue`
(book value per share — `(cash + assets + intangibleAssets + reserves - debt) /
totalSharesOutstanding`, no legal exposure/receivables since neither exists pre-turn-1),
used ONLY when `stockValue` is strictly `undefined` — a real computed 0 later in the game
(an actually underwater company) still triggers the free-takeover rule unchanged.

A purchase of `fractionBought = min(1, spend / stockValue / totalSharesOutstanding)` dilutes
*every* existing `shareOwnership` key by `(1 - fractionBought)` uniformly, then credits the
buyer's key with the full `fractionBought` — self-buyback and stacking multiple same-turn
buyers both fall out of this one formula with no special-casing (two sequential 50%
purchases land at 25%/50%, not 50/50 — being first only protects you from purchases
*before* yours). Every diluted key that maps to a real player (never `EXTERNAL_MARKET`,
never the buyer) receives `fraction * spend` in cash (not `fraction * fractionBought *
spend` — that extra factor was a real, reported payout bug, fixed).

**FIFO ordering for same-turn stacked trades** needs a real arrival timestamp, not
`Date.now()` at submission time — `game:submitDecisions` is full-replacement (see below),
so a per-call stamp would reflect whenever the player last touched *anything*.
`GameLoop.submissionTimestamps` (room → player → `${bucket}:${name}:${targetId}` → first-
seen time) only stamps a key the first time it appears in a turn's submissions.

**Majority-ownership elimination** reuses the bankruptcy case-payout waterfall verbatim
(`distributeCaseWaterfall`) for either reason. A merger's acquirer additionally inherits
the eliminated company's cash/assets/intangibleAssets (not debt, not decisions, not legal
cases). A prospective acquirer who is themselves bankrupting the same turn is excluded from
`playersToMerge` — their pending stake just gets swept to `EXTERNAL_MARKET` like anyone
else's. Any player eliminated this turn (either reason) has their stake in every *other*
company's `shareOwnership` swept to `EXTERNAL_MARKET` — without this a departed player's
stake would sit forever, un-payable and un-reclaimable.

`legalRiskConditions.minPercentAcquiredInSingleTransaction` is wired generically via
`DecisionEngine.meetsLegalRiskConditions(def, instance)`, reading the instance's own
`acquisitionFraction` — keyed off the data field, never a hardcoded decision name (see the
`DEPRECIATING_ASSETS` cautionary note under *Decisions/config are DB-backed* below for why
name-based special-casing in this engine is a recurring bug class to avoid). The takeover
threshold itself (`admin.ownership.takeoverThresholdPercent`, default 0.5) is also read
generically in `gameLoop.ts`'s Step 10 merger check now, not hardcoded to `0.5`.

Buy Shares/Sell Shares are their own `level: 'Financial'` decision-type category (not
Strategic), with an independent per-turn cap, `gameSettings.maxFinancialDecisionsPerTurn`
(default 2) — a third bucket alongside Strategic/Operational, tracked via a shared
`DECISION_BUCKETS = ['strategic','operational','financial']` tuple everywhere a bucket is
iterated (client and server), specifically so a third bucket never gets silently dropped by
a hardcoded two-item check the way earlier bugs in this codebase did. Neither carries
`impacts` — both are identified generically by `shareTransactionType: 'buy' | 'sell'` on
the `DecisionDefinition`, never by name. The target picker for these two is labeled
"COMPANY" not "TARGET" in the UI, since it's "whose cap table," not "who gets hurt."

The cap table (who owns how much of a company, not just its price) is shown via
`buildCapTable`/`CapTableSection` in the STOCK VALUE drill-down and a rival's Full Filing
report — a pure function resolving each `shareOwnership` key to a name/color (self,
`EXTERNAL_MARKET`, a real other-player id, or a "Former Shareholder" fallback for an
eliminated holder's stale key) and sorting largest stake first.

### Financial decision level, `room:startGame` ordering, and per-game decision subset

**`room:startGame` must broadcast the round-1 initial-snapshot `TURN_RESOLVED` before
`PHASE_CHANGED`/`GAME_READY_UPDATE`/`GAME_DECK`.** A client can't act (submit/ready) until
told the phase changed, so awaiting the initial snapshot first means no client can race a
ready-triggered real turn-1 resolution ahead of the (always-empty) initial one and have it
silently overwritten. `GameEngine.startGame(roomId)` is the extracted method with real
regression coverage for this exact broadcast order — found via a live two-socket Docker
repro, not code review; mocked-only tests have no relative timing between concurrent async
paths and won't catch an ordering bug like this on their own.

**Every new game draws its own fixed, random decision subset.** `RoomState.decisionSubset`
(decision names only) is picked once, in `startGame`, via `GameEngine.
pickRandomDecisionSubset()`: `RANDOM_DECISION_COUNT` (48) random decisions, **plus every
decision with `shareTransactionType` set, unconditionally** — selected by that field, never
by name, so an admin renaming/adding a share-transaction decision can't silently drop the
takeover mechanic from every future game. `GameEngine.getRoomDeck(roomId)` resolves the
subset back to full definitions for both `startGame`'s and `rejoinRoom`'s `game:deck`
broadcast (falls back to the full library if the subset is still empty — a test-only path).
Enforcement lives in `GameEngine.submitDecisions`, which filters incoming decision/lawsuit
entries against the room's subset *before* calling into `GameLoop` — `GameLoop` itself
stays unaware any per-room restriction exists (it still needs the whole library in memory
to look up already-deployed instances by name regardless of room).

### KPI history + prediction graphs

Every clickable KPI in `GamePhase.tsx` opens a generic `KpiHistoryGraph`, keyed by a
dot-path into `KpiSnapshotPoint` — adding a new clickable field is a one-line change, not a
new endpoint. Purely-computed intermediate rows (COGS, EBITDA, etc.) aren't clickable —
there's no single tracked field for them.

**History**: one `KpiSnapshot` row per player per round, `upsert`-written by `GameEngine.
persistKpiSnapshots` from both `resolveGameTurn` and the round-1 initial broadcast.

**Prediction** (`GameLoop.predictFutureKpis`) calls `resolveTurn` itself, `turnsAhead`
times, sandboxed behind a synthetic room id (`__predict__${playerId}`). Before the loop, the
target player's OWN currently-queued (not yet turn-resolved) decisions/lawsuits for the real
room — read live off `this.submissions.get(roomId)?.get(playerId)`, the same in-progress
selection `game:submitDecisions` keeps current as the player builds it — are seeded into the
sandbox for the very first predicted turn only (`this.submitDecisions(sandboxRoomId,
playerId, ...)`), so Step 1/Step 8 apply exactly once, for that one turn; `resolveTurn`'s own
`clearSubmissions(sandboxRoomId)` call at the end of that same iteration naturally prevents
re-application in later iterations — the newly-deployed instance just keeps maturing
normally from there, like any other already-active decision. A real, reported gap: the
prediction used to assume the player submits nothing at all, even with a real selection
queued right next to the graph — the whole point of a "preview my future" is to preview
what happens if they go through with what they've already picked. This deliberately reads
(never clears/consumes) the real room's submissions — must never disturb what's queued for
the real turn. Every rival, and the target's own future turns beyond the first, are still
held/advanced exactly as before: rivals are held completely frozen (re-fed unchanged each
iteration, and never seeded into the sandbox regardless of what they've queued in the real
room) — the literal implementation of "predicts your own decisions, not others'." `round`
passed to each sandboxed call must be the room's real current round plus
an offset, not a small fabricated counter, or depreciation-ledger math desyncs. A target's
own negotiating legal cases still run through real negotiation-timeout/trial logic inside
the sandbox (including its random verdict draw) — accepted, since reusing the real engine
wholesale (not an approximation) was the point; two predictions can legitimately differ if
a case resolves inside the window. Rivals never get a prediction, only history —
`GameEngine.getKpiHistory`'s `includePrediction` is `false` for any target other than the
requester's own id, a deliberate product decision (not a missing feature).

Trend arrows (up/down/no-change) next to every KPI are computed purely client-side by
diffing the current turn's snapshot against the one previous turn already in memory
(`computeTrend`) — no new server round trip. A handful of computed-only rows recompute
their whole formula against the previous snapshot rather than diffing a field (same
function, called twice) so the live value and its trend arrow can never drift apart.

### Decision Deck's "Predicted next turn" cash estimate — a client-side approximation, not `predictFutureKpis`

The Decision Deck modal's title shows `Cash: X · Predicted next turn: Y`, computed purely
client-side by `GamePhase.tsx`'s `estimatePendingCashEffect(pending, decisions,
vars.cash, decisionCostWealthScaleRate, cogs)` — no server round trip, recomputed on
every DEPLOY/CANCEL toggle since `pending` is already threaded down to the modal. This is
deliberately a fast approximation, not the real, full-engine `predictFutureKpis`
simulation shown in the CASH KPI drill-down graph (see *KPI history + prediction graphs*
above) — it only estimates the combined effect of whatever's currently queued (not yet
submitted) this turn, nothing about future turns or already-active decisions maturing.

**A real, reported bug: this used to read only a decision's literal `impacts.cash`
field**, which only 32 of the 212 seeded decisions actually carry. For the other ~85% —
e.g. Supplier Scorecard System (`operatingExpenses: +4500`, no `cash` field at all) —
queuing a real, costed decision moved the predicted figure by exactly $0, which read to a
player as "it doesn't include what I just queued," even though the function was
technically processing the entry correctly, just far too narrowly to represent its real
cost. This is the exact same class of bug `botService.ts`'s own `estimatedFirstYearCashEffect`
was fixed for earlier (see *Server-injected AI bot player*'s *Self-preservation* section
above) — fixed here the same way, by folding in the same two additional sources of real
cash effect:
- **`CASH_DOLLAR_FIELDS`** (`operatingExpenses`/`staffCost`/`otherIncome`/`financeCost`) —
  a local client-side copy of `botService.ts`'s `DOLLAR_FIELDS`/`FIELD_DIRECTION` (same
  fields, same signs), kept in sync by hand per this codebase's *Client-side duplicated
  pure logic* convention rather than importing a server module into the client bundle.
- **`materialCostPerTon`/`logisticsCostPerTon`'s real COGS effect** (`cogs =
  (materialCostPerTon + logisticsCostPerTon) * volume`, per `calcEngine.ts` — "very often
  the single largest real cost in this game's P&L," per the bot-COGS postmortem
  referenced above) — mirrors `botService.ts`'s `cogsEffectAtYear`/`BotCogsContext`
  exactly. The three live inputs it needs (`materialCostPerTon`/`logisticsCostPerTon`/
  `volume`) were already sitting in `GamePhase`'s own render scope
  (`vars.materialCostPerTon`/`vars.logisticsCostPerTon`/`derived.volume`) by the time the
  modal renders, so no new prop threading was needed.

Deliberately still scoped narrower than the bot's own estimator: no `debt`-to-`financeCost`
conversion (`debtAsFinanceCost`) — most debt-carrying decisions in the library already
expose their recurring cost via an explicit `financeCost` schedule value directly (already
covered above), and a same-turn "next turn" estimate has less to gain from also modeling
debt's own multi-turn knock-on effect than the bot's affordability check does — and still
no tax/legal-exposure effect or any other field's further P&L knock-on, unlike the real
`predictFutureKpis` simulation. Regression-tested in `GamePhase.utils.test.ts`'s own
duplicated copy of `estimatePendingCashEffect` (same "duplicate small pure logic" reasoning
as `getDecisionSortValue` and friends in that file) — covers the exact Supplier Scorecard
System reproduction, the `staffCost`/`financeCost`/`otherIncome` sign directions together
with an existing `cash` field, the COGS conversion using live per-ton rates and volume, and
the zero-volume edge case.

### Local LLM annual-report blurbs & AI decision generation (admin-only, experimental)

`GameEngine.getAnnualReport` narrates one sentence of flavor text per active decision via
a local `llama.cpp` server (`llmService.ts`, OpenAI-compatible `/v1/chat/completions`),
replacing old fixed `competitorsView` strings. **Must degrade invisibly**: every failure
(unreachable host, timeout, bad response) falls back to the decision's own
`competitorsView` text — never propagates an error, and the game is fully playable with
the `llm` container never started. Responses are cached in-process by
`decisionName#elapsedYears` (not per-player). A tier-1 incoming-attack hint (attacker
identity known, decision itself not yet) reuses this same generation as flavor — computed
in `GameEngine`, not `GameLoop`, since `resolveTurn` must stay synchronous/I/O-free; both
`digDeeper` and every subsequent `turn:resolved` broadcast re-attach it via a shared
`annualReportBlurbForInstance` helper.

**AI decision generation** (`decisionGenService.ts` + `decisionGenGuardrails.ts`, admin
portal only) can invent a whole draft decision + lawsuits from the same local model, but
**only ever produces a human-reviewed draft** — `POST /api/admin/decisions/generate`
returns the candidate, never saves it; an admin must review and submit it through the
normal decision-creation form. The guardrail pass does the real safety work (confirmed by
a live eval, not assumed): filters `impacts` to a field whitelist, clamps every schedule
value into real-data-derived ranges, coerces a field to whichever of `absolute`/`relative`
the real library actually uses for it (a magnitude clamp alone doesn't catch a
categorically-wrong type), forces `legalRisks[].impact.target` into `cash`/`equity`/
`revenue`, and derives `offensiveAction`/`requiresTarget` from what actually survived
clamping rather than trusting the model's own flags. Eval found the model reliably good at
prose (names, descriptions, legal-jargon grounds) and reliably unreliable at exact
numbers/type conventions — guardrails fired on nearly every generation (~3.2 warnings
each), including one case that would have handed a player 5-6x starting cash in fresh debt
unclamped. This is why the tool stays "AI proposes, human disposes," not wired into any
live game.

### EventLog + admin Analytics — durable, cross-game telemetry

`EventLog` (Prisma model) deliberately has **no FK to `Room`/`Player`** — both are
hard-deleted routinely (stale-room sweep, grace-period cleanup), so ids are plain
unconstrained strings; anything worth showing alongside one (names, reasons) is
denormalized into a JSONB `payload` at write time. `eventLogService.logEvent`/`logEvents`
are best-effort — same "must degrade invisibly" convention as `llmService` — a DB hiccup
writing telemetry must never abort a turn or surface to a player. `EVENT_TYPES` is a fixed
vocabulary (`turn.resolved`, `decision.deployed`/`rejected`, `player.eliminated`/
`disconnected`/`reconnected`/`kicked`, `room.stale_cleanup`, `game.completed`, `llm.call`,
`error.persistence`, `case.negotiation_action`). `game.completed` is logged from exactly
the two real game-ending call sites (`resolveGameTurn`, `forfeitGame`), never from the
payload-building helper itself (which has a third, non-completion caller: reconnect
re-fetch). `case.negotiation_action` is the odd one out — added purely as a forensic aid
for a specific reported bug (see the negotiation-actions-vs-turn-resolution race section
above) rather than for a dashboard: `GameEngine.logNegotiationAction` logs every
`makeOffer`/`acceptOffer`/`goToCourt`/`digDeeperOnCase` call, success or rejection,
including the case's exact `offers`/status snapshot immediately before the call
(`findCaseSnapshotInDbPlayers` — best-effort only, never used for an actual gameplay
decision, that stays inside `GameLoop.findCaseAndParties`) — so a "the wrong party got to
move" report can be diagnosed from real data next time instead of a player's memory of
what they clicked.

Three aggregate dashboards live in `analyticsService.ts` as pure functions over plain row
arrays (unit-testable without a DB): decision win/loss correlation (cross-references
deploy/reject events against `game.completed`'s winner), lawsuit win rates (reads
`LegalCaseHistory` directly, not `EventLog`), and performance (turn-resolution duration,
LLM latency/success by kind, error-context breakdown). Admin portal polls only the raw
Event Feed sub-view every 5s; the three dashboards fetch once on tab-mount plus a manual
refresh, since nothing there is ever edited (no clobber risk to guard against).

### Decisions/config are DB-backed, not static JSON — live-reloaded on every admin edit

`game_engine.json`/`game_config.json` (`server/src/data/`) are **seed-only** now —
`Decision`/`GameConfigRow` Prisma tables are authoritative at runtime, populated by
`prisma/seed.ts` (idempotent; also the disaster-recovery path: `npx prisma migrate reset
&& npm run db:seed`). Editing the JSON files directly has **no runtime effect** once the
DB is seeded — use `/admin`. `GameEngine.loadGameData()` reads both tables at startup;
every admin write calls the same `GameLoop.loadDecisions()`/`updateConfig()` used at
startup, taking effect on the very next turn resolved anywhere, no restart needed.

**Deleting a decision is guarded, not just validated** — several hot-path spots
dereference an active instance's `.definition` without a null check, so removing a
definition still deployed somewhere would crash the next turn resolution. `deleteDecision`
scans every non-bankrupt company's `activeDecisions` (`isDecisionInUse`) and rejects (409)
if still deployed.

**Cautionary precedent — don't special-case by decision name.** `calcEngine.ts` used to
hardcode a `DEPRECIATING_ASSETS` name allowlist gating which decisions created a
depreciation-ledger entry; auditing the real seeded library found an existing decision
already silently missing from it (never depreciating, no error). Fixed by trusting the
structural signal alone (`field === 'assets'/'intangibleAssets' && value > 0` on the
deployment year) instead of a name list. Whenever you're tempted to special-case by
decision *name* anywhere in the engine (vs. by a `DecisionDefinition` *field* like
`impacts`, `legalRisks`, `nature`, `shareTransactionType`), this is the failure mode to
remember — it silently drifts from the DB with no error, and ordinary tests against the
seeded library won't catch it.

`processingLevel`/`capacityUtilization`/`installedCapacity`/`price` are floored at 0 (no
ceiling) — `calcEngine.ts`'s `clampFloorZeroFields` helper, shared between
`applyDecisionImpacts` and `applyTargetImpacts` so a decision's own effects and its
`target.*`-routed effects agree on the floor.

### Randomized-simulation testing — a standing methodology, not a one-off

`server/src/engine/gameLoop.simulation.test.ts` (and `.simulation.smart.test.ts`, a
Dig-Deeper-informed suing strategy variant) are **permanent regression suites**: they play
full multi-player games against the real seeded decision/config data across fixed seeds,
asserting basic invariants every turn (every number finite, `riskGauge` in `[0,100]`,
ownership fractions sum to ~1). This is the project's standing tool for two purposes —
catching invariant violations a hand-written fixture wouldn't think to test (it already
found and fixed a real bug: absolute-type impact writes on an *undefined* derived field
like `revenue`/`financeCost`/`taxCost` produced permanent `NaN` corruption, fixed via `??
0` guards; and a `riskGauge` scrutiny term with no lower clamp, fixed by clamping both
ends), and checking decision-balance changes empirically (win-rate/elimination-rate
association per decision) rather than by assertion alone — every "data-only" balance edit
described elsewhere in this file was verified this way. **Any data-only change to
`game_engine.json`/`game_config.json` needs `npm run db:seed` re-run** on an
already-seeded dev database to take effect — this applies uniformly and is not repeated
per-section below.

Known, deliberately un-fixed balance findings from this methodology (product/design
questions, not bugs): `New Factory`'s cash cost and `capacityUtilization` ramp-down penalty
were reduced twice across two tuning rounds; `Venture Capital Shadow Money` gained a real
`financeCost` repayment cost (it used to be pure free cash); `Vertical Integration`/`Raw
Material Monopoly` had their upfront costs cut and, for the latter, a genuine sign error
fixed (its own `materialCostPerTon` impact was permanently *raising* the deployer's own
costs — flipped to lowering, matching its description). `Excess Dividend` originally had
its cost/risk roughly halved but remained a strictly weak pick with no offsetting benefit —
since given an actual purpose, see *"Cash-growth balance pass"* below.  `price`/
`operatingExpenses` in `playerStartingValues` were tuned so an idle player (never submits a
decision) nets exactly $0/turn — previously netted +$14k/turn purely from a
capacity-bound-regardless-of-market-share structural quirk; covered by a dedicated
5-turn-idle regression test. Dig-Deeper-informed suing measured ~8x the win rate of blind
guessing (~50.7% vs ~6.1%) at ~4.5x lower filing volume — validates that the pre-filing
probability estimate is a genuinely reliable signal, not just flavor text.

### Cash-growth balance pass — margin-stacking haircut, late-game escalation, wealth sinks

A user-reported "cash increases too high" prompted a multi-part balance investigation using
the randomized-simulation methodology above, in three rounds:

**Round 1 — literal `cash`-field windfalls.** ~8 "Dirty"/"Grey Area" decisions (Insider
Trading Ring, Rebate Redemption Friction, Preferential Insider Payment Terms, Loyalty Data
Resale, Selective Recall Delay, Warranty Claim Stonewalling, Data Broker Partnership) were
pure one-time cash windfalls ($97k-$191k) with zero offsetting cost — no debt, no
`financeCost`, no `operatingExpenses` increase, only a *probabilistic* lawsuit that
required another player to notice and sue. Fixed by scaling all 20 positive-cash decisions'
principal by -30% and adding a real recurring `financeCost`/`operatingExpenses` clawback
(~33% of the payout over years 2-4, mirroring Venture Capital Shadow Money's existing
multi-year shape) to the 7 genuinely uncosted ones. Measured effect on aggregate cash was
negligible — these turned out to be a minor contributor, not the dominant one.

**Round 2 — margin stacking (the real driver).** Isolating per-player round-over-round cash
deltas (avoiding the survivorship-bias trap of averaging over a shrinking active-player
population) showed revenue growing only ~1.5x over a 15-round game while per-turn organic
cash generation grew ~6x, plateauing around 25% of revenue — pure margin expansion, not
windfalls or merger transfers (which turned out to be rare under random play and not the
cause). Root cause: ~186 decisions' *own* effect on price/`capacityUtilization`/
`installedCapacity`/cost fields (competitiveness/P&L formula inputs — see
`defaultFormulas.ts`) applies once at maturity but *permanently* elevates the field, by
design (matches "New Factory permanently raised your capacity") — with ~20 decisions
accumulating over a typical game, these permanent step-changes stack. Fixed with a uniform
-40% magnitude haircut on every decision's own (never `target.*`, never legalRisks) impact
on those 14 fields — brought round-15 average cash down ~35% ($1.09M → $714k) and, more
importantly, stopped the *acceleration*: per-turn organic delta plateaus around $33k-$53k
instead of climbing to $95k.

**Round 3 — late-game escalation and wealth sinks.** A follow-up question ("40 rounds is
too long") found the real problem wasn't the median (11 rounds with informed/dig-then-sue
play) but a fat tail — ~12% of games hit the round cap, because elimination relies almost
entirely on lawsuit-driven bankruptcy (96% of eliminations vs. 4% merger in that run) with
no reliable second path once two evenly-matched survivors reach a standoff. Four
`GameSettings` fields (`lateGameRoundThreshold`, `lateGameLegalProbabilityBoost`,
`lateGameLegalStakesBoost`, `lateGameTakeoverBoost`, all deliberately gated to only bite
once `round >= lateGameRoundThreshold` — 18 by default, near the pre-fix P75 — so a
typical/median game is completely unaffected) boost a filed lawsuit's `baseProbability`
(capped 0.95) and `stakes`, and a Buy Shares purchase's effective buying power (spend, for
computing shares acquired only — never the cash actually paid), applied in `GameLoop.
resolveTurn`'s Step 8 and `applyShareTransaction` respectively. Measured effect against the
bot harness was modest and noisy (a *stronger* dose at round 15/2.0x measured *worse* than
the shipped round 18/1.5x one) — almost certainly because the bot harness deploys decisions
uniformly at random rather than deliberately attacking/buying out a stalemate rival, so a
boosted multiplier on a lawsuit/purchase that never gets filed does nothing; a real player
facing a 2-person standoff would behave adversarially in a way this harness doesn't model,
so the true effectiveness of this lever is likely understated by the simulation number.

Separately, a follow-up "how do we take money OUT of the game" question (money was only
ever slowing down or moving between players, never actually leaving) added four deliberate
sinks, each verified via `npm test`/the simulation methodology, none requiring a schema
migration:
- **Progressive tax surcharge** — `defaultFormulas.ts`'s `taxCost` expression gained
  `+ MAX(0, profitBeforeTax - 200000) * 0.12`, a 12% surcharge on the portion of a single
  turn's profit above $200k. Pure formula edit (`Formula` table, admin-editable), no engine
  code change — this money is destroyed, not redistributed.
- **Excess Dividend repurposed** — previously a strictly weak pick (flat -$20k cash, no
  offsetting benefit, only a legal-risk downside). Changed to a `relative` -12% of current
  cash (scales with wealth, still a real sink — the payout goes to no other player) plus a
  new `-15 scrutiny` benefit, giving a wealthy player an actual strategic reason to burn
  cash (lower risk gauge) instead of just hoarding it.
- **Merger integration cost** — `mergerIntegrationCostRate` (25% default): a hostile
  takeover's acquirer now loses that fraction of a *positive* `finalCash` transfer to
  "integration costs" rather than inheriting it in full (assets/intangibleAssets are still
  inherited whole) — see README's *Share Ownership & Takeover* section. Without this,
  takeover was a second, unlimited wealth-CONCENTRATION mechanism working directly against
  every other sink here. Skipped for a simultaneously-insolvent target (`finalCash <= 0`) —
  skimming a negative number would perversely reduce the debt the acquirer inherits.
- **Wealth-scaled litigation fees** — `wealthScaledFeeRate` (3% default) added to the flat
  `digDeeperCost`/`lawsuitFilingCost` base in `GameLoop.digDeeper`/
  `chargeLawsuitFilingFee`/`digDeeperOnCase` (the `wealthScaledFee` helper — shared by all
  three flat-fee, out-of-band charges), scaled off the *payer's own* current cash. The
  surcharge is never credited to anyone.

Measured combined effect of the four sinks on top of the round-2 margin fix: a further ~11%
reduction in round-15 average cash ($714k → $636k) in the same random-play harness — modest,
since none of the sinks fire hard under *uniformly random* play (the progressive tax needs
sustained high per-turn profit, the merger sink needs an actual merger, wealth-scaled fees
need active litigation) — a deliberately-managing real player would trigger all four far
more, so this number likely understates their real impact the same way Round 3's escalation
number does.

### Every decision must bring a real benefit — an 18% content-completeness gap, fixed

A user-reported "Astroturfed Regulatory Comment Drive only costs cash, what's the benefit?"
led to auditing the entire library for decisions with no real own-benefit at all (excluding
Buy/Sell Shares, whose value is the mechanic itself, and genuine `target.*` attacks, whose
value is harming a rival, not self-improvement). **37 of 212 decisions (~17%) had none** —
checked against the same real-formula-reference field set `botService.ts`'s `scoreDecision`
already established (`price`/`capacityUtilization`/`installedCapacity`/`processingLevel`/
`supplySecurity`/`processLoss`/`materialCostPerTon`/`logisticsCostPerTon`/
`operatingExpenses`/`staffCost`/`otherIncome`/`demand`/`scrutiny`/`outrage`/`debt`/
`financeCost`/`taxCost`/`revenue`/`receivables`/`assets`/`intangibleAssets`/`reserves` —
plus a positive `cash` schedule value), never the purely-cosmetic fields with no formula
reference anywhere (`energyIntensity`/`moistureContent`/`nutrientConsistency`/
`contaminationRisk`/`odorComplaints`/`breakdowns`/`carbonFootprint`/`stockVolume`).

**Root cause, once found, was mechanical, not random**: almost every flagged decision
already had a `{"default": 0}` placeholder for `demand`/`outrage`/`scrutiny` sitting right
in its `impacts` — the right field had clearly been picked to match the decision's
name/description (a marketing decision had a `demand` slot, a PR/compliance decision had
an `outrage`/`scrutiny` slot), the VALUE was simply never filled in. A systematic
content-generation gap, not scattered one-off oversights. Fixed by filling each existing
placeholder with a real, thematically-faithful value, calibrated against the rest of the
library's actual range for that field (`demand`: 2 to 18 positive, `scrutiny`: -10 to -20
negative, `outrage`: -5 to -60 negative — this pass used the lower/median end, since these
are lower-stakes Operational/Strategic-Traditional picks, not the library's most extreme
entries). A handful had no placeholder at all and needed a field added outright (`demand`
for volume/visibility-themed ones like Aggressive Sale/Influencer Astroturf Reviews;
`processLoss`/`materialCostPerTon`/`logisticsCostPerTon` for quality/efficiency-themed ones
like In-House Lab Testing Expansion/Rainwater Harvesting System/Fleet Electrification
Pilot, matching each field's real-library type convention — `processLoss` absolute,
`materialCostPerTon`/`logisticsCostPerTon` relative). Three decisions (Fine-Print
Auto-Renewal Contracts, Sneaky Checkout Upsell Flow, Backroom Territory Carve-Up) had
*zero* cost of any kind before this pass — giving them a real `demand` gain with no
offsetting risk would have made them strictly-dominant free picks, so each also got a real,
thematically-fitting `outrage`/`scrutiny` cost alongside the benefit (same risk/reward shape
every other Grey-Area/Dirty decision in the library already has). Regression-testable via
the same "every decision has a real benefit" scan (`server/src/data/game_engine.json`,
verified to return zero flagged decisions after the fix) — worth re-running after any
future content addition to catch the same content-completeness gap early.

**The exact same bug, independently affecting `target.*` fields, on a much larger scale —
now a permanent test, not just a one-off scan.** A player reported "Forged Regulatory
Violation Notice" (mail a forged violation notice to a rival's clients) showing only a cash
cost, no visible harm to the rival at all despite the description clearly promising one.
Root cause was identical to the pass above, just on the *attacking* side of the ledger this
time: its `impacts` already declared a `target.scrutiny` field — the right slot for "this
attack raises the rival's regulatory exposure" — but its schedule was `{"default": 0}`,
never filled in, so `summarizeEffects` silently dropped the line. Re-running the same
all-schedule-values-zero scan across the whole library (not just the field subset the first
pass checked) found this was far from a one-off: **81 of 212 decisions, 104 individual
fields**, split roughly 24 `target.*` placeholders (all on `Dirty`, `offensiveAction: true`
decisions — `target.scrutiny`/`target.outrage`/`target.demand`) and 80 own-field
placeholders the first pass's narrower field-and-decision selection had missed (`scrutiny`/
`outrage`/`demand` on decisions that already had a *different* real benefit field alongside
the dead one, plus a handful of purely-cosmetic `carbonFootprint`/`odorComplaints`/
`stockVolume` placeholders — cosmetic fields have no formula reference and don't affect
balance, but a zero schedule still means the effect line silently never renders, which is
the actual player-facing complaint here). Fixed by filling every one of the 104 with a
real, signed value, using the sign convention the existing non-zero examples of each field
already established: own `scrutiny`/`outrage` negative = benefit (reduces risk/backlash),
positive = cost (draws attention); own `demand` positive = grows sales, negative = hurts
them; `target.scrutiny`/`target.outrage` positive = harms the rival (their own risk/backlash
goes up); `target.demand` negative = harms the rival's sales; `carbonFootprint`/
`odorComplaints` positive = worse, negative = better — magnitudes calibrated against each
field's observed range in the library, scaled by the specific decision's described severity.
This time the scan was turned into a committed regression test
(`server/src/data/gameEngineData.test.ts`) instead of staying a throwaway script, precisely
because the first pass's "worth re-running" note was never actually re-run — closing that
gap is the point: any future content addition with the same picked-the-right-field/
forgot-the-value gap now fails `npm test --workspace=server` immediately instead of waiting
for another player report.

### The EFFECTS panel's "Ongoing" label was genuinely ambiguous — fixed by splitting duration AND audience

A user-reported "almost all say ongoing and it's not clear how long they are ongoing" led
to auditing what the old flat `Ongoing: X` label (`GamePhase.tsx`'s `summarizeEffects`) was
actually claiming, per field. It turned out to mean two different things depending on which
kind of field it was attached to, and the label didn't distinguish them:

- An own (non-`target.*`) field's trailing `'default'` schedule value applies exactly
  ONCE, at the turn the decision matures, and is never re-applied after that — see
  *"Root historical bug, worth remembering the shape of"* above. The field's new value
  simply stays that way going forward; nothing ticks every turn. `Ongoing` implied
  recurrence that never actually happens — the accurate word is `Permanent`.
- An ABSOLUTE `target.*` field's trailing `'default'` value is the opposite:
  `collectTargetImpacts` genuinely re-applies it to the targeted opponent EVERY turn, until
  `gameSettings.statuteOfLimitationsYears` (or a successful lawsuit voids the instance
  first) — this really is recurring, and `Ongoing` never said how long. Relabeled
  `Every turn until Yr N` (or just `Every turn` where the caller doesn't have
  `statuteOfLimitationsYears` on hand, e.g. the Decision Deck before `gameSettings` has
  loaded — the "until Yr N" qualifier is dropped, never shown wrong). A RELATIVE `target.*`
  field used to get this same label too, but that was later found to be actively
  misleading — see *"The exact same compounding bug existed on the target.* side too"*
  above: a relative target field no longer keeps re-applying past its own maturity (that
  was a real, separate bug, not a labeling issue), so it's labeled `Permanent` instead,
  same as an own field.

Fixed in `summarizeEffects` (`GamePhase.tsx`, duplicated in `GameTimelineView.tsx` per the
usual convention below), which now takes an optional `statuteOfLimitationsYears` param and
tags each `EffectLine` with `isTarget`. A companion **effects on you vs. effects on
target** split — the second half of the same report — replaced the old flat effects list:
a new shared `EffectsList` component (also duplicated into `GameTimelineView.tsx`) groups
lines into an **EFFECTS ON YOU** stack and, only when the decision actually has a
`target.*` field, a separately-headed, orange-labeled **EFFECTS ON TARGET** stack —
previously a `Target's …`-prefixed row just sat inline among the deploying player's own
KPIs, easy to miss. All three effects-detail call sites (`DecisionDetails`, shared by
`ActiveDecisionCard`/`QueuedDecisionCard`, and `DecisionCard`'s own inline copy in the
Decision Deck) now thread `statuteOfLimitationsYears` down from `gameSettings` and render
through `EffectsList`, so the labeling/grouping can't drift between the three.
Regression-tested in both `GamePhase.utils.test.ts` and `GameTimelineView.utils.test.ts`
(each file's own duplicated copy of `summarizeEffects`), covering both labels, the
`isTarget` split, and the "until Yr N" qualifier appearing/disappearing correctly.

### Market share is real economics now — a right-sized, player-count-scaled pie, plus real-world demand elasticity

A user-reported "does market share actually do anything, does revenue drop when share
drops?" led to an investigation that found: no, in practice, never. `marketShare` only
ever fed into one formula, `theoreticalVolume = marketShare * totalMarketVolume`, and
actual `volume = MIN(theoreticalVolume, maxSupply)` — but the old
`totalMarketVolumeTonnesPerYear` constant (10,000) was so far above any realistic
per-player `maxSupply` (`installedCapacity * capacityUtilization`, 350 at start) that a
player would need to fall to ~3.5% market share before it ever became the binding
constraint. Verified directly against the real formulas: even an extreme, unrealistic
scenario (one player's price set 30× a rival's — far beyond what any real decision or
stack of decisions can produce, the single largest seeded price swing being +27%) only
just barely pushed the disadvantaged player below that threshold. Every decision whose
*only* effect is on `processingLevel`/`supplySecurity`/`processLoss`/`demand`/`price` —
roughly a quarter of the whole library — moved the on-screen "Market Share" percentage
with zero effect on revenue in essentially any real game.

**Fix 1 — the pie now scales with the room's own active player count, not a flat
constant.** `GameSettings.totalMarketVolumeTonnesPerYear` was renamed to
`marketVolumePerPlayerTonnesPerYear` (400 by default) and represents ONE player's
theoretical entitlement at parity, not the whole market — `GameLoop.
computeEffectiveTotalMarketVolume` (thin wrapper around `calcEngine.ts`'s
`calculateEffectiveTotalMarketVolume`) multiplies it by `activePlayerCount` before
`theoreticalVolume` ever sees it. This matters because a flat constant splits very
differently depending on room size: the same 10,000-ton pie gave a 2-player game roughly
double the per-player headroom of a 4-player game (the more common case being 2-player,
since a lone waiting player gets a bot opponent — see *Server-injected AI bot player*
above) — meaning a flat number either left 2p games too slack to ever matter, or made a
brand-new/idle 4p player get squeezed at pure parity for no skill-related reason at all.
With the per-player figure, a 2p and 4p game both start with the identical per-player
headroom over `maxSupply` at round-1 parity (preserving the existing idle-breakeven
invariant — see `gameLoop.simulation.test.ts`'s dedicated regression test), and it's only
once a REAL competitiveness gap opens from actual decisions that the disadvantaged
player's volume — and therefore revenue — visibly drops.

**Fix 2 — real-world demand elasticity: an industry-wide price move now changes the size
of the WHOLE pie, not just each player's slice of a fixed one.** Previously `price` only
ever affected a player's own relative *share* (via `competitiveness`'s `1/price` term) —
if everyone in the game raised prices together, nothing would happen to total volume sold,
which isn't how real markets work (higher prices industry-wide should reduce how much
total demand gets satisfied). New `Formula`, `marketDemandElasticityFactor` — `MAX(0.3,
MIN(2.0, 1 - demandPriceElasticity * (avgPrice - referencePrice) / referencePrice))` — a
bounded LINEAR approximation of elasticity (the formula grammar has no exponent operator,
only `+ - * /` and `MIN`/`MAX` — see `formulaEngine.ts`'s security-motivated whitelist),
clamped to a 0.3×-2.0× band so a handful of extreme-price decisions can't zero out or
triple the market. `avgPrice` is the mean price across every ACTIVE player this turn —
computed once in `GameLoop.computeEffectiveTotalMarketVolume` (needs the whole room at
once, unlike every other per-player input `calculateVolume` reads) — and
`demandPriceElasticity`/`referencePrice` are new `AdminVariables.competitiveness` fields
(1.0 and 675 by default), editable live from `/admin` like every other tuning knob here.

**`GameSettings.marketFixed` — a field that already existed but was never actually wired
up to anything** (validated and stored by the admin schema, never read anywhere in the
engine) — repurposed as this whole mechanic's on/off switch rather than adding a new
field, matching its apparent original intent: `true` keeps the simpler, original
behavior (flat per-player-scaled pie, no price response); `false` (the new default) turns
on `marketDemandElasticityFactor`. `calculateEffectiveTotalMarketVolume` also guards
against a misconfigured `referencePrice <= 0` (falls back to the unscaled base rather than
dividing by zero).

Verified via the same randomized-simulation methodology as every other balance pass in
this file (see *Randomized-simulation testing* below): a dedicated diagnostic run isolating
the pie-resize from the elasticity (holding everything else constant, same seeds) found
NEITHER changes 2-player average round length at all — a real, separate, PRE-EXISTING
characteristic of two actively-adversarial random players in this specific harness
(never previously measured with only 2 players; every earlier balance pass in this file
happened to only ever simulate 4-player games). The 4-player average round length (the
apples-to-apples comparison against this file's own documented ~11-18-round history)
stayed consistent with the pre-change baseline (~12-15 rounds either way, well within the
engine's own run-to-run variance from non-seeded legal-verdict draws). The actual target
of this change — decisions that only move `processingLevel`/`supplySecurity`/
`processLoss`/`demand`/`price` — went from completely inert (0% effect on revenue,
confirmed directly against the formulas before the fix) to showing a real, measurable
win-rate spread (roughly 25%-55% depending on the specific decision, across both 2p and 4p
runs) once genuinely used in full games.

Regression-tested at the formula level (`calcEngine.test.ts`'s dedicated
`calculateEffectiveTotalMarketVolume` describe block: player-count scaling, elasticity
direction both ways, the 0.3-2.0 clamp, the `referencePrice <= 0` guard, `marketFixed`
disabling elasticity entirely) and at the full-turn level
(`gameLoop.test.ts`'s own describe block, using a dedicated small config rather than this
file's shared fixture — which deliberately keeps its own pie huge/inert so every OTHER
test in the file stays unaffected by this change): a competitiveness disadvantage now
costs real revenue: the 2p/4p pie-scaling parity check; elasticity shrinking volume
identically for two symmetrically-priced players; a price hike by ONE player shrinking
volume for a completely uninvolved bystander (proving this is a genuine aggregate/macro
effect, not just relative redistribution between the two, which the pre-existing `1/price`
competitiveness term already covered); and `marketFixed: true` provably disabling the new
mechanic. If you add a new decision or retune any of these fields, `game_engine.json`'s
own "every decision has a real benefit" scan (see *Every decision must bring a real
benefit* above) still doesn't check for this specific dynamic — worth remembering that a
`processingLevel`/`supplySecurity`/`processLoss`/`demand`/`price`-only decision's value
now genuinely depends on `marketVolumePerPlayerTonnesPerYear` being kept small enough
relative to typical `maxSupply` for market share to keep mattering as the game
(and installed capacity) grows.

### Decision costs are now company-size-scaled — a real-world dynamic this engine previously had no mechanism for

A follow-up question ("could company size — stock price, assets, equity — affect the cost
of a decision, since that happens in real life?") found the codebase already believed in
this idea for two OTHER subsystems, just never extended it to decision deployment costs
themselves: `wealthScaledFee` already adds a surcharge (`wealthScaledFeeRate`, 3%) on top
of the three instant, out-of-band fees (`digDeeperCost`/`lawsuitFilingCost`/dig-on-a-case),
scaled by the payer's own current cash; a `relative`-type legal-risk ground's stakes
already scale off the *defendant's* own current `equity`/`revenue` (see *Statute of
limitations & relative-type legal-risk stakes* above). But a decision's own `cash` cost —
119 of 212 decisions use a flat, `absolute` dollar amount; only 1 uses `relative`, which
already scales itself — stayed identical for a round-1 startup and a $2M-equity late-game
giant.

Fixed by extending the exact `wealthScaledFee` idea to decision deployment costs: a new
`gameSettings.decisionCostWealthScaleRate` (1% by default — deliberately smaller than
`wealthScaledFeeRate`'s 3%, since decisions deploy far more often per game than litigation
fees do, and a comparable rate risked pricing a wealthy late-game player out of deploying
*anything* — verified via the randomized-simulation methodology, see below) adds that
fraction of the deploying player's OWN current cash on top of any NEGATIVE absolute `cash`
schedule value, in `calcEngine.ts`'s `applyDecisionImpacts` — the single function both
Step 1 (`processNewDecisions`, deployment year) and Step 2 (`advanceAndApply`, every
subsequent maturing year) already funnel through, so this applies uniformly whether the
cost lands at deployment or is genuinely backloaded to a later year (scaling off whatever
the player's cash actually is THAT year, not what it was at deployment — the more
realistic reading of a bill due years later). Threaded through
`DecisionEngine.applyImpactsForYear`/`applyInstance`/`advanceAndApply` as a plain optional
parameter (default 0, same safe-default convention as `BotCogsContext` elsewhere in this
file) so every existing caller/test is unaffected unless it explicitly opts in.

**Deliberately costs-only, by explicit product decision**: a POSITIVE `cash` value (a
windfall) is never scaled down. Extending this to also shrink windfalls for large
companies was considered and explicitly deferred — it's a bigger-scope change (would need
auditing all ~119 decisions' positive-cash cases for what "shrinks with size" even means
per decision, not just adding one surcharge line) versus the low-risk, self-contained
costs-only version shipped here. Also deliberately scoped to the literal `cash` field only
— not `operatingExpenses`/`staffCost`/`financeCost` (`DOLLAR_FIELDS`) or any other
dollar-shaped field, since those are PERMANENT baseline shifts (see the "Root historical
bug" note above), not one-off-ish spends the "big company pays a premium" framing fits.

Verified via the same randomized-simulation methodology as every other rate in this file:
a batch comparison (rate 0 vs. the shipped 0.01 vs. 0.03, matching `wealthScaledFeeRate`
for reference) showed a modest, monotonic, non-alarming trend — average round length
12.98 → 11.78 → 11.03 as the rate increases, clean-single-winner rate staying 95-97%
throughout — nothing resembling the kind of runaway collapse a too-aggressive rate would
produce. Regression-tested in `calcEngine.test.ts`'s dedicated `costWealthScaleRate`
describe block (surcharge scales with the payer's own cash, a poorer player pays
measurably less for the identical decision, windfalls are never touched, a `relative`-type
cash impact is left alone since it already self-scales, the rate-0 default is fully
backward-compatible, other `DOLLAR_FIELDS` are untouched) and at the full-turn level in
`gameLoop.test.ts` (an A/B same-seed comparison isolating the exact surcharge amount
through a real `resolveTurn`, plus the poorer-player and rate-0 cases).

### Deck retune following the target-effect-compounding and market-share fixes

A deck audit prompted by the two fixes above (see *The exact same compounding bug existed
on the target.* side too* and *Market share is real economics now*) found two clusters of
decisions whose real-world power level had shifted out from under them without their own
numbers ever being touched:

- **17 decisions** (`Bot Attack`, `Feather Duster Sabotage`, `Hostile Supply Chain Choke`,
  `Predatory Logistics Squeeze`, `Manufactured Union Strike Wave`, `Supply Extortion
  Threat`, `Vertical Foreclosure Play`, `Sabotaged Delivery Manifest`, `Tire-Spike Delivery
  Route`, `Fake Union Organizer Plant`, `Poached Driver Sabotage`, `Malware-Laced Invoice
  Email`, `Bribed Weighbridge Operator`, `Rigged Union Vote Leaflets`, `Compromised
  Supplier Contract Leak` — the 15 single-stage decisions from the compounding-fix
  section above, plus `Aggressive Sale`/`Seasonal Discount Push` from the market-share
  section) needed a second look once their underlying mechanics started actually working
  as designed for the first time.
- The 15 single-stage relative `target.*` decisions had their magnitude increased ~1.5×
  (e.g. `Bot Attack`'s `target.capacityUtilization`: -20% → -30%; `Predatory Logistics
  Squeeze`'s `target.logisticsCostPerTon`: +7% → +10.5%) — now that they correctly land
  once and hold (not compound), their original -18%/-25% single-hit magnitude read as
  underwhelming for a `Dirty`-nature decision carrying real legal risk, especially next to
  the 3 two-stage decisions in the same cluster (`Patent Portfolio`/`Raw Material
  Monopoly`/`Union Agitation`, left untouched — their existing 2-stage schedules already
  compound to -28% to -40.5% total, the natural target band the 15 single-stage ones were
  bumped toward for internal consistency within the attack cluster).
- `Aggressive Sale` (`price`: -9%) and `Seasonal Discount Push` (`price`: -2.4%) — the two
  MARKET-share-only decisions that cut price — gained a new -$15,000/-$8,000 `cash` cost
  each. Both previously had NO direct cash cost at all (only legal-risk exposure), which
  was fine when a price cut only reshuffled a fixed pie between players; now that
  `marketDemandElasticityFactor` also grows the WHOLE pie a little whenever the average
  price dips, these two get a genuine second benefit on top of the original one, so a
  small compensating cost was added. Deliberately NOT applied to the other 2
  market-share-only decisions (`Small-Batch Artisan Line`/`Shrinkflation Repackaging`,
  both price INCREASES) — those now face a new elasticity HEADWIND instead (their own
  price hike shrinks the whole pie a little, on top of already hurting their own
  competitiveness) — an appropriate emergent check the mechanic already provides for free;
  adding a second penalty on top would double-count it.

Verified the same way as every other change in this file: a same-seed A/B simulation
(120 games) comparing the deck before/after found average round length dropped modestly
(11.45 → 10.96 rounds — attacks now land with real weight, so games resolve a little
faster) with clean-single-winner rate unchanged (97.5% either way) — no instability. The
retuned decisions' individual win rates are noisy at this sample size (7-29 uses each) but
trend upward as intended, and the two newly-costed price-cut decisions stayed clearly
viable (30-45% win rate) rather than being tanked by the new cost.

### Risk Gauge — 5 weighted terms, all DB-backed and admin-editable

`calculateRiskGauge` blends 5 terms (`w1..w5`, `RiskGaugeConfig` in `game_config.json`):
legal exposure ratio, scrutiny, outrage, **ownership risk**, and **solvency risk** — the
last two are additions beyond the original 3-term design, added because the gauge (this
game's one "am I in danger" glance) was silent about two entire independent loss
conditions.

**Ownership risk** (`calculateOwnershipRisk`) is the single largest real-player stake,
scaled linearly against `admin.ownership.takeoverThresholdPercent` (0 at 0% held, 1.0 at
the threshold) — deliberately not `1 - selfOwnership`, so dilution spread across several
minority holders reads as low risk while one concentrated buyer closing in reads as high
risk. Fixed a related dead-config bug along the way: the actual merger-elimination check in
`gameLoop.ts` used to hardcode `fraction > 0.5` instead of reading this same threshold.

**Solvency risk** (`calculateSolvencyRisk`) asks "could my open lawsuits bankrupt me next
turn": a cheap linear extrapolation, `predictNextTurnCashLinear(cashAfter, cashBefore) =
cashAfter + (cashAfter - cashBefore)` (deliberately not the real `predictFutureKpis`
sandbox — that would mean `resolveTurn` recursively re-running itself per player, per
turn), divided into the same probability-weighted open-case exposure `legalExposureRatio`
already computes, floored to avoid a divide-by-zero/sign-flip once cash is near zero.
`cashBeforeThisTurn` reuses `PlayerTurnContext.prevCash`, already snapshotted for the
bankruptcy waterfall.

Both terms are mirrored client-side in `ThreatView`'s `computeThreatTerms` (same
"duplicate small pure logic, keep in sync by hand" convention used elsewhere) — non-
clickable rows, since neither has a single persisted field to chart.

### Formulas are DB-backed — but only the pure-math half

Turn-resolution math splits into two kinds. **Pure, scalar, named-input formulas**
(competitiveness, P&L, balance sheet, legal-risk probability, risk gauge — 23 named
expressions) live in the `Formula` table, seeded from `defaultFormulas.ts`, editable live
from `/admin`'s Formulas tab. **Everything procedural/order-dependent** (execution order,
depreciation-ledger iteration, bankruptcy/merger waterfall, FIFO tie-breaking) stays plain
TypeScript control flow and always will — don't try to make it data-driven too.

`server/src/engine/formulaEngine.ts` is a small hand-rolled recursive-descent parser/
evaluator — **deliberately not `eval`/`new Function`/`vm`** (arbitrary-code-execution
risk). Grammar: numbers, identifiers, `+ - * /`, unary `-`, parens, and exactly `MIN`/`MAX`
as whitelisted calls — nothing else. Add new builtins to this whitelist deliberately;
never reach for `eval`/`Function`/`vm` as a shortcut.

The formula key set is fixed — no create/delete via `/admin`, only `PUT`, since each key is
hard-referenced at a specific `calcEngine.ts` call site with no safe-deletion guard
possible. Every write is validated twice: real syntax parsing, and a fixed per-key variable
whitelist (`FORMULA_VARIABLES` in `validation/schemas.ts`) — keep this in sync with actual
`evalNamed` call sites or it stops protecting anything.

### JSONB game state, typed columns only for what needs querying

`Company.variables`, `Company.engineState`, and `Company.lastTurnSnapshot` are JSON columns
so `GameLoop` can read/write full per-player engine state atomically without a migration
per new field. `cash`/`debt` are separate typed Decimal columns purely for fast queries
(bankruptcy checks, standings). Don't promote engine-state fields to typed columns unless
they need to be queried outside the engine.

### Shared types live in `shared/src/`

`shared/src/index.ts` — room/player/socket-event types, enums, payloads. `shared/src/
gameTypes.ts` — engine types (`DecisionDefinition`, `PlayerVariables`, `LegalCaseData`,
`TurnResolutionResult`, `GameConfig`). Both workspaces resolve `@suethemchickens/shared`
straight to source via path alias — no build step needed to see changes during dev.

### Client: no path-based routing for game phases — `/` is a content hub, the game is `/play`

`App.tsx` renders WAITING/GAME_PHASE/AFTERMATH directly off server-authoritative
`currentPhase` in a plain `switch`, no `<Routes>`, no URL change — these have no deep-link
value (no room id in the path, nothing bookmarkable). Don't reintroduce phase-driven
`navigate()` calls; react to phase changes with a plain `useEffect` instead.

Seven real, static URLs exist alongside that phase switch, each checked via
`window.location.pathname` ahead of it, since none has any relationship to game state:
`/admin` (`AdminPortal.tsx`), `/` (`Home.tsx`), `/whats-new` (`WhatsNew.tsx`),
`/how-to-play` (`HowToPlay.tsx`), `/rules` (`Rules.tsx`), `/strategy`
(`StrategyGuide.tsx`), `/glossary` (`Glossary.tsx`), and `/devlog` (`Devlog.tsx`). None of
these uses `<Routes>`/`<Link>` — just a plain pathname check and ordinary `<a href>`/
`Button component="a"` navigation (a real full-page load, not a client-side transition —
deliberate, since it keeps each one a genuinely separate, independently-crawlable
request). `BrowserRouter` still wraps the app purely for `Matchmaking.tsx`'s
`useSearchParams` (`?room=` invite links).

**`/` is `Home.tsx`, not the game.** The actual game (`Matchmaking.tsx`, then the phase
switch) lives at `/play`. `Home.tsx` is a real content hub: a pitch, a "Play Now" button,
and a grid of links to every static page above. This split — and the whole cluster of
static pages it fans out to — exists because of a real AdSense rejection; see the next
section. One deliberate back-compat wrinkle: `App.tsx`'s `isHomeRoute` is `pathname ===
'/' && !hasRoomParam` — a `/?room=<id>` link (the format `Matchmaking.tsx` generated
before this split existed) still falls through to the phase switch and opens the join
flow exactly as before, rather than stranding an already-shared old invite link on the
hub. New invite links (`ShareButton`'s `url` prop) are generated pointing at
`/play?room=<id>` directly; the root-level form only matters for links shared before this
change shipped. Regression-tested in `tests/e2e/matchmaking.spec.ts`'s "Root URL routing"
block: a bare `/` shows the hub (not the name-entry form), and `/?room=<id>` still opens
"Join a Room" with the code pre-filled.

### AdSense "low-value content" rejection — real, crawlable content pages, not just a modal

AdSense rejected the site with "Google-supplied ads on screens without publisher-content /
low-value content." Root cause: the landing page's only real explanatory text (an "About"
section) lived inside a Mantine `Modal` that never rendered unless a visitor clicked a
button — to Google's reviewer, the page where `AdSlot`'s landing placement lived
(`Matchmaking.tsx`, at the time still mounted at `/`) was just a hero image, four buttons,
and a name field, with essentially zero visible publisher content anywhere near the ad.

Fixed in two rounds. **First round** (content, same URL): the About text moved out of the
modal into a real, always-visible "How to Play" section on the page itself, and two new
pages — `/whats-new` (a changelog) and `/how-to-play` (a screenshot walkthrough) — gave
the site real content beyond the thin landing shell.

**Second round** (structure): a follow-up request for a proper rules reference, strategy
guide, legal-jargon glossary, and devlog — plus "one page that leads to all of them and to
the game" — prompted a bigger split rather than piling more content onto `Matchmaking.tsx`
directly. `/` became `Home.tsx`, a genuine directory/hub page (see the routing section
above), and `Matchmaking.tsx` moved to `/play`, shedding the inline How to Play section
and its `AdSlot` — both moved to `Home.tsx`, which is now the page with real, substantial,
always-visible content (a pitch plus six real guide descriptions) sitting next to the ad,
while `/play` stays lean and conversion-focused with nothing competing for a returning
player's attention right next to the Join/Create buttons. Four new pages exist purely as
content in their own right, not just as an ad-adjacency trick:
- **`/rules`** (`Rules.tsx`) — the precise structured reference: category caps, the real
  default numbers (`server/src/data/game_config.json`), elimination conditions. Distinct
  in tone from `/how-to-play`'s narrative screenshots and `/strategy`'s advice.
- **`/strategy`** (`StrategyGuide.tsx`) — deeper strategic advice grounded in real,
  documented engine behavior (cash discipline given decision-cost wealth-scaling, the
  late-game lawsuit/takeover escalation, Buy Shares vs. litigation tradeoffs) rather than
  generic strategy-game platitudes.
- **`/glossary`** (`Glossary.tsx`) — plain-language definitions for the legal jargon a
  case's UI actually uses (Grounds, Stakes, Settled, Statute of Limitations, etc.) and the
  business/game terms alongside it (Dilution, Risk Gauge, Market Share, etc.), exported as
  `LEGAL_TERMS`/`BUSINESS_TERMS` and alphabetized within each group — `Glossary.test.ts`
  asserts the sort and checks for duplicates.
- **`/devlog`** (`Devlog.tsx`) — six real engineering postmortems (the target-effect
  compounding bug, the bot's attacks never actually landing, the bot's own COGS-blind-spot
  self-bankruptcy saga, the `'settled'` mislabeling bug, the market-share fix, and this
  very AdSense rejection) adapted from this file's own bug writeups into plain-language
  stories for a general audience — distinct from `/whats-new` in both length and intent:
  that page is short player-facing patch notes, this one is "here's a bug and how we found
  it." `DEVLOG_ENTRIES` is exported and dated from the real commits that shipped each fix;
  `Devlog.test.ts` checks the entries are well-formed and sorted newest-first.

**The GDPR privacy policy text is a shared component now, not duplicated prose.**
`PrivacyPolicyModal.tsx` was extracted out of `Matchmaking.tsx` specifically because
`Home.tsx` needed the exact same legal text — unlike the small pure UI-logic functions
this codebase deliberately hand-duplicates per file (trend arrows, offer brackets, etc.,
see *Client-side duplicated pure logic* below), a legal document is exactly the kind of
content where two copies drifting apart would be a real problem, so this one is a genuine
shared component instead of the usual per-file copy.

`/how-to-play`'s "Read the Signs" section is also a genuine gameplay tip, not just SEO
padding: an incoming-attack hint card already quotes a line from the attacker's own
LLM-generated annual report (see *Local LLM annual-report blurbs* above) — often a
legible tell for what they actually deployed — so a player can frequently form a strong
guess for free by cross-referencing that against Competitor Intel's visible KPI swings,
rather than assuming Dig Deeper is a prerequisite for filing at all. `/strategy` repeats
this same tip in condensed form as its second strategic principle.

**Every static page now carries its own manual `AdSlot`, not just `Home.tsx`.** `/rules`,
`/strategy`, `/glossary`, `/devlog`, `/how-to-play`, and `/whats-new` each render an
`AdSlot` below their content `Paper`, same placement convention as `Home.tsx`'s own —
each with its own distinct env var (`VITE_ADSENSE_SLOT_RULES`/`_STRATEGY`/`_GLOSSARY`/
`_DEVLOG`/`_HOWTOPLAY`/`_WHATSNEW`), following the pre-existing "each placement needs its
own ad unit" rule `VITE_ADSENSE_SLOT_LANDING`/`_GAMEOVER` already established. Wired
through `client/.env.example`, `vite-env.d.ts`, `client/Dockerfile`'s ARG/ENV pairs, and
`.github/workflows/docker.yml`'s build-args, same shape as the original two slots — six
new GitHub Actions repo Variables (`ADSENSE_SLOT_RULES` etc.) need to exist for these to
actually render in production; until then `AdSlot`'s own "renders nothing without a
configured slot id" gate keeps them silently absent, same as any other unset slot.

**The cookie-consent banner now mounts only in `Home.tsx`, not sitewide.** It used to be
mounted unconditionally in `App.tsx`'s final return, which meant it could appear over any
phase — including a live GamePhase round, where a fixed bottom overlay asking for a
cookie decision has no good place to sit without covering a real-time control. Moved to
`Home.tsx` only: the decision now happens once, up front, on the hub page before a player
ever reaches `/play`, and never interrupts gameplay again. `Home.tsx` reserves the same
bottom-padding-while-visible space (`consentBannerVisible ? 140 : 0`) `App.tsx`'s old
mount used to, now scoped locally instead of wrapping the whole app. `Matchmaking.tsx`'s
own "Cookie Settings" button was removed along with this — reopening the banner has
nowhere left to render on `/play`, so the button would have been silently dead. A
consequence worth knowing: a player who reaches `/play` directly (an invite link,
`?room=`, a bookmark) without ever visiting `/` never sees the consent banner at all —
`advertising`/`analytics` consent simply stays at its default-denied value for that
visitor, same as anyone who explicitly rejects. `AdSlot`'s own "no consent, no ad" gate
already handles this gracefully (nothing renders, nothing crashes); this is a deliberate
product tradeoff (ask once, don't interrupt play), not an oversight.

**That tradeoff turned out to cost more than expected, so the banner now ALSO mounts on
`/play`'s landing branch — but nowhere else.** The "consequence worth knowing" above
stopped being hypothetical the first time real external traffic arrived: a r/WebGames
post drove 23 unique visitors and 7 played matches (measured in Caddy's access log — see
*Production deployment* above), and GA4 recorded literally **zero** of it. Every one of
them landed directly on `/play`, never loaded `/`, never saw the banner, so
`analytics_storage` stayed denied for the whole visit — and a denied visitor only
produces cookieless "modeled" pings, which Google won't surface below an aggregate
volume this site doesn't have. Since an external link essentially *must* point at `/play`
(`/` is a hub page, and r/WebGames' P4.iii bans linking a "collection or directory"),
that blind spot applied to all inbound marketing traffic, which is precisely the traffic
worth measuring. The GA4 tag itself was verified fine — `G-6HNSW83104` and the gtag
loader are both in the deployed bundle; nothing was broken, the visitors simply never
consented.

Mounted in **`Matchmaking.tsx`'s landing branch only** (the final return — name entry +
Join/Create), never the room-lobby branch above it, and never `GamePhase`/`GameOver`
(which `App.tsx` renders instead of `Matchmaking` entirely). The original objection is
respected rather than reverted: the landing screen is as passive as the hub page with
nothing time-sensitive to cover, and it's strictly *before* a player enters a room —
whereas the lobby's chat input has the same fixed-overlay problem a live round does.
Same `pb={consentBannerVisible ? 140 : 0}` reservation `Home.tsx` uses. Verified at a
390px mobile viewport that the banner doesn't cover the name field or the Quick Play CTA.
Regression-tested in `tests/e2e/matchmaking.spec.ts` ("a first-time visitor on /play sees
the consent banner", and a companion asserting it does NOT follow the player into the
room lobby) — E2E rather than unit, since this workspace runs Vitest without jsdom and
there's no pure logic to extract here beyond the one-line `consentBannerVisible`.

Two things this deliberately does NOT fix: a visitor who lands on `/play` and immediately
clicks Create/Join without answering still contributes nothing to GA4, and anyone who
rejects never will by design. The Caddy access log remains the ground truth for
marketing attribution; GA4 is the richer-but-partial view on top of it.

### Search-engine/crawler files — real favicon, robots.txt, sitemap.xml, per-page metadata

A follow-up audit ("are the search-engine-related files OK?") found several real gaps
beyond the AdSense content fix above, none of which had ever been addressed since the
project started from the default Vite template:

- **`client/public/robots.txt`** (new) — `Allow: /` sitewide, `Disallow: /admin` (nothing
  sensitive would leak since it's token-gated, but an admin panel showing up in search
  results is still worth avoiding), plus a `Sitemap:` pointer.
- **`client/public/sitemap.xml`** (new) — lists all 8 real static pages (not `/admin`).
  Update this by hand whenever a new static page is added — nothing generates it.
- **The favicon was broken** — `index.html` referenced `/vite.svg`, a file that never
  actually existed in this project (leftover boilerplate, silently 404ing on every page
  load). Replaced with a real one: `favicon.ico` (16/32/48px, multi-resolution),
  `favicon-16x16.png`/`favicon-32x32.png`, and `apple-touch-icon.png` (180px), all cropped
  from the existing `hero.png` key art (the angry rooster's head/comb — recognizable even
  at 16×16) via ImageMagick, not new art.
- **No meta description, Open Graph, or Twitter Card tags existed at all.** Beyond the
  generic SEO-snippet-quality problem, this directly undercut `ShareButton` (see its own
  section above) — a shared invite/brag link posted to WhatsApp/Discord/X/Slack rendered
  as a bare gray URL with no title/image, since those apps' link-preview scrapers read
  `og:title`/`og:description`/`og:image` from raw HTML and don't execute JavaScript.
  `index.html` now carries a real description plus `og:*`/`twitter:*` tags, all pointing
  at a new `client/public/images/og-image.png` — `hero.png` top-cropped to 1200×629 (the
  bottom row of desk clutter trimmed, title/characters kept) via ImageMagick, same
  size-vs-quality reasoning as `/how-to-play`'s screenshot re-encoding.
- **Every route shared one static `<title>`/description** (the homepage's own, since
  there's no SSR — `index.html` is one file for every path). `client/src/lib/
  usePageMeta.ts` is a tiny hook (`document.title` + the description `<meta>` tag,
  updated in a `useEffect`) called from every routable page except `Home.tsx` (whose
  content already matches the static defaults) — `Matchmaking.tsx`, `Rules.tsx`,
  `StrategyGuide.tsx`, `Glossary.tsx`, `Devlog.tsx`, `HowToPlay.tsx`, `WhatsNew.tsx`.
  Safe with no cleanup needed specifically because every one of these routes is a full
  page load (`<a href>`, never client-side nav — see App.tsx's own doc comment), so a
  page's own title never has to be "restored" for a previous page that might still be
  mounted. Deliberately does **not** attempt to vary `og:*`/canonical tags per page the
  same way — those are read by the same JS-less scrapers as above, so a client-side
  update would never reach them; true per-page OG tags would need real SSR, judged out of
  scope here. `og:url`/canonical stay pointed at `/` for every page as a result — a known,
  accepted limitation, not an oversight.
- **`ads.txt`** was already correct (added alongside the original AdSense setup) and
  needed no changes.

### Admin portal — env-var token, REST-only

Gated by a single shared secret (`ADMIN_TOKEN`), checked via constant-time compare on
every `/api/admin/*` request's `x-admin-token` header — no broader auth system exists in
this app (see *Reconnection & Session Resume* in the README for the general unauthenticated-
id-pair trust model). **Fails closed**: if `ADMIN_TOKEN` isn't set, the admin API returns
503. The token is never baked into the client bundle (don't add an `ADMIN_TOKEN`-shaped
`VITE_*` var — anything under `VITE_*` ships publicly); `AdminPortal.tsx` prompts for it
at runtime and keeps it in `sessionStorage`. Decisions/config/formulas are fetched once
(on auth, and again after a successful save), never polled — a background poll could
otherwise silently clobber an admin's in-progress edit. Rooms and the Analytics raw feed
poll every 5s, since those are genuinely live, read-only data.

### `Matchmaking` never unmounts across a room ↔ landing transition

`App.tsx` swaps phases by re-rendering different JSX inside the *same* component instance
— no route change, nothing that naturally resets local `useState` between "in a room" and
"back on landing." Any local state conceptually "scoped to the current room" needs an
explicit `useEffect` reset keyed on `room`/`room?.id`, not reliance on unmount — this bit
`isCreating`/`isSearching` (a stuck spinner after Leave Room) and lobby `chatMessages`
(leaking into the next room) before being fixed this way.

### `ShareButton` — the free-distribution growth loop (invite link + result brag card)

`client/src/components/ShareButton.tsx` is a single reusable component behind two
distribution surfaces, both zero-cost/organic (no ad spend, no backend involvement — pure
client-side use of the Web Share API): the room lobby's invite link and the Game Over
screen's result card. On a device that implements `navigator.share` (effectively all
mobile browsers, few desktop ones), clicking it opens the OS-native share sheet — every
messaging/social app already installed (WhatsApp, SMS, Discord, X, email, etc.) in one
tap, with zero per-platform integration work. Where `navigator.share` doesn't exist
(desktop), it falls back to a plain `navigator.clipboard.writeText` of `` `${text}\n${url}` ``
(`formatShareMessage`, the one pure/exported/unit-tested piece — see `ShareButton.test.ts`;
the two branches themselves aren't unit-tested, matching this workspace's established
"no jsdom, extract the pure logic instead" convention, see `AdSlot.test.ts`/
`googleConsent.test.ts`) and flips its own label to "Copied to clipboard!" for 1.5s, same
UX shape as `Matchmaking.tsx`'s existing icon-only `CopyButton`. Both failure paths (user
dismisses the native share sheet — a rejected promise, not an error; clipboard API
unavailable) are swallowed silently — same "must degrade invisibly" convention as
`llmService`/`eventLogService`.

**Room lobby invite**: shown to *every* player in the room, not just the host — gating it
to the host alone would cut the invite loop down to one person per room instead of up to
`maxPlayers`, and any player waiting for the room to fill has the same reason to invite a
friend. The plain copy-icon `CopyButton` next to it is kept as a secondary/manual option
(host-adjacent players who'd rather paste into a specific chat).

**Game Over result card**: shown once, right after the win/loss headline (not buried below
the KPI chart/happenings log), with distinct copy for a win vs. anything else —
`buildResultShareText` (`GameTimelineView.tsx`) gives a winner a stronger "I just won,
outlasted N rivals" hook rather than diluting it into "I placed #1/N," the same message a
runner-up gets. `computeFinalPlacement` derives a non-winner's placement from
`TimelinePlayerInfo`: the winner sorts first (their `bankrupt` is `false` at game end),
everyone else ordered by `eliminatedRound` descending
(survived longer = better placement) — not meant as authoritative tie-broken standings,
good enough for a one-line brag message only. Both functions are duplicated into
`GameTimelineView.utils.test.ts` rather than imported, same convention as every other
pure helper in that file (see *Client-side duplicated pure logic* below).

### Everything per-round is client-full-replacement, not incremental

`game:submitDecisions` sends the player's *entire* pending selection every time (strategic/
operational/financial + lawsuits); the server always treats it as a full replacement for
that in-flight turn, never a delta. Keep this in mind touching either the client
submission logic (`GamePhase.tsx`) or `GameLoop.submitDecisions`.

### Client-side duplicated pure logic — a deliberate, hand-synced convention

Several small pure functions exist in two places by design: server-authoritative math
(`GameLoop`/`calcEngine`) has a lightweight client-side mirror purely for instant UI
feedback (deployability checks, KPI trend arrows, threat-gauge breakdown rows, offer
brackets) — never for anything actually authoritative. `GamePhase.utils.test.ts`
deliberately duplicates the pure functions themselves (not imports) to keep that test file
free of the Mantine/tabler-icons import chain. If you change one side of a mirrored pair,
update the other by hand — there's no shared-module mechanism enforcing sync, on purpose,
to keep each side lightweight.

### Post-turn events are a passive, clickable News feed

Being sued, a lawsuit resolving/settling, a share purchase, and a new round starting are
modeled as a discriminated union `PostTurnEvent`, appended to `newsItems` (`{ id, round,
event }`) and rendered as a scrollable **News** box — nothing auto-pops a modal. Clicking a
row opens the same per-type info-window `Modal` this used to auto-open. **One case/purchase
per event, always** — an earlier version batched every same-kind event in a turn into one
News row (`{ cases: LegalCaseData[] }`), which read exactly like data loss to a player
skimming for "how many things happened"; fixed by flattening to one event per case.
`sharesBought` needs no diff against previous state — `GameLoop` already knows exactly who
bought what in `PlayerTurnResult.sharesBoughtThisTurn`, scoped to that turn's trades and
never emitted for a self-buyback.

**Deliberately not a News item**: the "someone else went bankrupt" notice lives in
top-level `gameStore.bankruptcyEvents`/`App.tsx`'s `BankruptcyModal`, not `GamePhase`'s
local `newsItems` — a bankruptcy can end the game and unmount `GamePhase` almost
immediately, which would silently drop anything queued in its local state. `BankruptcyModal`
renders as a `Modal` overlay *alongside* whatever phase is showing (not an early return
replacing it) — an earlier version fully replaced the page, freezing every surviving
player's view the instant anyone else went bankrupt. A forfeit's `player:bankrupt`
broadcast carries `reason: 'forfeit'` (alongside `'bankruptcy'`/`'merger'`), rendered with
distinct "🐔 CHICKENED OUT" copy/art rather than the generic bankruptcy notice.

**React `setState` updater callbacks must stay pure** — StrictMode calls them more than
once in dev specifically to catch impurity. Do array-diffing and the resulting
accumulating `setState` call in the effect body directly; never nest a non-idempotent
`setState` call inside another `setState`'s functional updater.

**A reconnect can re-trigger this same non-idempotence a different way** — `GameEngine.
rejoinRoom` re-sends the room's cached last-resolved-turn via the exact same
`ServerEvents.TURN_RESOLVED` event a live turn broadcast uses (any page refresh, a brief
network blip Socket.IO auto-reconnects from, or a dev-server restart), as a fresh object
with identical content. The turn-sync effect's own re-entry guard used to compare the
incoming `turnResults` by object REFERENCE (`processedTurnResultsRef.current ===
turnResults`) — built only to catch StrictMode's dev-only double-invoke of the *same*
object, it never accounted for a *different* object carrying the *same* round's data. Every
reconnect after a turn resolved re-ran the effect's `setNewsItems` append, silently
duplicating that turn's News items (a real, reported bug: "your shares were bought"
appearing several times for one real purchase). First fixed by comparing `turnResults.round`
alone instead of object identity — subsumed the StrictMode case (same object → same round)
while also catching the reconnect case (different object, same round) that reference
equality missed.

**That round-only fix then introduced its own regression, specifically for round 1** — a
second real, reported bug: decisions deployed in round 1 stopped showing up in the Active
Decisions list from round 2 onward. Root cause: `startGame` broadcasts TWO
`TURN_RESOLVED` events carrying the SAME round number by design — `broadcastInitialSnapshot`'s
always-empty `getInitialSnapshot` result (round 1, no decisions yet, sent before players can
even act) and, once the timer/all-ready triggers real resolution, round 1's actual
`resolveTurn` result (also tagged round 1, since `GameEngine.resolveGameTurn` reads
`currentPhaseRound` — still 1 at that point — and only increments it to 2 *after* resolving).
A round-only dedup key can't tell these apart: the guard treated the real round-1 resolution
as an already-processed duplicate of the empty starting snapshot and skipped `setMyData`
entirely, silently freezing `myData` (and therefore the Active Decisions list) on the empty
snapshot forever. Fixed by adding `TurnResolutionResult.isInitialSnapshot` (`true` only on
`GameLoop.getInitialSnapshot`'s output, never on a real `resolveTurn` result) and keying the
client's guard (`processedTurnKeyRef`) on `` `${round}:${isInitialSnapshot ? 'i' : 'r'}` ``
instead of `round` alone — a genuine reconnect resend still carries the identical key both
times (still deduped), but the empty snapshot and the real resolution for the same round now
have different keys and both get processed. Regression-tested at both layers:
`gameLoop.test.ts` (`getInitialSnapshot` always stamps the flag, `resolveTurn` never does)
and `gameEngine.test.ts` (`startGame`'s broadcast carries the flag, a real `resolveGameTurn`
round-1 broadcast doesn't) — same two-layer split as everywhere else in this codebase.

**`myData`/`competitors` are live memos of `turnResults`, not separate `useState`
snapshots** — a third real, reported bug surfaced by this same area: clicking "Dig
Deeper" charged the cost and computed the reveal server-side (confirmed via the DB write
and the socket response), but the card kept showing the OLD investigation level and CASH
kept showing the pre-deduction figure until the next full turn resolved, making the
button look broken. Root cause: `socketStore.ts`'s `GAME_DIG_DEEPER_RESULT` handler (and
the same-shaped `GAME_FILE_LAWSUIT_RESULT`/`GAME_LEGAL_CASE_UPDATE` handlers) patch the
*store's* `turnResults` directly (`applyDigDeeperResult` et al. in `gameStore.ts`) — but
`GamePhase.tsx` used to hold `myData`/`competitors` as their own `useState`, set ONLY
once per genuinely new turn inside the round-gated turn-sync effect above. Since none of
these three out-of-band actions resolve a whole new turn, the round-gated effect's guard
correctly (by design) skipped re-running, and the frozen `myData`/`competitors` state
simply never picked up the patch — the reveal/cash change silently sat in the store,
invisible, until the *next* real turn resolved and the effect finally ran again, at which
point the accumulated patch just blended in unnoticed. First reported as "dig deeper
isn't working in turn 2," but that's coincidental, not the actual trigger — round 2 is
simply the earliest point a player can have anything to dig into at all, since nothing
exists to reveal before round 1 has resolved once. Fixed by converting `myData`/
`competitors` from `useState` to `useMemo(() => turnResults?.players.find/filter(...),
[turnResults, player])` — always live, so ANY store mutation (a genuinely new turn, or
one of these three out-of-band patches) is reflected on the very next render, with no
separate "remember to also update the local copy" step to forget. The turn-sync effect's
own need for "the value from before this turn" (trend-arrow `prevData`/`prevCompetitors`,
and diffing for newly-sued/-resolved/-settled cases) no longer has `myData` itself to
read that from (by the time the effect's closure would see it, the memo has already
recomputed to the CURRENT value) — replaced with dedicated
`lastProcessedMyDataRef`/`lastProcessedCompetitorsRef`, updated only at the end of a
genuinely-new-turn pass, same as `processedTurnKeyRef`'s own gating.

### Game Timeline — Civilization-style game-over replay, also the live spectator view

`GameTimelineView` (`'live'` mode for an eliminated player who chooses to keep watching,
`'finished'` mode for Game Over) replaces the old dead-end "Return to Start" + static
standings table with a KPI race chart, happenings log, and ranked standings. Two new
persisted pieces made this possible: `Player.eliminatedRound` (set alongside `bankrupt:
true` at both write sites, and **synced onto the in-memory roster too**, not just the DB
row — the natural-bankruptcy loop previously only wrote the DB, leaving the live roster
stale) and `LegalCaseHistory` (one row per case, filed→resolved lifecycle, **no FK to
`Player`** — same reasoning as `EventLog`). A bankrupted player's final KPI snapshot
(`BankruptedPlayer.finalVariables/finalDerived/finalRiskGauge`) is now captured too — it
used to stop one round early, so Game Over could show a stale positive balance.

**Eliminated players are exempt from the disconnect grace-period sweep** (they can
`room:rejoin`/spectate indefinitely) — which required the stale-room cleanup check to
change from "every socket disconnected" to "every remaining player is *both* eliminated
and disconnected," or a normal player's ordinary reconnect grace period (also briefly
socket-less) would race the sweep into deleting the whole room out from under them.

`GameEngine.getGameTimeline` is pure serialization (no `GameLoop` involvement), reachable
in both `GAME_PHASE` and `AFTERMATH` — the first payload-less client→server request in the
codebase, and the first on-demand handler allowed in both phases.

**A "deployed X" happening's decision name is clickable**, opening a themed `Modal` popup
(same convention as every other popup: `title`/parchment styling) with that decision's
full details — description, level/nature badges, an effects timeline, and legal risks.
`GameTimelineView.tsx` duplicates the relevant chunk of `GamePhase.tsx`'s `DecisionDetails`/
`summarizeEffects`/`EffectsList`/`formatImpactValue`/`formatFieldLabel` rather than importing them (same
"duplicate small pure logic, keep in sync by hand" convention this file's own header
already establishes) — the `DecisionDefinition` itself comes from `useGameStore().decisions`
(the room's fixed deck, already populated and not reset by mounting this view), looked up
by name; a name with no match (an admin deleted the definition mid-game) shows a plain
fallback message rather than crashing the popup. Clicking the decision name
`stopPropagation`s so it doesn't also trigger the row's own "jump to this round" click.

**A lawsuit happening (filed or resolved) shows its stakes and the plaintiff's own known
odds**, both stamped once at filing time onto `LegalCaseHistory` (`baseProbability`/
`plaintiffFullyInvestigated` columns, added specifically for this — written only in
`recordLegalCaseHistory`'s `create` branch, never touched by the resolution `updateMany`,
matching the "stamped once" convention `plaintiffFullyInvestigated` already has on the live
`LegalCaseData`). Odds are shown as the same 5-band verbal likelihood
(`likelihoodLabel`/`Highly Unlikely`…`Highly Likely`) the live game uses, gated the same
way: `plaintiffFullyInvestigated` false (sued on a hunch, never actually knew the odds)
always shows "Unknown," never a number the plaintiff never had, regardless of what
`baseProbability` happens to hold (0 for a wrong guess/time-barred filing, a real value
otherwise — the gate is what matters, not the number itself).

**A resolved lawsuit happening names the actual winner and, when known, the real dollar
amount.** Two real, reported gaps here: first, `happeningLabel`'s verdict text used to say
"won by the plaintiff"/"lost by the plaintiff" — technically accurate but useless, since
the "X vs. Y" header right before it already establishes who the plaintiff is; a reader
has to do their own lookup to find out who actually won. Fixed by naming the winner
directly ("won by Alice"/"won by Bob") instead of their fixed case role. Second, no dollar
amount was ever shown for a resolved case at all, even though a WON verdict's payout is
always exactly `stakes` (see `GameLoop.resolveTurn`'s Step 9) and a SETTLED case's payout
is whatever the last accepted offer was — which can differ from the pre-trial `stakes`
estimate. `LegalCaseHistory.resolvedAmount` (new column) stores this: `stakes` for 'won',
`offers[offers.length-1]?.amount ?? stakes` for 'settled' (mirrors `GamePhase.tsx`'s own
live "Settled — you received/paid X" News item math, now finally shared rather than
recomputed ad hoc), `null` for 'lost'/'cancelled' (no payment). Computed once by
`GameEngine.resolvedCaseAmount`, written by both of `recordLegalCaseHistory`'s write sites
(the upsert's `create` and the resolution `updateMany`) so they can't drift. `getGameTimeline`
maps a `null`-or-missing value to `undefined` (loose `!= null`, not strict `!==` — a row
written before this column existed has no key at all, not literally `null`, and the two
must be treated the same way client-side or `Number(undefined)` produces `NaN`).
`happeningLabel` (both the real copy and `GameTimelineView.utils.test.ts`'s duplicated
one) appends `(amount)`/`for amount` only when `resolvedAmount` is present.

**A Buy Shares happening shows the acquired stake percentage.** `TimelineDecisionEvent.
acquisitionFraction` mirrors `DeployedDecision.acquisitionFraction`/`SharesBoughtEvent.
fractionBought` — the fraction of the WHOLE target company acquired in that one purchase,
not the buyer's resulting total stake — populated in `GameEngine.getGameTimeline` straight
off the persisted `PersistedDecisionInstance` (no extra query; the instance already carries
it). `happeningLabel` appends `(acquired N% stake)` whenever it's set, same `Math.round(x *
100)` convention `revealAttack`'s "Acquired N% ownership stake" effect summary already
uses; the decision-detail popup's context line shows it too. Undefined for every other
decision, so the label falls back to its ordinary "deployed X → Y" phrasing unchanged.

### Chat spans all three phases via a client-side `chatStore`, continuous history

`GameEngine.sendChatMessage` dropped its old `status === WAITING` gate entirely — chat
works in the lobby, mid-game, and post-game alike. Client-side, history moved out of any
one page component into a standalone Zustand `chatStore` (`resetForRoom(roomId)` only
clears on an actual room change, never a phase change, so lobby→game→gameover is one
continuous conversation) with a floating `ChatWidget` fab+popup on the game and
finished-game screens, plus the lobby's existing inline box reading/writing the same
store. Gotcha worth remembering: `position: fixed` on the element a Mantine `Indicator`
badge wraps breaks the badge's positioning (the fixed element collapses out of normal
flow) — put the fixed positioning on a wrapping `Box` instead, badge/`ActionIcon` inside it
positioned normally.

### Player Feedback — anonymous REST endpoint, not a socket event

`POST /api/feedback` (public, unauthenticated, validated by `feedbackSubmitSchema`) is
plain REST specifically because the landing page (one of two entry points) has no
room/socket context to piggyback on — using a different mechanism just for the game-over
entry point would make the two forms behave differently for no reason. `Feedback` has **no
FK to `Player`/`Room`** at all, by explicit product decision (fully anonymous everywhere,
even at game-over where context would technically be available). One shared `FeedbackForm`
component, embedded in two shells (`Matchmaking.tsx`'s inline button+Modal,
`FeedbackWidget.tsx`'s floating fab mirroring `ChatWidget`'s shape at bottom-left). Admin
portal's Feedback tab is read-only, polled alongside Rooms.

### Consent-gated Google Analytics/Ads — GA4 tag always installs, AdSense's ad script doesn't

`client/src/lib/googleConsent.ts` implements Google Consent Mode v2 (the signal-passing
protocol Google requires before any of its ad/analytics scripts may request personalized
ads or set non-essential cookies), backed by a sitewide `ConsentBanner.tsx` +
`consentStore.ts` (Zustand, `localStorage`-persisted under `stita_consent`). `main.tsx`
calls `initConsentDefaults(storedChoice)` before React mounts, which always pushes a
fully-denied baseline first (`ensureDataLayer`'s `gtag` stub, not the real
`googletagmanager.com/gtag/js` library), then layers a returning visitor's already-stored
choice on top in the same synchronous tick, so there's no window where a consented visitor
is treated as denied.

**The two loaders are deliberately asymmetric, and that asymmetry is load-bearing — don't
"fix" it into symmetry again.** `loadAdSenseScript` (`VITE_ADSENSE_CLIENT_ID`) still injects
its `<script>` tag only once `advertising` consent is actually granted — a "the script
simply doesn't exist pre-consent" posture, since showing actual ads pre-consent is a real
UX/policy event. `loadAnalyticsScript` (`VITE_GA_MEASUREMENT_ID`) used to be gated the same
way on `analytics` consent, but that was a real, reported bug: Google's own GA4
tag-detection/"Realtime" checks never saw the tag at all for a visitor who hadn't yet
consented (i.e. everyone, on first load), so the property never registered as receiving
data. Fixed by calling `loadAnalyticsScript()` **unconditionally** from both
`initConsentDefaults` (regardless of `stored`) and `pushConsentUpdate` (regardless of
`categories.analytics`) — matching Google's own documented Consent Mode v2 pattern: the tag
installs on every page load; the `consent` `default`/`update` signals already being pushed
are what govern cookie/personalization behavior, not whether the script exists. With
`analytics_storage` denied, `gtag.js` sends cookieless, non-identifying pings instead of
setting `_ga` cookies — enough for Google's tooling to detect the tag and for
aggregate/modeled reporting, without tracking a denied visitor. Both loaders remain safe
no-ops with their env var unset (the default) — nothing here requires a real GA4 property
or an approved AdSense account to ship; `googleConsent.test.ts` covers the no-op-when-unset,
idempotent-when-called-twice, and (for GA4) consent-independent-load cases, all without a
DOM (`window`/`document` are stubbed by hand per test, since this workspace runs Vitest
without jsdom — no test needs a real browser here).

**A real, reported gap even after the tag-always-installs fix above: "the tag test passes
but the GA4 property shows zero data."** Root cause is timing, not the tag detection issue
already fixed — `gtag('config', ...)`'s automatic page_view fires the instant the async
`gtag.js` script finishes loading, typically within a couple hundred milliseconds of page
load, almost always before a human has had any chance to even see `ConsentBanner`, let
alone click it. That means for essentially every first-time visitor, the *only* hit ever
sent for that pageview is the automatic one, sent while consent is still denied — a
limited, cookieless "modeled" ping that Google's own tooling requires substantial
aggregate traffic volume before it'll surface in reports at all (Realtime included, in
many cases). A new/low-traffic site can realistically never clear that threshold, so the
property looks like it's receiving nothing even though the tag is, technically, working
exactly as designed. Fixed by having `pushConsentUpdate` take an optional
`backfillPageView` parameter (default `false`): when `true` and `categories.analytics` is
granted, it fires an explicit `gtag('event', 'page_view')` immediately after the `consent
update` signal — a second, genuinely non-cookieless hit reflecting the just-granted state,
recorded for that same visit rather than only ever the earlier denied one.
`ConsentBanner`'s three actions (`acceptAll`/`rejectAll`/`saveCustom` in `consentStore.ts`)
all pass `true`, since each is a live, in-session consent decision arriving strictly after
that load's automatic page_view already fired. `initConsentDefaults`'s own replay of an
*already-stored* decision on a fresh page load deliberately passes `false` (the default)
instead — that replay's `consent update` lands in `dataLayer` ahead of the upcoming
`config` call (both happen synchronously before the async script even finishes loading),
so *that* load's own automatic page_view already correctly reflects the stored consent
once `gtag.js` processes the queue; backfilling there too would just double-count every
returning consented visitor's pageviews for no benefit. Regression-tested in
`googleConsent.test.ts` (backfills only when both the flag and `analytics` are true; never
backfills on a bare `pushConsentUpdate(categories)` call) and `consentStore.test.ts` (all
three live actions pass `true`).

**The actual root cause, found after the backfill fix above still didn't resolve a live
"zero data in GA4" report: `ensureDataLayer`'s `gtag` stub used a rest parameter instead
of the `arguments` object.** Google's own official installation snippet is written
`function gtag(){dataLayer.push(arguments)}` — pushing the array-*like* `arguments`
object. This file's stub was instead written `function gtag(...args: unknown[])
{ window.dataLayer!.push(args); }` — a rest parameter, which pushes a genuine `Array`.
The two look interchangeable (both support indexing/`.length`/iteration identically for
every normal purpose, and `JSON.stringify`/deep-equality comparisons of the two look
the same), but `gtag.js`'s own internal command processing apparently distinguishes a
real `gtag()` call from its own internal bookkeeping entries by exactly this
`Array.isArray()` check, and silently drops anything that doesn't match — with zero
console errors, a fully-initialized `google_tag_manager` container (Enhanced
Measurement's scroll-depth auto-tracking and all), and a `dataLayer` array that looks
completely correct when logged. The observable symptom: the script loads (200), every
`gtag()` call queues correctly, Google's own Tag Assistant reports the tag as installed —
but not one single `/g/collect` network request is ever attempted, for the automatic
page_view or a manually-fired `gtag('event', ..., {debug_mode: true})` alike, and GA4
Admin shows "data collection is not enabled on your site" indefinitely.

This bug's own diagnostic trail is worth remembering, since every more-obvious suspect
gets ruled out before it: reproduced identically across three separate GA4 properties and
two separate Google accounts (ruling out property/account misconfiguration), on two real
devices/browsers/OSes over both WiFi and mobile data (ruling out the visitor's own
network/ad-blocker/browser), and even from a completely different sandboxed network with
a real non-headless Chromium instance (ruling out headless-bot filtering, which is a real
and separate phenomenon — see below — but was never the actual cause here). The
confirming step was a control test: a known-good, definitely-live GA4 property borrowed
from a real, unrelated public site sent a real hit successfully under the exact same test
harness, proving the harness itself was capable of a real collect request and narrowing
the search back to this codebase. From there, bisecting by rebuilding progressively
smaller slices of the real app (full app → consent code alone via a stripped `main.tsx`,
same Vite build → a hand-copied version of just `ensureDataLayer`) reproduced the failure
at every step until the literal `arguments`-vs-rest-parameter line was isolated as the
single change that mattered — confirmed by rebuilding the full production bundle with
only that one line changed and watching real `204` responses appear from
`region1.google-analytics.com`, `analytics.google.com`, and the AdSense/DoubleClick
conversion endpoint simultaneously.

`arguments` is unavailable inside arrow functions, so `ensureDataLayer`'s stub must stay
a plain `function gtag() {...}` expression, never `() => {}`, if this is ever touched
again. Regression-tested in `googleConsent.test.ts`'s dedicated `Array.isArray()`
assertion — deliberately a *separate* test from the ones checking `dataLayer` *content*,
since `toEqual`-style deep-equality assertions (Vitest's included) DO actually distinguish
an `arguments` object from a real `Array` holding the same elements, but only if a test
author thinks to check that specific property — every other test in the file normalizes
via `Array.from()` before comparing, since they only care about content, not shape.

**A separate, real phenomenon that came up during this investigation but was never the
actual cause: Google's own tags detect and silently filter headless/automated browser
traffic** (`navigator.webdriver === true`, a `HeadlessChrome` user-agent string, and
likely deeper fingerprinting) — confirmed by masking those specific signals and still
seeing no request in a genuinely bot-detected context, separately from this bug. This
means any FUTURE automated (Playwright/Puppeteer) check of whether GA4 is *actually*
sending real hits is fundamentally unreliable as a pass/fail signal — such a script can
confirm `dataLayer` state and that the script/config load correctly, but proving a real
`/g/collect` request fires needs either a real, human-driven browser, or a `headless:
false` real browser context with automation signals explicitly masked (still not
guaranteed against more sophisticated fingerprinting) — don't trust a headless "no request
seen" result as proof of a bug on its own; corroborate with DevTools Network tab in a
real session first, the way this investigation eventually did.

All four env vars (`VITE_ADSENSE_CLIENT_ID`/`VITE_GA_MEASUREMENT_ID`/
`VITE_ADSENSE_SLOT_LANDING`/`VITE_ADSENSE_SLOT_GAMEOVER`) are ordinary Vite build-time env
vars (see `vite-env.d.ts`) — safe to expose despite the `VITE_*` public-bundle convention
noted elsewhere in this file, since all four are public by nature (an AdSense publisher
ID, ad-unit slot id, and GA measurement ID are always visible in any site's shipped
HTML/JS, unlike `ADMIN_TOKEN`). Wired through `client/Dockerfile`'s build `ARG`/`ENV`
pairs (same shape as `VITE_SERVER_URL`) and, in CI, `.github/workflows/docker.yml`'s
`build-client` job pulls them from GitHub Actions repo **Variables**
(`vars.ADSENSE_CLIENT_ID`/`vars.GA_MEASUREMENT_ID`/`vars.ADSENSE_SLOT_LANDING`/
`vars.ADSENSE_SLOT_GAMEOVER`), not Secrets — there's nothing to protect by hiding a value
that ends up baked verbatim into the public client bundle either way. Leaving any/all of
them unset is fully supported and ships a working game with no ads/analytics.

**Manual ad placement, not Auto ads** — a deliberate product decision for this specific
game: Auto ads let Google's ML place ad units anywhere on the page it judges to fit,
which for a real-time 120s-round game risks landing an ad near/over an actual gameplay
control (Ready button, a decision card) — both a UX problem and an AdSense policy risk
(accidental clicks near ads next to interactive elements can trigger an "invalid click
activity" account penalty). `client/src/components/AdSlot.tsx` is a single reusable manual
ad-unit component instead, placed at exactly two call sites, both scroll-only/passive
areas with no time-sensitive clicking near them: below the landing page's interactive
`Paper` (`Matchmaking.tsx`, `VITE_ADSENSE_SLOT_LANDING`) and below the Game
Over/spectating screen's content (`GameTimelineView.tsx`, `VITE_ADSENSE_SLOT_GAMEOVER`,
shown in both `'live'` and `'finished'` mode) — never on the live `GamePhase` screen
itself. Each placement needs its own AdSense ad unit/slot id (`AdSlot`'s own `slot` prop),
since a single ad unit isn't meant to be reused across visually distinct placements.

`AdSlot` follows the same "the markup simply doesn't exist without consent" posture as
`googleConsent.ts`: renders nothing at all — not even an empty `<ins>` — unless a
publisher ID, a real slot id for that placement, AND granted advertising consent are all
present (`shouldShowAd`, the pure/testable gate — see `AdSlot.test.ts`). Reads consent
live off `useConsentStore`, so a placement appears the instant a visitor accepts, no
reload needed. `adsbygoogle.push({})` fires exactly once per real mount, guarded by a
`useRef` rather than DOM inspection — React StrictMode double-invokes effects in dev, and
a second push against the same `<ins>` throws "already have ads in this slot."

The Privacy Policy modal (`Matchmaking.tsx`, "Third-Party Services and Analytics" section)
names both services and states scripts are blocked until explicit consent — keep that text
in sync if either mechanism's actual behavior changes.

### Server-injected AI bot player — heuristic, not optimal, deliberately non-deterministic

When a lone player waits in a public (non-invite-only) room past a short delay
(`gameSettings.enableBotPlayers`, default on — see `GameEngine.scheduleBotJoinCheck`/
`addBotPlayer`), the server injects a bot opponent so they aren't stuck waiting forever.
`botService.ts` (`server/src/services/`) is pure decision-making, no Prisma/Socket.IO —
same "thin orchestration in `GameEngine`, tested logic in the service" split
`analyticsService.ts` established; `GameEngine.runBotTurn` (called from
`runBotTurnsForRoom`, fire-and-forget, right after each round's data settles) does the
actual I/O (`digDeeper`/`fileLawsuit`/`submitDecisions`/`toggleReady`) via the exact same
methods a real client's socket handlers call — never a bot-only path into `GameLoop`.

**Upgraded from pure-random after a user reported winning "using little thinking."** Still
deliberately not optimal/exhaustive (no lookahead, no `DecisionEngine.canDeploy`
pre-validation — an ineligible pick is just silently dropped by `GameLoop.
processNewDecisions` the same way a real rejected submission is) and deliberately **not**
a `game_engine.json`/`game_config.json` change — the bot is a difficulty/AI-quality lever,
never a game-balance one; those stay exactly as tuned by the randomized-simulation
methodology above. What changed is purely heuristic:

- **`scoreDecision`** ranks the deck by a rough cost-effectiveness score: the decision's
  own year-1 cash impact, plus every other own-effect field with a REAL formula reference
  (`price`/`capacityUtilization`/`installedCapacity`/`processingLevel`/`supplySecurity`/
  `processLoss`/`materialCostPerTon`/`logisticsCostPerTon`/`operatingExpenses`/
  `staffCost`/`otherIncome`/`demand`/`scrutiny`/`outrage` — see `defaultFormulas.ts`'s
  `competitiveness`/`cogs`/`ebitda` expressions), signed by whether that field helps or
  hurts. Deliberately excludes purely-cosmetic fields with no formula reference anywhere
  (`energyIntensity`/`moistureContent`/`nutrientConsistency`/`contaminationRisk`/
  `odorComplaints`/`breakdowns`/`carbonFootprint`/`stockVolume`) — scoring those would be
  noise, not signal. `price` counting as "higher is better" is a deliberate approximation
  (it actually also lowers `competitiveness`'s `1/price` term) — good enough given
  production is capacity-bound rather than market-share-bound in the vast majority of
  games (see the randomized-simulation methodology above), not claimed to be exact.
- **`pickBotDecisions`** splits the scored, affordable pool into a better half and a worse
  half (each independently shuffled, better half tried first) rather than either uniform
  random (the old behavior) or deterministically always the single top pick — meaningfully
  favors good picks while staying non-deterministic/harder to read exactly. Affordability
  is now checked against a running remaining-cash total across multiple picks in the same
  turn, not each independently against the original starting cash (a real gap in the
  original version — two individually-affordable picks could collectively breach the
  reserve).
- **Self-preservation**: once `riskGauge >= BOT_RISK_CAUTION_THRESHOLD` (65), every
  `nature: 'Dirty'` decision is excluded outright before scoring even runs (a soft penalty
  in `scoreDecision` also eases off approaching, not just past, the threshold) — the bot
  backs off wholesale rather than judging any specific Dirty pick still worth the risk.
- **Aggression**: `scoreDecision` adds a flat bonus for any decision that bears on the
  human at all (`requiresTarget`, or an indirect decision with a `target.*` impact) — a
  bad targeting decision still loses to a great neutral one, it's a bonus on top of the
  cost-effectiveness score, not a category override.
- **Hostile takeover, previously entirely unimplemented for the bot** (`shareTransactionType`
  decisions were explicitly out of scope in the first version — `variableAmount: true` and
  empty `impacts` mean "affordable" isn't a schedule lookup the way every other decision
  is). `pickBotShareBuy` is a dedicated, separate strategy: gated by a real financial-slot
  budget still available this turn, a minimum spare-cash bar, and a per-turn coin flip (not
  every turn, so it doesn't telegraph as a predictable drip) — spends half its spare cash
  above the reserve when it goes ahead. `GameEngine.runBotTurn` tracks what
  `pickBotDecisions`' own picks would spend (`estimatedFirstYearCashEffect`, now exported)
  before calling this, so the two never independently double-commit the same spare cash.

**The bot's attacking decisions used to never actually land, silently.** A user-reported
"the bot made all kinds of decisions but only Buy Shares had any visible effect on my
cash" traced to `pickBotDecisions` assigning `targetId` off `def.requiresTarget` directly
instead of the already-defined `needsTarget(def)` helper one line above it (used correctly
for the scoring bonus, but never reused for the actual pick). In the real seeded library,
`requiresTarget: true` is set on exactly Buy Shares/Sell Shares — every one of the 53
genuine `target.*`-bearing attack decisions (Bot Attack, Fox Release, Patent Trolling,
Talent Poaching, Union Agitation, Reporting Rivals, etc.) relies purely on carrying a
`target.*` impact field, exactly the case `GamePhase.tsx`'s own `decisionNeedsTarget`
already treats as target-needing (see its doc comment). With `targetId` silently staying
`undefined`, `DecisionEngine.collectTargetImpacts` (`if (!d.targetId) continue`) dropped
the attack's entire cross-player effect every time — the decision still deployed and cost
the bot its own cash, it just never actually hurt anyone. Fixed by calling `needsTarget(def)`
at the pick site instead of reading the flag directly; regression-tested in
`botService.test.ts` with a decision that has a `target.*` impact but no `requiresTarget`
flag (matching the real library's shape), asserting `targetId` is set.

**Settlement negotiation, previously entirely passive.** The bot used to never actively
respond to an offer at all — any offer a human made just sat there until Step 8b's
turn-boundary timeout auto-accepted it, however small, a real reported gap ("bot accepts
very little settlements"). `botService.ts`'s `decideBotNegotiationAction(case_, myRole,
cash, digDeeperCost)` fixes this by weighing the current offer against a genuine
expected-value estimate, `probability * stakes` (`baseProbability` once the bot's own side
has earned real odds — `plaintiffFullyInvestigated`/`defendantInvestigated`, same gating
`CaseCard`'s odds chip uses client-side — else a 50/50 fallback if it can't afford to dig
and find out). `GameEngine.runBotTurn` calls it once per `status: 'negotiating'` case the
bot is a party to, every turn, dispatching to the exact same `digDeeperOnCase`/
`acceptOffer`/`makeOffer`/`goToCourt` methods a real client's `NegotiationPanel` calls —
never a bot-only path into `GameLoop`, same convention as the rest of this bot.

- Only acts when `roleOnMove(case_) === myRole` (duplicated from `GameLoop`'s own private
  `roleOnMove`, same "keep small pure logic in sync by hand" convention used client-side)
  — otherwise the ball is in the other party's court and it's a no-op this turn.
- **Defendant** accepts once the pending offer is within `BOT_DEFENDANT_ACCEPT_TOLERANCE`
  (1.15x) of fair value, forces trial (`goToCourt`) once its own odds are so good
  (`baseProbability <= BOT_DEFENDANT_COURT_THRESHOLD`, 0.15) that settling at all is worse
  than just winning outright, and otherwise counters at `fairValue` clamped into
  `computeOfferBracket`'s current range (also duplicated from `GameLoop`, mirroring
  `NegotiationPanel`'s own client-side slider-bound copy). **Plaintiff** is the symmetric
  mirror (`BOT_PLAINTIFF_ACCEPT_TOLERANCE` 0.85, `BOT_PLAINTIFF_COURT_THRESHOLD` 0.85). The
  defendant's opening move (`case_.offers.length === 0`) has nothing to compare against
  yet, so it opens at 70% of fair value rather than accepting nothing or forcing a trial
  immediately.
- One action per case per turn (dig this turn, decide next) — matches this bot's existing
  "investigate before committing" pacing elsewhere (`pickAttacksToInvestigate`).
- Regression-tested at both layers: `botService.test.ts`'s `decideBotNegotiationAction`
  block (pure logic, all branches) and `gameEngine.test.ts`'s `runBotTurn orchestration`
  block (confirms `runBotTurn` actually dispatches to the right real method for a
  favorable-offer scenario) — same two-layer split as the rest of this bot's coverage.

**Self-preservation — the bot used to reliably bankrupt itself even against a fully idle
human, with zero adversarial pressure involved at all.** Root-caused (via the same
randomized-simulation methodology described above, adapted to a "human submits nothing,
ever" opponent) to several independent gaps, each fixed in `botService.ts`:

- **Affordability/scoring only ever read a decision's `cash` field at year 1** — invisible
  to same-turn `operatingExpenses`/`staffCost`/`otherIncome`/`financeCost` movement, and to
  a `debt` impact's real cost (`financeCost = baseFinanceCost + debt*interestRate +
  financeCostDelta`, `calcEngine.ts`'s `calculatePL`). `estimatedFirstYearCashEffect`
  folds all of these into one real dollar figure (a `debt` impact is converted via
  `debtAsFinanceCost`, `raw * interestRate`); `FIELD_DIRECTION`/`DOLLAR_FIELDS` gained
  `financeCost` so `scoreDecision` scores it too — a decision like "Payday Loan"/"Manure
  Futures Speculation" (a real cash windfall funded by real recurring debt-service cost)
  used to score as a near-pure windfall with none of its downside represented at all.
- **Both were also blind to genuinely BACKLOADED costs** — a schedule value that's zero at
  deployment but lands in a later year (e.g. "Manure Futures Speculation"'s `financeCost`:
  `{"1":0,"2":12000,"3":12000}`) scored and budgeted as completely free at the exact
  moment the bot had to decide whether to pick it at all. Fixed by scoring/budgeting
  pessimistically against the single WORST year across a decision's whole schedule
  (`worstScheduleValue`/`worstCaseCashEffect`), not just year 1 — used internally by
  `scoreDecision` and `pickBotDecisions`'s affordability check.
- **No general self-preservation against the bot's own real cash trajectory existed** —
  `isCashTrendDeclining` (net decline over `BOT_CASH_TREND_WINDOW`, 3, turns of the bot's
  own real post-resolution cash) and `isStructurallyUnprofitable`
  (`operatingExpenses+staffCost+financeCost`, net of `otherIncome`, already exceeding
  `revenue` — a company can coast on a cash cushion for many turns while already
  structurally underwater every turn, right up until the cushion runs out).
  `computeEffectiveReserve` folds the trend signal (multiplies `BOT_CASH_RESERVE` by
  `BOT_CASH_TREND_RESERVE_MULTIPLIER`, 4, once declining) into one number `GameEngine.
  runBotTurn` computes ONCE per turn and threads through digging/suing/picking/buying
  alike, so every discretionary spend backs off together; `isStructurallyUnprofitable`
  additionally forces the reserve to the bot's own current cash (blocking everything but a
  net-cash-positive move) and vetoes any new decision in `pickBotDecisions` whose worst-case
  effect isn't non-negative.
- **No accounting for what ALREADY-active decisions will cost NEXT turn regardless of new
  picks** — several already-active backloaded decisions could land their bills in the same
  future turn, cratering cash in what looked like one sudden turn but was structural for
  several turns before that. `projectedNextTurnOwnCashEffect` mirrors `DecisionEngine.
  advanceAndApply`'s own "past its own maturity threshold, never applies its own schedule
  again" gate closely enough to predict what each already-active instance will do next
  turn (deliberately NOT full lookahead — it only reasons about commitments ALREADY made,
  never simulates a hypothetical future pick), and its result (only the negative side) is
  folded into `computeEffectiveReserve` too.
- **Biggest single lever, by far: the bot never validated against `DecisionEngine.
  canDeploy` at all** (still true in spirit — see the bot's own header — but this one
  specific gap was directly, measurably responsible for most of the bankruptcies). It kept
  "picking" a decision `canDeploy` would silently reject (permanent-effect redeploy-lock
  cooldown, an own instance still maturing, forward/reverse `excludes` mutual exclusion) —
  `GameLoop.processNewDecisions` drops an ineligible pick the same way it drops a real
  player's rejected submission, which is fine for a single "wasted" pick in isolation. The
  real bug: the bot's OWN cash accounting had already credited itself the full
  (never-realized) windfall of that rejected pick, inflating what it believed it could
  then afford to spend on OTHER things that same turn — Buy Shares chief among them — even
  though the credited amount never actually landed. `pickBotDecisions` now takes the bot's
  own `activeDecisions` and mirrors `canDeploy`'s exact conditions (`hasPermanentEffect`
  redeploy lock, imported directly from `decisionEngine.ts` rather than reimplemented; the
  more basic "own instance hasn't matured yet" rule; forward/reverse `excludes`) before a
  candidate is even scored.
- **`GameLoop.applyShareTransaction` charges the buyer's FULL requested spend even once
  `fractionBought` has already capped at 1 (100% owned)** — nothing refunds the excess (see
  its own doc comment: the surplus is distributed to the diluted sellers instead, a pure
  loss for the buyer). `pickBotShareBuy`'s spend used to be sized purely off the bot's OWN
  spare cash, with zero awareness of what the target was actually worth — once the bot's
  own cash pile grew past the target's value, it could vastly overpay for a small/cheap
  company in one move. `pickBotShareBuy` now takes an optional `maxUsefulSpend` (computed
  by the caller as `(1 - currentBotOwnershipFraction) * totalSharesOutstanding *
  stockValue`, mirroring `applyShareTransaction`'s own math) and clamps its spend to it.
- **A second, later self-bankruptcy bug, found the same way and much bigger in practice:
  NONE of the checks above ever accounted for COGS.** `calcEngine.ts`'s real formula,
  `cogs = (materialCostPerTon + logisticsCostPerTon) * volume`, is very often the SINGLE
  LARGEST cost in this game's real P&L — but `isStructurallyUnprofitable`'s own previous
  doc comment claimed omitting it was safe ("only ever makes a healthy company look
  slightly worse, never a sick one look healthy"), which is true for depreciation/tax but
  false for COGS, since it SCALES WITH `volume` — exactly the field the bot's own
  capacity/demand-boosting picks keep growing. A live-play investigation (prompted by a
  user report that an idle human opponent "almost always" wins) traced a real game where
  `isStructurallyUnprofitable` reported "not unprofitable" for 10+ straight rounds while
  the real (COGS-inclusive) profit was -$40k to -$120k every single turn from round 3
  onward; across 100 simulated games, 59-76% showed negative real per-turn P&L at any
  checkpoint round, and the bot bankrupted itself in ~39% of 40-round games. Root cause:
  the bot never stops deploying new decisions (one traced game had 51 active by round 32),
  and many of the ones it favors for a good `scoreDecision` score (boosting price/capacity/
  demand) also permanently raise `materialCostPerTon`/`logisticsCostPerTon` as their real
  trade-off — a cost invisible to every self-preservation check, compounding with the
  `volume` growth those same picks cause. `materialCostPerTon`/`logisticsCostPerTon` are
  always `relative`-type in the real library, so converting to a real dollar cost needs
  the bot's own CURRENT $/ton rate and `volume` — neither of which lives on a
  `DecisionDefinition` the way a `DOLLAR_FIELDS` value does — hence `BotCogsContext`, a new
  small bundle (`{ volume, materialCostPerTon, logisticsCostPerTon }`) threaded through
  every cash-aware function (`realCashEffectAtYear`/`worstCaseCashEffect`/`scoreDecision`/
  `pickBotDecisions`/`estimatedFirstYearCashEffect`/`projectedNextTurnOwnCashEffect`) and
  `isStructurallyUnprofitable` (which now takes `materialCostPerTon`/`logisticsCostPerTon`/
  `volume` directly and subtracts COGS from its approximate EBIT). `GameEngine.runBotTurn`
  builds one `botCogs` object per turn straight off the bot's own `PlayerVariables` and
  passes it to all of them, mirroring how `interestRate` was already threaded through for
  the analogous `debt`-to-`financeCost` conversion. `scoreDecision`'s generic per-field
  loop now excludes `materialCostPerTon`/`logisticsCostPerTon` (they're scored via the
  dollar-scaled `worstCaseCogsEffect` path instead, same reason `DOLLAR_FIELDS` is already
  excluded there — comparing a raw per-ton fraction directly against an unrelated 0-1-scale
  field like `price`, with no volume scaling, undercounted the real cost by orders of
  magnitude). Measured effect: bankruptcy rate on the same 100-game/40-round harness
  dropped from ~39% to ~3%.

Regression-tested with the same randomized-simulation methodology described above, adapted
to this specific scenario: `botService.idleOpponent.simulation.test.ts` plays many
independent full games of the real bot (via the real `botService.ts` functions, now
including a `botCogs` context built the same way `GameEngine.runBotTurn` does) against a
human who submits nothing, ever, and asserts the bankruptcy rate within a realistic game
length (20 rounds — comfortably inside CLAUDE.md's documented ~11-18-round typical range)
stays below 20% (tightened from an original 50% ceiling — see the test's own doc comment
for the two bug generations that ceiling had to stay loose enough to tolerate). Individual
mechanisms are also unit-tested directly in `botService.test.ts` (`estimatedFirstYearCashEffect`,
`isCashTrendDeclining`/`computeEffectiveReserve`, `projectedNextTurnOwnCashEffect`,
`isStructurallyUnprofitable`, the `pickBotDecisions`/`scoreDecision`/`pickBotShareBuy`
veto/clamp behaviors, and the newer `BotCogsContext`-aware cases for all of the above).

### Test layers, and which one to reach for

- **`server/src/**/*.test.ts`** — Vitest, no Docker. `engine/*.test.ts` (GameLoop,
  calcEngine, decisionEngine, legalEngine) needs no mocking — pure input/output.
  `formulaEngine.test.ts` is security-relevant: checks dangerous-looking input
  (`__proto__`, arbitrary function calls) is rejected as invalid syntax, never evaluated.
  `GameLoop` requires `loadFormulas()` before any turn resolves. `socket/gameEngine.test.ts`
  mocks Prisma + `Server` (and `llmService`) since that's where real I/O happens — use this
  layer for room/phase lifecycle, not engine math.
- **`client/src/**/*.test.ts`** — Vitest, Zustand stores and pure UI utilities.
  `GamePhase.utils.test.ts` duplicates small pure functions out of `GamePhase.tsx` rather
  than importing them (see *Client-side duplicated pure logic* above) — keep any
  duplicated copy in sync by hand.
- **`tests/api/*.test.ts`** — Vitest + real Postgres via testcontainers (needs Docker).
  The only layer verifying socket event contracts end-to-end against a real Prisma schema.
  Reach for this when a change touches the room/DB/socket boundary, not engine-internal math.
- **`tests/e2e/*.spec.ts`** — Playwright, full browser + live client + backend. Use for
  lobby/matchmaking flows and phase transitions a user would actually click through.
- **`gameLoop.simulation.test.ts`/`.simulation.smart.test.ts`** — see *Randomized-
  simulation testing* above; the go-to for "does this change destabilize the engine
  against the real, full decision library" rather than a hand-written fixture.
- **`botService.idleOpponent.simulation.test.ts`** — same methodology, scoped to "does the
  bot bankrupt itself" against a human who submits nothing at all — see *Server-injected
  AI bot player*'s own *Self-preservation* section above.

When you touch a mechanic documented above, its own section names the specific
test file/describe block that exists to guard the invariant — extend that, not just
the happy path, rather than writing a parallel test from scratch.

### Deliberate deviations from the design spec

The original design specified every decision with `legalRisks` auto-generates a lawsuit
from every other player the instant it's deployed. Implemented behavior differs by
explicit product decision: lawsuits are filed deliberately via `game:submitDecisions`'s
`lawsuits` array, priced by `LegalEngine.fileLawsuit` against the ground's probability
schedule at the target's elapsed time. The original design also never modeled a
negotiation phase at all (a filed case just resolved via a probability draw) — this
codebase's `'negotiating'` status and full offer/counter/accept/go-to-court flow is a
further addition beyond spec. If a task asks you to "match the original spec exactly" on
either point, flag the conflict rather than silently reverting these deliberate designs —
see README's *Lawsuits* section and `GameLoop`'s Step 8 for context.

### Decision content — data, not code

The decision library has grown well past the original seed set (200+ entries as of this
writing, spanning every `level`/`nature` combination, all chicken-manure/fertilizer-
industry flavored, every one except `Sell Shares` carrying at least one `legalRisks`
entry) via `server/src/data/game_engine.json` — pure data, admin-editable, balanced and
verified using the randomized-simulation methodology described above rather than unit-
tested per decision. **Any edit to this file requires `npm run db:seed` re-run** on an
already-seeded dev database to take effect (see *Decisions/config are DB-backed* above).

### Production deployment — docker-compose.prod.yml + Caddy + GitHub Actions

`suethemchickens.online` runs on a single Hetzner Ubuntu VPS: `docker-compose.prod.yml`
(distinct from the local-dev `docker-compose.yml`) pulls pre-built GHCR images, publishes
no ports except Caddy's 80/443 (Postgres/server/client are internal-network-only), and
deliberately has no `llm:` service — the annual-report/decision-gen features already
degrade invisibly without one, and running llama.cpp alongside Postgres/Node on a small
VPS isn't worth it yet (copy the block back from `docker-compose.yml` if that changes).
`Caddyfile` is the one public entry point and auto-provisions TLS; because
`VITE_SERVER_URL` is compiled into the client bundle at build time and the Socket.IO
client connects directly to that origin, everything lives on one domain — Caddy routes
`/socket.io/*`, `/api/*`, `/health` to `server` and everything else to `client`, rather
than letting the client's own nginx `/api` proxy (still there for local
`docker-compose.yml` use) handle it a second time.

`.github/workflows/docker.yml` builds+pushes `server`/`client` images to GHCR on every
push to `main` (tagged by short SHA/branch/`latest`), then SSHes into the box to pull,
run `prisma migrate deploy` via a throwaway `server` container, and restart the stack.
It is **`paths`-filtered**, so a docs-only commit deliberately doesn't redeploy — but
that filter must list every file the deploy job actually ships, not just the ones that
go into an image: the deploy job scp's `Caddyfile` alongside `docker-compose.prod.yml`,
so `Caddyfile` is in the filter too. It was missing at first, which meant a
Caddyfile-only change would have silently never deployed (CI green, no error, box still
serving the old config); the access-logging change that exposed this only deployed
because it happened to touch `docker-compose.prod.yml` as well. Add a path here whenever
the deploy job learns to copy another file.
Needs three repo secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`) and the GHCR
`server`/`client` packages set to public visibility (one-time, in repo Settings) so the
box can pull without credentials. `deploy/server-setup.sh` is the one-time root bootstrap
for a fresh box (hardened SSH, ufw, Docker, a `deploy` user, a passphrase-less CI-only
SSH keypair) — meant to be run by a human watching the output, not automated, since SSH
hardening can lock you out if it goes wrong partway through.

**Caddy access logging is the only server-side traffic measurement that exists** — added
because GA4 provably can't measure a marketing link that points anywhere other than `/`.
The cookie-consent banner only mounts in `Home.tsx` (see *Consent-gated Google
Analytics/Ads* above), so a visitor arriving directly on `/play` — which is exactly what
an external link should point at, and what r/WebGames' rules actually require, since `/`
is a hub page and their P4.iii bans linking a "collection or directory" — never sees the
banner, never consents, and GA4 stays in cookieless/modeled mode, which at this site's
traffic volume surfaces as nothing at all. The `log` block in `Caddyfile` records
`request.uri` (path AND query string, so `utm_*` params on a campaign link are captured)
and `request.headers` (Referer/User-Agent; Caddy redacts Cookie/Authorization itself).

Written to a **file in the `caddy_logs` named volume, deliberately not stdout** — every
deploy recreates the container, which would discard a stdout/json-file log, and a
marketing post is measured over days, across deploys. Caddy's own roller caps disk use
(10 MiB × 5 files, 30 days), so nothing external needs to rotate it. Socket.IO/health
traffic is logged too rather than dropped via `log_skip` — it's genuinely useful for
debugging, and filtering at read time is strictly more flexible than discarding lines
permanently. Read it on the box with e.g.

```bash
# hits on a campaign link
docker exec stc-caddy sh -c 'cat /var/log/caddy/access.log*' | grep -c 'utm_campaign=<campaign>'
# unique-ish visitors (by client IP)
docker exec stc-caddy sh -c 'cat /var/log/caddy/access.log*' | grep 'utm_campaign=<campaign>' \
  | grep -o '"client_ip":"[^"]*"' | cut -d'"' -f4 | sort -u | wc -l
```

**`jq` is deliberately not used here — it isn't installed on the VPS** (verified; the box
is a bare Docker host, and `deploy` would need sudo to add it). These `grep`/`cut` forms
were tested against the real production log and need nothing but a shell. If `jq` ever
does get installed, the equivalent is
`jq -r 'select(.request.uri | test("<campaign>")) | .request.client_ip'`.

A `Caddyfile` edit is not covered by any test layer in this repo and a bad one takes the
whole site down on next deploy (Caddy refuses to start), so validate before pushing:
`docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate
--config /etc/caddy/Caddyfile --adapter caddyfile`.

`prisma` had to move from `server/package.json`'s `devDependencies` to `dependencies` —
the production image's `npm ci --omit=dev` would otherwise ship without the CLI
`prisma migrate deploy` needs. `db:migrate:deploy` (new, both root and server
`package.json`) wraps that non-interactive command; never run `db:migrate` (`prisma
migrate dev` — prompts, can generate new migrations) against production.
