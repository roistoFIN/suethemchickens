/**
 * Game Loop Orchestrator — manages the full turn resolution cycle.
 *
 * Each GAME_PHASE turn follows this sequence for ALL players simultaneously:
 *
 * Phase A — Decision Collection (interactive, within timer):
 *   Players submit strategic + operational decisions via socket events.
 *
 * Phase B — Turn Resolution (pure computation, when timer expires or all submit):
 *   1. Advance active decision instances by one year
 *   2. Apply depreciation ledger updates
 *   3. Calculate competitiveness & market share across all players
 *   4. Calculate volume per player with supply cap
 *   5. Calculate P&L per player
 *   6. Update balance sheet per player
 *   7. Evaluate legal risks from new decisions → create cases
 *   8. Lock open cases for trial / resolve awaiting trials
 *   9. Calculate risk gauge per player
 *
 * (This summary predates two later additions the numbered `// ── Step N ──` comments in
 * `resolveTurn` itself describe in full: a "Step 1b" between steps 1 and 2 that executes
 * Buy/Sell Shares trades, and a majority-ownership takeover elimination path alongside
 * the bankruptcy check — see CLAUDE.md's share-ownership section. The step comments
 * inline below are the accurate, current source of truth.)
 *
 * GameLoop is a pure computation engine — it never touches Prisma or Socket.IO. It takes
 * each player's current DB row (company variables + engine state) as plain input and
 * returns a TurnResolutionOutcome: the broadcast-ready result plus the exact company
 * updates and bankruptcy flags the caller needs to persist. GameEngine
 * (server/src/socket/gameEngine.ts) owns loading that input before the call and
 * persisting/broadcasting the outcome afterward.
 */

import type {
  PlayerVariables,
  AdminVariables,
  DecisionDefinition,
  GameConfig,
  PlayerTurnResult,
  TurnResolutionResult,
  LegalCaseData,
  SubmittedDecisions,
  IncomingAttackInfo,
  KpiSnapshotPoint,
  PlayerDerivedStats,
  SharesBoughtEvent,
} from '@suethemchickens/shared';
import {
  applyDepreciation,
  calculateCompetitivenessAndMarketShare,
  calculateEffectiveTotalMarketVolume,
  calculateVolume,
  calculatePL,
  updateBalanceSheet,
  calculateRiskGauge,
  calculateMaturityYears as calcMaturity,
  calculateAdjustedProbability,
  calculateLegalExposureRatio,
  applyTargetImpacts,
  renormalizeShareOwnership,
  SELF_OWNERSHIP_KEY,
  EXTERNAL_MARKET_KEY,
} from './calcEngine.js';
import { DecisionEngine, MAX_INVESTIGATION_LEVEL, summarizeTargetImpacts, summarizeOwnImpacts, pickAllGrounds, meetsLegalRiskConditions } from './decisionEngine.js';
import type { DeployedDecision, TargetImpactResult } from './decisionEngine.js';
import { LegalEngine } from './legalEngine.js';
import { buildFormulaSet, type FormulaSet } from './formulaEngine.js';

/**
 * Coerce a value that is *typed* as `Date` but may actually be an ISO string, because it
 * came back out of a Postgres JSONB column. Returns `undefined` for a missing/unparseable
 * value rather than an `Invalid Date`, so a caller can decide its own fallback.
 *
 * See `readEngineState`'s own comment for the production incident that motivated this.
 */
function toDate(value: Date | string | undefined | null): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Filing time of a case as epoch ms, for the FIFO "oldest case paid first" tie-break used
 * by both the bankruptcy/merger waterfall and Step 9's won-verdict cash cap.
 *
 * `readEngineState` already normalises `createdAt` back into a real `Date`, so this is
 * belt-and-braces — but these two comparators are exactly where a stray string previously
 * took down a live game mid-elimination, and a sort comparator is a uniquely bad place for
 * a `TypeError` (it aborts the whole turn). An unparseable date sorts oldest-first, which
 * keeps a corrupt row from jumping the queue ahead of legitimately-filed cases.
 */
function caseFiledAtMs(c: LegalCaseData): number {
  return toDate(c.createdAt)?.getTime() ?? 0;
}

// ============================================================
// Public input/output types — the boundary between GameLoop's pure
// computation and the caller's persistence/broadcast responsibilities
// ============================================================

/** One player's DB row as GameLoop needs it — a subset of what Prisma's `player.findMany` (with `company` included) returns. */
export interface EngineDataInput {
  id: string;
  name: string;
  company: {
    variables: unknown;
    engineState: unknown;
  } | null;
}

/** A single asset depreciation schedule entry, tracked per-player inside `Company.engineState`. */
export interface DepreciationEntry {
  id: string;
  assetType: 'assets' | 'intangibleAssets';
  originalValue: number;
  purchaseYear: number;
  usefulLife: number;
  annualAmount: number;
  remainingYears: number;
}

/**
 * A deployed decision instance as stored in `Company.engineState` JSONB — the serialized
 * counterpart of `DeployedDecision`. Stores `definitionName` (looked back up against the
 * loaded decision library on read, via `readEngineState`) rather than the full
 * `DecisionDefinition` object, since definitions are static and already loaded from
 * `game_engine.json` at startup — duplicating them per-instance into every player's DB
 * row would be redundant and, if ever read back as `.definitionName` (the reader's actual
 * expectation), silently wrong.
 */
export interface PersistedDecisionInstance {
  id: string;
  definitionName: string;
  deployedYear: number;
  elapsedYears: number;
  isMatured: boolean;
  /** The player this decision's `target.*` impacts route to — set when deployed against an opponent. */
  targetId?: string;
  /** True once a lost lawsuit cancelled this instance's forthcoming effects — see `DecisionEngine.hasPermanentEffect`/`canDeploy` and CLAUDE.md. */
  voidedByLawsuit: boolean;
  /** True the instant ANY lawsuit is ever filed against this specific instance — first
   * come, first served; see `DeployedDecision.everSued`/CLAUDE.md. */
  everSued: boolean;
  /** For a Buy Shares instance only — see `DeployedDecision.acquisitionFraction`/CLAUDE.md. */
  acquisitionFraction?: number;
}

/** The `Company` row fields the caller must write back to the DB for one still-active player after a turn resolves. */
export interface CompanyPersistUpdate {
  playerId: string;
  cash: number;
  variables: PlayerVariables;
  engineState: {
    activeDecisions: PersistedDecisionInstance[];
    depreciationLedger: DepreciationEntry[];
    legalCases: LegalCaseData[];
    /** "Dig Deeper" progress: attacking decision instance id -> investigation level (1-3). */
    investigations: Record<string, number>;
  };
}

/** A player eliminated this turn — the caller must flag them bankrupt in the DB and broadcast `player:bankrupt`. */
export interface BankruptedPlayer {
  playerId: string;
  playerName: string;
  /** This player's actual (negative, for a bankruptcy) cash balance at the moment of
   * elimination — the caller must persist this to their Company row too, since an
   * eliminated player is excluded from `companyUpdates` (their engine state is done being
   * touched) and would otherwise keep whatever positive `cash` the DB had from their last
   * still-active turn forever, including on the Game Over / final-standings screen. For a
   * merger elimination this is NOT negative — the acquirer's takeover doesn't require the
   * target to be insolvent, just majority-owned. */
  finalCash: number;
  /** This player's full variables/derived/riskGauge at the moment of elimination — the
   * same shape a still-active player's `PlayerTurnResult` carries, captured here since
   * an eliminated player is excluded from `outcome.result.players` entirely (nothing
   * else would ever compute or persist it). The caller writes this as one final
   * `KpiSnapshot` row, so the KPI history graphs (and the game-timeline replay) don't
   * lose exactly the round a player went bankrupt/was acquired in. */
  finalVariables: PlayerVariables;
  finalDerived: PlayerDerivedStats;
  finalRiskGauge: number;
  /** Why this player left the game — bankruptcy (cash < 0) or a majority-ownership
   * takeover. Both reuse the identical case-waterfall payout logic ("the same rule
   * applies to both bankruptcy and merger") — see CLAUDE.md's share-ownership section.
   * Defaults to `'bankruptcy'` for any caller that doesn't care about the distinction. */
  reason: 'bankruptcy' | 'merger';
  /** Set only for `reason: 'merger'` — the player who crossed the >50% ownership
   * threshold and inherited the eliminated company's cash/assets/intangibleAssets. */
  acquirerId?: string;
  acquirerName?: string;
}

/** Everything resolveTurn computed: the `turn:resolved` broadcast payload plus the side effects the caller must apply. */
export interface TurnResolutionOutcome {
  result: TurnResolutionResult;
  companyUpdates: CompanyPersistUpdate[];
  bankruptedPlayers: BankruptedPlayer[];
  /** Server-only telemetry for GameEngine to log to EventLog — see DecisionDeployEvent's doc comment. Never part of the client broadcast. */
  decisionEvents: DecisionDeployEvent[];
  /** Wall-clock ms this resolveTurn call itself took, for the admin Analytics tab's performance view. */
  durationMs: number;
}

/** Result of a `digDeeper` call — a lightweight, single-player, out-of-band mutation (not part of turn resolution). */
export type DigDeeperOutcome =
  | { success: false; reason: 'player_not_found' | 'invalid_attack' | 'already_fully_investigated' | 'insufficient_funds' }
  | {
      success: true;
      attackId: string;
      cost: number;
      newCash: number;
      attack: IncomingAttackInfo;
      /**
       * The requesting player's full `variables` JSONB to persist, cash already decremented.
       * Must be written alongside the `cash` column — `GameLoop` reads cash from
       * `variables.cash` (via `readVariables`), not the column, so writing only the column
       * would leave the next call (or the next normal turn resolution) reading stale cash.
       */
      variables: PlayerVariables;
      /** The requesting player's full engineState to persist — existing keys carried through unchanged, only `investigations` updated. */
      engineStateUpdate: CompanyPersistUpdate['engineState'];
    };

/** Result of a `chargeLawsuitFilingFee` call — a lightweight, single-player, out-of-band mutation (not part of turn resolution). */
export type LawsuitFilingFeeOutcome =
  | { success: false; reason: 'player_not_found' | 'insufficient_funds' | 'limit_reached' }
  | {
      success: true;
      cost: number;
      newCash: number;
      /** The requesting player's full `variables` JSONB to persist, cash already decremented —
       * same "must be written alongside the `cash` column" requirement as `DigDeeperOutcome.variables`. */
      variables: PlayerVariables;
    };

/** One party's persisted-state update from a `makeOffer`/`acceptOffer`/`goToCourt` call —
 * always needs its `engineState` written (the case changed inside it, even if nothing
 * else did); `cash`/`variables` are only present for the party whose cash actually moved
 * (a settlement, from `acceptOffer` or Step 8b's stale-offer auto-settle), same "must
 * stay in sync with the `cash` column" requirement as `DigDeeperOutcome.variables`. */
export interface LegalCaseSideUpdate {
  playerId: string;
  cash?: number;
  variables?: PlayerVariables;
  engineState: CompanyPersistUpdate['engineState'];
}

/** Result of a `makeOffer`/`acceptOffer`/`goToCourt` call — a two-party, out-of-band
 * mutation (not part of turn resolution). On success, the caller (`GameEngine`) persists
 * both `plaintiff` and `defendant` updates and emits `case` to both parties' sockets.
 * `'turn_resolving'` is never produced by `GameLoop` itself (it has no concept of
 * `GameEngine`'s `advancingRooms` lock) — it's returned directly by `GameEngine`'s wrapper
 * methods, before ever calling into `GameLoop`, when this room's turn is mid-resolution.
 * See CLAUDE.md's negotiation-actions-vs-turn-resolution race section for why this exists:
 * a real, reported bug where a `goToCourt` landing at the exact moment a turn resolved
 * could be silently clobbered by that same turn's Step 8b stale-offer auto-settle. */
export type LegalCaseActionOutcome =
  | {
      success: false;
      reason:
        | 'case_not_found'
        | 'not_negotiating'
        | 'not_a_party'
        | 'not_your_turn'
        | 'no_offer_to_accept'
        | 'invalid_amount'
        | 'not_defendant'
        | 'already_investigated'
        | 'insufficient_funds'
        | 'turn_resolving';
    }
  | {
      success: true;
      case: LegalCaseData;
      plaintiff: LegalCaseSideUpdate;
      defendant: LegalCaseSideUpdate;
    };

/** Result of a `predictFutureKpis` call — up to `turnsAhead` future points, fewer if the simulation shows the player going bankrupt partway through. */
export interface KpiPrediction {
  predicted: KpiSnapshotPoint[];
  bankruptAtRound?: number;
}

/** One active decision instance, read-only summary for narrating a rival's "annual report" (`GameEngine.getAnnualReport`). */
export interface ActiveDecisionSummary {
  instanceId: string;
  decisionName: string;
  description: string;
  deployedYear: number;
  elapsedYears: number;
}

/** The three `SubmittedDecisions` buckets a submission can carry decisions in — kept as
 * one shared tuple/type so `entryKey`/`stampEntryTimestamps`/`processNewDecisions` never
 * drift out of sync on which buckets exist (a `for (const bucket of ['strategic',
 * 'operational'] as const)`-style hardcoded pair was the exact class of bug that missed
 * `financial` the first time a third bucket was added). */
const DECISION_BUCKETS = ['strategic', 'operational', 'financial'] as const;
type DecisionBucket = (typeof DECISION_BUCKETS)[number];

/**
 * A deployed Buy/Sell Shares instance queued for execution in Step 1b — collected by
 * `processNewDecisions` for exactly the entries it actually deployed
 * (so a filing dropped by a level-limit/`canDeploy` check is never queued), grouped by
 * `targetId` and sorted by `submittedAt` before being applied sequentially. See
 * CLAUDE.md's share-ownership section for why `submittedAt` can't just be "now" at the
 * point of collection — it has to be the entry's own first-seen timestamp from
 * `GameLoop`'s submission-timestamp tracking.
 */
interface ShareTransactionRequest {
  buyerId: string;
  instanceId: string;
  targetId: string;
  amount: number;
  submittedAt: number;
  type: 'buy' | 'sell';
}

/**
 * One entry per decision `processNewDecisions` actually attempted to deploy this turn —
 * server-only telemetry for the admin Analytics tab (decision-balance dashboard, and
 * bug-tracing a repeat of the "canDeploy's level-limit check silently dropped a decision
 * for the rest of the game" class of bug — see CLAUDE.md). `canDeploy` already computes a
 * human-readable `reason` for every rejection and always has (`processNewDecisions` used
 * to just discard it via a bare `continue`) — this only starts collecting what already
 * existed, it doesn't change what gets rejected or why. Deliberately NOT part of
 * `TurnResolutionResult` (the `turn:resolved` broadcast payload) — the client has no use
 * for this, and `processNewDecisions`' existing silent-drop behavior for the PLAYER stays
 * completely unchanged; this is purely an additional, parallel collection for
 * `GameEngine` to log to `EventLog`.
 */
export interface DecisionDeployEvent {
  playerId: string;
  bucket: DecisionBucket;
  decisionName: string;
  targetId?: string;
  outcome: 'deployed' | 'rejected';
  /** Only set for `outcome: 'rejected'` — `canDeploy`'s own reason string, or 'Unknown decision' for a bogus name. */
  reason?: string;
}

// ============================================================
// Internal types — not exported, used only within this module
// ============================================================

/** Engine state stored per-player inside Company.variables JSONB */
interface CompanyEngineState {
  activeDecisions: DeployedDecision[];
  depreciationLedger: DepreciationEntry[];
  legalCases: LegalCaseData[];
  investigations: Record<string, number>;
}

interface PlayerTurnContext {
  playerId: string;
  playerName: string;
  vars: PlayerVariables;
  submittedDecisions: SubmittedDecisions | null;
  engineState: CompanyEngineState;
  /** cash_i(edellinen vuoro) — cash as loaded at turn start, before any of this turn's effects (feeds the bankruptcy/merger waterfall pool, see distributeCaseWaterfall). */
  prevCash: number;
  /** Absolute deltas from newly deployed decisions on this turn (applied in processNewDecisions). */
  newDecisionAbsDeltas?: { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number };
}

export class GameLoop {
  private decisionEngine = new DecisionEngine();
  private legalEngine = new LegalEngine();
  private config: GameConfig;
  private adminVars: AdminVariables;
  // The pure, scalar, named-input formulas (competitiveness, market share, P&L, balance
  // sheet, legal-risk probability, risk gauge) — DB-backed (Formula table, seeded from
  // defaultFormulas.ts), loaded via loadFormulas() same as decisions/config. Empty
  // until GameEngine.loadGameData() populates it at startup (before the server
  // accepts connections), so this is never read before it's real.
  private formulas: FormulaSet = new Map();

  // Per-room turn state (decisions submitted during Phase A)
  private submissions = new Map<string, Map<string, SubmittedDecisions>>();

  // Per-room, per-player, per-entry FIRST-SEEN timestamp — for FIFO ordering of
  // simultaneous same-target Buy Shares purchases. NOT simply "the time of
  // the last submitDecisions call": the client always resends a player's ENTIRE pending
  // state on every toggle (`game:submitDecisions` is full-replacement, see CLAUDE.md), so
  // naively stamping "now" per call would make a Buy Shares entry's timestamp reflect
  // whatever the player touched LAST (even something unrelated), not when Buy Shares was
  // actually added. Instead, each submitted entry gets a stable key
  // (`${bucket}:${name}:${targetId ?? ''}`) and only keys not already present for that
  // player this turn are stamped with a fresh `Date.now()` — a key that survives across
  // resubmits keeps its original timestamp.
  private submissionTimestamps = new Map<string, Map<string, Map<string, number>>>();

  constructor(config: GameConfig) {
    this.config = config;
    this.adminVars = config.adminVariables;
  }

  /**
   * Replace gameSettings/playerStartingValues/adminVariables in place — called both
   * for the initial DB-backed load (`GameEngine.loadGameData`) and every later admin
   * edit via `/admin` (`GameEngine.updateGameConfigData`). Takes effect on the next
   * turn resolved after the call; nothing in-flight needs to be re-run.
   */
  updateConfig(config: GameConfig): void {
    this.config = config;
    this.adminVars = config.adminVariables;
  }

  /** Load all decision definitions — from the DB via GameEngine.loadGameData(), not
   * from game_engine.json directly (that file is now seed-only, see prisma/seed.ts).
   * Safe to call again any time — DecisionEngine/LegalEngine just replace their
   * internal maps, so an admin edit takes effect on the next turn immediately. */
  loadDecisions(definitions: DecisionDefinition[]): void {
    this.decisionEngine.setDefinitions(definitions);
    this.legalEngine.setDefinitions(definitions);
  }

  /** Compile and load the named formulas (see the `Formula` DB table / defaultFormulas.ts
   * for the current set) — from the DB via GameEngine.loadGameData(). Safe to call again
   * any time (GameEngine.updateFormula does so after every admin edit) — replaces the
   * whole set outright, taking effect on the next turn resolved. */
  loadFormulas(rows: Array<{ key: string; expression: string }>): void {
    this.formulas = buildFormulaSet(rows);
  }

  // ============================================================
  // Phase A — Decision Collection
  // ============================================================

  submitDecisions(roomId: string, playerId: string, decisions: SubmittedDecisions): boolean {
    if (!this.submissions.has(roomId)) this.submissions.set(roomId, new Map());
    this.submissions.get(roomId)!.set(playerId, decisions);
    this.stampEntryTimestamps(roomId, playerId, decisions);
    return true;
  }

  getSubmissionCount(roomId: string): number {
    return this.submissions.get(roomId)?.size ?? 0;
  }

  clearSubmissions(roomId: string): void {
    this.submissions.delete(roomId);
    this.submissionTimestamps.delete(roomId);
  }

  /** Stable per-entry key for FIFO timestamp tracking — see `submissionTimestamps`'s
   * doc comment for why this can't just be "the whole payload" or "the latest call". */
  private entryKey(bucket: DecisionBucket, entry: { name: string; targetId?: string }): string {
    return `${bucket}:${entry.name}:${entry.targetId ?? ''}`;
  }

  /** Assigns a fresh `Date.now()` to any submitted entry key not already tracked for this
   * player this turn, leaving every previously-seen key's timestamp untouched — see
   * `submissionTimestamps`'s doc comment. */
  private stampEntryTimestamps(roomId: string, playerId: string, decisions: SubmittedDecisions): void {
    if (!this.submissionTimestamps.has(roomId)) this.submissionTimestamps.set(roomId, new Map());
    const roomMap = this.submissionTimestamps.get(roomId)!;
    if (!roomMap.has(playerId)) roomMap.set(playerId, new Map());
    const playerMap = roomMap.get(playerId)!;

    const now = Date.now();
    for (const bucket of DECISION_BUCKETS) {
      for (const entry of decisions[bucket]) {
        const key = this.entryKey(bucket, entry);
        if (!playerMap.has(key)) playerMap.set(key, now);
      }
    }
  }

  /** First-seen timestamp for one submitted entry, or `Date.now()` as a safe fallback if
   * somehow untracked (e.g. a call site that mutates `submittedDecisions` outside the
   * normal `submitDecisions` path) — never `undefined`, so FIFO sorting always has a
   * real number to compare. */
  private entryTimestamp(roomId: string, playerId: string, bucket: DecisionBucket, entry: { name: string; targetId?: string }): number {
    return this.submissionTimestamps.get(roomId)?.get(playerId)?.get(this.entryKey(bucket, entry)) ?? Date.now();
  }

  // ============================================================
  // Phase B — Turn Resolution (the core game loop step)
  // ============================================================

  resolveTurn(roomId: string, round: number, players: EngineDataInput[]): TurnResolutionOutcome {
    const t0 = Date.now();

    const dbPlayers = players;
    if (dbPlayers.length === 0) {
      return { result: { round, players: [], gameOver: false }, companyUpdates: [], bankruptedPlayers: [], decisionEvents: [], durationMs: Date.now() - t0 };
    }

    // ── Build in-memory context per player ─────────────────────
    const ctxs = new Map<string, PlayerTurnContext>();
    const playerIds: string[] = [];

    for (const p of dbPlayers) {
      const company = p.company!;
      let vars = this.readVariables(company.variables);

      // First turn: seed starting values
      if (!vars.cash && !vars.assets) {
        vars = this.startingVars();
      }

      // Load engine state from JSONB on Company
      const engineState = this.readEngineState(company);

      ctxs.set(p.id, {
        playerId: p.id,
        playerName: p.name,
        vars,
        submittedDecisions: this.submissions.get(roomId)?.get(p.id) ?? null,
        engineState,
        prevCash: vars.cash,
        newDecisionAbsDeltas: undefined,
      });
      playerIds.push(p.id);
    }

    // ── Step 1 — Process newly submitted decisions ─────────────
    // Snapshot how many decisions were already active BEFORE this turn's new
    // submissions get deployed — Step 2 must only advance/re-apply THOSE, never
    // the ones Step 1 is about to push. A decision deployed this same turn
    // already gets its one deployment-year impact applied right here in Step 1
    // (processNewDecisions → applyImpactsForYear, elapsedYears=0); if Step 2 also
    // advanced it, its impact would apply a second time in the same turn it was
    // deployed (see CLAUDE.md's "A decision deployed this turn was double-
    // applying its own impact" section — a real, reproduced bug this snapshot
    // fixes, not a hypothetical).
    const preTurnActiveCount = new Map<string, number>();
    for (const [pid, ctx] of ctxs) {
      preTurnActiveCount.set(pid, ctx.engineState.activeDecisions.length);
    }

    const shareTransactionQueue: ShareTransactionRequest[] = [];
    const decisionEvents: DecisionDeployEvent[] = [];
    for (const [, ctx] of ctxs) {
      if (!ctx.submittedDecisions) continue;
      const { shareTransactions, decisionEvents: events } = this.processNewDecisions(roomId, ctx, round);
      shareTransactionQueue.push(...shareTransactions);
      decisionEvents.push(...events);
    }

    // ── Step 1b — Buy/Sell Shares execution (design addition — not part of the
    // original numbered execution order since Buy/Sell Shares are dynamically-priced
    // trades, not schedule-driven impacts) ──────────────────────────────────────
    // Priced off each target's stockValue AS IT STOOD AT THE START OF THIS TURN (last
    // turn's balance-sheet close) — Step 7 hasn't recomputed it yet this turn, and
    // deliberately isn't waited for (avoids a circular dependency on this turn's not-
    // yet-computed balance sheet; see CLAUDE.md). Grouped by target and sorted by each
    // entry's own first-seen submission timestamp (FIFO ordering) — the first
    // purchase against a given target updates its cap table before the next one in the
    // same group is computed, so overlapping/conflicting purchases resolve in arrival
    // order rather than double-counting or splitting pro-rata between simultaneous
    // buyers.
    const byTarget = new Map<string, ShareTransactionRequest[]>();
    for (const request of shareTransactionQueue) {
      if (!byTarget.has(request.targetId)) byTarget.set(request.targetId, []);
      byTarget.get(request.targetId)!.push(request);
    }
    // Every other player who bought a stake in a given target's company this turn —
    // surfaced to that target as PlayerTurnResult.sharesBoughtThisTurn (a "somebody
    // bought your shares" news item, see CLAUDE.md). Built here, at the exact point the
    // trade executes, rather than reconstructed later from a shareOwnership diff — the
    // diff approach can't disambiguate "this buyer's fractionBought" once dilution from
    // other same-turn buyers/an existing prior stake is mixed in (see the FIFO-stacking
    // section of CLAUDE.md's share-ownership notes), while the transaction itself already
    // knows the exact number.
    const sharesBoughtByTarget = new Map<string, SharesBoughtEvent[]>();
    for (const requests of byTarget.values()) {
      requests.sort((a, b) => a.submittedAt - b.submittedAt);
      for (const request of requests) {
        const fractionBought = this.applyShareTransaction(request, ctxs, round);
        if (fractionBought !== undefined) {
          if (!sharesBoughtByTarget.has(request.targetId)) sharesBoughtByTarget.set(request.targetId, []);
          sharesBoughtByTarget.get(request.targetId)!.push({
            buyerId: request.buyerId,
            buyerName: ctxs.get(request.buyerId)?.playerName ?? '',
            fractionBought,
          });
        }
      }
    }

    // ── Step 2 — Advance pre-existing active decisions by one year ──────
    // Extract absolute schedule deltas directly from impact application
    const absDeltasMap = new Map<string, { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }>();
    const varsList: PlayerVariables[] = [];
    const targetImpactQueue: TargetImpactResult[] = [];
    for (const [pid, ctx] of ctxs) {
      // Only the decisions present before Step 1 ran get advanced — anything Step 1
      // just pushed is appended (unadvanced, still at elapsedYears 0) after.
      const existingCount = preTurnActiveCount.get(pid) ?? 0;
      const preExisting = ctx.engineState.activeDecisions.slice(0, existingCount);
      const justDeployed = ctx.engineState.activeDecisions.slice(existingCount);
      const result = this.decisionEngine.advanceAndApply(
        pid,
        ctx.vars,
        preExisting,
        round,
        this.config.gameSettings.statuteOfLimitationsYears,
        this.config.gameSettings.decisionCostWealthScaleRate ?? 0,
      );
      ctx.vars = result.updatedVars;
      ctx.engineState.activeDecisions = [...result.updatedActiveDecisions, ...justDeployed];

      // Merge newly created depreciation entries into the ledger
      for (const entry of result.newDepreciationEntries) {
        ctx.engineState.depreciationLedger.push(entry);
      }

      // Merge with any absolute deltas from newly deployed decisions on this turn (processNewDecisions already applied them to ctx.vars)
      const newDecisionAbsDeltas = ctx.newDecisionAbsDeltas ?? { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
      absDeltasMap.set(pid, {
        revenueDelta: result.absDeltas.revenueDelta + newDecisionAbsDeltas.revenueDelta,
        financeCostDelta: result.absDeltas.financeCostDelta + newDecisionAbsDeltas.financeCostDelta,
        taxCostDelta: result.absDeltas.taxCostDelta + newDecisionAbsDeltas.taxCostDelta,
        receivablesDelta: result.absDeltas.receivablesDelta + newDecisionAbsDeltas.receivablesDelta,
        cashDelta: result.absDeltas.cashDelta + newDecisionAbsDeltas.cashDelta,
      });

      // Collect this player's outgoing target.* effects — applied after
      // every player has advanced, so it doesn't matter which player's turn is processed
      // first in this loop.
      targetImpactQueue.push(...this.decisionEngine.collectTargetImpacts(ctx.engineState.activeDecisions, this.config.gameSettings.statuteOfLimitationsYears));

      varsList.push(result.updatedVars);
    }

    // Apply queued target.* effects to their targets, then refresh varsList so the
    // Step 4 competitiveness/market-share calc sees the post-attack state.
    for (const entry of targetImpactQueue) {
      if (entry.targetId === undefined) continue;
      const targetCtx = ctxs.get(entry.targetId);
      if (!targetCtx) continue; // target no longer in the game (already bankrupt)
      targetCtx.vars = applyTargetImpacts(targetCtx.vars, entry.impacts, entry.elapsedYears);
    }
    for (let i = 0; i < playerIds.length; i++) {
      varsList[i] = ctxs.get(playerIds[i])!.vars;
    }

    // ── Step 3 — Depreciation ledger ───────────────────────────
    const depreciationMap = new Map<string, number>();
    for (const [pid, ctx] of ctxs) {
      const depResult = applyDepreciation(ctx.vars, ctx.engineState.depreciationLedger, round);
      ctx.vars = depResult.updatedVars;
      ctx.engineState.depreciationLedger = depResult.updatedLedger;
      depreciationMap.set(pid, depResult.totalDepreciation);
    }

    // ── Step 4 — Competitiveness & market share ────────────────
    const marketShares = calculateCompetitivenessAndMarketShare(playerIds, varsList, this.adminVars, this.formulas);
    let si = 0;
    for (const pid of playerIds) {
      varsList[si].marketShare = marketShares.get(pid) || 0;
      // Also update ctx.vars with marketShare
      const ctx = ctxs.get(pid)!;
      ctx.vars.marketShare = varsList[si].marketShare;
      si++;
    }

    // ── Step 5 — Volume with supply cap ─────────────────────────
    const totalVol = this.computeEffectiveTotalMarketVolume(varsList);
    for (const [, ctx] of ctxs) {
      ctx.vars.volume = calculateVolume(ctx.vars, ctx.vars.marketShare || 0, totalVol, this.formulas);
    }

    // ── Step 6 — P&L ─────────────────────────────────────────────
    const plMap = new Map<string, ReturnType<typeof calculatePL>>();
    for (const [pid, ctx] of ctxs) {
      const dep = depreciationMap.get(pid) ?? 0;
      const deltas = absDeltasMap.get(pid) ?? { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
      plMap.set(pid, calculatePL(ctx.vars, ctx.vars.volume || 0, dep, this.adminVars, this.formulas, {
        revenueDelta: deltas.revenueDelta,
        financeCostDelta: deltas.financeCostDelta,
        taxCostDelta: deltas.taxCostDelta,
      }));
    }

    // ── Step 7 — Balance sheet ───────────────────────────────────
    // First, load existing legal cases from engineState (before calculating legal exposure).
    // Every case gets persisted into BOTH the plaintiff's and the defendant's own
    // engineState.legalCases at the end of the turn it's active in (Step 12) — each side
    // needs it in their own persisted state — so it's present in two different players'
    // engineState by the time it's loaded back here. Dedupe by id (last write wins, though
    // both copies are always identical) or this list — and, since Step 12 persists whatever
    // it finds back into every party's engineState again, the duplication too — doubles
    // every subsequent turn.
    const allCasesById = new Map<string, LegalCaseData>();
    for (const [, ctx] of ctxs) {
      for (const c of ctx.engineState.legalCases) {
        if (c.status !== 'resolved') {
          allCasesById.set(c.id, c);
        }
      }
    }
    const allCases: LegalCaseData[] = Array.from(allCasesById.values());

    // Calculate legal exposure for each player from their open cases
    const legalExposureMap = new Map<string, number>();
    for (const pid of playerIds) {
      const defendantCases = allCases.filter(c => c.defendantId === pid && c.status !== 'resolved');
      const legalExposure = defendantCases.reduce((sum, c) => sum + (c.adjustedProbability ?? c.baseProbability) * c.stakes, 0);
      legalExposureMap.set(pid, legalExposure);
    }

    for (const [pid, ctx] of ctxs) {
      const pl = plMap.get(pid)!;
      const dep = depreciationMap.get(pid) ?? 0;
      const deltas = absDeltasMap.get(pid) ?? { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
      const legalExposure = legalExposureMap.get(pid) ?? 0;
      const bs = updateBalanceSheet(ctx.vars, pl.netProfit, dep, pl.revenue, legalExposure, this.adminVars, this.formulas, deltas.receivablesDelta);
      ctx.vars.cash = bs.cash;
      ctx.vars.reserves = bs.reserves;
      ctx.vars.receivables = bs.receivables;
      ctx.vars.equity = bs.equity;
      ctx.vars.stockValue = bs.stockValue;
      ctx.vars.legalExposure = bs.legalExposure;
      ctx.vars.legalExposureRatio = calculateLegalExposureRatio(legalExposure, ctx.vars.cash, this.adminVars, this.formulas);
    }

    // Snapshot cases already negotiating BEFORE this turn's filings, for the
    // negotiation-timeout step below — a case filed this turn starts at
    // turnsNegotiating 0 and shouldn't be incremented in the same turn it's created.
    const negotiatingBeforeFiling = allCases.filter(c => c.status === 'negotiating');

    // Tracks cash actually RECEIVED this turn via case transfers per plaintiff — the
    // "case-siirrot: saatu" line of the operating cash flow, feeding the
    // §16 bankruptcy waterfall pool. Declared here (rather than down at Step 9, where it
    // used to live) since a stale-offer auto-settlement in Step 8b is just as real a
    // same-turn cash receipt as a trial payout — both write into this same map.
    const legalReceivedThisTurn = new Map<string, number>();

    // ── Step 8 — Deliberate lawsuit filings ─────────────────────────────────────
    // Lawsuits are never automatic — a player must choose to sue a specific target
    // over a specific ground drawn from that target's actually-deployed decisions,
    // up to maxLawsuitsPerPlayerPerTurn filings per turn.
    const maxLawsuits = this.config.gameSettings.maxLawsuitsPerPlayerPerTurn;
    for (const [, ctx] of ctxs) {
      if (!ctx.submittedDecisions) continue;
      for (const filing of ctx.submittedDecisions.lawsuits.slice(0, maxLawsuits)) {
        const targetCtx = ctxs.get(filing.targetId);
        if (!targetCtx) continue;
        // Voided instances are excluded — a decision already shut down by a lost lawsuit
        // is no longer a live ground to sue over again; `.find()`-by-name below must land
        // on a genuinely live instance (if the player redeployed since), never a stale
        // voided one sitting earlier in the array. Already-sued instances (`everSued`) are
        // excluded the same way — first come, first served: once ANY lawsuit has ever been
        // filed against a specific instance, no further one can target it, regardless of how
        // that first case resolves (see CLAUDE.md).
        const targetActiveDecisions = targetCtx.engineState.activeDecisions
          .filter(d => !d.voidedByLawsuit && !d.everSued)
          .map(d => ({
            id: d.id,
            decisionName: d.definition.decision,
            elapsedYears: d.elapsedYears,
            acquisitionFraction: d.acquisitionFraction,
          }));

        // `targetCtx.vars` doesn't carry this turn's `revenue` — unlike `equity` (written
        // back in Step 7 above), `revenue` is only ever materialized into the local `plMap`
        // for the turn's broadcast result, never round-tripped onto `ctx.vars` (see
        // CLAUDE.md's stakes-calculation note). A relative-type legal-risk ground targeting
        // `revenue` (17 of the 25 in the real library) needs the real figure, not
        // `undefined`/a stale Step-1 delta, so it's patched in here for fileLawsuit's stakes
        // calc — a targeted override, not a general "persist revenue onto vars" change.
        const targetVarsForFiling = { ...targetCtx.vars, revenue: plMap.get(filing.targetId)?.revenue ?? targetCtx.vars.revenue };

        // Does the plaintiff already know these odds from fully "Dig Deeper"-investigating
        // the underlying attack, and are they suing over one of the grounds that
        // investigation actually surfaced? Mirrors revealAttack's own level-3 computation
        // exactly (same instance, same attacker vars, same pickAllGrounds call) — matches
        // ANY of the returned grounds, not just the first (highest-probability) one, since
        // a fully-investigated player now sees every viable ground on the hint card, not
        // just the single strongest.
        // Direct decisions must actually target the plaintiff; indirect ones (no target at
        // all — see isIndirectEffect) just need to be an instance of the cited decision
        // name on the cited defendant, since we're already scoped to `targetCtx`'s own
        // decisions and there's no targeting relationship to further disambiguate by.
        //
        // When `filing.attackId` is present, matched by that EXACT instance id (plus the
        // same targeting/name checks) rather than "the first name+targeting match" — a
        // target can legitimately have two live, un-sued instances of the same decision at
        // once (stacking a permanent-effect decision is normal, intended play), and
        // resolving to the wrong one here previously let the instance the plaintiff
        // actually investigated dodge `everSued` forever (see `fileLawsuit`'s `attackId`
        // doc comment / CLAUDE.md — a real, reported incident).
        let plaintiffFullyInvestigated = false;
        const matchesInvestigatedAttack = (d: DeployedDecision): boolean => {
          if (d.voidedByLawsuit) return false;
          if (d.definition.decision !== filing.decisionName) return false;
          const targetImpacts = this.decisionEngine.getTargetImpacts(d.definition.impacts);
          return this.isIndirectEffect(d.definition, targetImpacts, d.targetId) || d.targetId === ctx.playerId;
        };
        const attackInstance = filing.attackId !== undefined
          ? targetCtx.engineState.activeDecisions.find((d) => d.id === filing.attackId && matchesInvestigatedAttack(d))
          : targetCtx.engineState.activeDecisions.find(matchesInvestigatedAttack);
        if (attackInstance) {
          const rawLevel = ctx.engineState.investigations[attackInstance.id] ?? 0;
          const level = this.effectiveInvestigationLevel(rawLevel, ctxs.size);
          if (level >= MAX_INVESTIGATION_LEVEL) {
            const grounds = pickAllGrounds(attackInstance.definition, attackInstance.elapsedYears, targetCtx.vars, this.adminVars, this.formulas, this.config.gameSettings.statuteOfLimitationsYears);
            plaintiffFullyInvestigated = grounds.some((g) => g.name === filing.groundName);
          }
        }

        const newCase = this.legalEngine.fileLawsuit(
          ctx.playerId,
          filing.targetId,
          filing.decisionName,
          filing.groundName,
          targetActiveDecisions,
          targetVarsForFiling,
          roomId,
          plaintiffFullyInvestigated,
          this.config.gameSettings.statuteOfLimitationsYears,
          filing.attackId,
        );
        if (newCase) {
          // Late-game escalation (see CLAUDE.md/GameSettings doc comments): once the game
          // has run past lateGameRoundThreshold, a genuine case (baseProbability already
          // nonzero — a wrong guess/time-barred ground stays exactly 0, multiplying is a
          // no-op) gets a real-terms boost, both to its odds (capped at 0.95 — never a sure
          // thing) and its stakes. Targets the specific finding that elimination relies
          // almost entirely on lawsuit-driven bankruptcy with no reliable fallback once a
          // stalemate sets in — this keeps litigation credibly dangerous against a leader
          // whose cash cushion has otherwise outgrown what any one case could touch.
          if (round >= this.config.gameSettings.lateGameRoundThreshold && newCase.baseProbability > 0) {
            // `?? 1` (neutral, no change) guards a config loaded before these fields
            // existed in the DB — see wealthScaledFee's doc comment for the exact failure
            // mode this prevents (a real, reproduced incident).
            newCase.baseProbability = Math.min(0.95, newCase.baseProbability * (this.config.gameSettings.lateGameLegalProbabilityBoost ?? 1));
            newCase.stakes = newCase.stakes * (this.config.gameSettings.lateGameLegalStakesBoost ?? 1);
          }
          allCases.push(newCase);
          // Claim the instance the instant a genuine (non-wrong-guess, non-time-barred)
          // case is filed against it — `defendantDecisionInstanceId` is only ever set for
          // exactly that case (see LegalEngine.fileLawsuit), so this fires precisely once
          // per instance, first come first served. Any later filing this same turn (or any
          // future turn) re-reads `targetCtx.engineState.activeDecisions` fresh and will no
          // longer find this instance in the unclaimed `targetActiveDecisions` list above.
          if (newCase.defendantDecisionInstanceId) {
            const claimedInstance = targetCtx.engineState.activeDecisions.find(d => d.id === newCase.defendantDecisionInstanceId);
            if (claimedInstance) claimedInstance.everSued = true;
          }
        }
      }
    }

    // ── Step 8b — Negotiation timeout / stale-offer auto-settle (design addition,
    // beyond the base turn math) ───────────────────────────────────────────────
    // The base turn math has no concept of a negotiation phase at all — a case is just
    // "resolved this turn" via a probability draw. The 'negotiating' status and its offer/accept
    // flow (`makeOffer`/`acceptOffer`/`goToCourt` below — instant, out-of-band actions,
    // not part of this turn cycle) are a richer addition than spec. Two distinct things
    // can leave a case dangling at a turn boundary, and each gets a different fallback:
    //
    // 1. GENUINE back-and-forth happened (`offers.length > 1` — both sides have been
    //    heard from at least once) and the round ended before the other side answered
    //    the latest move. Rather than let it linger, the standing offer is treated as
    //    accepted: the case settles right here for the last offer's amount, no
    //    probability draw needed. This is the *only* way a case can settle besides an
    //    explicit `acceptOffer` call — same cash-transfer shape (defendant pays
    //    plaintiff), tracked in `legalReceivedThisTurn` exactly like a trial payout so
    //    the §16 bankruptcy pool sees it as real income received this turn.
    // 2. Nobody ever really engaged — either `offers` is still empty, OR exactly ONE
    //    one-sided offer sits there with zero response (a real, reported bug: the
    //    defendant's own opening move, e.g. the bot's rational $0 offer on a
    //    provably-hopeless case, used to auto-settle the very next boundary purely
    //    because SOME offer object existed, even though the plaintiff never did
    //    anything — accepted nothing, countered nothing, forced no trial. From their
    //    side this read as "Settled" for an agreement they never made). A single
    //    unengaged offer is treated exactly like no offer at all: after
    //    `negotiationPeriodTurns` turns of silence, force to trial instead of quietly
    //    accepting whatever the opening mover happened to propose. The existing
    //    trial-resolution loop right below reads the very same `allCases` objects this
    //    mutates, so a case crossing the threshold resolves in this SAME turn (not
    //    "starts waiting, resolves next turn") — the client never observes an
    //    `awaiting_trial` snapshot for a case that timed out this way.
    //
    // A case with active back-and-forth (every offer answered before its turn boundary)
    // never reaches branch 2's cap — by construction, any exchange that never explicitly
    // accepts or goes to court always has an unanswered offer sitting at the next
    // boundary check once a SECOND offer exists, so branch 1 settles it first. The cap
    // only ever fires for a case nobody ever engages with beyond, at most, one one-sided
    // opening move.
    const negotiationPeriodTurns = this.config.gameSettings.negotiationPeriodTurns;
    for (const case_ of negotiatingBeforeFiling) {
      case_.turnsNegotiating += 1;
      if (case_.offers.length > 1) {
        const lastOffer = case_.offers[case_.offers.length - 1];
        const defCtx = ctxs.get(case_.defendantId);
        const pltCtx = ctxs.get(case_.plaintiffId);
        if (defCtx && pltCtx) {
          defCtx.vars.cash -= lastOffer.amount;
          pltCtx.vars.cash += lastOffer.amount;
          legalReceivedThisTurn.set(
            case_.plaintiffId,
            (legalReceivedThisTurn.get(case_.plaintiffId) ?? 0) + lastOffer.amount,
          );
          this.voidSuedDecisionInstance(defCtx.engineState, case_);
        }
        case_.status = 'resolved';
        case_.verdict = 'settled';
        case_.resolvedAt = new Date();
      } else if (case_.turnsNegotiating >= negotiationPeriodTurns) {
        case_.status = 'awaiting_trial';
      }
    }

    // Resolve awaiting trials from previous turns (adjustedProbability, using legal exposure ratio)
    const casesResolvedThisTurn: LegalCaseData[] = [];
    for (const trial of allCases) {
      if (trial.status !== 'awaiting_trial') continue;
      const defCtx = ctxs.get(trial.defendantId);
      if (!defCtx) continue;
      const defLegalExposureRatio = calculateLegalExposureRatio(
        legalExposureMap.get(trial.defendantId) ?? 0,
        defCtx.vars.cash,
        this.adminVars,
        this.formulas,
      );
      const adjProb = calculateAdjustedProbability(
        trial.baseProbability,
        defCtx.vars.scrutiny,
        defLegalExposureRatio,
        this.adminVars,
        this.formulas,
      );
      const won = Math.random() < adjProb;
      trial.adjustedProbability = adjProb;
      trial.verdict = won ? 'won' : 'lost';
      trial.status = 'resolved';
      trial.resolvedAt = new Date();
      if (won) this.voidSuedDecisionInstance(defCtx.engineState, trial);
      casesResolvedThisTurn.push(trial);
    }

    // ── Step 9 — Process resolved cases & apply cash settlements ───────────────────
    // Apply verdict cash flows: loser pays stakes to winner, CAPPED to the defendant's
    // own actually-available (non-negative) cash — a real, reported bug: this used to be
    // an unconditional `cash -= stakes`, so a plaintiff could "receive" the full nominal
    // stakes even when the defendant's cash couldn't cover it, effectively paying out
    // money that didn't exist. This is the same problem `distributeCaseWaterfall`
    // (Step 10b) already solves for a case still open when its defendant is eliminated —
    // this closes the gap for a case that resolves via a NORMAL trial verdict THIS turn
    // instead, before bankruptcy is even checked. When multiple cases resolve 'won'
    // against the SAME defendant this turn, they share that defendant's available cash in
    // filing order (oldest `createdAt` first) — same FIFO tie-break convention as the
    // waterfall — rather than each independently driving cash further negative.
    // `legalReceivedThisTurn` (declared up at Step 8b, which can also write into it)
    // tracks amounts actually RECEIVED this turn per player, using the real (possibly
    // capped) payment, never the nominal `stakes`.
    const wonCasesByDefendant = new Map<string, LegalCaseData[]>();
    for (const trial of casesResolvedThisTurn) {
      if (trial.verdict !== 'won') continue;
      if (!ctxs.has(trial.defendantId) || !ctxs.has(trial.plaintiffId)) continue;
      if (!wonCasesByDefendant.has(trial.defendantId)) wonCasesByDefendant.set(trial.defendantId, []);
      wonCasesByDefendant.get(trial.defendantId)!.push(trial);
    }
    // A defendant whose cash could not cover the full judgment is insolvent, and must be
    // eliminated even though the cap above deliberately stops their cash going negative.
    // A real, reported bug (2026-08-12): the cap exists so a plaintiff can never collect
    // money that doesn't exist, but it also drained losing defendants to EXACTLY 0.00 —
    // and Step 10's bankruptcy test is `cash < 0`, which zero fails. Two different players
    // in the same game survived judgments they demonstrably could not pay (one sat on
    // exactly 0.00 for two consecutive rounds). Being unable to satisfy a judgment is the
    // textbook definition of insolvency, so it's tracked here rather than inferred from a
    // cash balance that has been deliberately clamped.
    const insolventFromJudgment = new Set<string>();
    for (const [defendantId, wonCases] of wonCasesByDefendant) {
      const defCtx = ctxs.get(defendantId)!;
      wonCases.sort((a, b) => caseFiledAtMs(a) - caseFiledAtMs(b));
      let available = Math.max(0, defCtx.vars.cash);
      for (const trial of wonCases) {
        const pltCtx = ctxs.get(trial.plaintiffId)!;
        const payment = Math.min(trial.stakes, available);
        defCtx.vars.cash -= payment;
        pltCtx.vars.cash += payment;
        available -= payment;
        if (payment < trial.stakes) {
          trial.actualAmountPaid = payment;
          insolventFromJudgment.add(defendantId);
        }
        legalReceivedThisTurn.set(
          trial.plaintiffId,
          (legalReceivedThisTurn.get(trial.plaintiffId) ?? 0) + payment,
        );
      }
    }
    // Defendant-won ('lost') verdicts need no payment — nothing further to do for them.

    // ── Step 10 — Check for bankruptcies & mergers ───────────────────────────
    const playersStillActive: string[] = [];
    const playersToBankrupt: string[] = [];

    for (const pid of playerIds) {
      const ctx = ctxs.get(pid)!;
      // Bankruptcy: cash < 0 on any turn, OR a judgment this turn that the player's own
      // cash could not cover (see `insolventFromJudgment` above — their cash reads exactly
      // 0 by design in that case, so it can't be detected from the balance alone).
      if (ctx.vars.cash < 0 || insolventFromJudgment.has(pid)) {
        playersToBankrupt.push(pid);
        continue;
      }
      playersStillActive.push(pid);
    }

    // Majority-ownership takeover — a second elimination path,
    // entirely independent of bankruptcy. Any player (never the reserved `"self"`/
    // `EXTERNAL_MARKET"` sentinel keys) holding more than `takeoverThresholdPercent`
    // (50% by default, admin-editable) of another player's shareOwnership eliminates
    // that player, exactly as if they'd gone bankrupt. This used to hardcode `0.5`
    // directly — `admin.ownership.takeoverThresholdPercent` existed in config/seed/
    // validation the whole time but was never actually read anywhere, the same class
    // of dead-config bug already fixed once for `legalRiskConditions.
    // minPercentAcquiredInSingleTransaction` (see CLAUDE.md). Wired in now so an
    // admin-edited threshold and `calcEngine.ts`'s `calculateOwnershipRisk` (the Risk
    // Gauge's takeover-risk term, which reads this same config value) can never drift
    // apart from the actual elimination trigger.
    // Precedence: a prospective acquirer who is themselves going bankrupt THIS SAME
    // turn can't complete a takeover — they're leaving the game too, so their pending
    // majority stake simply doesn't trigger anything this turn (it gets swept back to
    // EXTERNAL_MARKET below, same as any other eliminated player's cross-holdings, so
    // it can never resurface as a stale claim on a later turn either).
    const takeoverThresholdPercent = this.adminVars.ownership.takeoverThresholdPercent;
    const playersToMerge: Array<{ pid: string; acquirerId: string; acquirerName: string }> = [];
    for (const pid of playerIds) {
      if (playersToBankrupt.includes(pid)) continue;
      const ownership = ctxs.get(pid)!.vars.shareOwnership ?? {};
      const acquirerEntry = Object.entries(ownership).find(
        ([key, fraction]) => key !== SELF_OWNERSHIP_KEY && key !== EXTERNAL_MARKET_KEY && fraction > takeoverThresholdPercent,
      );
      if (!acquirerEntry) continue;
      const [acquirerId] = acquirerEntry;
      if (playersToBankrupt.includes(acquirerId)) continue;
      const acquirerCtx = ctxs.get(acquirerId);
      if (!acquirerCtx) continue;
      playersToMerge.push({ pid, acquirerId, acquirerName: acquirerCtx.playerName });
      const idx = playersStillActive.indexOf(pid);
      if (idx !== -1) playersStillActive.splice(idx, 1);
    }

    // ── Step 10b — Case waterfall distribution for every elimination this turn
    // ("the same rule applies to both bankruptcy and merger", so both
    // reuse the exact same `distributeCaseWaterfall` — see its doc comment) ─────────
    //
    // buildFinalSnapshot mirrors Step 11/13's own per-active-player computation
    // (calculateRiskGauge / the derived-stats shape), just also run for an eliminated
    // player before their engine state is discarded — see BankruptedPlayer's doc comment
    // for why this has to be captured here rather than left to the normal
    // riskMap/results loops, which only ever run over `playersStillActive`.
    const buildFinalSnapshot = (pid: string): { finalVariables: PlayerVariables; finalDerived: PlayerDerivedStats; finalRiskGauge: number } => {
      const ctx = ctxs.get(pid)!;
      const pl = plMap.get(pid)!;
      const dep = depreciationMap.get(pid) ?? 0;
      const openCases = allCases
        .filter(c => c.defendantId === pid && c.status !== 'resolved')
        .map(c => ({ probability: c.adjustedProbability ?? c.baseProbability, stakes: c.stakes }));
      return {
        finalVariables: this.stripInternal(ctx.vars),
        finalDerived: {
          equity: ctx.vars.equity || 0,
          revenue: pl.revenue,
          volume: ctx.vars.volume || 0,
          receivables: ctx.vars.receivables || 0,
          financeCost: pl.financeCost,
          taxCost: pl.taxCost,
          depreciation: dep,
          stockValue: ctx.vars.stockValue || 0,
          marketShare: ctx.vars.marketShare || 0,
          competitiveness: ctx.vars.competitiveness || 0,
        },
        finalRiskGauge: calculateRiskGauge(ctx.vars, openCases, this.adminVars, this.formulas),
      };
    };

    const bankruptedPlayers: BankruptedPlayer[] = [];
    for (const pid of playersToBankrupt) {
      const ctx = ctxs.get(pid)!;
      const finalCash = this.distributeCaseWaterfall(pid, ctxs, allCases, plMap, depreciationMap, absDeltasMap, legalReceivedThisTurn);
      bankruptedPlayers.push({ playerId: pid, playerName: ctx.playerName, finalCash, ...buildFinalSnapshot(pid), reason: 'bankruptcy' });
    }
    for (const { pid, acquirerId, acquirerName } of playersToMerge) {
      const ctx = ctxs.get(pid)!;
      const acquirerCtx = ctxs.get(acquirerId)!;
      const finalCash = this.distributeCaseWaterfall(pid, ctxs, allCases, plMap, depreciationMap, absDeltasMap, legalReceivedThisTurn);
      const snapshot = buildFinalSnapshot(pid);
      // Acquirer inherits the eliminated company's cash/assets/intangibleAssets — a
      // confirmed product decision beyond what the base spec describes (which only
      // ever specifies elimination, not a transfer of value); deliberately NOT debt, NOT
      // active decisions/production variables, and NOT legal cases (those already lapsed
      // via the same waterfall call above).
      //
      // A mergerIntegrationCostRate fraction of a POSITIVE finalCash is lost rather than
      // transferred — a deliberate cash sink (see GameSettings doc comment): without it,
      // hostile takeover was a second, unlimited wealth-CONCENTRATION mechanism (100%
      // pass-through) working directly against the other sinks below. Only applied when
      // finalCash is positive — a target that's simultaneously insolvent (finalCash <= 0,
      // an edge case the waterfall can still produce) already leaves the acquirer worse
      // off; skimming a negative number would perversely reduce the debt they inherit.
      // `?? 0` (no skim, full pass-through — the pre-feature default) guards a config
      // loaded before this field existed in the DB — see wealthScaledFee's doc comment.
      const transferredCash = finalCash > 0 ? finalCash * (1 - (this.config.gameSettings.mergerIntegrationCostRate ?? 0)) : finalCash;
      acquirerCtx.vars.cash += transferredCash;
      acquirerCtx.vars.assets = (acquirerCtx.vars.assets || 0) + (ctx.vars.assets || 0);
      acquirerCtx.vars.intangibleAssets = (acquirerCtx.vars.intangibleAssets || 0) + (ctx.vars.intangibleAssets || 0);
      bankruptedPlayers.push({ playerId: pid, playerName: ctx.playerName, finalCash, ...snapshot, reason: 'merger', acquirerId, acquirerName });
    }

    // Sweep every eliminated player's cross-holdings out of every OTHER company's cap
    // table, reassigned to EXTERNAL_MARKET — otherwise a departed player's stake would
    // sit forever in another player's shareOwnership map, permanently un-payable and
    // un-reclaimable (scaled down by future dilution but never actually resolved).
    const eliminatedIds = new Set<string>([...playersToBankrupt, ...playersToMerge.map(m => m.pid)]);
    if (eliminatedIds.size > 0) {
      for (const [, ctx] of ctxs) {
        const ownership = ctx.vars.shareOwnership;
        if (!ownership) continue;
        let changed = false;
        const cleaned = { ...ownership };
        for (const key of Object.keys(cleaned)) {
          if (!eliminatedIds.has(key)) continue;
          cleaned[EXTERNAL_MARKET_KEY] = (cleaned[EXTERNAL_MARKET_KEY] ?? 0) + cleaned[key];
          delete cleaned[key];
          changed = true;
        }
        if (changed) ctx.vars.shareOwnership = renormalizeShareOwnership(cleaned);
      }
    }

    // ── Step 11 — Risk gauge ─────────────────────────────────────
    const riskMap = new Map<string, number>();
    for (const pid of playersStillActive) {
      const ctx = ctxs.get(pid)!;
      const openCases = allCases
        .filter(c => c.defendantId === pid && c.status !== 'resolved')
        .map(c => ({ probability: c.adjustedProbability ?? c.baseProbability, stakes: c.stakes }));
      riskMap.set(pid, calculateRiskGauge(ctx.vars, openCases, this.adminVars, this.formulas));
    }

    // ── Step 12 — Collect Company persistence updates (all engine state in JSONB) ──
    const companyUpdates: CompanyPersistUpdate[] = [];
    for (const pid of playersStillActive) {
      const ctx = ctxs.get(pid)!;
      const saveVars = this.stripInternal(ctx.vars);
      companyUpdates.push({
        playerId: pid,
        cash: ctx.vars.cash,
        variables: saveVars,
        engineState: {
          activeDecisions: ctx.engineState.activeDecisions.map(d => ({
            id: d.id,
            definitionName: d.definition.decision,
            deployedYear: d.deployedYear,
            elapsedYears: d.elapsedYears,
            isMatured: d.isMatured,
            targetId: d.targetId,
            voidedByLawsuit: d.voidedByLawsuit,
            everSued: d.everSued,
            acquisitionFraction: d.acquisitionFraction,
          })),
          depreciationLedger: ctx.engineState.depreciationLedger,
          legalCases: allCases.filter(c => c.plaintiffId === pid || c.defendantId === pid),
          investigations: ctx.engineState.investigations,
        },
      });
    }

    // ── Step 13 — Build result ─────────────────────────────────
    const results: PlayerTurnResult[] = [];
    for (const pid of playersStillActive) {
      const ctx = ctxs.get(pid)!;
      const pl = plMap.get(pid)!;
      const dep = depreciationMap.get(pid) ?? 0;
      results.push({
        playerId: pid,
        playerName: ctx.playerName,
        variables: this.stripInternal(ctx.vars),
        derived: {
          equity: ctx.vars.equity || 0,
          revenue: pl.revenue,
          volume: ctx.vars.volume || 0,
          receivables: ctx.vars.receivables || 0,
          financeCost: pl.financeCost,
          taxCost: pl.taxCost,
          depreciation: dep,
          stockValue: ctx.vars.stockValue || 0,
          marketShare: ctx.vars.marketShare || 0,
          competitiveness: ctx.vars.competitiveness || 0,
        },
        activeDecisions: ctx.engineState.activeDecisions.map(d => ({
          id: d.id,
          decisionName: d.definition.decision,
          deployedYear: d.deployedYear,
          maturityYears: calcMaturity(d.definition.impacts),
          elapsedYears: d.elapsedYears,
          isMatured: d.isMatured,
          voidedByLawsuit: d.voidedByLawsuit,
          targetId: d.targetId,
        })),
        legalCases: allCases.filter(c => c.plaintiffId === pid || c.defendantId === pid),
        riskGauge: riskMap.get(pid) ?? 0,
        incomingAttacks: this.buildIncomingAttacks(pid, ctxs, playersStillActive, plMap),
        sharesBoughtThisTurn: sharesBoughtByTarget.get(pid) ?? [],
      });
    }

    const gameOver = playersStillActive.length <= 1;
    let winnerId: string | undefined;
    if (gameOver && playersStillActive.length === 1) {
      winnerId = playersStillActive[0];
    }

    this.clearSubmissions(roomId);

    const durationMs = Date.now() - t0;

    return {
      result: { round, players: results, gameOver, winnerId },
      companyUpdates,
      bankruptedPlayers,
      decisionEvents,
      durationMs,
    };
  }

  /**
   * Compute each player's starting-position snapshot — used when the host starts the
   * game, so players land straight in the game room showing their real starting numbers
   * instead of a blank "waiting" screen for the full first `turnDurationSeconds` window.
   * No decisions have been submitted yet, so this reuses the same formula pipeline as
   * resolveTurn (competitiveness/market-share/volume/P&L/balance-sheet steps) with zero
   * decision impacts, zero legal cases, and zero
   * depreciation — nothing to persist, nothing that could produce a bankruptcy or
   * game-over. The real round-1 resolution still happens normally when the timer
   * expires. Like resolveTurn, this is pure: the caller is responsible for broadcasting
   * the returned snapshot.
   */
  getInitialSnapshot(_roomId: string, round: number, players: EngineDataInput[]): TurnResolutionResult {
    const dbPlayers = players;
    if (dbPlayers.length === 0) return { round, players: [], gameOver: false, isInitialSnapshot: true };

    const varsByPlayer = new Map<string, PlayerVariables>();
    const playerIds: string[] = [];
    const playerNames = new Map<string, string>();

    for (const p of dbPlayers) {
      const company = p.company!;
      let vars = this.readVariables(company.variables);
      if (!vars.cash && !vars.assets) {
        vars = this.startingVars();
      }
      varsByPlayer.set(p.id, vars);
      playerNames.set(p.id, p.name);
      playerIds.push(p.id);
    }

    // Competitiveness & market share (zero-sum across all players)
    const varsList = playerIds.map(pid => varsByPlayer.get(pid)!);
    const marketShares = calculateCompetitivenessAndMarketShare(playerIds, varsList, this.adminVars, this.formulas);
    for (const pid of playerIds) {
      varsByPlayer.get(pid)!.marketShare = marketShares.get(pid) || 0;
    }

    // Volume with supply cap
    const totalVol = this.computeEffectiveTotalMarketVolume(varsList);
    for (const pid of playerIds) {
      const vars = varsByPlayer.get(pid)!;
      vars.volume = calculateVolume(vars, vars.marketShare || 0, totalVol, this.formulas);
    }

    const results: PlayerTurnResult[] = [];
    for (const pid of playerIds) {
      const vars = varsByPlayer.get(pid)!;
      // P&L (no decisions yet, so no absolute schedule deltas)
      const pl = calculatePL(vars, vars.volume || 0, 0, this.adminVars, this.formulas);
      // Balance sheet (no legal exposure yet — no cases exist on turn 1)
      const bs = updateBalanceSheet(vars, pl.netProfit, 0, pl.revenue, 0, this.adminVars, this.formulas);
      vars.cash = bs.cash;
      vars.reserves = bs.reserves;
      vars.receivables = bs.receivables;
      vars.equity = bs.equity;
      vars.stockValue = bs.stockValue;
      vars.legalExposure = bs.legalExposure;
      vars.legalExposureRatio = 0;

      results.push({
        playerId: pid,
        playerName: playerNames.get(pid) ?? '',
        variables: this.stripInternal(vars),
        derived: {
          equity: vars.equity || 0,
          revenue: pl.revenue,
          volume: vars.volume || 0,
          receivables: vars.receivables || 0,
          financeCost: pl.financeCost,
          taxCost: pl.taxCost,
          depreciation: 0,
          stockValue: vars.stockValue || 0,
          marketShare: vars.marketShare || 0,
          competitiveness: vars.competitiveness || 0,
        },
        activeDecisions: [],
        legalCases: [],
        riskGauge: calculateRiskGauge(vars, [], this.adminVars, this.formulas),
        incomingAttacks: [],
        sharesBoughtThisTurn: [],
      });
    }

    return { round, players: results, gameOver: false, isInitialSnapshot: true };
  }

  /**
   * "Dig Deeper" — pay `gameSettings.digDeeperCost` to reveal the next tier of intel on
   * one incoming attack. Unlike `resolveTurn`, this is NOT part of the turn cycle: it's
   * a single-player, out-of-band action a client can trigger any time during GAME_PHASE,
   * independent of the turn timer. Still pure (no Prisma/Socket.IO) — the caller
   * (`GameEngine.digDeeper`) persists `engineStateUpdate`/`newCash` and emits the result
   * back to just the requesting socket.
   */
  digDeeper(playerId: string, attackId: string, players: EngineDataInput[]): DigDeeperOutcome {
    const byId = new Map<string, { name: string; vars: PlayerVariables; engineState: CompanyEngineState }>();
    for (const p of players) {
      if (!p.company) continue;
      let vars = this.readVariables(p.company.variables);
      // Same "first turn hasn't resolved yet, Company.variables is still {}" fallback
      // resolveTurn/getInitialSnapshot already apply — this is an instant, out-of-band
      // action that can in principle be triggered before any turn has ever resolved.
      if (!vars.cash && !vars.assets) vars = this.startingVars();
      byId.set(p.id, {
        name: p.name,
        vars,
        engineState: this.readEngineState(p.company),
      });
    }

    const me = byId.get(playerId);
    if (!me) return { success: false, reason: 'player_not_found' };

    // The attacking decision instance lives in SOME OTHER player's activeDecisions —
    // never trust the client past that. Direct ones must actually target this player;
    // indirect ones (isIndirectEffect) have no target at all, so any other active
    // player may legitimately dig into one (matches buildIncomingAttacks broadcasting
    // it to everyone in the first place).
    let attacker: { id: string; name: string; decision: DeployedDecision; isIndirect: boolean } | null = null;
    for (const [pid, state] of byId) {
      if (pid === playerId) continue;
      const inst = state.engineState.activeDecisions.find(d => d.id === attackId);
      if (!inst) continue;
      if (inst.voidedByLawsuit) continue;
      const targetImpacts = this.decisionEngine.getTargetImpacts(inst.definition.impacts);
      const isIndirect = this.isIndirectEffect(inst.definition, targetImpacts, inst.targetId);
      if (!isIndirect && inst.targetId !== playerId) continue;
      if (!isIndirect && targetImpacts.size === 0 && inst.definition.shareTransactionType !== 'buy') continue;
      attacker = { id: pid, name: state.name, decision: inst, isIndirect };
      break;
    }
    if (!attacker) return { success: false, reason: 'invalid_attack' };

    // byId's size is every active (non-bankrupt) player in the room, target included —
    // 2 means a heads-up game, where digDeeper's next raw level should skip straight to
    // level-2 content (see effectiveInvestigationLevel's doc comment).
    const activePlayerCount = byId.size;
    const currentLevel = me.engineState.investigations[attackId] ?? 0;
    if (this.effectiveInvestigationLevel(currentLevel, activePlayerCount) >= MAX_INVESTIGATION_LEVEL) {
      return { success: false, reason: 'already_fully_investigated' };
    }

    const cost = this.wealthScaledFee(this.config.gameSettings.digDeeperCost, me.vars.cash);
    if (me.vars.cash < cost) return { success: false, reason: 'insufficient_funds' };

    const newLevel = currentLevel + 1;
    const newCash = me.vars.cash - cost;
    const newInvestigations = { ...me.engineState.investigations, [attackId]: newLevel };

    const attackerVars = byId.get(attacker.id)!.vars;
    const attack = this.revealAttack(attacker.id, attacker.name, attacker.decision, this.effectiveInvestigationLevel(newLevel, activePlayerCount), attackerVars, attacker.isIndirect);

    return {
      success: true,
      attackId,
      cost,
      newCash,
      attack,
      variables: this.stripInternal({ ...me.vars, cash: newCash }),
      engineStateUpdate: {
        activeDecisions: me.engineState.activeDecisions.map(d => ({
          id: d.id,
          definitionName: d.definition.decision,
          deployedYear: d.deployedYear,
          elapsedYears: d.elapsedYears,
          isMatured: d.isMatured,
          targetId: d.targetId,
          voidedByLawsuit: d.voidedByLawsuit,
          everSued: d.everSued,
          acquisitionFraction: d.acquisitionFraction,
        })),
        depreciationLedger: me.engineState.depreciationLedger,
        legalCases: me.engineState.legalCases,
        investigations: newInvestigations,
      },
    };
  }

  /**
   * Charge the flat `gameSettings.lawsuitFilingCost` filing fee the instant a player
   * actually files a lawsuit (SueModal's "File" button) — like `digDeeper`, this is a
   * single-player, out-of-band mutation independent of the turn timer, not part of
   * `resolveTurn`. The lawsuit itself is still only created/validated at the next turn
   * resolution via the normal submitDecisions → `LegalEngine.fileLawsuit` path (Step 8);
   * this only ever moves cash. Deliberately not refunded if that later validation
   * rejects the case (e.g. the target no longer has the cited decision deployed) —
   * filing is a real, deliberate action the instant it's paid for, by product decision.
   *
   * Capped at `gameSettings.maxLawsuitsPerPlayerPerTurn` using `this.submissions`, the
   * same in-memory per-round store `submitDecisions`/`resolveTurn` use — this player's
   * currently-queued lawsuit count (before the one about to be charged) must be under
   * the limit, or a client could rack up fee charges for filings Step 8's own
   * `.slice(0, maxLawsuits)` guard would silently drop anyway.
   */
  chargeLawsuitFilingFee(roomId: string, playerId: string, players: EngineDataInput[]): LawsuitFilingFeeOutcome {
    const me = players.find(p => p.id === playerId);
    if (!me?.company) return { success: false, reason: 'player_not_found' };

    const alreadyQueued = this.submissions.get(roomId)?.get(playerId)?.lawsuits.length ?? 0;
    if (alreadyQueued >= this.config.gameSettings.maxLawsuitsPerPlayerPerTurn) {
      return { success: false, reason: 'limit_reached' };
    }

    let vars = this.readVariables(me.company.variables);
    // Same "first turn hasn't resolved yet, Company.variables is still {}" fallback
    // resolveTurn/getInitialSnapshot already apply — filing (and guessing) a lawsuit is
    // now a realistic round-1 action (see getGroundsAgainst's whole-library ground
    // catalog), not just something that happens after a turn has populated real values.
    // Without this, vars.cash is undefined here, `undefined - cost` is NaN, and the
    // resulting Prisma company.update crashes with an invalid-argument error.
    if (!vars.cash && !vars.assets) vars = this.startingVars();
    const cost = this.wealthScaledFee(this.config.gameSettings.lawsuitFilingCost, vars.cash);
    if (vars.cash < cost) return { success: false, reason: 'insufficient_funds' };

    const newCash = vars.cash - cost;
    return {
      success: true,
      cost,
      newCash,
      variables: this.stripInternal({ ...vars, cash: newCash }),
    };
  }

  /**
   * Make (or counter) a settlement offer on a case still `'negotiating'` — like
   * `digDeeper`/`chargeLawsuitFilingFee`, an instant, out-of-band action independent of
   * the turn timer, not part of `resolveTurn`. Unlike those, this touches TWO players'
   * persisted state at once (a case lives in both the plaintiff's and defendant's own
   * `engineState.legalCases`, see the Step 7 dedup comment above) — the caller
   * (`GameEngine.makeOffer`) must persist both `plaintiff` and `defendant` updates.
   *
   * The defendant always moves first (`offers.length === 0`); after that, only the
   * role that did *not* make the most recent offer may respond. `amount` must fall
   * within `computeOfferBracket(case_)` — the bracket that's narrowed inward by every
   * offer so far, converging the two sides toward each other rather than letting either
   * one drift away from what's already been offered/asked.
   */
  makeOffer(playerId: string, caseId: string, amount: number, players: EngineDataInput[]): LegalCaseActionOutcome {
    const found = this.findCaseAndParties(caseId, players);
    if (!found) return { success: false, reason: 'case_not_found' };
    const { case: case_, plaintiff, defendant } = found;

    if (case_.status !== 'negotiating') return { success: false, reason: 'not_negotiating' };
    const role = this.roleInCase(playerId, case_);
    if (!role) return { success: false, reason: 'not_a_party' };
    if (role !== this.roleOnMove(case_)) return { success: false, reason: 'not_your_turn' };
    const { min, max } = this.computeOfferBracket(case_);
    if (!Number.isFinite(amount) || amount < min || amount > max) {
      return { success: false, reason: 'invalid_amount' };
    }

    const updatedCase: LegalCaseData = { ...case_, offers: [...case_.offers, { by: role, amount }] };

    return {
      success: true,
      case: updatedCase,
      plaintiff: { playerId: plaintiff.playerId, engineState: this.serializeEngineStateForCase(plaintiff.engineState, updatedCase) },
      defendant: { playerId: defendant.playerId, engineState: this.serializeEngineStateForCase(defendant.engineState, updatedCase) },
    };
  }

  /**
   * Accept the other party's most recent offer on a case still `'negotiating'` —
   * settles immediately for that amount (defendant pays plaintiff), same shape as Step
   * 8b's stale-offer auto-settle inside `resolveTurn`, just triggered explicitly instead
   * of by a turn boundary. Only the party who did *not* make that offer may accept it
   * (can't accept your own offer).
   */
  acceptOffer(playerId: string, caseId: string, players: EngineDataInput[]): LegalCaseActionOutcome {
    const found = this.findCaseAndParties(caseId, players);
    if (!found) return { success: false, reason: 'case_not_found' };
    const { case: case_, plaintiff, defendant } = found;

    if (case_.status !== 'negotiating') return { success: false, reason: 'not_negotiating' };
    if (case_.offers.length === 0) return { success: false, reason: 'no_offer_to_accept' };
    const role = this.roleInCase(playerId, case_);
    if (!role) return { success: false, reason: 'not_a_party' };
    const lastOffer = case_.offers[case_.offers.length - 1];
    if (lastOffer.by === role) return { success: false, reason: 'not_your_turn' };

    const updatedCase: LegalCaseData = { ...case_, status: 'resolved', verdict: 'settled', resolvedAt: new Date() };
    const newPlaintiffCash = plaintiff.vars.cash + lastOffer.amount;
    const newDefendantCash = defendant.vars.cash - lastOffer.amount;
    this.voidSuedDecisionInstance(defendant.engineState, updatedCase);

    return {
      success: true,
      case: updatedCase,
      plaintiff: {
        playerId: plaintiff.playerId,
        cash: newPlaintiffCash,
        variables: this.stripInternal({ ...plaintiff.vars, cash: newPlaintiffCash }),
        engineState: this.serializeEngineStateForCase(plaintiff.engineState, updatedCase),
      },
      defendant: {
        playerId: defendant.playerId,
        cash: newDefendantCash,
        variables: this.stripInternal({ ...defendant.vars, cash: newDefendantCash }),
        engineState: this.serializeEngineStateForCase(defendant.engineState, updatedCase),
      },
    };
  }

  /**
   * End negotiation on a case still `'negotiating'` and send it to trial — either party
   * may call this at any time, regardless of whose turn it is to respond (unlike
   * `makeOffer`/`acceptOffer`); walking away from the table is a unilateral decision in
   * a way that offering/accepting aren't. Only marks the case `'awaiting_trial'` — no
   * verdict is drawn here. The next time this room's `resolveTurn` actually runs, the
   * existing trial-resolution loop picks up any `'awaiting_trial'` case the same way it
   * already does for one that got there via Step 8b's timeout, so there's exactly one
   * verdict-drawing code path for both origins.
   */
  goToCourt(playerId: string, caseId: string, players: EngineDataInput[]): LegalCaseActionOutcome {
    const found = this.findCaseAndParties(caseId, players);
    if (!found) return { success: false, reason: 'case_not_found' };
    const { case: case_, plaintiff, defendant } = found;

    if (case_.status !== 'negotiating') return { success: false, reason: 'not_negotiating' };
    const role = this.roleInCase(playerId, case_);
    if (!role) return { success: false, reason: 'not_a_party' };

    const updatedCase: LegalCaseData = { ...case_, status: 'awaiting_trial' };

    return {
      success: true,
      case: updatedCase,
      plaintiff: { playerId: plaintiff.playerId, engineState: this.serializeEngineStateForCase(plaintiff.engineState, updatedCase) },
      defendant: { playerId: defendant.playerId, engineState: this.serializeEngineStateForCase(defendant.engineState, updatedCase) },
    };
  }

  /**
   * Pay `gameSettings.digDeeperCost` to reveal the probability of success on a case
   * you're the DEFENDANT on. A case's `baseProbability`/`adjustedProbability` used to be
   * free intel for the defendant the instant it was filed — this makes it cost the same
   * "dig deeper" fee an incoming-attack investigation does, and gates it behind an
   * explicit action instead of showing it automatically. Unlike the 3-tier incoming-
   * attack investigation ladder (`digDeeper`), this is a single one-shot reveal scoped to
   * one case — there's only one thing to learn (the odds), not a progression of tiers.
   *
   * Same two-party persist shape as `makeOffer`/`acceptOffer`/`goToCourt` (the case is
   * spliced into both parties' `engineState.legalCases`), even though only the
   * defendant's cash moves — the plaintiff's own copy of the case still needs the
   * updated `defendantInvestigated` flag written back so the two copies never diverge.
   */
  digDeeperOnCase(playerId: string, caseId: string, players: EngineDataInput[]): LegalCaseActionOutcome {
    const found = this.findCaseAndParties(caseId, players);
    if (!found) return { success: false, reason: 'case_not_found' };
    const { case: case_, plaintiff, defendant } = found;

    if (playerId !== defendant.playerId) return { success: false, reason: 'not_defendant' };
    if (case_.defendantInvestigated) return { success: false, reason: 'already_investigated' };

    const cost = this.wealthScaledFee(this.config.gameSettings.digDeeperCost, defendant.vars.cash);
    if (defendant.vars.cash < cost) return { success: false, reason: 'insufficient_funds' };

    const newCash = defendant.vars.cash - cost;
    const updatedCase: LegalCaseData = { ...case_, defendantInvestigated: true };

    return {
      success: true,
      case: updatedCase,
      plaintiff: {
        playerId: plaintiff.playerId,
        engineState: this.serializeEngineStateForCase(plaintiff.engineState, updatedCase),
      },
      defendant: {
        playerId: defendant.playerId,
        cash: newCash,
        variables: this.stripInternal({ ...defendant.vars, cash: newCash }),
        engineState: this.serializeEngineStateForCase(defendant.engineState, updatedCase),
      },
    };
  }

  /**
   * Predict this player's own KPI trajectory `turnsAhead` turns into the future — by
   * literally reusing `resolveTurn` itself, sandboxed behind a synthetic room id that
   * can never collide with (or read/clear) any real room's `this.submissions` entry.
   * A key never passed to `submitDecisions` always reads back as "nobody submitted
   * anything" (line ~296's `this.submissions.get(roomId)?.get(p.id) ?? null`), so every
   * player in the sandbox — including the target themselves — deploys nothing new and
   * files no new lawsuits (Step 1/Step 8 both no-op on a null `submittedDecisions`);
   * only already-active decisions keep maturing/scheduling normally (`advanceAndApply`
   * increments `elapsedYears` unconditionally, independent of any submission). This is
   * deliberately the *real* math, not an approximation — competitiveness, market share,
   * P&L, balance sheet, depreciation, and risk gauge all run exactly as they would for a
   * real turn.
   *
   * Every rival is held completely frozen: the SAME original snapshot (loaded once,
   * before the loop) is fed back in on every iteration, never advanced with the target
   * player's own evolving state. This is the "doesn't take other players' decisions/
   * causes into account" product decision — market share/competitiveness still get
   * recomputed each iteration (they're relative, so the target's own growth can still
   * shift the split), but a rival's own decisions never mature, and rivals never deploy,
   * sue, or get sued by anyone further during the simulated window.
   *
   * One real consequence of reusing the real engine wholesale: if the target has any
   * existing case still `negotiating`, the real negotiation-timeout/trial-resolution
   * logic (Step 8b onward) runs inside the sandbox too — including its random verdict
   * draw, if `turnsNegotiating` crosses `negotiationPeriodTurns` within the predicted
   * window. That's accepted, not suppressed: it's a real mechanic driven by the
   * player's own existing situation (an already-filed case), not a new decision by
   * anyone else, and fidelity to the real engine was the whole point of this approach
   * over a client-side approximation. It does mean two predictions requested back to
   * back can differ if a case happens to resolve inside the window — that's expected,
   * not a bug.
   *
   * `round` must be the room's real, current round — `applyDepreciation` computes
   * `currentYear - entry.purchaseYear` (calcEngine.ts), so a fabricated small counter
   * (e.g. 1, 2, 3) instead of the real incrementing round number would desync every
   * existing depreciation ledger entry's remaining-years countdown.
   *
   * Stops early (fewer than `turnsAhead` points, `bankruptAtRound` set) if the target
   * would go bankrupt partway through the simulation — nothing meaningful to project
   * past that turn. Unlike the general KPI-history persistence path, this DOES reuse
   * `BankruptedPlayer.finalVariables`/`finalDerived`/`finalRiskGauge`: the whole point of
   * showing a player their own predicted future is to warn them cash is about to go
   * negative (e.g. so they can sell shares before it happens), so `predicted`'s last
   * point for a would-go-bankrupt player is the actual bankrupt-round snapshot — real
   * (negative) cash included — not silently omitted just because the round it happened
   * on ends the simulation. A real, reported gap: the graph used to stop one turn short
   * of the drop, so a player never actually saw the line cross zero.
   *
   * The player's OWN currently-queued decisions/lawsuits for THIS (not-yet-resolved) real
   * round — `this.submissions.get(roomId)?.get(playerId)`, the same live, in-progress
   * selection `game:submitDecisions` keeps up to date as they build it — are seeded into
   * the sandbox for the very first predicted turn only (`this.submitDecisions(sandboxRoomId,
   * playerId, ...)` before the loop starts). A real, reported gap: the prediction used to
   * assume the player submits nothing, even while they had a real selection queued up in
   * the UI right next to the graph — the whole point of "preview my future" is to preview
   * what happens if they actually go through with what they've already picked. This is
   * seeded exactly once: `resolveTurn`'s own `clearSubmissions(sandboxRoomId)` call at the
   * end of the first iteration naturally prevents it from being re-applied in iterations 2
   * and 3 — the newly-deployed instance just keeps maturing normally from there, same as
   * any other already-active decision. Deliberately READS (never clears/consumes) the
   * real room's own submissions — this must never disturb what the player has queued for
   * the real turn, only mirror it into the sandbox. And deliberately the player's OWN
   * queued selection only — a rival's `this.submissions.get(roomId)?.get(rivalId)` is
   * never read or seeded into the sandbox, keeping "predicts your own decisions, not
   * others'" intact (see the rival-freezing note above).
   */
  predictFutureKpis(roomId: string, playerId: string, round: number, players: EngineDataInput[], turnsAhead: number): KpiPrediction {
    const me = players.find(p => p.id === playerId);
    if (!me?.company) return { predicted: [] };

    const rivals = players.filter(p => p.id !== playerId);
    const sandboxRoomId = `__predict__${playerId}`;
    const predicted: KpiSnapshotPoint[] = [];

    const myQueuedDecisions = this.submissions.get(roomId)?.get(playerId);
    if (myQueuedDecisions) {
      this.submitDecisions(sandboxRoomId, playerId, myQueuedDecisions);
    }

    let meInput: EngineDataInput = me;
    for (let i = 1; i <= turnsAhead; i++) {
      const virtualRound = round + i;
      const outcome = this.resolveTurn(sandboxRoomId, virtualRound, [meInput, ...rivals]);

      const bankrupted = outcome.bankruptedPlayers.find(b => b.playerId === playerId);
      if (bankrupted) {
        predicted.push({
          round: virtualRound,
          variables: bankrupted.finalVariables,
          derived: bankrupted.finalDerived,
          riskGauge: bankrupted.finalRiskGauge,
        });
        return { predicted, bankruptAtRound: virtualRound };
      }

      const result = outcome.result.players.find(p => p.playerId === playerId);
      const update = outcome.companyUpdates.find(u => u.playerId === playerId);
      if (!result || !update) return { predicted, bankruptAtRound: virtualRound };

      predicted.push({
        round: virtualRound,
        variables: result.variables,
        derived: result.derived,
        riskGauge: result.riskGauge,
      });

      meInput = { id: playerId, name: me.name, company: { variables: update.variables, engineState: update.engineState } };
    }

    return { predicted };
  }

  /**
   * Read-only summary of one player's active decisions, for narrating their "annual
   * report" to a rival (`GameEngine.getAnnualReport`) — like `digDeeper`, a single-
   * player, out-of-band lookup that bypasses the turn cycle entirely and never
   * mutates anything. Returns `null` if the player isn't found (unknown id, or
   * bankrupted and no longer in the active-players list the caller loaded).
   */
  getActiveDecisionSummaries(playerId: string, players: EngineDataInput[]): ActiveDecisionSummary[] | null {
    const target = players.find((p) => p.id === playerId);
    if (!target?.company) return null;

    const engineState = this.readEngineState(target.company);
    return engineState.activeDecisions
      .filter((d) => !!d.definition)
      .map((d) => ({
        instanceId: d.id,
        decisionName: d.definition.decision,
        description: d.definition.description,
        deployedYear: d.deployedYear,
        elapsedYears: d.elapsedYears,
      }));
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Read engine state from Company JSONB (active decisions + depreciation ledger) */
  private readEngineState(company: { engineState: unknown } | null | undefined): CompanyEngineState {
    const raw = (company?.engineState ?? {}) as {
      activeDecisions?: PersistedDecisionInstance[];
      depreciationLedger?: DepreciationEntry[];
      legalCases?: LegalCaseData[];
      investigations?: Record<string, number>;
    };
    return {
      activeDecisions: (raw.activeDecisions ?? []).map((d) => ({
        id: d.id,
        // Non-null: an in-use decision's definition can never vanish from the loaded
        // library (see CLAUDE.md's "Deleting a decision is guarded" — GameEngine.deleteDecision
        // rejects removing a decision still deployed anywhere before it ever reaches the DB).
        definition: this.decisionEngine.getDef(d.definitionName)!,
        deployedYear: d.deployedYear,
        elapsedYears: d.elapsedYears,
        isMatured: d.isMatured,
        targetId: d.targetId,
        voidedByLawsuit: d.voidedByLawsuit ?? false,
        everSued: d.everSued ?? false,
        acquisitionFraction: d.acquisitionFraction,
      })),
      depreciationLedger: raw.depreciationLedger ?? [],
      // `createdAt`/`resolvedAt` are typed `Date` but survive a Postgres JSONB round-trip
      // as ISO **strings** — and nothing in the type system notices, because the JSONB
      // read is cast straight to `LegalCaseData`. A real, production-breaking bug
      // (2026-08-12): `distributeCaseWaterfall`'s FIFO sort called `.getTime()` on one of
      // these and threw `TypeError: b.createdAt.getTime is not a function`, which aborted
      // the whole turn mid-elimination — see `caseFiledAtMs` and `resolveGameTurn`'s
      // `finally` for the two other halves of that fix. Normalising here, at the single
      // chokepoint every persisted case passes through on the way back into the engine,
      // is what keeps the rest of the engine free to treat these as real `Date`s.
      // Deliberately tolerant of an already-`Date` value: `GameLoop` is also fed
      // straight from in-memory state in tests and from `getInitialSnapshot`, where these
      // never round-trip at all.
      legalCases: (raw.legalCases ?? []).map((c) => ({
        ...c,
        createdAt: toDate(c.createdAt) ?? new Date(0),
        resolvedAt: toDate(c.resolvedAt),
      })),
      investigations: raw.investigations ?? {},
    };
  }

  /**
   * Locate a case by id and load both parties' full state — shared lookup for
   * `makeOffer`/`acceptOffer`/`goToCourt`. Since the same case is persisted into both
   * the plaintiff's and defendant's own `engineState.legalCases` (Step 7's dedup
   * comment), it's found by scanning whichever loaded player happens to have it; `null`
   * if the case doesn't exist in any loaded player's state, or if — which shouldn't
   * happen while a case is still `'negotiating'`, since either party going bankrupt
   * resolves it via the Step 10b waterfall first — one of the two parties named on the
   * case isn't in `players` at all (e.g. already eliminated).
   */
  private findCaseAndParties(
    caseId: string,
    players: EngineDataInput[],
  ): {
    case: LegalCaseData;
    plaintiff: { playerId: string; vars: PlayerVariables; engineState: CompanyEngineState };
    defendant: { playerId: string; vars: PlayerVariables; engineState: CompanyEngineState };
  } | null {
    const byId = new Map<string, { vars: PlayerVariables; engineState: CompanyEngineState }>();
    for (const p of players) {
      if (!p.company) continue;
      byId.set(p.id, {
        vars: this.readVariables(p.company.variables),
        engineState: this.readEngineState(p.company),
      });
    }

    let found: LegalCaseData | undefined;
    for (const state of byId.values()) {
      found = state.engineState.legalCases.find(c => c.id === caseId);
      if (found) break;
    }
    if (!found) return null;

    const plaintiffState = byId.get(found.plaintiffId);
    const defendantState = byId.get(found.defendantId);
    if (!plaintiffState || !defendantState) return null;

    return {
      case: found,
      plaintiff: { playerId: found.plaintiffId, ...plaintiffState },
      defendant: { playerId: found.defendantId, ...defendantState },
    };
  }

  /** Which role (if any) `playerId` has on this case. */
  private roleInCase(playerId: string, case_: LegalCaseData): 'plaintiff' | 'defendant' | null {
    if (playerId === case_.plaintiffId) return 'plaintiff';
    if (playerId === case_.defendantId) return 'defendant';
    return null;
  }

  /** Whichever role did *not* make the case's most recent offer is the one currently
   * allowed to respond (counter or accept — `goToCourt` deliberately doesn't gate on
   * this, see its own doc comment). The defendant always moves first, while `offers` is
   * still empty. */
  private roleOnMove(case_: LegalCaseData): 'plaintiff' | 'defendant' {
    if (case_.offers.length === 0) return 'defendant';
    const lastOffer = case_.offers[case_.offers.length - 1];
    return lastOffer.by === 'plaintiff' ? 'defendant' : 'plaintiff';
  }

  /**
   * The valid `[min, max]` range for the *next* offer on this case, regardless of which
   * role is about to make it — negotiation only ever moves inward from the two starting
   * anchors (0, the full stakes) toward wherever the two sides' most recent offers
   * currently sit:
   * - `min` is the defendant's own most recent offer (what they've committed to paying
   *   so far) — 0 if they haven't offered yet.
   * - `max` is the plaintiff's own most recent offer (what they've committed to
   *   accepting so far) — the full `stakes` if they haven't offered yet.
   *
   * Each side's new offer can only ever tighten its own end of the bracket (a defendant
   * offer raises `min`, a plaintiff offer lowers `max`), so the range never widens and
   * `min <= max` always holds as long as every accepted offer was itself validated
   * against this same bracket — see the callers below.
   */
  private computeOfferBracket(case_: LegalCaseData): { min: number; max: number } {
    let min = 0;
    let max = case_.stakes;
    for (const offer of case_.offers) {
      if (offer.by === 'defendant') min = offer.amount;
      else max = offer.amount;
    }
    return { min, max };
  }

  /** Rebuilds one party's full persistable `engineState` (same serialized shape
   * `CompanyPersistUpdate`/`DigDeeperOutcome.engineStateUpdate` use) with `updatedCase`
   * spliced into their own `legalCases` by id — everything else (active decisions,
   * depreciation ledger, investigations) carried through unchanged. */
  private serializeEngineStateForCase(engineState: CompanyEngineState, updatedCase: LegalCaseData): CompanyPersistUpdate['engineState'] {
    return {
      activeDecisions: engineState.activeDecisions.map(d => ({
        id: d.id,
        definitionName: d.definition.decision,
        deployedYear: d.deployedYear,
        elapsedYears: d.elapsedYears,
        isMatured: d.isMatured,
        targetId: d.targetId,
        voidedByLawsuit: d.voidedByLawsuit,
        everSued: d.everSued,
        acquisitionFraction: d.acquisitionFraction,
      })),
      depreciationLedger: engineState.depreciationLedger,
      legalCases: engineState.legalCases.map(c => (c.id === updatedCase.id ? updatedCase : c)),
      investigations: engineState.investigations,
    };
  }

  /**
   * A lawsuit "win" (trial verdict 'won' for the plaintiff, or any settlement where the
   * defendant paid out — see CLAUDE.md) cancels the sued decision instance's forthcoming
   * effects: forces it `isMatured: true` immediately (so it frees up for redeployment via
   * `canDeploy`'s existing "previous instance matured" check) and flags `voidedByLawsuit`
   * (so `advanceAndApply`/`collectTargetImpacts` stop applying its schedule ever again, and
   * so it doesn't count as a "successful" completion for `hasPermanentEffect`'s redeploy
   * lock). No-ops if the case never resolved to a genuine instance (a wrong guess or a
   * time-barred ground — `defendantDecisionInstanceId` is undefined) or if that instance
   * was already voided by an earlier case. Deliberately does NOT touch a decision's
   * already-applied history — whatever it did in earlier turns stays.
   */
  private voidSuedDecisionInstance(defendantEngineState: CompanyEngineState, case_: LegalCaseData): void {
    if (!case_.defendantDecisionInstanceId) return;
    const inst = defendantEngineState.activeDecisions.find(d => d.id === case_.defendantDecisionInstanceId);
    if (!inst || inst.voidedByLawsuit) return;
    inst.isMatured = true;
    inst.voidedByLawsuit = true;
  }

  /**
   * Executes one Buy or Sell Shares transaction (Step 1b) — a
   * pairwise mutation between the acting player and the target company, same "touches
   * two players atomically" shape as a lawsuit filing, not a generic schedule-driven
   * impact. No-ops safely if either party is missing from `ctxs` (e.g. a stale target)
   * or the target has no shares outstanding at all.
   *
   * **Buy**: `sharesBought = min(amount, buyer's cash) / target's stockValue` (last
   * turn's closing price — see the Step 1b comment above) — if that price is exactly 0,
   * treat the purchase as acquiring the ENTIRE company regardless of amount paid
   * (a sufficiently distressed company can be bought/taken over for free, by design). A
   * genuinely undefined `stockValue` (round 1 — see `startingStockValue`'s doc comment)
   * is NOT treated as that same "distressed, free takeover" 0 — a real, reported bug: any
   * nonzero Buy Shares spend on round 1 bought 100% of the target company outright, since
   * `stockValue` had never been computed yet and `?? 0` silently collapsed "not computed"
   * into the same case as "computed and genuinely worthless." Falls back to a real starting
   * book-value-per-share instead, so round 1 prices shares normally.
   * `fractionBought` (capped at 1) is stamped onto the buyer's own deployed instance as
   * `acquisitionFraction` (gates `legalRiskConditions`, see `meetsLegalRiskConditions`).
   * Every existing shareOwnership key on the target scales down by `(1 - fractionBought)`
   * — pro-rata dilution "from all current owners, including EXTERNAL_MARKET" per
   * while the buyer's own key (their real playerId, or `SELF_OWNERSHIP_KEY`
   * if the buyer *is* the target's own founder — self-buyback falls out of
   * this exact same formula with no special case needed) gets the full `fractionBought`
   * credited on top. The buyer's cash decreases by the full `amount`; every OTHER diluted
   * key that maps to a real player (never `EXTERNAL_MARKET`, which absorbs its own
   * diluted portion with no counterparty; never the buyer's own key, which would just be
   * paying themselves) receives their pro-rata share of that `amount` in cash — a
   * confirmed product decision, not a strictly spec-mandated detail.
   *
   * **Sell**: shares always return to `EXTERNAL_MARKET` specifically, never pro-rata to
   * other players ("shares can only be sold to the external market, never directly to
   * another player"). Capped at whatever the seller actually holds.
   */
  /**
   * Returns the `fractionBought` for a genuine, other-player purchase (never a
   * self-buyback — the buyer already knows about their own trade, so `fractionBought`
   * is only returned when `request.buyerId !== request.targetId`), or `undefined` for
   * every other case (a Sell, a no-op, or a self-buyback) — the caller (Step 1b) uses
   * this to build `PlayerTurnResult.sharesBoughtThisTurn`, the target's own "somebody
   * bought your shares" news item.
   */
  private applyShareTransaction(request: ShareTransactionRequest, ctxs: Map<string, PlayerTurnContext>, round: number): number | undefined {
    const buyerCtx = ctxs.get(request.buyerId);
    const targetCtx = ctxs.get(request.targetId);
    if (!buyerCtx || !targetCtx) return undefined;

    const totalShares = targetCtx.vars.totalSharesOutstanding || 0;
    if (totalShares <= 0) return undefined;
    const price = targetCtx.vars.stockValue !== undefined ? targetCtx.vars.stockValue : this.startingStockValue(targetCtx.vars);
    const actorKey = request.buyerId === request.targetId ? SELF_OWNERSHIP_KEY : request.buyerId;
    const ownership: Record<string, number> = { ...(targetCtx.vars.shareOwnership ?? {}) };

    if (request.type === 'buy') {
      const spend = Math.min(request.amount, buyerCtx.vars.cash);
      if (spend <= 0) return undefined;
      // Late-game escalation (see CLAUDE.md/GameSettings doc comments): once round >=
      // lateGameRoundThreshold, a buyer's effective buying power (for computing shares
      // acquired only — the cash actually paid below is unaffected) is boosted, giving a
      // real second path to force a stalled lawsuit standoff to a close via hostile
      // takeover instead. Never applied before the threshold, so ordinary/median-length
      // games see no change to buyout economics at all.
      // `?? 1` (neutral, no change) guards a config loaded before this field existed in
      // the DB — see wealthScaledFee's doc comment.
      const effectiveSpend = round >= this.config.gameSettings.lateGameRoundThreshold
        ? spend * (this.config.gameSettings.lateGameTakeoverBoost ?? 1)
        : spend;
      const sharesBought = price > 0 ? effectiveSpend / price : totalShares;
      const fractionBought = Math.min(1, sharesBought / totalShares);
      if (fractionBought <= 0) return undefined;

      const instance = buyerCtx.engineState.activeDecisions.find(d => d.id === request.instanceId);
      if (instance) instance.acquisitionFraction = fractionBought;

      for (const [key, fraction] of Object.entries(ownership)) {
        if (key === actorKey) continue; // netted into the buyer's own credit below — never pays itself
        ownership[key] = fraction * (1 - fractionBought);
        if (key === EXTERNAL_MARKET_KEY) continue; // absorbs its own dilution, no counterparty
        const ownerCtx = key === SELF_OWNERSHIP_KEY ? targetCtx : ctxs.get(key);
        if (ownerCtx) ownerCtx.vars.cash += fraction * spend;
      }
      ownership[actorKey] = (ownership[actorKey] ?? 0) * (1 - fractionBought) + fractionBought;

      buyerCtx.vars.cash -= spend;
      targetCtx.vars.shareOwnership = renormalizeShareOwnership(ownership);
      return request.buyerId !== request.targetId ? fractionBought : undefined;
    } else {
      const currentFraction = ownership[actorKey] ?? 0;
      if (currentFraction <= 0) return undefined;
      const holdingValue = currentFraction * totalShares * price;
      const proceeds = Math.min(request.amount, holdingValue);
      if (proceeds <= 0) return undefined;
      const fractionSold = price > 0 ? Math.min(currentFraction, proceeds / price / totalShares) : currentFraction;

      ownership[actorKey] = currentFraction - fractionSold;
      ownership[EXTERNAL_MARKET_KEY] = (ownership[EXTERNAL_MARKET_KEY] ?? 0) + fractionSold;
      targetCtx.vars.shareOwnership = renormalizeShareOwnership(ownership);
      buyerCtx.vars.cash += proceeds;
      return undefined;
    }
  }

  /**
   * The end-of-turn elimination payout — shared by BOTH bankruptcy and
   * merger elimination ("the same rule applies to both"), so this is the one place the
   * waterfall math lives rather than duplicated per elimination reason. When a player
   * falls (for either reason), ALL their still-unresolved cases lapse — both as
   * defendant and as plaintiff. Cases against them are paid from:
   *   jaettava_summa = cash_i (previous turn)
   *                   + this turn's POSITIVE income-side cash-flow lines
   *                     (revenue, other income, depreciation add-back,
   *                      positive decision cash impacts, legal cash received)
   *   — expense-side lines (opex, staff, COGS, finance cost, tax, capex
   *     spend) never reduce this pool.
   * Paid to plaintiffs in filing order (oldest `createdAt` first), each in full until
   * the pool runs out; the rest get nothing. Returns the player's actual final cash
   * (untouched by the pool math above, which is a separate, more optimistic figure used
   * only to size the payout) — the caller persists this as `BankruptedPlayer.finalCash`
   * and, for a merger, credits it to the acquirer.
   *
   * A paid-out case's verdict is `'waterfall_payout'`, NOT `'settled'` — a real, reported
   * bug: a case a player had explicitly sent to `goToCourt` (forcing a probability
   * verdict, deliberately bypassing negotiation) showed up as "Settled" once the
   * defendant went bankrupt before the trial could draw, with no offer ever made or
   * accepted at all. See `LegalCaseData.verdict`'s own doc comment for the full
   * distinction between this, a real negotiated `'settled'`, and an unpaid `'cancelled'`.
   */
  private distributeCaseWaterfall(
    pid: string,
    ctxs: Map<string, PlayerTurnContext>,
    allCases: LegalCaseData[],
    plMap: Map<string, ReturnType<typeof calculatePL>>,
    depreciationMap: Map<string, number>,
    absDeltasMap: Map<string, { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }>,
    legalReceivedThisTurn: Map<string, number>,
  ): number {
    const ctx = ctxs.get(pid)!;
    const pl = plMap.get(pid)!;
    const dep = depreciationMap.get(pid) ?? 0;
    const deltas = absDeltasMap.get(pid) ?? { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
    const legalReceived = legalReceivedThisTurn.get(pid) ?? 0;

    const pool = Math.max(0,
      ctx.prevCash
      + Math.max(0, pl.revenue)
      + Math.max(0, ctx.vars.otherIncome || 0)
      + dep
      + Math.max(0, deltas.cashDelta)
      + legalReceived,
    );

    // Find all unresolved cases where this player was the defendant, sorted
    // oldest-first by filing order
    const casesAgainstDefunct = allCases
      .filter(c => c.defendantId === pid && c.status !== 'resolved')
      .sort((a, b) => caseFiledAtMs(a) - caseFiledAtMs(b));

    // Distribute pool to plaintiffs in filing order
    let remaining = pool;
    for (const case_ of casesAgainstDefunct) {
      if (remaining <= 0) break;
      const payment = Math.min(case_.stakes, remaining);
      const pltCtx = ctxs.get(case_.plaintiffId);
      if (pltCtx) {
        pltCtx.vars.cash += payment;
      }
      case_.status = 'resolved';
      case_.verdict = 'waterfall_payout';
      case_.waterfallPayoutAmount = payment;
      case_.resolvedAt = new Date();
      remaining -= payment;
    }

    // All remaining unresolved cases touching the fallen player lapse without
    // payment — as defendant (pool exhausted) AND as plaintiff.
    for (const case_ of allCases) {
      if (case_.status === 'resolved') continue;
      if (case_.defendantId === pid || case_.plaintiffId === pid) {
        case_.status = 'resolved';
        case_.verdict = 'cancelled';
        case_.resolvedAt = new Date();
      }
    }

    return ctx.vars.cash;
  }

  /**
   * Scan every OTHER still-active player's activeDecisions for ones targeting `pid`,
   * revealing fields progressively per `pid`'s own persisted investigation level for
   * that attack (never the attacker's — this player only ever unlocks intel about
   * attacks against them, via `digDeeper`). A now-bankrupt attacker's decisions are
   * excluded — `attackerCtxIds` is the still-active player set for this turn.
   */
  /**
   * True for a decision with no `target.*` impacts at all (no single player it's routed
   * to) AND no explicit `targetId` either, that still carries `legalRisks` — New Factory's
   * nuisance suit, Water Pumping's environmental suit, Night Dumping, etc. These broadcast
   * an incoming-attack-style hint to EVERY other active player (see buildIncomingAttacks),
   * not just one target, since there's no target to route it to. A decision with neither
   * `target.*` impacts nor any `legalRisks` (e.g. Sell Shares) is neither direct nor
   * indirect — nothing to reveal or sue over, so it never generates a hint at all.
   *
   * `targetId` matters because Buy Shares has NO `target.*` impacts at
   * all (its real effect is computed dynamically in Step 1b, not via the generic impacts
   * schedule) but DOES have a real, explicit target — without checking `targetId` too, it
   * would misclassify as indirect (broadcast to everyone) despite being aimed at one
   * specific player, letting anyone dig into or sue over a purchase they weren't the
   * target of. Sell Shares is unaffected either way (its `legalRisks` is empty).
   */
  private isIndirectEffect(def: DecisionDefinition, targetImpacts: Map<string, unknown>, targetId?: string): boolean {
    return targetImpacts.size === 0 && targetId === undefined && !!def.legalRisks && def.legalRisks.length > 0;
  }

  /** The room's effective per-turn market pie — see `calcEngine.ts`'s
   * `calculateEffectiveTotalMarketVolume` for the full reasoning. `avgPrice` is computed
   * here (the mean `price` across every player in `varsList`, i.e. every ACTIVE player
   * this turn — both `resolveTurn` and `getInitialSnapshot` only ever build `varsList`
   * from active players to begin with) since it needs the whole room at once, unlike
   * every other per-player input `calculateVolume` reads. Shared by both call sites so
   * they can never drift on how this is computed. */
  private computeEffectiveTotalMarketVolume(varsList: PlayerVariables[]): number {
    const avgPrice = varsList.length > 0
      ? varsList.reduce((sum, v) => sum + (v.price || 0), 0) / varsList.length
      : 0;
    return calculateEffectiveTotalMarketVolume(
      this.config.gameSettings.marketVolumePerPlayerTonnesPerYear,
      varsList.length,
      avgPrice,
      this.config.gameSettings.marketFixed,
      this.adminVars,
      this.formulas,
    );
  }

  private buildIncomingAttacks(pid: string, ctxs: Map<string, PlayerTurnContext>, attackerCtxIds: string[], plMap: Map<string, ReturnType<typeof calculatePL>>): IncomingAttackInfo[] {
    const myInvestigations = ctxs.get(pid)!.engineState.investigations;
    const attacks: IncomingAttackInfo[] = [];
    for (const attackerId of attackerCtxIds) {
      if (attackerId === pid) continue;
      const attackerCtx = ctxs.get(attackerId)!;
      // `attackerCtx.vars` never carries `revenue` (like `equity`, it's only ever
      // materialized into `plMap` for this turn's broadcast — see the Step 8 stakes-
      // calculation note) — patched in here for `revealAttack`'s `pickAllGrounds` call,
      // which needs the real figure to price a relative-type ground targeting revenue
      // (17 of the 25 in the real library). Reading `undefined` there was a real,
      // reported bug: every such ground's displayed "Stakes" showed $0 on every incoming-
      // attack hint card, since `pickAllGrounds` falls back to 0 for a non-numeric target
      // field. Same fix Step 8's `targetVarsForFiling` already applies to the real filing.
      const attackerVarsForReveal = { ...attackerCtx.vars, revenue: plMap.get(attackerId)?.revenue ?? attackerCtx.vars.revenue };
      for (const d of attackerCtx.engineState.activeDecisions) {
        if (d.voidedByLawsuit) continue;
        // A real, reported gap: once an instance is past `statuteOfLimitationsYears`,
        // suing over it is already forced to 0% (LegalEngine.fileLawsuit/pickAllGrounds),
        // and a direct attack's own target.* effect has already stopped re-applying every
        // turn (see CLAUDE.md's "Root historical bug" note — collectTargetImpacts' own
        // statute cutoff) — the hint card (direct "did something to you" AND indirect
        // "indirectly affects you" alike) has nothing left to warn about or act on, so it
        // must stop appearing rather than lingering forever as a stale, un-actionable
        // notification.
        if (d.elapsedYears >= this.config.gameSettings.statuteOfLimitationsYears) continue;
        const targetImpacts = this.decisionEngine.getTargetImpacts(d.definition.impacts);
        const isIndirect = this.isIndirectEffect(d.definition, targetImpacts, d.targetId);
        // Direct: only the specific player it targets sees it. Indirect: every other
        // active player sees it (there's no single target) — see isIndirectEffect's doc
        // comment for why decisions with neither trait are skipped entirely. Buy Shares
        // is a third case: a real direct attack (targetId set) with no target.* impacts
        // at all (its effect is a dynamic share transaction, not a routed schedule field)
        // — excluded from the "must have target.* impacts" check below, unlike every
        // other direct decision. Sell Shares isn't an attack on anyone (and has no
        // legalRisks to reveal regardless), so it's deliberately NOT given the same
        // exemption here.
        if (!isIndirect && d.targetId !== pid) continue;
        if (!isIndirect && targetImpacts.size === 0 && d.definition.shareTransactionType !== 'buy') continue;
        const rawLevel = myInvestigations[d.id] ?? 0;
        const level = this.effectiveInvestigationLevel(rawLevel, attackerCtxIds.length);
        attacks.push(this.revealAttack(attackerId, attackerCtx.playerName, d, level, attackerVarsForReveal, isIndirect));
      }
    }
    return attacks;
  }

  /**
   * In a heads-up game (exactly 2 active players), investigation level 1's only content —
   * the attacker's identity — is never actually ambiguous: there's only one other active
   * player, so it's obvious who it was without spending a dig on it. Callers pass a raw,
   * persisted investigation level (0-2 in a heads-up game, since level 3 becomes reachable
   * one dig earlier) through here to get the level that should actually be revealed/checked
   * against `MAX_INVESTIGATION_LEVEL` — one tier ahead of raw in a heads-up game, unchanged
   * otherwise. `activePlayerCount` must count every still-active player, the target included
   * (i.e. 2 means "just me and one attacker"), matching `playersStillActive.length` /
   * `byId.size` / `ctxs.size` at each of this method's call sites.
   */
  private effectiveInvestigationLevel(rawLevel: number, activePlayerCount: number): number {
    return activePlayerCount === 2 ? Math.min(rawLevel + 1, MAX_INVESTIGATION_LEVEL) : rawLevel;
  }

  /**
   * Builds the progressively-revealed intel for one incoming attack at the given
   * investigation level. `isIndirect` (see isIndirectEffect's doc comment) only changes
   * which impacts tier 2's `effectSummary` describes — the decision's own effects for an
   * indirect one (there's no `target.*` effect to summarize), the routed cross-player
   * effect for a direct one — everything else about the reveal ladder is identical.
   */
  private revealAttack(attackerId: string, attackerName: string, decision: DeployedDecision, level: number, attackerVars: PlayerVariables, isIndirect: boolean): IncomingAttackInfo {
    const info: IncomingAttackInfo = { attackId: decision.id, investigationLevel: level, isIndirect };
    if (level >= 1) {
      info.attackerId = attackerId;
      info.attackerName = attackerName;
    }
    if (level >= 2) {
      info.decisionName = decision.definition.decision;
      info.decisionDescription = decision.definition.description;
      // Buy Shares has no target.* impacts to summarize generically (its effect is a
      // dynamic share transaction, not a routed schedule field) — describe the one
      // number that actually matters instead: how much of the target it acquired.
      info.effectSummary = decision.definition.shareTransactionType === 'buy'
        ? `Acquired ${Math.round((decision.acquisitionFraction ?? 0) * 100)}% ownership stake`
        : isIndirect
          ? summarizeOwnImpacts(decision.definition.impacts, decision.elapsedYears)
          : summarizeTargetImpacts(decision.definition.impacts, decision.elapsedYears);
    }
    if (level >= 3) {
      const grounds = pickAllGrounds(decision.definition, decision.elapsedYears, attackerVars, this.adminVars, this.formulas, this.config.gameSettings.statuteOfLimitationsYears, decision.everSued, meetsLegalRiskConditions(decision.definition, decision));
      if (grounds.length > 0) {
        info.suggestedGrounds = grounds;
      }
    }
    return info;
  }

  /** Returns any Buy/Sell Shares entries this call actually deployed (queued for Step 1b
   * — see `ShareTransactionRequest`'s doc comment for why this can't just re-scan raw
   * submissions: some entries get dropped by `canDeploy`/level-limit checks below, and
   * only the ones that actually deployed should ever execute a real trade). */
  private processNewDecisions(roomId: string, ctx: PlayerTurnContext, year: number): { shareTransactions: ShareTransactionRequest[]; decisionEvents: DecisionDeployEvent[] } {
    const sub = ctx.submittedDecisions!;
    const maxForLevel: Record<DecisionBucket, number> = {
      strategic: this.config.gameSettings.maxStrategicDecisionsPerTurn,
      operational: this.config.gameSettings.maxOperationalDecisionsPerTurn,
      financial: this.config.gameSettings.maxFinancialDecisionsPerTurn,
    };

    // Track absolute deltas from newly deployed decisions on the same turn
    const newDecisionAbsDeltas: Array<{ revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }> = [];
    const shareTransactions: ShareTransactionRequest[] = [];
    const decisionEvents: DecisionDeployEvent[] = [];

    for (const bucket of DECISION_BUCKETS) {
      const maxForBucket = maxForLevel[bucket];
      // This slice is the ONLY thing enforcing "at most maxForBucket decisions of this
      // level per turn" — canDeploy itself no longer takes a level/max-count and never
      // recomputes one from ctx.engineState.activeDecisions (a player's entire historical
      // active-decisions list, which only grows) — see CLAUDE.md's "canDeploy's
      // level-limit check counted a player's entire lifetime of active decisions" section.
      for (const entry of sub[bucket].slice(0, maxForBucket)) {
        const { name, targetId, amount } = entry;
        const def = this.decisionEngine.getDef(name);
        if (!def) {
          decisionEvents.push({ playerId: ctx.playerId, bucket, decisionName: name, targetId, outcome: 'rejected', reason: 'Unknown decision' });
          continue;
        }
        const ok = this.decisionEngine.canDeploy(
          ctx.engineState.activeDecisions,
          name,
          this.config.gameSettings.permanentEffectCooldownYears,
        );
        if (!ok.allowed) {
          decisionEvents.push({ playerId: ctx.playerId, bucket, decisionName: name, targetId, outcome: 'rejected', reason: ok.reason });
          continue;
        }
        decisionEvents.push({ playerId: ctx.playerId, bucket, decisionName: name, targetId, outcome: 'deployed' });
        const inst = this.decisionEngine.deploy(ctx.playerId, def, year, targetId);
        ctx.engineState.activeDecisions.push(inst);
        const result = this.decisionEngine.applyImpactsForYear(ctx.vars, def.impacts, 0, year, this.config.gameSettings.decisionCostWealthScaleRate ?? 0);
        ctx.vars = result.updatedVars;
        // Merge newly created depreciation entries into the ledger
        for (const entry of result.newDepreciationEntries) {
          ctx.engineState.depreciationLedger.push(entry);
        }
        // Capture absolute schedule deltas from the deployment
        newDecisionAbsDeltas.push(result.absDeltas);

        // Buy/Sell Shares carry no fixed impacts schedule at all —
        // their real effect is computed dynamically in Step 1b from the player-chosen
        // amount/target, not applied generically like every other decision above.
        if (def.shareTransactionType && targetId && amount !== undefined) {
          shareTransactions.push({
            buyerId: ctx.playerId,
            instanceId: inst.id,
            targetId,
            amount,
            submittedAt: this.entryTimestamp(roomId, ctx.playerId, bucket, entry),
            type: def.shareTransactionType,
          });
        }
      }
    }

    // Store merged deltas on context and apply to vars so they're available in absDeltasMap later.
    // Note: cashDelta is NOT re-applied here — applyImpactsForYear already added it directly to
    // ctx.vars.cash; it's only tracked so the §16 bankruptcy waterfall can read it later.
    if (newDecisionAbsDeltas.length > 0) {
      const merged = this.decisionEngine.aggregateAbsDeltas(newDecisionAbsDeltas);
      ctx.newDecisionAbsDeltas = merged;
      if (merged.revenueDelta !== 0) ctx.vars.revenue = (ctx.vars.revenue ?? 0) + merged.revenueDelta;
      if (merged.financeCostDelta !== 0) ctx.vars.financeCost = (ctx.vars.financeCost ?? 0) + merged.financeCostDelta;
      if (merged.taxCostDelta !== 0) ctx.vars.taxCost = (ctx.vars.taxCost ?? 0) + merged.taxCostDelta;
      if (merged.receivablesDelta !== 0) ctx.vars.receivables = (ctx.vars.receivables ?? 0) + merged.receivablesDelta;
    } else {
      ctx.newDecisionAbsDeltas = { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
    }

    return { shareTransactions, decisionEvents };
  }

  /**
   * A flat litigation fee (`digDeeperCost`/`lawsuitFilingCost`) plus `wealthScaledFeeRate`
   * of the payer's OWN current cash — a deliberate cash sink (see GameSettings doc
   * comment): the surcharge portion is never credited to anyone, it just leaves the game,
   * and scales the flat fee's real bite with how rich the payer already is, so litigation
   * stays a meaningful cost for a wealthy late-game player instead of the same flat fee a
   * round-1 player pays. Shared by `digDeeper`, `chargeLawsuitFilingFee`, and
   * `digDeeperOnCase` — the three flat-fee, out-of-band (non-turn-cycle) charges.
   *
   * `?? 0` guards a config loaded before `wealthScaledFeeRate` existed in the DB (an
   * already-running `GameEngine` holds `this.config` from its own last `loadGameData()`,
   * not a live view — a bare `db:seed` run against the DB while a server is already up
   * doesn't notify it) — the same "undefined arithmetic silently produces NaN, which then
   * gets written straight into a Decimal/JSONB column" failure mode as
   * `applyDecisionImpacts`' absolute-impact write bug (see CLAUDE.md); a real, reproduced
   * incident here, not a hypothetical.
   */
  private wealthScaledFee(baseCost: number, currentCash: number): number {
    return baseCost + (this.config.gameSettings.wealthScaledFeeRate ?? 0) * Math.max(0, currentCash);
  }

  private readVariables(json: unknown): PlayerVariables {
    if (!json || typeof json !== 'object') return {} as PlayerVariables;
    return json as unknown as PlayerVariables;
  }

  private startingVars(): PlayerVariables {
    const s = this.config.playerStartingValues;
    return {
      cash: s.cash,
      assets: s.assets,
      intangibleAssets: s.intangibleAssets,
      debt: s.debt,
      reserves: s.reserves,
      operatingExpenses: s.operatingExpenses,
      staffCost: s.staffCost,
      materialCostPerTon: s.materialCostPerTon,
      otherIncome: s.otherIncome,
      price: s.price,
      capacityUtilization: s.capacityUtilization,
      processingLevel: s.processingLevel,
      energyIntensity: s.energyIntensity,
      moistureContent: s.moistureContent,
      nutrientConsistency: s.nutrientConsistency,
      supplySecurity: s.supplySecurity,
      logisticsCostPerTon: s.logisticsCostPerTon,
      processLoss: s.processLoss,
      installedCapacity: s.installedCapacity,
      totalSharesOutstanding: s.totalSharesOutstanding,
      // A fresh object per player, never the shared `config.playerStartingValues`
      // reference — every player starting their first turn would otherwise silently
      // alias the SAME shareOwnership object, so mutating one player's cap table (once
      // Buy/Sell Shares actually writes to it) would corrupt every other still-unstarted
      // player's "starting" snapshot too.
      shareOwnership: { ...s.shareOwnership },
      outrage: s.outrage,
      scrutiny: s.scrutiny,
      breakdowns: s.breakdowns,
      contaminationRisk: s.contaminationRisk,
      odorComplaints: s.odorComplaints,
      tokenLiability: s.tokenLiability,
      carbonFootprint: s.carbonFootprint,
      stockVolume: s.stockVolume,
      demand: s.demand,
    } as PlayerVariables;
  }

  /**
   * Book value per share at the moment a company's `stockValue` has never actually been
   * computed yet (before that company's very first turn has resolved) — `stockValue` is a
   * `"derived"` field (`playerStartingValues`' own comment), only ever written by
   * `updateBalanceSheet` inside `resolveTurn`'s balance-sheet step, so it's genuinely
   * `undefined`, not a real computed 0, at that point. `equity - legalExposure` (no
   * receivables, no legal exposure — neither exists yet pre-turn-1) divided by shares
   * outstanding; used ONLY as the round-1 fallback in `applyShareTransaction`, never as a
   * general-purpose stockValue getter — see that method's doc comment for the real, reported
   * bug this fixes (buying a company for a token amount on round 1).
   */
  private startingStockValue(vars: PlayerVariables): number {
    const totalShares = vars.totalSharesOutstanding || 0;
    if (totalShares <= 0) return 0;
    const equity = (vars.cash ?? 0) + (vars.assets ?? 0) + (vars.intangibleAssets ?? 0) + (vars.reserves ?? 0) - (vars.debt ?? 0);
    return Math.max(0, equity) / totalShares;
  }

  private stripInternal(v: PlayerVariables): PlayerVariables {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _playerId, ...rest } = v as PlayerVariables & { _playerId?: unknown };
    return rest;
  }
}
