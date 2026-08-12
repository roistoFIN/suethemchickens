import { Server, Socket } from 'socket.io';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  RoomStatus,
  ClientEvents,
  ServerEvents,
  PHASE_TIMERS,
  PHASE_ORDER,
  MAX_PLAYERS,
  type Player,
  type Room,
  type RoomState,
  type RoomInfo,
  type Company,
  type GameOverResponse,
  type PlayerStanding,
  type DecisionDefinition,
  type GameConfig,
  type GameSettings,
  type TurnResolutionResult,
  type PlayerTurnResult,
  type AnnualReportEntry,
  type AdminRoomSnapshot,
  type FormulaInfo,
  type GameReadyUpdateResponse,
  type KpiHistoryResponse,
  type KpiSnapshotPoint,
  type LegalCaseData,
  type GameTimelineResponse,
  type TimelinePlayerInfo,
  type TimelineDecisionEvent,
  type TimelineLawsuitEvent,
  type PlayerVariables,
  type PlayerDerivedStats,
  type SubmittedDecisions,
  type SubmittedLawsuitEntry,
  type IncomingAttackInfo,
} from '@suethemchickens/shared';
import type { PersistedDecisionInstance } from '../engine/gameLoop.js';
import { validateRoomJoin, validateSubmitDecisions, validateDigDeeper, validateFileLawsuit, validateRoomRejoin, validateAnnualReportRequest, validateChatMessage, validateGameReady, validateRoomSetInviteOnly, validateKpiHistoryRequest, validateMakeOffer, validateAcceptOffer, validateGoToCourt, validateDigDeeperCase } from '../validation/schemas.js';
import { GameLoop } from '../engine/gameLoop.js';
import type { BankruptedPlayer } from '../engine/gameLoop.js';
import { generateAnnualReportBlurb } from '../services/llmService.js';
import { logEvent, logEvents } from '../services/eventLogService.js';
import { pickBotDecisions, pickBotShareBuy, pickAttacksToInvestigate, shouldFileLawsuit, decideBotNegotiationAction, estimatedFirstYearCashEffect, computeEffectiveReserve, projectedNextTurnOwnCashEffect, isStructurallyUnprofitable, BOT_CASH_TREND_WINDOW } from '../services/botService.js';

export class GameEngine {
  public rooms: Map<string, RoomState> = new Map();
  private playerToRoom: Map<string, string> = new Map();
  private prisma: PrismaClient;
  private io: Server;
  // Lock to prevent concurrent phase advances (race condition guard)
  private advancingRooms: Set<string> = new Set();
  // Heartbeat: track last activity per room to detect stale/disconnected rooms
  private roomLastActivity: Map<string, number> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  // How long (ms) before a room with no connected players is considered stale
  private readonly STALE_ROOM_THRESHOLD = 60_000;
  // How many non-share decisions each game's random subset draws — always topped up
  // with every share-transaction decision (see pickRandomDecisionSubset), so a real
  // game's fixed set is this plus however many Buy/Sell-Shares-style decisions exist.
  private readonly RANDOM_DECISION_COUNT = 48;
  // Reconnection grace period: players who disconnect are kept in the room (not
  // deleted) for this long, keyed by playerId since their old socketId is now dead.
  // Swept by the same heartbeat interval that cleans up stale rooms.
  private disconnectedPlayers: Map<string, { roomId: string; disconnectedAt: number }> = new Map();
  private readonly RECONNECT_GRACE_PERIOD_MS = 120_000;
  // Per-room "join a bot after N seconds of nobody showing up" timers — see
  // scheduleBotJoinCheck. Not part of RoomState itself (mirrors the roomLastActivity/
  // lastTurnResults side-Map convention) since it's ephemeral scheduling state, not
  // anything a client ever needs reflected back to it.
  private botJoinTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly BOT_JOIN_DELAY_MS = 10_000;
  // Clearly bot-flavored names, cycled at random each spawn — deliberately not a single
  // fixed name, so a host kicking a bot never collides with `kickedNames` blocking a
  // later, differently-named bot from joining.
  private readonly BOT_NAMES = ['🤖 RoboRival', '🤖 CircuitCFO', '🤖 ByteBoss', '🤖 AlgoAntagonist', '🤖 SiliconShark', '🤖 MechaMogul'];
  // Each room's last resolved turn (or round-1 starting snapshot) — re-sent to a
  // reconnecting player immediately instead of making them wait for the next turn.
  private lastTurnResults: Map<string, TurnResolutionResult> = new Map();
  // Each bot's own recent real (turn-resolved) cash readings, oldest first, capped at
  // BOT_CASH_TREND_WINDOW — see botService.ts's isCashTrendDeclining/computeEffectiveReserve
  // doc comments for why runBotTurn needs this beyond just lastTurnResults' single snapshot.
  // Keyed by roomId (not roomId:botId) so room cleanup can drop it in one call, same
  // convention as lastTurnResults itself; nested by botPlayerId to support >1 bot per room.
  private botCashHistory: Map<string, Map<string, number[]>> = new Map();
  // Core turn-resolution engine — authoritative source of all GAME_PHASE calculations.
  // Definite-assignment: only ever used after loadGameData() resolves (see index.ts's
  // start() — awaited before httpServer.listen, so no socket can connect first).
  private gameLoop!: GameLoop;
  // In-memory mirror of the `decisions` table — the decision library, live-reloaded
  // (loadDecisions() called again) on every admin create/update/delete via /admin.
  // Also supplies the competitorsView fallback text for getAnnualReport when the LLM
  // is unreachable.
  private decisionsByName!: Map<string, DecisionDefinition>;
  // In-memory mirror of the `game_config` singleton row — gameSettings/
  // playerStartingValues/adminVariables, live-reloaded on every admin config edit.
  private gameConfig!: GameConfig;
  // In-memory mirror of the `formulas` table — the pure, scalar, named-input
  // formulas (competitiveness, P&L, risk gauge, etc.), live-reloaded on every admin formula edit.
  // Fixed key set (no create/delete via /admin) — see CLAUDE.md.
  private formulasByKey!: Map<string, { expression: string; description: string }>;

  constructor(io: Server, prisma: PrismaClient) {
    this.io = io;
    this.prisma = prisma;
    this.startHeartbeatCleanup();
  }

  /**
   * Loads the decision library + game config from the database — must be awaited
   * once, before the server starts accepting connections (see index.ts's start()).
   * Decisions/config used to be static JSON imports; the DB is now authoritative at
   * runtime and this is the only place that reads it at startup. `server/src/data/
   * *.json` remain on disk purely as the versioned seed source for `npm run db:seed`
   * (see prisma/seed.ts) — editing them directly no longer has any runtime effect.
   */
  async loadGameData(): Promise<void> {
    const configRow = await this.prisma.gameConfigRow.findUnique({ where: { id: 1 } });
    if (!configRow) {
      throw new Error('GameConfigRow (id=1) not found — run `npm run db:seed` to populate it.');
    }
    this.gameConfig = {
      gameSettings: configRow.gameSettings as unknown as GameSettings,
      playerStartingValues: configRow.playerStartingValues as unknown as GameConfig['playerStartingValues'],
      adminVariables: configRow.adminVariables as unknown as GameConfig['adminVariables'],
    };
    this.gameLoop = new GameLoop(this.gameConfig);

    const decisionRows = await this.prisma.decision.findMany();
    const decisions = decisionRows.map((r) => r.data as unknown as DecisionDefinition);
    this.decisionsByName = new Map(decisions.map((d) => [d.decision, d]));
    this.gameLoop.loadDecisions(decisions);

    const formulaRows = await this.prisma.formula.findMany();
    this.formulasByKey = new Map(formulaRows.map((r) => [r.key, { expression: r.expression, description: r.description }]));
    this.gameLoop.loadFormulas(formulaRows.map((r) => ({ key: r.key, expression: r.expression })));
  }

  /** Current formula set, for `GET /api/admin/formulas`. */
  getFormulasSnapshot(): FormulaInfo[] {
    return Array.from(this.formulasByKey.entries()).map(([key, v]) => ({ key, ...v }));
  }

  /**
   * Update one formula's expression/description — the key set is fixed (no create/
   * delete via /admin; each key is referenced by name at a specific calcEngine.ts
   * call site GameLoop hard-depends on). The caller (the `PUT /api/admin/formulas/:key`
   * route) must already have validated the expression's syntax and variable whitelist
   * via `validateFormulaUpdate` before calling this — a bad formula must never reach
   * here, since this writes straight through to GameLoop's live formula set.
   */
  async updateFormula(key: string, expression: string, description: string): Promise<{ success: boolean; reason?: 'not_found' }> {
    if (!this.formulasByKey.has(key)) return { success: false, reason: 'not_found' };

    await this.prisma.formula.update({ where: { key }, data: { expression, description } });
    this.formulasByKey.set(key, { expression, description });
    this.gameLoop.loadFormulas(
      Array.from(this.formulasByKey.entries()).map(([k, v]) => ({ key: k, expression: v.expression })),
    );
    return { success: true };
  }

  /**
   * Submit one player's decisions for the current GAME_PHASE turn — filtered first
   * against this room's fixed decision set (`RoomState.decisionSubset`, see
   * `pickRandomDecisionSubset`): a strategic/operational/financial entry, or a lawsuit's
   * `decisionName`, naming a decision outside this game's assigned set is silently
   * dropped before it ever reaches `GameLoop` — the same "silently drop, no
   * player-facing error" convention `DecisionEngine.canDeploy` rejections already use
   * (see `ShareTransactionRequest`'s doc comment). This is the actual server-side
   * enforcement of "the decisions are fixed per game" — `game:deck` only ever showing
   * the room's set stops an honest client from picking anything else, but a socket that
   * sends a decision name from outside the set (a stale/buggy client, or a deliberately
   * crafted payload) must not be able to deploy it anyway. An empty/unset subset (a room
   * that hasn't gone through `startGame` yet — not a real production path, see
   * `getRoomDeck`'s doc comment) is treated as unrestricted, not "reject everything."
   */
  submitDecisions(roomId: string, playerId: string, decisions: import('@suethemchickens/shared').SubmittedDecisions): void {
    const roomState = this.rooms.get(roomId);
    const allowed = roomState && roomState.decisionSubset.length > 0 ? new Set(roomState.decisionSubset) : undefined;
    const filtered = allowed
      ? {
          strategic: decisions.strategic.filter((e) => allowed.has(e.name)),
          operational: decisions.operational.filter((e) => allowed.has(e.name)),
          financial: decisions.financial.filter((e) => allowed.has(e.name)),
          lawsuits: decisions.lawsuits.filter((l) => allowed.has(l.decisionName)),
        }
      : decisions;
    this.gameLoop.submitDecisions(roomId, playerId, filtered);
  }

  /**
   * "Dig Deeper" — pay to reveal the next tier of intel on one incoming attack. Unlike
   * `resolveGameTurn`, this happens instantly, outside the turn-resolution cycle: a
   * single Prisma write for the requesting player only, no broadcast to the room (the
   * attacker's identity is private intel for the investigating player alone).
   */
  async digDeeper(roomId: string, playerId: string, attackId: string): Promise<import('../engine/gameLoop.js').DigDeeperOutcome> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    // `Company.variables.revenue` is never actually populated — GameLoop only ever
    // materializes it fresh into a turn's own local `plMap` (see gameLoop.ts's Step 8
    // stakes-calculation note), and this is an out-of-band action with no live turn in
    // progress to compute one. Patch in the latest known figure from KpiSnapshot history
    // instead — see `latestKnownRevenueByPlayer`'s doc comment for the real bug this
    // fixes (revealAttack's pickAllGrounds silently pricing every relative-type,
    // revenue-targeting ground's stakes at $0).
    const revenueByPlayer = await this.latestKnownRevenueByPlayer(roomId);
    const playersForDig = dbPlayers.map((p) => {
      const revenue = revenueByPlayer.get(p.id);
      if (revenue === undefined || !p.company) return p;
      return { ...p, company: { ...p.company, variables: { ...(p.company.variables as Record<string, unknown>), revenue } } };
    });
    const outcome = this.gameLoop.digDeeper(playerId, attackId, playersForDig);
    if (outcome.success) {
      await this.prisma.company.update({
        where: { playerId },
        data: {
          cash: outcome.newCash,
          // GameLoop reads cash from variables.cash (JSONB), not the cash column — both
          // must be written or the next dig (or the next normal turn resolution) reads
          // stale pre-deduction cash back out.
          variables: outcome.variables as unknown as Prisma.InputJsonValue,
          engineState: outcome.engineStateUpdate as unknown as Prisma.InputJsonValue,
        },
      });
      // The dig that lands exactly on investigationLevel 1 is the one that first reveals
      // the attacker's identity without yet revealing the decision itself — see
      // `enrichIncomingAttackBlurbs`'s doc comment for why this can't happen inside
      // `GameLoop.digDeeper` itself.
      if (outcome.attack.investigationLevel === 1 && outcome.attack.attackerId) {
        const attackerCompany = dbPlayers.find((p) => p.id === outcome.attack.attackerId)?.company;
        const activeDecisions = ((attackerCompany?.engineState as { activeDecisions?: PersistedDecisionInstance[] } | null | undefined)?.activeDecisions ?? []);
        const instance = activeDecisions.find((d) => d.id === outcome.attack.attackId);
        const blurb = await this.annualReportBlurbForInstance(instance, roomId);
        if (blurb) outcome.attack.annualReportBlurb = blurb;
      }
    }
    return outcome;
  }

  /**
   * Charge the flat lawsuit filing fee the instant a player files (SueModal's "File"
   * button) — like `digDeeper`, this happens instantly, outside the turn-resolution
   * cycle: a single Prisma write for the requesting player only. The lawsuit itself is
   * still only created/validated at the next turn resolution via the normal
   * `submitDecisions` → `LegalEngine.fileLawsuit` path — this method only ever moves cash.
   */
  async fileLawsuit(roomId: string, playerId: string): Promise<import('../engine/gameLoop.js').LawsuitFilingFeeOutcome> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const outcome = this.gameLoop.chargeLawsuitFilingFee(roomId, playerId, dbPlayers);
    if (outcome.success) {
      await this.prisma.company.update({
        where: { playerId },
        data: {
          cash: outcome.newCash,
          // GameLoop reads cash from variables.cash (JSONB), not the cash column — both
          // must be written, same requirement as digDeeper's write.
          variables: outcome.variables as unknown as Prisma.InputJsonValue,
        },
      });
    }
    return outcome;
  }

  /**
   * Fires `runBotTurn` for every currently-active bot in a room, right after that round's
   * data is settled — called from `broadcastInitialSnapshot` (round 1) and
   * `resolveGameTurn` (every round after). Fire-and-forget from both call sites: a bot
   * "thinking" must never delay a real broadcast (especially `broadcastInitialSnapshot`'s
   * own must-land-before-`PHASE_CHANGED` ordering — see `startGame`'s doc comment) or hold
   * up `resolveGameTurn`'s `advancingRooms` lock any longer than the turn resolution
   * itself already does. Each bot is isolated in its own try/catch — one bot's failure
   * must never affect another, or the human's own turn.
   */
  private runBotTurnsForRoom(roomId: string): void {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;
    const bots = Array.from(roomState.players.values()).filter((p) => p.isBot && !p.bankrupt);
    for (const bot of bots) {
      this.runBotTurn(roomId, bot.id).catch((err) => {
        console.error(`[Bot] runBotTurn failed for bot ${bot.id} in room ${roomId}:`, err);
      });
    }
  }

  /**
   * Computes and submits one bot player's turn: dig up to 2 incoming attacks
   * (prioritizing whichever is already partway investigated), file a lawsuit over
   * anything that clears a 30% estimated win chance, pick 1-2 new decisions, then ready
   * up — all via the exact same engine methods a real client's socket handlers call
   * (`digDeeper`/`fileLawsuit`/`submitDecisions`/`toggleReady`), never a special bot-only
   * code path into `GameLoop`. The actual picking logic is in `botService.ts` (pure,
   * unit-tested); this method is pure orchestration — real I/O, no decisions of its own.
   * Everything is bounded by `BOT_CASH_RESERVE` so the bot can't spend itself into a
   * corner (see botService.ts's own doc comment).
   *
   * Public (not called directly outside this file otherwise — always via
   * `runBotTurnsForRoom`) specifically so its dig → fee-charge-then-submit-before-next-
   * charge → ready-up sequencing has real regression coverage, the same "pulled out
   * as its own testable method" reasoning `startGame` already documents for its own
   * broadcast-ordering tests.
   */
  async runBotTurn(roomId: string, botPlayerId: string): Promise<void> {
    const roomState = this.rooms.get(roomId);
    if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;
    const bot = roomState.players.get(botPlayerId);
    if (!bot || bot.bankrupt) return;

    const lastTurn = this.lastTurnResults.get(roomId);
    const botResult = lastTurn?.players.find((p) => p.playerId === botPlayerId);
    if (!botResult) return;

    let cash = botResult.variables.cash ?? 0;
    const { digDeeperCost, lawsuitFilingCost } = this.gameConfig.gameSettings;
    const { interestRate } = this.gameConfig.adminVariables.finance;
    // Live COGS state (calcEngine.ts: cogs = (materialCostPerTon + logisticsCostPerTon) *
    // volume) — threaded through every cash-aware botService.ts function below. See
    // BotCogsContext's own doc comment for the real, reported bug this fixes: none of the
    // bot's self-preservation checks used to account for COGS at all, even though it's
    // very often the single largest cost in this game's real P&L.
    const botCogs: import('../services/botService.js').BotCogsContext = {
      volume: botResult.variables.volume ?? 0,
      materialCostPerTon: botResult.variables.materialCostPerTon ?? 0,
      logisticsCostPerTon: botResult.variables.logisticsCostPerTon ?? 0,
    };

    // Record this turn's real cash reading and derive this turn's effective reserve from
    // it — see botService.ts's isCashTrendDeclining/computeEffectiveReserve doc comments:
    // a single-turn affordability check can't see a decision's backloaded (year 2-4) cost,
    // so once the bot's own real cash is genuinely trending down, every discretionary
    // spend below (digging, suing, new decisions, buying shares) backs off together by
    // budgeting against a larger reserve until cash recovers.
    const roomBotHistory = this.botCashHistory.get(roomId) ?? new Map<string, number[]>();
    const cashHistory = roomBotHistory.get(botPlayerId) ?? [];
    cashHistory.push(cash);
    if (cashHistory.length > BOT_CASH_TREND_WINDOW) cashHistory.shift();
    roomBotHistory.set(botPlayerId, cashHistory);
    this.botCashHistory.set(roomId, roomBotHistory);
    const deck = this.getRoomDeck(roomId);
    // What the bot's OWN already-active decisions will cost/pay next turn regardless of
    // anything picked this turn — folded into the reserve so a known upcoming bill (a
    // backloaded financeCost schedule, say) isn't invisible to this turn's spending
    // decisions. See botService.ts's projectedNextTurnOwnCashEffect doc comment.
    const projectedNextTurn = projectedNextTurnOwnCashEffect(botResult.activeDecisions, deck, interestRate, botCogs);
    let effectiveReserve = computeEffectiveReserve(cashHistory, projectedNextTurn);
    // Already losing money every turn on its own cost structure, regardless of any single
    // turn's new picks (see isStructurallyUnprofitable's doc comment) — a company can
    // coast on a large cash cushion for many turns while structurally underwater, only to
    // crater once the cushion runs out. Once detected, block ALL discretionary spending
    // this turn (reserve = current cash, so nothing but a net-cash-positive move clears
    // it) until the structure improves — a harder stop than the trend/projection reserve
    // bumps above, which only react to cash that's already moving.
    const structurallyUnprofitable = isStructurallyUnprofitable(
      botResult.variables.operatingExpenses ?? 0,
      botResult.variables.staffCost ?? 0,
      botResult.variables.otherIncome ?? 0,
      botResult.derived.financeCost,
      botResult.derived.revenue,
      botCogs.materialCostPerTon,
      botCogs.logisticsCostPerTon,
      botCogs.volume,
    );
    if (structurallyUnprofitable) effectiveReserve = Math.max(effectiveReserve, cash);

    // Dig up to 2 attacks that aren't fully revealed yet.
    const dugAttacks: IncomingAttackInfo[] = [];
    for (const attack of pickAttacksToInvestigate(botResult.incomingAttacks)) {
      if (cash - digDeeperCost < effectiveReserve) break;
      const outcome = await this.digDeeper(roomId, botPlayerId, attack.attackId);
      if (outcome.success) {
        cash = outcome.newCash;
        dugAttacks.push(outcome.attack);
      }
    }

    // Anything already fully revealed this turn (no dig needed) plus whatever the
    // digging above just revealed — either can now clear the suing bar.
    const candidateAttacks = [...botResult.incomingAttacks.filter((a) => a.suggestedGrounds !== undefined), ...dugAttacks];

    const lawsuits: SubmittedLawsuitEntry[] = [];
    for (const attack of candidateAttacks) {
      // Files over its single strongest ground (suggestedGrounds[0], already sorted
      // probability-descending) — see shouldFileLawsuit's own doc comment for why the
      // bot's own strategy doesn't need to consider every suggested ground, just its best.
      const bestGroundName = attack.suggestedGrounds?.[0]?.name;
      if (!attack.attackerId || !attack.decisionName || !bestGroundName) continue;
      if (!shouldFileLawsuit(attack, cash, lawsuitFilingCost, effectiveReserve)) continue;
      const feeOutcome = await this.fileLawsuit(roomId, botPlayerId);
      if (!feeOutcome.success) continue; // per-turn cap reached, or funds changed mid-loop
      cash = feeOutcome.newCash;
      lawsuits.push({ targetId: attack.attackerId, decisionName: attack.decisionName, groundName: bestGroundName });
      // chargeLawsuitFilingFee's per-turn cap check reads the already-queued count off
      // GameLoop's own submissions map (see its doc comment) — must be reflected here
      // before the next fee charge, same "charge fees one at a time" requirement a real
      // client's SueModal already follows.
      this.submitDecisions(roomId, botPlayerId, { strategic: [], operational: [], financial: [], lawsuits });
    }

    // Negotiate every open case the bot is a party to — a real, reported gap: the bot
    // used to never actively respond to a settlement offer at all, so any offer a human
    // made to it just sat there until Step 8b's turn-boundary timeout auto-accepted it,
    // however small. `decideBotNegotiationAction` weighs the current offer against a
    // real expected-value estimate instead. One action per case per turn (dig this turn,
    // decide next), matching this bot's existing "investigate before committing" pacing.
    for (const case_ of botResult.legalCases) {
      if (case_.status !== 'negotiating') continue;
      const myRole = case_.plaintiffId === botPlayerId ? 'plaintiff' : case_.defendantId === botPlayerId ? 'defendant' : null;
      if (!myRole) continue;
      const action = decideBotNegotiationAction(case_, myRole, cash, digDeeperCost);
      let outcome: import('../engine/gameLoop.js').LegalCaseActionOutcome | undefined;
      switch (action.type) {
        case 'wait':
          continue;
        case 'digDeeperOnCase':
          outcome = await this.digDeeperOnCase(roomId, botPlayerId, case_.id);
          break;
        case 'accept':
          outcome = await this.acceptOffer(roomId, botPlayerId, case_.id);
          break;
        case 'counter':
          outcome = await this.makeOffer(roomId, botPlayerId, case_.id, action.amount);
          break;
        case 'goToCourt':
          outcome = await this.goToCourt(roomId, botPlayerId, case_.id);
          break;
      }
      if (outcome?.success) {
        const myUpdate = myRole === 'plaintiff' ? outcome.plaintiff : outcome.defendant;
        if (myUpdate.cash !== undefined) cash = myUpdate.cash;
      }
    }

    const humanPlayerId = Array.from(roomState.players.values()).find((p) => !p.isBot)?.id;
    const picks = humanPlayerId
      ? pickBotDecisions(
          deck,
          cash,
          humanPlayerId,
          botResult.riskGauge,
          effectiveReserve,
          interestRate,
          structurallyUnprofitable,
          botResult.activeDecisions,
          this.gameConfig.gameSettings.permanentEffectCooldownYears,
          botCogs,
        )
      : [];

    const decisions: SubmittedDecisions = { strategic: [], operational: [], financial: [], lawsuits };
    for (const entry of picks) {
      const def = deck.find((d) => d.decision === entry.name);
      const bucket: 'strategic' | 'operational' | 'financial' =
        def?.level === 'Strategic' ? 'strategic' : def?.level === 'Financial' ? 'financial' : 'operational';
      decisions[bucket].push(entry);
      // Track what pickBotDecisions' own picks would spend so pickBotShareBuy (below)
      // doesn't independently think the same spare cash is still available. Uses the same
      // full cash-effect estimate pickBotDecisions itself budgets against (not just the
      // `cash` field alone — see estimatedFirstYearCashEffect's own doc comment).
      if (def) cash += estimatedFirstYearCashEffect(def, interestRate, botCogs);
    }

    // Hostile-takeover threat: a genuine (if unsophisticated) Buy Shares strategy, on top
    // of pickBotDecisions' own picks — see botService.ts's pickBotShareBuy doc comment.
    if (humanPlayerId) {
      const humanResult = lastTurn?.players.find((p) => p.playerId === humanPlayerId);
      const stockValue = humanResult?.variables.stockValue;
      const totalShares = humanResult?.variables.totalSharesOutstanding;
      // How much MORE spend is actually useful against this target — see
      // pickBotShareBuy's own doc comment for the overpay bug this prevents. Left
      // Infinity (uncapped) only when the target's stockValue genuinely isn't known yet
      // (round 1, before any turn has priced it).
      let maxUsefulSpend = Infinity;
      if (stockValue !== undefined && totalShares && totalShares > 0) {
        const currentBotFraction = humanResult?.variables.shareOwnership?.[botPlayerId] ?? 0;
        maxUsefulSpend = Math.max(0, 1 - currentBotFraction) * totalShares * stockValue;
      }
      const buyAmount = pickBotShareBuy(cash, decisions.financial.length, this.gameConfig.gameSettings.maxFinancialDecisionsPerTurn, effectiveReserve, maxUsefulSpend);
      if (buyAmount !== undefined) {
        decisions.financial.push({ name: 'Buy Shares', targetId: humanPlayerId, amount: buyAmount });
      }
    }

    this.submitDecisions(roomId, botPlayerId, decisions);

    // Mirrors the GAME_READY socket handler exactly (broadcast the ready update, and
    // trigger immediate resolution if that was the last player needed) — the bot has no
    // socket of its own to route through that handler, so this is the one place that
    // logic has to be duplicated. Without the broadcast, a human watching the room would
    // never see "opponent is ready" reflect the bot's own readiness until their own next
    // action independently re-broadcasts it.
    const readyUpdate = this.toggleReady(roomId, botPlayerId, true);
    if (!readyUpdate) return;
    this.broadcastRoomState(roomId, ServerEvents.GAME_READY_UPDATE, readyUpdate);
    if (readyUpdate.activePlayerCount > 0 && readyUpdate.readyPlayerIds.length >= readyUpdate.activePlayerCount) {
      this.clearTimer(roomId);
      this.resolveGameTurn(roomId).catch((err) => {
        console.error(`[Bot] ready-triggered turn resolution failed for room ${roomId}:`, err);
      });
    }
  }

  /**
   * Make (or counter) a settlement offer on a case still `'negotiating'` — instant,
   * outside the turn-resolution cycle, same pattern as `digDeeper`/`fileLawsuit`. Unlike
   * those single-player actions, a case touches BOTH parties: on success, both parties'
   * Company rows are written and both parties' sockets (not just the requester's) get
   * the update, via `persistLegalCaseAction`/`emitLegalCaseUpdate`.
   *
   * Rejects outright with `reason: 'turn_resolving'` — before reading anything — while
   * this room's `advancingRooms` lock is held. A real, reported bug: a player's
   * `goToCourt` landing at the same moment their room's turn happened to resolve could be
   * silently clobbered by that same turn's Step 8b stale-offer auto-settle, since neither
   * side knew about the other. This can't fully close the race (the lock could still be
   * acquired a moment after this check, before this call's own persistence write lands —
   * a full fix would need a real per-room mutex/queue, not just a check-and-reject), but
   * it closes the overwhelmingly likely window: a live human clicking a negotiation button
   * at the *exact* instant a multi-second turn timer independently expires. See CLAUDE.md.
   */
  async makeOffer(roomId: string, playerId: string, caseId: string, amount: number): Promise<import('../engine/gameLoop.js').LegalCaseActionOutcome> {
    if (this.advancingRooms.has(roomId)) {
      const outcome: import('../engine/gameLoop.js').LegalCaseActionOutcome = { success: false, reason: 'turn_resolving' };
      await this.logNegotiationAction('makeOffer', roomId, playerId, caseId, undefined, outcome, { amount });
      return outcome;
    }
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const before = this.findCaseSnapshotInDbPlayers(dbPlayers, caseId);
    const outcome = this.gameLoop.makeOffer(playerId, caseId, amount, dbPlayers);
    await this.logNegotiationAction('makeOffer', roomId, playerId, caseId, before, outcome, { amount });
    if (outcome.success) {
      await this.persistLegalCaseAction(outcome);
      this.emitLegalCaseUpdate(roomId, outcome);
    }
    return outcome;
  }

  /** Accept the other party's most recent offer — settles the case immediately. Same two-party persist/emit shape as `makeOffer`, including the same `advancingRooms` rejection (see `makeOffer`'s doc comment). */
  async acceptOffer(roomId: string, playerId: string, caseId: string): Promise<import('../engine/gameLoop.js').LegalCaseActionOutcome> {
    if (this.advancingRooms.has(roomId)) {
      const outcome: import('../engine/gameLoop.js').LegalCaseActionOutcome = { success: false, reason: 'turn_resolving' };
      await this.logNegotiationAction('acceptOffer', roomId, playerId, caseId, undefined, outcome);
      return outcome;
    }
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const before = this.findCaseSnapshotInDbPlayers(dbPlayers, caseId);
    const outcome = this.gameLoop.acceptOffer(playerId, caseId, dbPlayers);
    await this.logNegotiationAction('acceptOffer', roomId, playerId, caseId, before, outcome);
    if (outcome.success) {
      await this.persistLegalCaseAction(outcome);
      this.emitLegalCaseUpdate(roomId, outcome);
      // The only out-of-band case action that can resolve a case outside resolveTurn
      // (makeOffer never changes status; goToCourt only ever reaches 'awaiting_trial',
      // never loggable as "resolved") — so this is the one other call site
      // persistLegalCaseHistory's per-turn hook can't cover on its own. The row is
      // guaranteed to already exist by the time acceptOffer can run (filing only ever
      // happens inside resolveTurn's Step 8), so the defensive `create` branch inside
      // recordLegalCaseHistory should never actually populate names here in practice.
      if (outcome.case.status === 'resolved') {
        const round = this.rooms.get(roomId)?.room.currentPhaseRound ?? 0;
        try {
          await this.recordLegalCaseHistory(outcome.case, round, new Map());
        } catch (err) {
          console.error(`[acceptOffer] Failed to persist history for case ${caseId}, round ${round}:`, err);
        }
      }
    }
    return outcome;
  }

  /** End negotiation and send a case to trial — only marks it `awaiting_trial`; the verdict is drawn the next time this room's turn actually resolves. Same two-party persist/emit shape as `makeOffer`, including the same `advancingRooms` rejection (see `makeOffer`'s doc comment). */
  async goToCourt(roomId: string, playerId: string, caseId: string): Promise<import('../engine/gameLoop.js').LegalCaseActionOutcome> {
    if (this.advancingRooms.has(roomId)) {
      const outcome: import('../engine/gameLoop.js').LegalCaseActionOutcome = { success: false, reason: 'turn_resolving' };
      await this.logNegotiationAction('goToCourt', roomId, playerId, caseId, undefined, outcome);
      return outcome;
    }
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const before = this.findCaseSnapshotInDbPlayers(dbPlayers, caseId);
    const outcome = this.gameLoop.goToCourt(playerId, caseId, dbPlayers);
    await this.logNegotiationAction('goToCourt', roomId, playerId, caseId, before, outcome);
    if (outcome.success) {
      await this.persistLegalCaseAction(outcome);
      this.emitLegalCaseUpdate(roomId, outcome);
    }
    return outcome;
  }

  /** Pay `gameSettings.digDeeperCost` to reveal the probability of success on a case you're the defendant on — instant, outside the turn-resolution cycle. Same two-party persist/emit shape as `makeOffer`, even though only the defendant's cash moves — including the same `advancingRooms` rejection (see `makeOffer`'s doc comment). */
  async digDeeperOnCase(roomId: string, playerId: string, caseId: string): Promise<import('../engine/gameLoop.js').LegalCaseActionOutcome> {
    if (this.advancingRooms.has(roomId)) {
      const outcome: import('../engine/gameLoop.js').LegalCaseActionOutcome = { success: false, reason: 'turn_resolving' };
      await this.logNegotiationAction('digDeeperOnCase', roomId, playerId, caseId, undefined, outcome);
      return outcome;
    }
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const before = this.findCaseSnapshotInDbPlayers(dbPlayers, caseId);
    const outcome = this.gameLoop.digDeeperOnCase(playerId, caseId, dbPlayers);
    await this.logNegotiationAction('digDeeperOnCase', roomId, playerId, caseId, before, outcome);
    if (outcome.success) {
      await this.persistLegalCaseAction(outcome);
      this.emitLegalCaseUpdate(roomId, outcome);
    }
    return outcome;
  }

  /** Best-effort scan of `loadActiveCompanyPlayers`' result for a case by id, across
   * either party's own `engineState.legalCases` copy — used only for `logNegotiationAction`'s
   * "before" snapshot (forensic detail), never for any actual gameplay decision (that stays
   * inside `GameLoop.findCaseAndParties`). Returns `undefined` if not found in either. */
  private findCaseSnapshotInDbPlayers(
    dbPlayers: Awaited<ReturnType<GameEngine['loadActiveCompanyPlayers']>>,
    caseId: string,
  ): LegalCaseData | undefined {
    for (const p of dbPlayers) {
      const cases = (p.company?.engineState as { legalCases?: LegalCaseData[] } | null | undefined)?.legalCases ?? [];
      const found = cases.find((c) => c.id === caseId);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Forensic trail for `makeOffer`/`acceptOffer`/`goToCourt`/`digDeeperOnCase` — logs
   * every call, success or rejection, to `EventLog` (`case.negotiation_action`). Added
   * specifically because a real, reported "wrong party got to move" bug couldn't be
   * reproduced or pinned down from code review alone; this exists purely so the NEXT
   * occurrence leaves concrete evidence (the case's exact `offers`/status immediately
   * before the call, the actor, and the server's outcome) instead of relying on a
   * player's memory of what they clicked. Best-effort — `logEvent` itself never throws,
   * so this can never affect the actual negotiation outcome.
   */
  private async logNegotiationAction(
    action: 'makeOffer' | 'acceptOffer' | 'goToCourt' | 'digDeeperOnCase',
    roomId: string,
    playerId: string,
    caseId: string,
    before: LegalCaseData | undefined,
    outcome: import('../engine/gameLoop.js').LegalCaseActionOutcome,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await logEvent(this.prisma, {
      eventType: 'case.negotiation_action',
      severity: outcome.success ? 'info' : 'warning',
      roomId,
      playerId,
      payload: {
        action,
        caseId,
        success: outcome.success,
        ...(outcome.success ? {} : { reason: outcome.reason }),
        beforeStatus: before?.status,
        beforePlaintiffId: before?.plaintiffId,
        beforeDefendantId: before?.defendantId,
        beforeOffers: before?.offers,
        ...(outcome.success
          ? { afterStatus: outcome.case.status, afterVerdict: outcome.case.verdict ?? null, afterOffers: outcome.case.offers }
          : {}),
        ...extra,
      },
    });
  }

  /** Writes both parties' Company rows for a successful `makeOffer`/`acceptOffer`/`goToCourt` outcome. `cash`/`variables` are only included in a party's write when they're actually present on that side's update (a settlement) — omitted entirely for an offer or a court decision, which never move cash. */
  private async persistLegalCaseAction(
    outcome: Extract<import('../engine/gameLoop.js').LegalCaseActionOutcome, { success: true }>,
  ): Promise<void> {
    for (const side of [outcome.plaintiff, outcome.defendant]) {
      await this.prisma.company.update({
        where: { playerId: side.playerId },
        data: {
          engineState: side.engineState as unknown as Prisma.InputJsonValue,
          ...(side.cash !== undefined ? { cash: side.cash, variables: side.variables as unknown as Prisma.InputJsonValue } : {}),
        },
      });
    }
  }

  /** Sends the updated case to both parties' sockets — never a room-wide broadcast, since
   * nobody but the two parties on a case has any business seeing it. Each recipient gets
   * their OWN `newCash` (undefined for a recipient whose cash didn't move). Silently
   * skips a party who's currently disconnected (`socketId` cleared by
   * `markPlayerDisconnected`) — they'll see the persisted update on reconnect or the
   * next `turn:resolved` either way. */
  private emitLegalCaseUpdate(
    roomId: string,
    outcome: Extract<import('../engine/gameLoop.js').LegalCaseActionOutcome, { success: true }>,
  ): void {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;
    for (const side of [outcome.plaintiff, outcome.defendant]) {
      const socketId = roomState.players.get(side.playerId)?.socketId;
      if (!socketId) continue;
      this.io.to(socketId).emit(ServerEvents.GAME_LEGAL_CASE_UPDATE, {
        case: outcome.case,
        newCash: side.cash,
      });
    }
  }

  /**
   * AI-narrated "annual report" text for one rival's active decisions — on demand
   * (opened from the Full Filing modal), never part of turn resolution. Re-derives the
   * rival's active decisions server-side from their Company row rather than trusting
   * anything the requesting client sent, same as `digDeeper`. Returns `null` if the
   * rival isn't found (unknown id, or bankrupted since the requester last saw them).
   */
  async getAnnualReport(roomId: string, rivalPlayerId: string): Promise<AnnualReportEntry[] | null> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const summaries = this.gameLoop.getActiveDecisionSummaries(rivalPlayerId, dbPlayers);
    if (!summaries) return null;

    const entries = await Promise.all(
      summaries
        .map((s) => ({ summary: s, def: this.decisionsByName.get(s.decisionName) }))
        .filter((x): x is { summary: typeof x.summary; def: DecisionDefinition } => !!x.def?.competitorsView?.length)
        .map(async ({ summary, def }) => {
          const fallback = def.competitorsView![summary.elapsedYears % def.competitorsView!.length];
          const text = await generateAnnualReportBlurb(
            {
              decisionName: summary.decisionName,
              description: summary.description,
              elapsedYears: summary.elapsedYears,
              fallback,
            },
            (telemetry) => this.logLlmCall('annualReport', roomId, telemetry),
          );
          return { decisionName: summary.decisionName, text, year: summary.deployedYear + 1 };
        }),
    );
    return entries;
  }

  /** Best-effort — see eventLogService.ts's own doc comment for why this must never throw
   * or delay the caller; fire-and-forget on purpose (the LLM call this measures already
   * has its own latency, no reason to add the EventLog write's latency on top of it). */
  private logLlmCall(kind: 'annualReport' | 'decisionGen', roomId: string | undefined, telemetry: import('../services/llmService.js').LlmCallTelemetry): void {
    void logEvent(this.prisma, {
      eventType: 'llm.call',
      severity: telemetry.success ? 'info' : 'warning',
      roomId,
      payload: { kind, latencyMs: telemetry.latencyMs, success: telemetry.success, cached: telemetry.cached },
    });
  }

  /** Same AI-narrated (or `competitorsView`-fallback) blurb `getAnnualReport` generates
   * for one decision instance, reused for `IncomingAttackInfo.annualReportBlurb` (see its
   * doc comment) — `undefined` if the instance is unknown or its definition has no
   * `competitorsView` to draw a fallback from (mirrors `getAnnualReport`'s own filter). */
  private async annualReportBlurbForInstance(instance: import('../engine/gameLoop.js').PersistedDecisionInstance | undefined, roomId: string): Promise<string | undefined> {
    if (!instance) return undefined;
    const def = this.decisionsByName.get(instance.definitionName);
    if (!def?.competitorsView?.length) return undefined;
    const fallback = def.competitorsView[instance.elapsedYears % def.competitorsView.length];
    return generateAnnualReportBlurb(
      {
        decisionName: def.decision,
        description: def.description,
        elapsedYears: instance.elapsedYears,
        fallback,
      },
      (telemetry) => this.logLlmCall('annualReport', roomId, telemetry),
    );
  }

  /**
   * Fills in `IncomingAttackInfo.annualReportBlurb` (mutating in place) for every attack
   * at investigationLevel === 1, across every player's `incomingAttacks` — the tier where
   * the attacker's identity is known but the decision itself isn't yet (see
   * `revealAttack`'s tiers in `GameLoop`). Deliberately lives here, not inside
   * `GameLoop.buildIncomingAttacks`/`revealAttack`: those run inside the pure, synchronous
   * `resolveTurn`/`getInitialSnapshot`, which must never do network I/O (CLAUDE.md's
   * two-layer architecture split) — this mirrors why `getAnnualReport` itself is entirely
   * `GameEngine`'s job, not `GameLoop`'s. `activeDecisionsByPlayer` must be POST-turn
   * engine state (`companyUpdates`, not the pre-turn `dbPlayers` this same call resolved
   * from) — a decision deployed or matured this very turn must resolve the same instance
   * `buildIncomingAttacks` itself just described.
   */
  private async enrichIncomingAttackBlurbs(
    players: PlayerTurnResult[],
    activeDecisionsByPlayer: Map<string, import('../engine/gameLoop.js').PersistedDecisionInstance[]>,
    roomId: string,
  ): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const player of players) {
      for (const attack of player.incomingAttacks) {
        if (attack.investigationLevel !== 1 || !attack.attackerId) continue;
        const instance = activeDecisionsByPlayer.get(attack.attackerId)?.find((d) => d.id === attack.attackId);
        tasks.push(
          this.annualReportBlurbForInstance(instance, roomId).then((blurb) => {
            if (blurb) attack.annualReportBlurb = blurb;
          }),
        );
      }
    }
    await Promise.all(tasks);
  }

  /**
   * KPI history (persisted `KpiSnapshot` rows, oldest round first) for either the
   * requesting player themselves (`includePrediction: true`, adds a 3-turn-ahead
   * `GameLoop.predictFutureKpis` projection) or a rival in the same room
   * (`includePrediction: false`, history only — predicting a rival's future from their
   * own decisions isn't offered, only real history). On demand, opened by clicking any
   * KPI card or breakdown line item in `GamePhase.tsx`, for either your own KPIs or a
   * rival's Full Filing report / mini-stats. Returns `null` only if the room itself is
   * unknown. The `kpiSnapshot` query is scoped to `player: { roomId }` — the same
   * distrust-the-client, scope-via-room pattern `getAnnualReport` uses — so a
   * `targetPlayerId` for a player in a different room (or no longer in this one) just
   * comes back with an empty `history` rather than leaking another room's data or
   * erroring. If the player has since gone bankrupt (excluded from
   * `loadActiveCompanyPlayers`), `predicted` just comes back empty rather than the whole
   * call failing — `history` is still real and worth returning. `predictFutureKpis` reads
   * this player's own currently-queued (not yet turn-resolved) decisions straight off
   * `this.gameLoop`'s live submission state for `roomId` and folds them into the very
   * first predicted point — never a rival's, whose queued decisions stay excluded exactly
   * as before (see `predictFutureKpis`'s own doc comment).
   */
  async getKpiHistory(roomId: string, targetPlayerId: string, includePrediction: boolean): Promise<KpiHistoryResponse | null> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return null;

    const rows = await this.prisma.kpiSnapshot.findMany({
      where: { playerId: targetPlayerId, player: { roomId } },
      orderBy: { round: 'asc' },
    });
    const history = rows.map((r) => ({
      round: r.round,
      variables: r.variables as unknown as PlayerVariables,
      derived: r.derived as unknown as PlayerDerivedStats,
      riskGauge: r.riskGauge,
    }));

    if (!includePrediction) {
      return { playerId: targetPlayerId, history, predicted: [] };
    }

    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const prediction = this.gameLoop.predictFutureKpis(roomId, targetPlayerId, roomState.room.currentPhaseRound, dbPlayers, 3);

    return { playerId: targetPlayerId, history, predicted: prediction.predicted, bankruptAtRound: prediction.bankruptAtRound };
  }

  /**
   * The whole room's game-timeline replay/spectator data — every player (active or
   * eliminated), every decision ever deployed, every lawsuit ever filed/resolved. Unlike
   * `getKpiHistory` (per-target, fetched fresh per open graph), this returns everything
   * at once: the single data source behind both the live spectator view (an eliminated
   * player who chose to keep watching) and the finished-game replay (the Game Over
   * screen, for everyone) — see CLAUDE.md's game-timeline section.
   *
   * Pure serialization — no `GameLoop`/`DecisionEngine` involvement needed. Decision
   * names are resolved client-side against the already-cached deck (the same pattern
   * `ActiveDecisionCard` already uses), and everything else here is either already in
   * Postgres verbatim (`KpiSnapshot`, `LegalCaseHistory`) or raw JSON already sitting in
   * `Company.engineState.activeDecisions` (append-only, never pruned — see
   * `PersistedDecisionInstance`'s doc comment in `gameLoop.ts`).
   *
   * Queries every `Player` in the room regardless of `bankrupt` (mirrors
   * `buildGameOverPayload`'s "everyone, not just active" shape, not
   * `loadActiveCompanyPlayers`'s active-only one) — an eliminated player's data must
   * still appear in the replay.
   */
  async getGameTimeline(roomId: string): Promise<GameTimelineResponse | null> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return null;
    // A room being actively watched (even read-only, no state-mutating actions) should
    // never get swept up by the stale-room cleanup out from under a spectator.
    this.touchRoomActivity(roomId);

    // Stable join order — client-side color assignment for the multi-player race chart
    // relies on `players` always arriving in the same order across re-fetches, so the
    // same player always lands on the same categorical color slot.
    const dbPlayers = await this.prisma.player.findMany({
      where: { roomId },
      include: { company: true },
      orderBy: { createdAt: 'asc' },
    });

    const players: TimelinePlayerInfo[] = dbPlayers.map((p) => ({
      playerId: p.id,
      playerName: p.name,
      bankrupt: p.bankrupt,
      eliminatedRound: p.eliminatedRound ?? undefined,
    }));

    const kpiRows = await this.prisma.kpiSnapshot.findMany({
      where: { player: { roomId } },
      orderBy: [{ playerId: 'asc' }, { round: 'asc' }],
    });
    const kpiHistory: Record<string, KpiSnapshotPoint[]> = {};
    for (const r of kpiRows) {
      const point: KpiSnapshotPoint = { round: r.round, variables: r.variables as unknown as PlayerVariables, derived: r.derived as unknown as PlayerDerivedStats, riskGauge: r.riskGauge };
      (kpiHistory[r.playerId] ??= []).push(point);
    }

    const decisions: TimelineDecisionEvent[] = [];
    for (const p of dbPlayers) {
      const activeDecisions = (p.company?.engineState as { activeDecisions?: PersistedDecisionInstance[] } | null | undefined)?.activeDecisions ?? [];
      for (const d of activeDecisions) {
        decisions.push({
          instanceId: d.id,
          playerId: p.id,
          decisionName: d.definitionName,
          deployedYear: d.deployedYear,
          targetId: d.targetId,
          voidedByLawsuit: !!d.voidedByLawsuit,
          acquisitionFraction: d.acquisitionFraction,
        });
      }
    }

    const lawsuitRows = await this.prisma.legalCaseHistory.findMany({
      where: { roomId },
      orderBy: { filedRound: 'asc' },
    });
    const lawsuits: TimelineLawsuitEvent[] = lawsuitRows.map((c) => ({
      id: c.id,
      plaintiffId: c.plaintiffId,
      plaintiffName: c.plaintiffName,
      defendantId: c.defendantId,
      defendantName: c.defendantName,
      decisionName: c.decisionName,
      groundName: c.groundName,
      description: c.description,
      stakes: Number(c.stakes),
      baseProbability: c.baseProbability,
      plaintiffFullyInvestigated: c.plaintiffFullyInvestigated,
      filedRound: c.filedRound,
      resolvedRound: c.resolvedRound ?? undefined,
      // `LegalCaseHistory.verdict` is a plain string column (not DB-enforced — same
      // pragmatic style as LegalCaseData.verdict, see CLAUDE.md), but only ever written
      // by this codebase's own resolve/settle paths, always one of the four real values.
      verdict: (c.verdict ?? undefined) as TimelineLawsuitEvent['verdict'],
      resolvedAmount: c.resolvedAmount != null ? Number(c.resolvedAmount) : undefined,
    }));

    // The turn:resolved cache already carries gameOver/winnerId — no need to
    // re-derive the win condition here.
    const cachedResult = this.lastTurnResults.get(roomId);

    return {
      roomId,
      currentRound: roomState.room.currentPhaseRound,
      gameOver: roomState.room.status === RoomStatus.AFTERMATH,
      winnerId: cachedResult?.winnerId,
      players,
      kpiHistory,
      decisions,
      lawsuits,
    };
  }

  /**
   * Broadcast each player's starting-position snapshot the instant the game starts,
   * so the client renders the game room immediately instead of a blank loading state
   * for the whole first round's timer.
   */
  async broadcastInitialSnapshot(roomId: string, round: number): Promise<void> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const snapshot = this.gameLoop.getInitialSnapshot(roomId, round, dbPlayers);
    await this.persistKpiSnapshots(snapshot.players, round);
    this.lastTurnResults.set(roomId, snapshot);
    this.io.to(roomId).emit(ServerEvents.TURN_RESOLVED, snapshot);
    // Fire-and-forget — must never delay this method's return, since startGame awaits it
    // before broadcasting PHASE_CHANGED (see that method's doc comment on why).
    this.runBotTurnsForRoom(roomId);
  }

  /**
   * Enters GAME_PHASE round 1 for a WAITING room — the `ROOM_START_GAME` handler's own
   * state mutation/broadcast orchestration, pulled out as its own testable method (the
   * handler itself keeps only the NOT_HOST/NOT_ENOUGH_PLAYERS validation, which needs
   * direct `socket.emit` access) specifically so its broadcast ORDER has real regression
   * coverage — see gameEngine.test.ts's 'startGame' describe block.
   *
   * **`broadcastInitialSnapshot` is deliberately awaited and broadcast BEFORE
   * `PHASE_CHANGED`** — a real, reproduced race otherwise (found via a live Docker smoke
   * test, not just code review): `PHASE_CHANGED` is what makes the client render the
   * GamePhase screen and allows submitting/readying up, but `broadcastInitialSnapshot`'s
   * own DB work (`loadActiveCompanyPlayers`, `persistKpiSnapshots`) takes real time. A
   * client fast enough to submit and ready up (both players — e.g. an idle round-1 pass)
   * the instant it sees `PHASE_CHANGED` could have its OWN real turn-1 resolution
   * complete and broadcast `TURN_RESOLVED` FIRST, only for this always-empty initial
   * snapshot to land moments later and silently stomp the real result with stale,
   * zero-decisions data — reproduced live with two Socket.IO clients readying up
   * immediately on `PHASE_CHANGED`, which received the empty snapshot as a SECOND,
   * later `TURN_RESOLVED` overwriting the real one. Awaiting this call before
   * `PHASE_CHANGED` broadcasts means no client can possibly act until after it's already
   * landed, closing the race entirely.
   */
  async startGame(roomId: string): Promise<void> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    roomState.room.status = RoomStatus.GAME_PHASE;
    roomState.room.currentPhaseRound = 1;
    roomState.readyPlayerIds.clear();
    // This game's fixed, random decision set — picked once here, never again for the
    // life of the game (see pickRandomDecisionSubset's doc comment).
    roomState.decisionSubset = this.pickRandomDecisionSubset();
    await this.syncRoomToDB(roomId);

    // Players land straight in the game room with real starting numbers — no blank
    // "waiting for game data" screen for the whole first round. See this method's doc
    // comment for why this must be awaited and broadcast before PHASE_CHANGED below.
    await this.broadcastInitialSnapshot(roomId, 1);

    this.startTimer(roomId, PHASE_TIMERS[RoomStatus.GAME_PHASE]);

    this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
      phase: RoomStatus.GAME_PHASE,
      round: 1,
      timeLimit: PHASE_TIMERS[RoomStatus.GAME_PHASE],
    });
    this.broadcastRoomState(roomId, ServerEvents.GAME_READY_UPDATE, {
      readyPlayerIds: [],
      activePlayerCount: Array.from(roomState.players.values()).filter((p) => !p.bankrupt).length,
    });

    // Send this game's fixed decision set + per-turn limits once — static for the whole
    // game, so the client can render the real Decision Deck immediately.
    this.broadcastRoomState(roomId, ServerEvents.GAME_DECK, {
      decisions: this.getRoomDeck(roomId),
      gameSettings: this.getGameConfigSnapshot().gameSettings,
    });
  }

  /**
   * One `KpiSnapshot` row per player per round — the source of the KPI history graphs
   * (every KPI card/breakdown line item is clickable; see CLAUDE.md's "KPI history +
   * prediction graphs" section). `upsert`, not `create` — idempotent against a
   * hypothetical double-call for the same round (nothing currently does this, but a
   * unique-constraint crash on a UI-triggered write path is worse than a harmless
   * overwrite). Never called for a bankrupted player's final round — they're excluded
   * from `outcome.result.players`/`getInitialSnapshot`'s output the same way
   * `companyUpdates` excludes them (see `BankruptedPlayer.finalCash`'s doc comment).
   * `resolveGameTurn`'s bankruptcy-persistence loop writes that final round's
   * `KpiSnapshot` separately, using `BankruptedPlayer.finalVariables`/`finalDerived`/
   * `finalRiskGauge` — see the comment there.
   */
  private async persistKpiSnapshots(players: PlayerTurnResult[], round: number): Promise<void> {
    for (const p of players) {
      try {
        await this.prisma.kpiSnapshot.upsert({
          where: { playerId_round: { playerId: p.playerId, round } },
          create: {
            playerId: p.playerId,
            round,
            variables: p.variables as unknown as Prisma.InputJsonValue,
            derived: p.derived as unknown as Prisma.InputJsonValue,
            riskGauge: p.riskGauge,
          },
          update: {
            variables: p.variables as unknown as Prisma.InputJsonValue,
            derived: p.derived as unknown as Prisma.InputJsonValue,
            riskGauge: p.riskGauge,
          },
        });
      } catch (err) {
        // Same isolation as resolveGameTurn's per-player persistence loops above — a
        // player's row disappearing mid-resolution (grace-period race) must not abort
        // KPI history for the rest of the room, nor the turn:resolved broadcast that
        // follows this call.
        console.error(`[persistKpiSnapshots] Failed to persist KPI snapshot for player ${p.playerId}, round ${round}:`, err);
        await logEvent(this.prisma, {
          eventType: 'error.persistence',
          severity: 'error',
          playerId: p.playerId,
          payload: { context: 'persistKpiSnapshots', round, message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  /**
   * Durable lawsuit-lifecycle log for the game-timeline replay/spectator feature — see
   * the `LegalCaseHistory` Prisma model's doc comment for why this has to exist at all
   * (a resolved `LegalCaseData` only survives one extra turn in `engineState.legalCases`
   * before `GameLoop`'s Step 7 prunes it from persisted state for good). `GameLoop`
   * itself never touches this table — it's pure, no I/O — so this reads every case
   * already present in this turn's broadcast result and upserts a history row per case,
   * exactly the same "GameLoop computes, GameEngine persists" split every other
   * turn-resolution write already follows.
   *
   * `players` (this turn's still-active players) and `bankrupted` (this turn's
   * eliminations) both need to contribute cases and names: a case can reference a
   * player bankrupted THIS exact turn, who's excluded from `players` — but per
   * `distributeCaseWaterfall`'s own doc comment, every case touching a player bankrupted
   * this turn is force-resolved the same turn, so a case can never reference a player
   * bankrupted in some earlier round while still appearing here.
   */
  private async persistLegalCaseHistory(players: PlayerTurnResult[], bankrupted: BankruptedPlayer[], round: number): Promise<void> {
    const casesById = new Map<string, LegalCaseData>();
    for (const p of players) {
      for (const c of p.legalCases) casesById.set(c.id, c);
    }
    if (casesById.size === 0) return;

    const nameById = new Map<string, string>();
    for (const p of players) nameById.set(p.playerId, p.playerName);
    for (const b of bankrupted) nameById.set(b.playerId, b.playerName);

    for (const c of casesById.values()) {
      try {
        await this.recordLegalCaseHistory(c, round, nameById);
      } catch (err) {
        console.error(`[persistLegalCaseHistory] Failed to persist history for case ${c.id}, round ${round}:`, err);
        await logEvent(this.prisma, {
          eventType: 'error.persistence',
          severity: 'error',
          roomId: c.roomId,
          payload: { context: 'persistLegalCaseHistory', caseId: c.id, round, message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  /**
   * Shared by `persistLegalCaseHistory` (the once-per-turn choke point) and
   * `acceptOffer` (the one out-of-band case action that can resolve a case outside
   * `resolveTurn` — `makeOffer` never changes status, `goToCourt` only ever reaches
   * `'awaiting_trial'`, neither is a loggable "filed/resolved" event on its own).
   *
   * `upsert` ensures the row exists (covers a case filed and immediately resolved the
   * same turn, e.g. by the bankruptcy waterfall) — `create` populates every field,
   * including `resolvedRound`/`verdict` if already resolved at first sight. The
   * separate, GUARDED `updateMany` below is what actually stamps a resolution: a
   * resolved case is still visible in the FOLLOWING turn's broadcast too (Step 7 only
   * drops it from persisted state starting the turn after that), so an unconditional
   * update here would silently overwrite `resolvedRound` to a later, wrong round the
   * next time the same already-resolved case is seen. `resolvedRound: null` in the
   * `where` clause is what prevents that.
   */
  private async recordLegalCaseHistory(c: LegalCaseData, round: number, nameById: Map<string, string>): Promise<void> {
    const resolvedAmount = this.resolvedCaseAmount(c);
    await this.prisma.legalCaseHistory.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        roomId: c.roomId,
        plaintiffId: c.plaintiffId,
        plaintiffName: nameById.get(c.plaintiffId) ?? 'Unknown',
        defendantId: c.defendantId,
        defendantName: nameById.get(c.defendantId) ?? 'Unknown',
        decisionName: c.decisionName,
        groundName: c.groundName,
        description: c.description,
        stakes: c.stakes,
        baseProbability: c.baseProbability,
        plaintiffFullyInvestigated: c.plaintiffFullyInvestigated,
        filedRound: round,
        resolvedRound: c.status === 'resolved' ? round : null,
        verdict: c.status === 'resolved' ? (c.verdict ?? null) : null,
        resolvedAmount: c.status === 'resolved' ? resolvedAmount : null,
      },
      update: {},
    });

    if (c.status === 'resolved') {
      await this.prisma.legalCaseHistory.updateMany({
        where: { id: c.id, resolvedRound: null },
        data: { resolvedRound: round, verdict: c.verdict ?? null, resolvedAmount },
      });
    }
  }

  /** The actual dollar amount that changed hands to resolve a case — `null` for
   * 'lost'/'cancelled' (no payment). Mirrors `GamePhase.tsx`'s own "Settled — you
   * received/paid X" News item math (`offers[offers.length-1]?.amount ?? stakes`) for a
   * settlement, since a negotiated amount can differ from the pre-trial `stakes`
   * estimate; a 'won' trial verdict uses `actualAmountPaid` (see `LegalCaseData.verdict`'s
   * own doc comment — a real, reported bug: the defendant's own cash might not have
   * covered the full `stakes`, in which case `GameLoop.resolveTurn`'s Step 9 caps the real
   * payment to whatever non-negative cash they actually had, and `actualAmountPaid` is
   * only set when that cap actually bit); 'waterfall_payout' uses `waterfallPayoutAmount`
   * (can also be less than `stakes` if the bankruptcy/merger waterfall pool ran out before
   * fully covering this case). Pulled out as its own helper so `recordLegalCaseHistory`'s
   * two write sites (the upsert's `create` and the resolution `updateMany`) can't drift on
   * how this is computed. */
  private resolvedCaseAmount(c: LegalCaseData): number | null {
    if (c.verdict === 'won') return c.actualAmountPaid ?? c.stakes;
    if (c.verdict === 'settled') return c.offers[c.offers.length - 1]?.amount ?? c.stakes;
    if (c.verdict === 'waterfall_payout') return c.waterfallPayoutAmount ?? c.stakes;
    return null;
  }

  /**
   * Full monitoring snapshot of every in-memory room — unlike `room:list` (Quick Play
   * discovery, WAITING-only, non-full rooms only), this is every room in every phase
   * with every player, for the admin portal (`GET /api/admin/rooms`). Synchronous,
   * in-memory only — no DB round trip, since `this.rooms` is already the live state.
   */
  getAdminRoomsSnapshot(): AdminRoomSnapshot[] {
    const snapshot: AdminRoomSnapshot[] = [];
    for (const roomState of this.rooms.values()) {
      snapshot.push({
        id: roomState.room.id,
        status: roomState.room.status,
        round: roomState.room.currentPhaseRound,
        maxPlayers: roomState.room.maxPlayers,
        createdAt: roomState.room.createdAt.toISOString(),
        players: Array.from(roomState.players.values()).map((p) => ({
          id: p.id,
          name: p.name,
          isHost: p.isHost,
          bankrupt: p.bankrupt,
          connected: !!p.socketId,
        })),
      });
    }
    return snapshot;
  }

  /** Current decision library, for `GET /api/admin/decisions` — same in-memory map GameLoop reads from. */
  getDecisionsSnapshot(): DecisionDefinition[] {
    return Array.from(this.decisionsByName.values());
  }

  /**
   * Picks one game's fixed, random decision set: `RANDOM_DECISION_COUNT` (48) decisions
   * drawn at random from the library, plus EVERY share-transaction decision, always
   * included regardless of the draw — the hostile-takeover mechanic (Buy/Sell Shares)
   * must never be left out by chance. Selects "always include" by `shareTransactionType`
   * presence, not by decision name — matches this codebase's standing rule against
   * hardcoded decision-name allowlists (see CLAUDE.md's `DEPRECIATING_ASSETS`/
   * `legalRiskConditions` history: a name-keyed check silently drifts the moment a
   * decision is renamed or a new one of the same kind is added via `/admin`), so a
   * future admin-added or renamed share-transaction decision is still always included
   * automatically. Called once, from `startGame` — the result is stored on
   * `RoomState.decisionSubset` and never recomputed for the life of that game.
   */
  private pickRandomDecisionSubset(): string[] {
    const all = Array.from(this.decisionsByName.values());
    const always = all.filter((d) => !!d.shareTransactionType);
    const pool = all.filter((d) => !d.shareTransactionType);

    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const picked = shuffled.slice(0, Math.min(this.RANDOM_DECISION_COUNT, shuffled.length));

    return [...always.map((d) => d.decision), ...picked.map((d) => d.decision)];
  }

  /**
   * This room's fixed decision set (see `pickRandomDecisionSubset`), resolved back into
   * full definitions — what `game:deck` actually sends, on both `startGame` and a
   * mid-game `rejoinRoom`. Everything downstream that reads "the decision library"
   * client-side (the Decision Deck, SUE THEM CHICKENS' whole-library ground catalog, Dig
   * Deeper's suggested-ground reveal) only ever sees decisions it received this way, so
   * scoping this one broadcast is what makes lawsuits/deploys implicitly follow the
   * room's assigned set — no separate client-side filtering needed. Falls back to the
   * full library when no subset has been picked yet (an empty/never-started room) —
   * defensive, not a real production path, since `startGame` always populates this
   * before `game:deck` is ever sent.
   */
  getRoomDeck(roomId: string): DecisionDefinition[] {
    const roomState = this.rooms.get(roomId);
    if (!roomState || roomState.decisionSubset.length === 0) return this.getDecisionsSnapshot();
    return roomState.decisionSubset
      .map((name) => this.decisionsByName.get(name))
      .filter((d): d is DecisionDefinition => !!d);
  }

  /** Current game config, for `GET /api/admin/config`. */
  getGameConfigSnapshot(): GameConfig {
    return this.gameConfig;
  }

  /**
   * Create or update one decision — `isNew` picks which; the caller (the
   * `POST`/`PUT /api/admin/decisions` routes) already knows which one it's doing
   * from the HTTP verb. Writes the DB row, then live-reloads `GameLoop`'s in-memory
   * decision map so the change takes effect on the very next turn resolved, no
   * restart needed.
   */
  async upsertDecision(
    def: DecisionDefinition,
    isNew: boolean,
  ): Promise<{ success: boolean; reason?: 'already_exists' | 'not_found' }> {
    const exists = this.decisionsByName.has(def.decision);
    if (isNew && exists) return { success: false, reason: 'already_exists' };
    if (!isNew && !exists) return { success: false, reason: 'not_found' };

    await this.prisma.decision.upsert({
      where: { name: def.decision },
      create: { name: def.decision, data: def as unknown as Prisma.InputJsonValue },
      update: { data: def as unknown as Prisma.InputJsonValue },
    });
    this.decisionsByName.set(def.decision, def);
    this.gameLoop.loadDecisions(Array.from(this.decisionsByName.values()));
    return { success: true };
  }

  /**
   * Delete a decision — blocked if it's currently deployed in any active (non-
   * bankrupt) player's `engineState.activeDecisions` anywhere. Several places in
   * `GameLoop.resolveTurn`'s hot path dereference a decision instance's `.definition`
   * without a null check, so removing a definition still in use would crash the next
   * turn resolution for whoever has it deployed — this check is the safety net for
   * that, not a nice-to-have.
   */
  async deleteDecision(name: string): Promise<{ success: boolean; reason?: 'not_found' | 'in_use' }> {
    if (!this.decisionsByName.has(name)) return { success: false, reason: 'not_found' };
    if (await this.isDecisionInUse(name)) return { success: false, reason: 'in_use' };

    await this.prisma.decision.delete({ where: { name } });
    this.decisionsByName.delete(name);
    this.gameLoop.loadDecisions(Array.from(this.decisionsByName.values()));
    return { success: true };
  }

  /** Write the new config to the DB, then live-reload GameLoop's in-memory copy. */
  async updateGameConfigData(config: GameConfig): Promise<void> {
    await this.prisma.gameConfigRow.update({
      where: { id: 1 },
      data: {
        gameSettings: config.gameSettings as unknown as Prisma.InputJsonValue,
        playerStartingValues: config.playerStartingValues as unknown as Prisma.InputJsonValue,
        adminVariables: config.adminVariables as unknown as Prisma.InputJsonValue,
      },
    });
    this.gameConfig = config;
    this.gameLoop.updateConfig(config);
  }

  /** Whether any non-bankrupt player, in any room, currently has this decision deployed. */
  private async isDecisionInUse(name: string): Promise<boolean> {
    const companies = await this.prisma.company.findMany({
      where: { player: { bankrupt: false } },
      select: { engineState: true },
    });
    return companies.some((c) => {
      const activeDecisions = (c.engineState as { activeDecisions?: PersistedDecisionInstance[] } | null)?.activeDecisions ?? [];
      return activeDecisions.some((d) => d.definitionName === name);
    });
  }

  /** Load every non-bankrupt player + company row GameLoop needs to resolve/preview a turn. */
  private async loadActiveCompanyPlayers(roomId: string) {
    return this.prisma.player.findMany({
      where: { roomId, bankrupt: false },
      include: { company: true },
    });
  }

  /**
   * Best-effort "what was each of this room's players' revenue, last time it was
   * computed" — `GameLoop` never persists `revenue` onto `Company.variables` (it's a
   * derived P&L figure, only ever materialized fresh into a turn's own local `plMap`
   * inside `resolveTurn` — see gameLoop.ts's Step 8 stakes-calculation note), so an
   * out-of-band action with no live turn in progress (`digDeeper`) has no other source
   * for it. Reads the latest `KpiSnapshot` row per player instead (`distinct: ['playerId']`
   * combined with `orderBy: { round: 'desc' }` gets Prisma to return exactly the newest
   * row per player). A real, reported bug this fixes: without it, `revealAttack`'s
   * `pickAllGrounds` call fell back to 0 for any relative-type legal-risk ground
   * targeting revenue (17 of the 25 in the real library), showing a flatly wrong "$0"
   * stakes on the Dig Deeper reveal for those. Approximate (last-turn's figure, not
   * "right now") — same "can't afford a live recomputation out-of-band" tradeoff as
   * everywhere else in this codebase a non-turn-cycle action needs a P&L-derived number.
   */
  private async latestKnownRevenueByPlayer(roomId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.kpiSnapshot.findMany({
      where: { player: { roomId } },
      orderBy: { round: 'desc' },
      distinct: ['playerId'],
    });
    const map = new Map<string, number>();
    for (const r of rows) {
      const revenue = (r.derived as { revenue?: number } | null)?.revenue;
      if (typeof revenue === 'number') map.set(r.playerId, revenue);
    }
    return map;
  }

  /**
   * Periodically clean up rooms where all players have disconnected (crash recovery),
   * and finalize the removal of any player whose reconnect grace period has expired
   * without them coming back via `room:rejoin`.
   */
  private startHeartbeatCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [roomId, lastActivity] of this.roomLastActivity.entries()) {
        if (now - lastActivity > this.STALE_ROOM_THRESHOLD) {
          const roomState = this.rooms.get(roomId);
          // Eliminated (bankrupt) players are exempt from finalizePlayerRemoval below —
          // their Player/Company rows (and KpiSnapshot history) are kept for the rest of
          // the room's life so a game-timeline replay/spectator view never loses their
          // data just because they closed their tab. That means `players.size === 0`
          // alone can no longer detect "everyone's actually gone" once a room has ever
          // had an elimination — a room can sit with only eliminated players' (never-
          // removed) entries forever.
          //
          // Fix: a room is stale once every REMAINING entry is both eliminated AND
          // currently disconnected — `p.bankrupt && !p.socketId`, not just `!p.socketId`
          // alone. Checking `!p.socketId` alone would be wrong: a still-active,
          // non-bankrupt player who's merely mid-reconnect-grace-period also has
          // `socketId: null` for up to RECONNECT_GRACE_PERIOD_MS, and this stale-room
          // check must never race ahead of that grace period / finalizePlayerRemoval
          // below and tear the whole room down first (a real regression caught by
          // gameEngine.test.ts's existing single-disconnected-player finalization test).
          // Requiring `p.bankrupt` too means an active player's temporary disconnect
          // never counts toward "stale," only a genuinely eliminated-and-gone spectator
          // does.
          //
          // A bot player is exempt from the bankrupt/disconnected requirement entirely —
          // it's never "bankrupt" just because it won (see `playersStillActive.length <=
          // 1` in gameLoop.ts), and it never has a socketId to begin with, so it would
          // otherwise never satisfy `p.bankrupt && !p.socketId` and a bot-only room (every
          // human already forfeited/disconnected/left) would sit forever. Treat any
          // remaining bot as automatically counting toward "everyone's actually gone."
          const allDisconnected = roomState
            ? roomState.players.size === 0 ||
              Array.from(roomState.players.values()).every((p) => p.isBot || (p.bankrupt && !p.socketId))
            : false;
          if (roomState && allDisconnected) {
            // Logged BEFORE the room row is deleted below — EventLog has no FK to Room
            // (see its own doc comment), but this keeps the event's payload sourced from
            // still-live in-memory state rather than a row that's about to be gone.
            logEvent(this.prisma, {
              eventType: 'room.stale_cleanup',
              roomId,
              payload: { playerCount: roomState.players.size, status: roomState.room.status, round: roomState.room.currentPhaseRound },
            }).catch(() => {});
            this.rooms.delete(roomId);
            this.roomLastActivity.delete(roomId);
            this.lastTurnResults.delete(roomId);
            this.botCashHistory.delete(roomId);
            // Also clean up from DB to prevent ghost rooms
            this.prisma.room.delete({ where: { id: roomId } }).catch((err: Prisma.PrismaClientKnownRequestError) => {
              if (err.code !== 'P2025') {
                console.error(`[Heartbeat] Failed to delete stale room ${roomId} from DB:`, err.message);
              }
            });
          }
        }
      }

      for (const [playerId, { roomId, disconnectedAt }] of this.disconnectedPlayers.entries()) {
        if (now - disconnectedAt > this.RECONNECT_GRACE_PERIOD_MS) {
          // A GAME_PHASE turn resolution for this same room may be in flight right now
          // (the round timer runs independently of this sweep, so the two can land at
          // almost the same moment) — see finalizePlayerRemoval's doc comment for why
          // deleting this player's DB rows out from under it is unsafe. Skip this player
          // for now and let the next 10s tick retry; `disconnectedPlayers` isn't touched,
          // so nothing about their grace period is lost, just delayed a few seconds.
          if (this.advancingRooms.has(roomId)) continue;
          // Eliminated players are exempt from removal entirely — there's no "coming
          // back" concept for someone who's already out of the game, and a game-timeline
          // replay/spectator view needs their data to survive regardless of how long
          // they stay disconnected (they can still room:rejoin whenever they like,
          // since their row is never deleted). Left in `disconnectedPlayers` forever is
          // harmless — this check just no-ops on every future tick instead of removing
          // them. Relies on the in-memory `bankrupt` flag being accurate, which
          // resolveGameTurn's bankruptcy loop and forfeitGame both now keep in sync.
          const player = this.rooms.get(roomId)?.players.get(playerId);
          if (player?.bankrupt) continue;
          this.finalizePlayerRemoval(roomId, playerId).catch((err) => {
            console.error(`[Heartbeat] Failed to finalize removal of player ${playerId}:`, err);
          });
        }
      }
    }, 10_000); // Check every 10 seconds
  }

  /** Update the last activity timestamp for a room. */
  private touchRoomActivity(roomId: string): void {
    this.roomLastActivity.set(roomId, Date.now());
  }

  /** Stop the heartbeat cleanup interval. */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }

  getPlayerRoom(socketId: string): string | undefined {
    return this.playerToRoom.get(socketId);
  }

  /**
   * Validates and broadcasts an in-room chat message from the given socket — usable in
   * every room phase (WAITING, GAME_PHASE, AFTERMATH), not just the lobby; the client
   * renders a chat surface throughout (Matchmaking.tsx's inline lobby box, GamePhase.tsx
   * / GameTimelineView.tsx's floating ChatWidget). Pulled out of the `chat:message`
   * handler into its own method so it's unit-testable the same way this class's other
   * socket-driven logic is (gameEngine.test.ts calls methods directly rather than
   * simulating raw Socket.IO events — see its own `sendChatMessage` describe block).
   *
   * Silently no-ops if the socket can't currently be resolved to a room/player — the
   * same "nothing to do" cases the handler always had (an already-disconnected socket,
   * a stale event, etc.); throws only for a genuinely invalid message payload, which the
   * `chat:message` handler catches and turns into an `error` emit back to just that
   * socket.
   */
  sendChatMessage(socketId: string, payload: unknown): void {
    const roomId = this.getPlayerRoom(socketId);
    if (!roomId) return;

    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    const sender = Array.from(roomState.players.values()).find((p) => p.socketId === socketId);
    if (!sender) return;

    const { message } = validateChatMessage(payload);
    this.broadcastRoomState(roomId, ServerEvents.CHAT_MESSAGE, {
      playerId: sender.id,
      playerName: sender.name,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * A socket must only ever be a Socket.IO room member of the ONE room `playerToRoom`
   * currently associates it with — otherwise it keeps receiving `io.to(oldRoomId).emit(...)`
   * broadcasts for a room it's no longer meant to be in. Call this right before
   * (re)pointing `playerToRoom` at a new room, in every path that can attach the same
   * socket to a different room: `createRoom`, `joinRoom`, `rejoinRoom`.
   *
   * This was a real, reproduced bug: `game:leave` (forfeit) marks a player bankrupt and
   * tells the client to return to the landing page, but — unlike `room:leave` (the
   * WAITING-lobby departure, which already calls `socket.leave(roomId)` at its own call
   * site) — never called `socket.leave` for the forfeited room, since the socket itself
   * stays fully connected and able to keep playing (a forfeited/bankrupted player can
   * choose to keep spectating that exact room — see the game-timeline feature — so
   * leaving the Socket.IO room the INSTANT they forfeit would break that). If that same
   * socket went on to create or join a SECOND room without ever reloading the page, it
   * remained subscribed to BOTH rooms' broadcasts — the moment the first (old) room's
   * game later concluded, its `game:over`/`player:bankrupt`/`phase:changed` broadcasts
   * landed on this socket too, silently overwriting whatever the second (current) game
   * was showing with the first game's stale winner/eliminated-player data. Guarding at
   * the point a socket newly attaches to a room (rather than at every place it might stop
   * belonging to one) closes this for every current and future such path in one place.
   */
  private leaveStaleSocketRoom(socketId: string, newRoomId: string): void {
    const oldRoomId = this.playerToRoom.get(socketId);
    if (!oldRoomId || oldRoomId === newRoomId) return;
    this.io.sockets.sockets.get(socketId)?.leave(oldRoomId);
  }

  async createRoom(player: Player): Promise<RoomState> {
    const roomId = crypto.randomUUID();

    // Use transaction for atomic room + player + company creation
    const room = await this.prisma.$transaction(async (tx) => {
      return tx.room.create({
        data: {
          id: roomId,
          status: RoomStatus.WAITING,
          maxPlayers: MAX_PLAYERS,
          players: {
            create: {
              name: player.name,
              isHost: true,
              socketId: player.socketId,
              company: {
                create: {
                  cash: 100000,
                },
              },
            },
          },
        },
        include: {
          players: { include: { company: true } },
        },
      });
    });

    const dbPlayer = room.players[0];
    const syncedPlayer: Player = {
      id: dbPlayer.id,
      name: dbPlayer.name,
      roomId: room.id,
      isHost: dbPlayer.isHost ?? false,
      bankrupt: dbPlayer.bankrupt,
      companyId: dbPlayer.companyId ?? undefined,
      socketId: dbPlayer.socketId ?? player.socketId,
      isBot: false,
    };

    const roomState: RoomState = {
      // Bridges the raw Prisma result (players: (Player & { company })[]) into the
      // app-level `Room` shape (players: Player[]) — safe because `roomState.room.players`
      // is never actually read; it's a frozen room-creation snapshot immediately made
      // stale by anything that joins/leaves/kicks afterward (see buildRoomSnapshot's own
      // doc comment, and CLAUDE.md's "Room.players array" section for why).
      room: room as unknown as Room,
      players: new Map([[dbPlayer.id, syncedPlayer]]),
      timer: null,
      timerValue: 0,
      readyPlayerIds: new Set(),
      kickedNames: new Set(),
      decisionSubset: [],
    };

    this.rooms.set(room.id, roomState);
    this.leaveStaleSocketRoom(player.socketId!, room.id);
    this.playerToRoom.set(player.socketId!, room.id);
    this.touchRoomActivity(room.id);
    this.scheduleBotJoinCheck(room.id);

    return roomState;
  }

  async joinRoom(roomId: string, player: Player): Promise<RoomState> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) {
      throw new Error('Room not found');
    }

    if (roomState.players.size >= roomState.room.maxPlayers) {
      throw new Error('Room is full');
    }

    if (roomState.kickedNames.has(player.name)) {
      throw new Error('You were removed from this room and cannot rejoin');
    }

    const existingPlayer = Array.from(roomState.players.values())
      .find((p: Player) => p.name === player.name);
    if (existingPlayer) {
      throw new Error('Player name already taken');
    }

    // Use transaction for atomic player + company creation
    const dbPlayer = await this.prisma.$transaction(async (tx) => {
      return tx.player.create({
        data: {
          name: player.name,
          roomId,
          isHost: false,
          socketId: player.socketId,
          company: {
            create: {
              cash: 100000,
            },
          },
        },
        include: { company: true },
      });
    });

    const syncedPlayer: Player = {
      id: dbPlayer.id,
      name: dbPlayer.name,
      roomId,
      isHost: dbPlayer.isHost ?? false,
      bankrupt: dbPlayer.bankrupt,
      companyId: dbPlayer.companyId ?? undefined,
      socketId: dbPlayer.socketId ?? player.socketId,
      isBot: false,
    };

    roomState.players.set(dbPlayer.id, syncedPlayer);
    this.leaveStaleSocketRoom(player.socketId!, roomId);
    this.playerToRoom.set(player.socketId!, roomId);
    this.touchRoomActivity(roomId);

    // A real human just joined — the bot that was standing in for a lack of an
    // opponent has no reason to stay (see addBotPlayer's own doc comment). Always
    // removed, regardless of remaining room capacity — the bot only ever exists to
    // fill a genuine absence of a human opponent.
    await this.removeBotPlayers(roomState);

    return roomState;
  }

  /**
   * (Re)schedules the "nobody's joined this public room yet, send in a bot" check for
   * `roomId`, clearing any previously-scheduled one first. Fired 10s after a room first
   * has exactly one (human) player in it — from `createRoom`, and again from `leaveRoom`
   * whenever a departure leaves exactly one human alone in a still-WAITING room (e.g. a
   * 2nd player joined and then left again, or the host kicked the bot).
   *
   * Deliberately re-checks every condition at fire time rather than trusting the state
   * at schedule time — a room that filled up, started, went invite-only, or disappeared
   * in the meantime just silently no-ops, so no separate cancel-on-every-other-path logic
   * is needed.
   */
  public scheduleBotJoinCheck(roomId: string): void {
    const existing = this.botJoinTimers.get(roomId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.botJoinTimers.delete(roomId);
      const roomState = this.rooms.get(roomId);
      if (!roomState) return;
      if (roomState.room.status !== RoomStatus.WAITING) return;
      if (roomState.room.inviteOnly) return;
      if (!this.gameConfig?.gameSettings.enableBotPlayers) return;
      const players = Array.from(roomState.players.values());
      if (players.length !== 1 || players[0].isBot) return;

      this.addBotPlayer(roomId).catch((err) => {
        console.error(`[Bot] Failed to add bot player to room ${roomId}:`, err);
      });
    }, this.BOT_JOIN_DELAY_MS);

    this.botJoinTimers.set(roomId, timer);
  }

  private clearBotJoinCheck(roomId: string): void {
    const existing = this.botJoinTimers.get(roomId);
    if (existing) {
      clearTimeout(existing);
      this.botJoinTimers.delete(roomId);
    }
  }

  /**
   * Adds a server-injected AI opponent to a room that's been sitting with a lone human
   * player — same DB shape `joinRoom` creates (Player + Company via one transaction),
   * just with `isBot: true`, `socketId: null` (a bot has no real Socket.IO connection —
   * never touches `playerToRoom`/`leaveStaleSocketRoom`), and a randomly-picked, always
   * clearly-bot-flavored name (see BOT_NAMES). Removed the instant a real human joins
   * the room (see `joinRoom`'s `removeBotPlayers` call) — the bot only exists to fill a
   * genuine absence of a human opponent, never to occupy a seat a human might want.
   */
  private async addBotPlayer(roomId: string): Promise<void> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    const name = this.BOT_NAMES[Math.floor(Math.random() * this.BOT_NAMES.length)];

    const dbPlayer = await this.prisma.$transaction(async (tx) => {
      return tx.player.create({
        data: {
          name,
          roomId,
          isHost: false,
          isBot: true,
          socketId: null,
          company: { create: { cash: 100000 } },
        },
        include: { company: true },
      });
    });

    const syncedPlayer: Player = {
      id: dbPlayer.id,
      name: dbPlayer.name,
      roomId,
      isHost: false,
      bankrupt: false,
      companyId: dbPlayer.companyId ?? undefined,
      socketId: null,
      isBot: true,
    };

    roomState.players.set(dbPlayer.id, syncedPlayer);
    this.touchRoomActivity(roomId);

    this.broadcastRoomState(roomId, ServerEvents.ROOM_UPDATED, { room: this.buildRoomSnapshot(roomState) });

    await logEvent(this.prisma, {
      eventType: 'player.bot_joined',
      roomId,
      playerId: dbPlayer.id,
      payload: { playerName: name },
    });
  }

  /** Removes every bot player currently in `roomState` (DB-delete Company/Player rows +
   * in-memory map entry) — at most one in the current single-bot-only design, but written
   * generically. Used when a real human joins a room a bot is occupying. */
  private async removeBotPlayers(roomState: RoomState): Promise<void> {
    const bots = Array.from(roomState.players.values()).filter((p) => p.isBot);
    if (bots.length === 0) return;

    for (const bot of bots) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const company = await tx.company.findUnique({ where: { playerId: bot.id } });
          if (company) {
            await tx.asset.deleteMany({ where: { companyId: company.id } });
            await tx.company.delete({ where: { id: company.id } });
          }
          await tx.player.delete({ where: { id: bot.id } });
        });
      } catch (error) {
        console.error(`Failed to clean up bot player ${bot.id} from DB:`, error);
      }
      roomState.players.delete(bot.id);
    }
  }

  /**
   * A socket disconnected — network hiccup, back button, refresh, whatever. Don't
   * delete the player yet: just mark them as having no live connection and keep
   * them in `roomState.players` (their open decisions/lawsuits keep resolving
   * normally, exactly like an AFK player who didn't submit this turn). They get
   * `RECONNECT_GRACE_PERIOD_MS` to reconnect via `room:rejoin` before the heartbeat
   * sweep calls `finalizePlayerRemoval`. No DB write happens here at all.
   */
  async markPlayerDisconnected(socketId: string): Promise<void> {
    const roomId = this.playerToRoom.get(socketId);
    if (!roomId) return;

    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    // Find the player by socketId in the room
    const player = Array.from(roomState.players.values()).find(
      (p: Player) => p.socketId === socketId
    ) as Player | undefined;

    this.playerToRoom.delete(socketId);
    if (!player) return; // already removed (e.g. kicked just before this fired)

    player.socketId = null;
    this.disconnectedPlayers.set(player.id, { roomId, disconnectedAt: Date.now() });
    this.touchRoomActivity(roomId);

    await logEvent(this.prisma, {
      eventType: 'player.disconnected',
      roomId,
      playerId: player.id,
      payload: { playerName: player.name },
    });
  }

  /**
   * Actually remove a player who never reconnected within the grace period — same
   * DB cleanup `removePlayer` always did, just deferred and keyed by `playerId`
   * (their old `socketId` is long dead by the time this runs). Broadcasts
   * `ROOM_PLAYER_LEFT` so the rest of the room learns they're actually gone.
   */
  private async finalizePlayerRemoval(roomId: string, playerId: string): Promise<void> {
    this.disconnectedPlayers.delete(playerId);

    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    const player = roomState.players.get(playerId);
    if (!player) return;

    // Clean up database records atomically using transaction
    try {
      await this.prisma.$transaction(async (tx) => {
        const company = await tx.company.findUnique({
          where: { playerId },
        });
        if (company) {
          await tx.asset.deleteMany({
            where: { companyId: company.id },
          });
          await tx.company.delete({
            where: { id: company.id },
          });
        }

        await tx.player.delete({
          where: { id: playerId },
        });
      });
    } catch (error) {
      console.error(`Failed to clean up player ${playerId} from DB:`, error);
      await logEvent(this.prisma, {
        eventType: 'error.persistence',
        severity: 'error',
        roomId,
        playerId,
        payload: { context: 'finalizePlayerRemoval', message: error instanceof Error ? error.message : String(error) },
      });
    }

    roomState.players.delete(playerId);
    this.touchRoomActivity(roomId);

    this.io.to(roomId).emit(ServerEvents.ROOM_PLAYER_LEFT, {
      playerId,
      playerName: player.name,
      roomId,
    });

    if (roomState.players.size === 0) {
      this.clearBotJoinCheck(roomId);
      this.rooms.delete(roomId);
      this.lastTurnResults.delete(roomId);
      this.botCashHistory.delete(roomId);
      // Also clean up the room from the database to prevent ghost rooms
      // from appearing in quick join queries
      try {
        await this.prisma.room.delete({
          where: { id: roomId },
        });
      } catch (error) {
        console.error(`Failed to clean up room ${roomId} from DB:`, error);
      }
    } else {
      // The player whose grace period just expired might have been the host.
      await this.promoteNewHostIfNeeded(roomState);
      this.broadcastRoomState(roomId, ServerEvents.ROOM_UPDATED, { room: this.buildRoomSnapshot(roomState) });

      // Same "back down to exactly one human, still WAITING" rescheduling leaveRoom does
      // — this path can just as easily be the one that gets a lobby down to one player
      // (e.g. a 2nd joiner's tab crashed before they ever clicked anything else).
      const remaining = Array.from(roomState.players.values());
      if (roomState.room.status === RoomStatus.WAITING && remaining.length === 1 && !remaining[0].isBot) {
        this.scheduleBotJoinCheck(roomId);
      }
    }
  }

  async advancePhase(roomId: string): Promise<void> {
    // Mutex: skip if already advancing this room (prevents concurrent phase transitions)
    if (this.advancingRooms.has(roomId)) return;
    this.advancingRooms.add(roomId);

    try {
      const roomState = this.rooms.get(roomId);
      if (!roomState) return;

      const currentIdx = PHASE_ORDER.indexOf(roomState.room.status);
      const nextIdx = currentIdx + 1;

      if (nextIdx >= PHASE_ORDER.length) {
        // Already at the last phase — nothing further to advance to.
        return;
      }

      const nextPhase = PHASE_ORDER[nextIdx];

      // Persist phase change to database BEFORE mutating in-memory state
      // This prevents inconsistency if DB write fails
      await this.syncRoomToDB(roomId);

      // Now mutate in-memory state (safe - DB is already consistent)
      roomState.room.status = nextPhase;

      // Start timer if applicable
      this.clearTimer(roomId);
      this.startTimer(roomId, PHASE_TIMERS[nextPhase]);

      // Broadcast phase change
      this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
        phase: nextPhase,
        round: roomState.room.currentPhaseRound,
        timeLimit: PHASE_TIMERS[nextPhase],
      });
    } catch (error) {
      console.error(`Failed to advance phase for room ${roomId}:`, error);
      throw error;
    } finally {
      // Always release the lock, even on error
      this.advancingRooms.delete(roomId);
    }
  }

  /**
   * Resolve the current GAME_PHASE turn via GameLoop, then either loop into
   * another GAME_PHASE round or — once only one player remains — transition
   * to AFTERMATH. GAME_PHASE is not a single linear step in PHASE_ORDER; it
   * repeats every `turnDurationSeconds` until the game is over.
   */
  async resolveGameTurn(roomId: string): Promise<void> {
    if (this.advancingRooms.has(roomId)) return;
    this.advancingRooms.add(roomId);
    const wallStart = Date.now();

    try {
      const roomState = this.rooms.get(roomId);
      if (!roomState) return;

      const round = roomState.room.currentPhaseRound;
      const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
      const outcome = this.gameLoop.resolveTurn(roomId, round, dbPlayers);

      // Persist bankruptcies first (matches GameLoop's original in-loop ordering),
      // then still-active players' updated engine state, then broadcast the turn.
      //
      // Each player's persistence is isolated in its own try/catch: a player's Company/
      // Player rows can vanish out from under this loop if they disconnected and their
      // reconnect grace period happened to expire mid-resolution — the heartbeat sweep
      // now skips finalizing a removal while this room is already resolving (see
      // startHeartbeatCleanup), but that only closes the common direction of the race,
      // not every possible one, so this loop stays defensive regardless. Without this,
      // a single missing row throws (Prisma P2025), aborts the whole loop, and the
      // outer catch swallows it — meaning `turn:resolved`/`phase:changed` never fire at
      // all and the room is left with no running timer, stuck until every client
      // manually refreshes. One player's missing row must never take the rest of the
      // room down with it.
      for (const bankrupted of outcome.bankruptedPlayers) {
        try {
          // Reused for BOTH elimination reasons (bankruptcy and merger takeover) —
          // there's no separate "merged" flag in the schema, and `bankrupt`
          // already means exactly what's needed everywhere else it's read (e.g.
          // `loadActiveCompanyPlayers`'s `bankrupt: false` filter). `bankrupted.reason`
          // (broadcast below) is what lets the client tell the two apart.
          await this.prisma.player.update({
            where: { id: bankrupted.playerId },
            data: { bankrupt: true, eliminatedRound: round },
          });
          // Eliminated players (either reason) are deliberately excluded from
          // outcome.companyUpdates (see BankruptedPlayer.finalCash doc comment) — their
          // final cash has to be persisted here instead, or the DB (and anything reading
          // it later, e.g. buildGameOverPayload's final-standings cash column) keeps
          // showing their last still-active balance. The acquirer's own inherited
          // cash/assets/intangibleAssets (merger only) are already reflected in their
          // OWN normal companyUpdates entry — no separate persistence needed for them.
          await this.prisma.company.update({
            where: { playerId: bankrupted.playerId },
            data: { cash: bankrupted.finalCash },
          });
          // One final KpiSnapshot capturing this player's true end-of-game numbers —
          // persistKpiSnapshots (below) only ever runs against outcome.result.players,
          // which excludes eliminated players the same way companyUpdates does, so
          // without this their KPI history would simply stop one round early, missing
          // the actual round they went bankrupt/were acquired in. GameLoop computes
          // these values (finalVariables/finalDerived/finalRiskGauge) the same way it
          // computes them for any still-active player, just also captured here before
          // the player's engine state is discarded — see BankruptedPlayer's doc comment.
          await this.prisma.kpiSnapshot.upsert({
            where: { playerId_round: { playerId: bankrupted.playerId, round } },
            create: {
              playerId: bankrupted.playerId,
              round,
              variables: bankrupted.finalVariables as unknown as Prisma.InputJsonValue,
              derived: bankrupted.finalDerived as unknown as Prisma.InputJsonValue,
              riskGauge: bankrupted.finalRiskGauge,
            },
            update: {
              variables: bankrupted.finalVariables as unknown as Prisma.InputJsonValue,
              derived: bankrupted.finalDerived as unknown as Prisma.InputJsonValue,
              riskGauge: bankrupted.finalRiskGauge,
            },
          });
        } catch (err) {
          console.error(`[resolveGameTurn] Failed to persist elimination for player ${bankrupted.playerId} (room ${roomId}):`, err);
          await logEvent(this.prisma, {
            eventType: 'error.persistence',
            severity: 'error',
            roomId,
            playerId: bankrupted.playerId,
            payload: { context: 'resolveGameTurn:bankruptcy', round, message: err instanceof Error ? err.message : String(err) },
          });
        }
        // Keep the in-memory roster's bankrupt flag in sync too — forfeitGame already
        // does this for a voluntary forfeit, but this natural-elimination path (covers
        // both bankruptcy and merger) previously only wrote the DB row, leaving
        // roomState.players' own copy stale. Anything reading "is this player
        // eliminated" from the live roster (e.g. the heartbeat sweep's disconnect-
        // cleanup exemption) depends on this being accurate.
        const liveEntry = roomState.players.get(bankrupted.playerId);
        if (liveEntry) {
          liveEntry.bankrupt = true;
          liveEntry.eliminatedRound = round;
        }
        this.io.to(roomId).emit(ServerEvents.PLAYER_BANKRUPT, {
          playerId: bankrupted.playerId,
          playerName: bankrupted.playerName,
          reason: bankrupted.reason,
          acquirerId: bankrupted.acquirerId,
          acquirerName: bankrupted.acquirerName,
        });
        // See CLAUDE.md's Analytics section — one event per elimination, any reason,
        // is the source for the admin portal's "how do games actually end" breakdown.
        await logEvent(this.prisma, {
          eventType: 'player.eliminated',
          roomId,
          playerId: bankrupted.playerId,
          payload: {
            playerName: bankrupted.playerName,
            reason: bankrupted.reason,
            round,
            finalCash: bankrupted.finalCash,
            acquirerId: bankrupted.acquirerId,
            acquirerName: bankrupted.acquirerName,
          },
        });
      }

      for (const update of outcome.companyUpdates) {
        try {
          await this.prisma.company.update({
            where: { playerId: update.playerId },
            data: {
              cash: update.cash,
              variables: update.variables as unknown as Prisma.InputJsonValue,
              engineState: update.engineState as unknown as Prisma.InputJsonValue,
            },
          });
        } catch (err) {
          console.error(`[resolveGameTurn] Failed to persist company update for player ${update.playerId} (room ${roomId}):`, err);
          await logEvent(this.prisma, {
            eventType: 'error.persistence',
            severity: 'error',
            roomId,
            playerId: update.playerId,
            payload: { context: 'resolveGameTurn:companyUpdate', round, message: err instanceof Error ? err.message : String(err) },
          });
        }
      }

      // POST-turn engine state (companyUpdates), not the pre-turn dbPlayers loaded above —
      // see enrichIncomingAttackBlurbs's doc comment for why.
      const activeDecisionsByPlayer = new Map(outcome.companyUpdates.map((u) => [u.playerId, u.engineState.activeDecisions]));
      await this.enrichIncomingAttackBlurbs(outcome.result.players, activeDecisionsByPlayer, roomId);

      await this.persistKpiSnapshots(outcome.result.players, round);
      await this.persistLegalCaseHistory(outcome.result.players, outcome.bankruptedPlayers, round);

      this.lastTurnResults.set(roomId, outcome.result);
      this.io.to(roomId).emit(ServerEvents.TURN_RESOLVED, outcome.result);

      // Analytics/bug-tracing telemetry (admin portal Analytics tab) — see CLAUDE.md's
      // EventLog section. `outcome.decisionEvents` is what makes a repeat of the
      // "canDeploy silently dropped a decision for the rest of the game" bug class
      // visible without a manual repro: every rejection's real reason is logged, not
      // just silently `continue`d past the way the player-facing behavior always has.
      await logEvents(this.prisma, outcome.decisionEvents.map((e) => ({
        eventType: e.outcome === 'deployed' ? 'decision.deployed' as const : 'decision.rejected' as const,
        roomId,
        playerId: e.playerId,
        payload: { bucket: e.bucket, decisionName: e.decisionName, targetId: e.targetId, reason: e.reason, round },
      })));

      const lawsuitCaseIds = new Set<string>();
      for (const p of outcome.result.players) for (const c of p.legalCases) lawsuitCaseIds.add(c.id);
      await logEvent(this.prisma, {
        eventType: 'turn.resolved',
        roomId,
        payload: {
          round,
          activePlayerCount: outcome.result.players.length,
          bankruptedCount: outcome.bankruptedPlayers.length,
          decisionsDeployed: outcome.decisionEvents.filter((e) => e.outcome === 'deployed').length,
          decisionsRejected: outcome.decisionEvents.filter((e) => e.outcome === 'rejected').length,
          openLawsuitCount: lawsuitCaseIds.size,
          computeDurationMs: outcome.durationMs,
          totalDurationMs: Date.now() - wallStart,
        },
      });

      const result = outcome.result;
      if (result.gameOver) {
        roomState.room.status = RoomStatus.AFTERMATH;
        await this.syncRoomToDB(roomId);

        const gameOverPayload = await this.buildGameOverPayload(roomId, result.winnerId);
        this.io.to(roomId).emit(ServerEvents.GAME_OVER, gameOverPayload);
        // Logged here, at the one moment a game actually just ended — NOT inside
        // buildGameOverPayload itself, which rejoinRoom also calls on every reconnect to
        // an already-finished room; logging there would double/triple-count one real
        // completion as one event per reconnect.
        await logEvent(this.prisma, {
          eventType: 'game.completed',
          roomId,
          playerId: gameOverPayload.winner.id,
          payload: {
            winnerName: gameOverPayload.winner.name,
            round,
            playerCount: gameOverPayload.finalStandings.length,
            endReason: 'natural',
          },
        });

        this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
          phase: RoomStatus.AFTERMATH,
          round: roomState.room.currentPhaseRound,
          timeLimit: PHASE_TIMERS[RoomStatus.AFTERMATH],
        });
        // No timer started here — AFTERMATH is terminal (last entry in PHASE_ORDER), so a
        // timer that ran here used to just broadcast pointless timer:update ticks for 30s
        // and then call a guaranteed-no-op advancePhase. See CLAUDE.md.
        return;
      }

      // Not over — loop into the next GAME_PHASE round. Ready status is per-round —
      // whoever was ready for the turn that just resolved doesn't stay "ready" for
      // the next one.
      roomState.room.currentPhaseRound = round + 1;
      await this.syncRoomToDB(roomId);
      roomState.readyPlayerIds.clear();
      this.io.to(roomId).emit(ServerEvents.GAME_READY_UPDATE, {
        readyPlayerIds: [],
        activePlayerCount: Array.from(roomState.players.values()).filter((p) => !p.bankrupt).length,
      });

      this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
        phase: RoomStatus.GAME_PHASE,
        round: roomState.room.currentPhaseRound,
        timeLimit: PHASE_TIMERS[RoomStatus.GAME_PHASE],
      });
      this.startTimer(roomId, PHASE_TIMERS[RoomStatus.GAME_PHASE]);
      // Fire-and-forget — a bot "thinking" must never hold up this turn's own
      // advancingRooms lock any longer than resolution itself already does.
      this.runBotTurnsForRoom(roomId);
    } catch (error) {
      console.error(`Failed to resolve game turn for room ${roomId}:`, error);
      await logEvent(this.prisma, {
        eventType: 'error.persistence',
        severity: 'error',
        roomId,
        payload: {
          context: 'resolveGameTurn:outer',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack?.slice(0, 2000) : undefined,
        },
      });
    } finally {
      this.advancingRooms.delete(roomId);
      // A throw anywhere above used to leave the room with NO turn timer running at all,
      // because `startTimer` sits inside the `try` — so a single engine exception didn't
      // cost one turn, it silently froze the room forever (nothing would advance again
      // until some unrelated player action happened to re-trigger resolution). That is
      // exactly what a `TypeError` in the waterfall's FIFO sort did to a live game on
      // 2026-08-12; see `caseFiledAtMs` for the specific bug. Re-arming here in the
      // `finally` degrades any future engine throw to one skipped turn instead.
      //
      // Only re-arms when the room is genuinely still mid-game and no timer survived, so
      // this can never double-arm alongside the successful path's own `startTimer` above,
      // nor restart the clock on a room that just legitimately finished.
      // `startTimer`'s own tick clears `roomState.timer` before calling in here, so a
      // surviving non-null timer means the success path above already re-armed it.
      const roomState = this.rooms.get(roomId);
      if (roomState && roomState.room.status === RoomStatus.GAME_PHASE && !roomState.timer) {
        this.startTimer(roomId, PHASE_TIMERS[RoomStatus.GAME_PHASE]);
      }
    }
  }

  /**
   * Voluntary forfeit — the "Leave Game" button, GAME_PHASE only. Instantly marks the
   * requesting player bankrupt (same DB write + `player:bankrupt` broadcast shape as a
   * natural cash<0 elimination in `resolveGameTurn`) and, if that leaves at most one
   * active player, ends the game exactly like `resolveGameTurn`'s post-turn win check
   * does. Guarded by the same `advancingRooms` lock `resolveGameTurn` uses — both
   * mutate room/player state and must not interleave with an in-flight turn resolution.
   *
   * If the game continues, this player's ready flag (if any) no longer counts toward
   * "all active players ready" — `triggerImmediateResolution` tells the caller whether
   * removing it just satisfied that condition for everyone remaining. It's a flag, not
   * a direct `resolveGameTurn` call from in here, because this method still holds the
   * `advancingRooms` lock in its `finally` until it returns — calling back into
   * `resolveGameTurn` before that lock is released would just no-op.
   */
  async forfeitGame(roomId: string, playerId: string): Promise<{ success: boolean; reason?: string; triggerImmediateResolution?: boolean }> {
    if (this.advancingRooms.has(roomId)) {
      return { success: false, reason: 'turn_in_progress' };
    }
    this.advancingRooms.add(roomId);

    try {
      const roomState = this.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) {
        return { success: false, reason: 'not_in_game' };
      }

      const player = roomState.players.get(playerId);
      if (!player || player.bankrupt) {
        return { success: false, reason: 'not_active' };
      }

      const forfeitRound = roomState.room.currentPhaseRound;
      await this.syncPlayerToDB(playerId, { bankrupt: true, eliminatedRound: forfeitRound });
      player.bankrupt = true;
      player.eliminatedRound = forfeitRound;
      // `reason: 'forfeit'` is what lets every OTHER still-in-the-game player's
      // BankruptcyModal show "X chickened out" instead of the generic "gone bankrupt"
      // copy a natural cash<0 elimination gets — the forfeiting player's own screen
      // already distinguishes this correctly via the separate GAME_LEFT event (which
      // upgrades their own selfElimination reason to 'forfeit'); this is the same
      // distinction, just for the players watching it happen to someone else.
      this.io.to(roomId).emit(ServerEvents.PLAYER_BANKRUPT, {
        playerId: player.id,
        playerName: player.name,
        reason: 'forfeit',
      });
      await logEvent(this.prisma, {
        eventType: 'player.eliminated',
        roomId,
        playerId: player.id,
        payload: { playerName: player.name, reason: 'forfeit', round: forfeitRound },
      });

      const stillActive = await this.prisma.player.findMany({ where: { roomId, bankrupt: false } });
      if (stillActive.length <= 1) {
        this.clearTimer(roomId);
        roomState.room.status = RoomStatus.AFTERMATH;
        await this.syncRoomToDB(roomId);

        const gameOverPayload = await this.buildGameOverPayload(roomId, stillActive[0]?.id);
        this.io.to(roomId).emit(ServerEvents.GAME_OVER, gameOverPayload);
        // Same one-time-only placement rationale as resolveGameTurn's own game.completed
        // log — never inside buildGameOverPayload itself (see that comment).
        await logEvent(this.prisma, {
          eventType: 'game.completed',
          roomId,
          playerId: gameOverPayload.winner.id,
          payload: {
            winnerName: gameOverPayload.winner.name,
            round: roomState.room.currentPhaseRound,
            playerCount: gameOverPayload.finalStandings.length,
            endReason: 'forfeit',
          },
        });
        // getGameTimeline() reads winnerId from this same cache, normally kept current by
        // every resolveGameTurn call — a forfeit that itself ends the game never goes
        // through resolveGameTurn at all, so without this the cache stays stale (whatever
        // it last was, e.g. round 1's winnerId-less initial snapshot) and the finished-game
        // replay's win badge/art never appears for a forfeit-ended game specifically. A
        // real, reproduced gap — found while verifying the Game Over screen's new art.
        const existingCache = this.lastTurnResults.get(roomId);
        this.lastTurnResults.set(roomId, {
          round: existingCache?.round ?? roomState.room.currentPhaseRound,
          players: existingCache?.players ?? [],
          gameOver: true,
          winnerId: stillActive[0]?.id,
        });
        this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
          phase: RoomStatus.AFTERMATH,
          round: roomState.room.currentPhaseRound,
          timeLimit: PHASE_TIMERS[RoomStatus.AFTERMATH],
        });
        // No timer started here either — see the matching comment in resolveGameTurn.
        return { success: true };
      }

      roomState.readyPlayerIds.delete(playerId);
      const readyUpdate: GameReadyUpdateResponse = {
        readyPlayerIds: Array.from(roomState.readyPlayerIds),
        activePlayerCount: stillActive.length,
      };
      this.io.to(roomId).emit(ServerEvents.GAME_READY_UPDATE, readyUpdate);

      return {
        success: true,
        triggerImmediateResolution: readyUpdate.activePlayerCount > 0 && readyUpdate.readyPlayerIds.length >= readyUpdate.activePlayerCount,
      };
    } finally {
      this.advancingRooms.delete(roomId);
    }
  }

  /**
   * Toggle one player's ready status for the in-flight turn. Returns `null` if the
   * room/player isn't in a state where readiness is meaningful (not GAME_PHASE, unknown
   * player, already-bankrupt player) — the caller no-ops on `null` rather than erroring,
   * since a stale ready click racing a phase change isn't really invalid input.
   */
  toggleReady(roomId: string, playerId: string, ready: boolean): GameReadyUpdateResponse | null {
    const roomState = this.rooms.get(roomId);
    if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return null;

    const player = roomState.players.get(playerId);
    if (!player || player.bankrupt) return null;

    if (ready) {
      roomState.readyPlayerIds.add(playerId);
    } else {
      roomState.readyPlayerIds.delete(playerId);
    }

    return {
      readyPlayerIds: Array.from(roomState.readyPlayerIds),
      activePlayerCount: Array.from(roomState.players.values()).filter((p) => !p.bankrupt).length,
    };
  }

  /** Build the winner + ranked standings payload once only one player remains. */
  private async buildGameOverPayload(roomId: string, winnerId?: string): Promise<GameOverResponse> {
    const dbPlayers = await this.prisma.player.findMany({
      where: { roomId },
      include: { company: { include: { assets: true } } },
    });

    const toSharedPlayer = (p: (typeof dbPlayers)[number]): Player => ({
      id: p.id,
      name: p.name,
      roomId: p.roomId,
      isHost: p.isHost ?? false,
      bankrupt: p.bankrupt,
      eliminatedRound: p.eliminatedRound ?? undefined,
      companyId: p.companyId ?? undefined,
      socketId: p.socketId ?? null,
      isBot: p.isBot ?? false,
    });

    const toSharedCompany = (p: (typeof dbPlayers)[number]): Company | null =>
      p.company
        ? {
            id: p.company.id,
            playerId: p.company.playerId,
            cash: Number(p.company.cash),
            debt: Number(p.company.debt),
            assets: p.company.assets.map((a) => ({ id: a.id, companyId: a.companyId, type: a.type, value: Number(a.value) })),
          }
        : null;

    const standings: PlayerStanding[] = dbPlayers
      .sort((a, b) => Number(b.company?.cash ?? 0) - Number(a.company?.cash ?? 0))
      .map((p, index) => ({
        player: toSharedPlayer(p),
        company: toSharedCompany(p),
        rank: index + 1,
      }));

    const winnerDbPlayer = dbPlayers.find((p) => p.id === winnerId) ?? dbPlayers.find((p) => !p.bankrupt) ?? dbPlayers[0];

    return {
      winner: toSharedPlayer(winnerDbPlayer),
      finalStandings: standings,
    };
  }

  startTimer(roomId: string, seconds: number): void {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    roomState.timerValue = seconds;
    this.broadcastTimer(roomId, seconds);

    roomState.timer = setInterval(() => {
      roomState.timerValue--;
      this.broadcastTimer(roomId, roomState.timerValue);

      if (roomState.timerValue <= 0) {
        this.clearTimer(roomId);
        if (roomState.room.status === RoomStatus.GAME_PHASE) {
          this.resolveGameTurn(roomId).catch((error) => {
            console.error(`Turn resolution failed for room ${roomId}:`, error);
          });
        } else {
          this.advancePhase(roomId).catch((error) => {
            console.error(`Timer-triggered phase advance failed for room ${roomId}:`, error);
          });
        }
      }
    }, 1000);
  }

  clearTimer(roomId: string): void {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    if (roomState.timer) {
      clearInterval(roomState.timer);
      roomState.timer = null;
    }
  }

  async syncRoomToDB(roomId: string): Promise<void> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    await this.prisma.room.update({
      where: { id: roomId },
      data: {
        status: roomState.room.status,
        currentPhaseRound: roomState.room.currentPhaseRound,
      },
    });
  }

  async syncPlayerToDB(playerId: string, data: { isHost?: boolean; bankrupt?: boolean; eliminatedRound?: number }): Promise<void> {
    await this.prisma.player.update({
      where: { id: playerId },
      data,
    });
  }

  private broadcastTimer(roomId: string, timeLeft: number): void {
    this.io.to(roomId).emit(ServerEvents.TIMER_UPDATE, { timeLeft });
  }

  public broadcastRoomState(roomId: string, event: string, data: unknown): void {
    this.io.to(roomId).emit(event, data);
  }

  /**
   * Rebuilds a `Room` snapshot fresh from `roomState.players` every time — never read
   * `roomState.room.players` directly for anything sent to a client. It's only ever
   * populated once, at room creation (from the single founding player Prisma's
   * `room.create` returns), and nothing keeps it in sync as players join/leave/get
   * kicked/get promoted to host afterward — broadcasting it as-is was a real bug (the
   * "host shown as a plain player to someone else" report) fixed by routing every
   * roster-affecting broadcast through this method instead.
   */
  public buildRoomSnapshot(roomState: RoomState): Room {
    const allPlayers: Player[] = Array.from(roomState.players.values()).map((p: Player) => ({
      id: p.id,
      name: p.name,
      roomId: p.roomId,
      isHost: p.isHost,
      bankrupt: p.bankrupt,
      companyId: p.companyId ?? undefined,
      socketId: p.socketId ?? undefined,
      isBot: p.isBot ?? false,
    }));

    return {
      id: roomState.room.id,
      status: roomState.room.status,
      maxPlayers: roomState.room.maxPlayers,
      currentPhaseRound: roomState.room.currentPhaseRound,
      players: allPlayers,
      createdAt: roomState.room.createdAt,
      inviteOnly: roomState.room.inviteOnly,
    };
  }

  /** Builds the `room:joined` payload for one player — shared by the fresh-join and rejoin paths. */
  public buildRoomJoinedPayload(roomState: RoomState, player: Player): { room: Room; player: Player; companies: Company[] } {
    const fullRoom = this.buildRoomSnapshot(roomState);

    return {
      room: fullRoom,
      player: {
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        bankrupt: player.bankrupt,
        roomId: fullRoom.id,
      },
      companies: [],
    };
  }

  /**
   * Promote the earliest-remaining-joined player to host if the room currently has
   * none (the previous host was kicked, disconnected past the grace period, or left
   * voluntarily). No-ops if a host already exists or the room is now empty.
   * `roomState.players` is a `Map`, which iterates in insertion order, so the first
   * entry is genuinely the longest-tenured remaining player.
   */
  public async promoteNewHostIfNeeded(roomState: RoomState): Promise<void> {
    if (roomState.players.size === 0) return;
    const hasHost = Array.from(roomState.players.values()).some((p) => p.isHost);
    if (hasHost) return;

    // A bot must never become host — it has no client to exercise host-only actions
    // (Start Game, Kick, invite-only toggle) with.
    const candidates = Array.from(roomState.players.values()).filter((p) => !p.isBot);
    if (candidates.length === 0) return;

    const newHost = candidates[0];
    newHost.isHost = true;
    await this.prisma.player.update({ where: { id: newHost.id }, data: { isHost: true } });
  }

  /**
   * Voluntary departure from the WAITING-phase lobby — the "Leave Room" button.
   * Distinct from `forfeitGame` (GAME_PHASE's "Leave Game" forfeit): this actually
   * removes the player (DB row deleted, same cleanup as a kick) rather than marking
   * them bankrupt, since there's no game in progress to forfeit. Promotes a new host
   * if the leaver was one, and deletes the room outright if they were the last player
   * in it — mirroring `finalizePlayerRemoval`'s empty-room cleanup.
   */
  public async leaveRoom(roomId: string, playerId: string): Promise<{ success: boolean; reason?: string }> {
    const roomState = this.rooms.get(roomId);
    if (!roomState || roomState.room.status !== RoomStatus.WAITING) {
      return { success: false, reason: 'not_in_lobby' };
    }

    const player = roomState.players.get(playerId);
    if (!player) return { success: false, reason: 'not_found' };

    try {
      await this.prisma.$transaction(async (tx) => {
        const company = await tx.company.findUnique({ where: { playerId } });
        if (company) {
          await tx.asset.deleteMany({ where: { companyId: company.id } });
          await tx.company.delete({ where: { id: company.id } });
        }
        await tx.player.delete({ where: { id: playerId } });
      });
    } catch (error) {
      console.error(`Failed to clean up leaving player ${playerId} from DB:`, error);
      return { success: false, reason: 'db_error' };
    }

    roomState.players.delete(playerId);
    if (player.socketId) this.playerToRoom.delete(player.socketId);
    this.touchRoomActivity(roomId);

    const remaining = Array.from(roomState.players.values());
    // Nobody human left at all (either genuinely empty, or only the bot remains — a bot
    // can never start its own game, so a bot-only WAITING room is just as pointless as an
    // empty one). Tear down immediately rather than waiting on the heartbeat sweep, same
    // as the plain "everyone left" case this already handled.
    if (remaining.length === 0 || remaining.every((p) => p.isBot)) {
      this.clearBotJoinCheck(roomId);
      this.rooms.delete(roomId);
      this.lastTurnResults.delete(roomId);
      this.botCashHistory.delete(roomId);
      // Cascade-deletes any remaining bot's Player/Company rows too (see
      // schema.prisma's onDelete: Cascade) — no separate bot cleanup needed.
      try {
        await this.prisma.room.delete({ where: { id: roomId } });
      } catch (error) {
        console.error(`Failed to clean up room ${roomId} from DB:`, error);
      }
      return { success: true };
    }

    await this.promoteNewHostIfNeeded(roomState);
    this.broadcastRoomState(roomId, ServerEvents.ROOM_UPDATED, { room: this.buildRoomSnapshot(roomState) });

    // Back down to exactly one (human) player waiting alone — restart the "join a bot
    // after 10s" clock, the same as a freshly-created room (e.g. a 2nd player joined and
    // then left again, or the host just kicked the bot).
    if (remaining.length === 1 && !remaining[0].isBot) {
      this.scheduleBotJoinCheck(roomId);
    }

    return { success: true };
  }

  /**
   * Re-associate an existing player (previously disconnected, still within the
   * grace period) with a new socket. Returns everything the caller needs to emit —
   * this method does no Socket.IO I/O itself, matching the `digDeeper` pattern —
   * or `{ success: false }` if the room or player no longer exists (grace period
   * already expired, room cleaned up, or a stale/bogus session).
   */
  async rejoinRoom(roomId: string, playerId: string, socketId: string): Promise<
    | { success: false }
    | {
        success: true;
        roomJoined: { room: Room; player: Player; companies: Company[] };
        gameDeck?: { decisions: DecisionDefinition[]; gameSettings: GameSettings };
        turnResolved?: TurnResolutionResult;
        gameOver?: GameOverResponse;
      }
  > {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return { success: false };

    const player = roomState.players.get(playerId);
    if (!player) return { success: false };

    player.socketId = socketId;
    this.leaveStaleSocketRoom(socketId, roomId);
    this.playerToRoom.set(socketId, roomId);
    this.disconnectedPlayers.delete(playerId);
    this.touchRoomActivity(roomId);

    await logEvent(this.prisma, {
      eventType: 'player.reconnected',
      roomId,
      playerId,
      payload: { playerName: player.name },
    });

    const result: {
      success: true;
      roomJoined: { room: Room; player: Player; companies: Company[] };
      gameDeck?: { decisions: DecisionDefinition[]; gameSettings: GameSettings };
      turnResolved?: TurnResolutionResult;
      gameOver?: GameOverResponse;
    } = {
      success: true,
      roomJoined: this.buildRoomJoinedPayload(roomState, player),
    };

    if (roomState.room.status === RoomStatus.GAME_PHASE) {
      result.gameDeck = {
        decisions: this.getRoomDeck(roomId),
        gameSettings: this.gameConfig.gameSettings,
      };
      const lastTurn = this.lastTurnResults.get(roomId);
      if (lastTurn) result.turnResolved = lastTurn;
    } else if (roomState.room.status === RoomStatus.AFTERMATH) {
      result.gameOver = await this.buildGameOverPayload(roomId);
    }

    return result;
  }
}

export function setupSocketHandlers(io: Server, prisma: PrismaClient): GameEngine {
  const engine = new GameEngine(io, prisma);

  io.on('connection', (socket: Socket) => {
    // Matchmaking handlers
    socket.on(ClientEvents.ROOM_JOIN, async (payload: unknown) => {
      try {
        const validated = validateRoomJoin(payload);
        const player: Player = {
          id: '', // Will be set by DB
          name: validated.playerName,
          roomId: '',
          isHost: false,
          bankrupt: false,
          socketId: socket.id,
        };

        let roomState: RoomState | undefined;

        if (validated.searchForRoom) {
          // Search for an available room with less than MAX_PLAYERS — invite-only
          // rooms are never a Quick Play candidate.
          const availableRooms = await prisma.room.findMany({
            where: {
              status: RoomStatus.WAITING,
              inviteOnly: false,
            },
            orderBy: {
              players: { _count: 'asc' },
            },
            select: {
              id: true,
              _count: {
                select: { players: true },
              },
            },
          });

          for (const room of availableRooms) {
            if (room._count.players < MAX_PLAYERS && engine.rooms.has(room.id)) {
              try {
                roomState = await engine.joinRoom(room.id, player);
                break;
              } catch {
                // This specific room rejected the join — full by the time we got here,
                // this player's name was kicked from it, whatever. Quick Play means
                // "any room," so just try the next candidate rather than surfacing a
                // room-specific error; falls through to creating a new room if none work.
                continue;
              }
            }
          }

          if (!roomState) {
            // No room found or all rooms filled up, create a new one
            roomState = await engine.createRoom(player);
          }
        } else if (validated.roomName) {
          // Join existing room by ID
          const room = await prisma.room.findFirst({
            where: {
              id: validated.roomName,
              status: RoomStatus.WAITING,
            },
            include: { players: true },
          });

          if (!room) {
            socket.emit(ServerEvents.ERROR, {
              code: 'ROOM_NOT_FOUND',
              message: 'Room not found',
            });
            return;
          }

          roomState = await engine.joinRoom(room.id, player);
        } else {
          // Create new room
          roomState = await engine.createRoom(player);
        }

        if (!roomState) {
          socket.emit(ServerEvents.ERROR, {
            code: 'JOIN_FAILED',
            message: 'Failed to join or create a room',
          });
          return;
        }

        // Find the joining player by socketId (not just the first player in the map)
        const joiningPlayer = Array.from(roomState.players.values()).find(
          (p: Player) => p.socketId === socket.id,
        ) as Player | undefined;

        if (!joiningPlayer) {
          socket.emit(ServerEvents.ERROR, {
            code: 'JOIN_FAILED',
            message: 'Failed to locate player in room state',
          });
          return;
        }

        // Send room state to the joining player
        const roomJoinedPayload = engine.buildRoomJoinedPayload(roomState, joiningPlayer);
        socket.emit(ServerEvents.ROOM_JOINED, roomJoinedPayload);

        // Notify other players about the new player (exclude the joining player)
        socket.broadcast.to(roomState.room.id).emit(ServerEvents.ROOM_PLAYER_JOINED, {
          playerId: joiningPlayer.id,
          playerName: joiningPlayer.name,
          isHost: joiningPlayer.isHost,
          roomId: roomJoinedPayload.room.id,
        });

        // Join socket room
        socket.join(roomState.room.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attemptedName = (payload as { playerName?: string } | null)?.playerName ?? 'unknown';
        console.error(`Room join failed for ${attemptedName}:`, message);
        const codeByMessage: Record<string, string> = {
          'Player name already taken': 'NAME_TAKEN',
          'Room is full': 'ROOM_FULL',
          'Room not found': 'ROOM_NOT_FOUND',
          'You were removed from this room and cannot rejoin': 'KICKED_FROM_ROOM',
        };
        socket.emit(ServerEvents.ERROR, {
          code: codeByMessage[message] ?? 'JOIN_FAILED',
          message: message || 'Failed to join room',
        });
      }
    });

    // Resume an existing session (within the disconnect grace period) on a new socket —
    // e.g. after a page refresh, an accidental back button, or a brief network drop.
    socket.on(ClientEvents.ROOM_REJOIN, async (payload: unknown) => {
      try {
        const { roomId, playerId } = validateRoomRejoin(payload);
        const result = await engine.rejoinRoom(roomId, playerId, socket.id);

        if (!result.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'REJOIN_FAILED',
            message: 'This session no longer exists — it may have expired or the game may have ended.',
          });
          return;
        }

        socket.join(roomId);
        socket.emit(ServerEvents.ROOM_JOINED, result.roomJoined);
        if (result.gameDeck) socket.emit(ServerEvents.GAME_DECK, result.gameDeck);
        if (result.turnResolved) socket.emit(ServerEvents.TURN_RESOLVED, result.turnResolved);
        if (result.gameOver) socket.emit(ServerEvents.GAME_OVER, result.gameOver);
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'REJOIN_FAILED',
          message: error instanceof Error ? error.message : 'Failed to rejoin room',
        });
      }
    });

    // List available rooms (merge in-memory active rooms with DB rooms for consistency)
    socket.on(ClientEvents.ROOM_LIST, async () => {
      const availableRooms: RoomInfo[] = [];

      // Collect in-memory active rooms — invite-only rooms never appear here, same
      // as they're never a Quick Play candidate.
      for (const roomState of engine.rooms.values()) {
        if (
          roomState.room.status === RoomStatus.WAITING &&
          !roomState.room.inviteOnly &&
          roomState.players.size < roomState.room.maxPlayers
        ) {
          availableRooms.push({
            id: roomState.room.id,
            status: roomState.room.status,
            maxPlayers: roomState.room.maxPlayers,
            currentPhaseRound: roomState.room.currentPhaseRound,
            playerCount: roomState.players.size,
          });
        }
      }

      // Also query DB to surface rooms that exist but haven't been loaded in-memory yet
      // (e.g., after a server restart or if the room was created via quick-play)
      const dbRooms = await prisma.room.findMany({
        where: {
          status: RoomStatus.WAITING,
          inviteOnly: false,
        },
        include: {
          _count: {
            select: { players: true },
          },
        },
      });

      const inMemoryRoomIds = new Set(availableRooms.map((r) => r.id));

      for (const dbRoom of dbRooms) {
        // Skip rooms already in the in-memory list (they have accurate player counts)
        if (inMemoryRoomIds.has(dbRoom.id)) continue;

        // Only include rooms that are not full
        if (dbRoom._count.players < dbRoom.maxPlayers) {
          availableRooms.push({
            id: dbRoom.id,
            status: dbRoom.status as RoomStatus,
            maxPlayers: dbRoom.maxPlayers,
            currentPhaseRound: dbRoom.currentPhaseRound,
            playerCount: dbRoom._count.players,
          });
        }
      }

      socket.emit(ServerEvents.ROOMS_LISTED, { rooms: availableRooms });
    });

    // Kick player (host only)
    socket.on(ClientEvents.ROOM_KICK, async (payload: { playerId: string }) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState) return;

      // Find the host by socketId
      const host = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id
      );
      if (!host || !host.isHost) {
        socket.emit(ServerEvents.ERROR, {
          code: 'NOT_HOST',
          message: 'Only the host can kick players',
        });
        return;
      }

      // Host cannot kick themselves
      if (payload.playerId === host.id) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_KICK',
          message: 'Host cannot kick themselves',
        });
        return;
      }

      // Find the player to kick
      const playerToKick = roomState.players.get(payload.playerId);
      if (!playerToKick) return;

      const kickedSocketId = playerToKick.socketId;

      // FIX: Perform DB cleanup FIRST to ensure atomicity
      // If this fails, we keep the player in memory to prevent state corruption
      try {
        await prisma.$transaction(async (tx) => {
          const company = await tx.company.findUnique({
            where: { playerId: playerToKick.id },
          });
          if (company) {
            await tx.asset.deleteMany({
              where: { companyId: company.id },
            });
            await tx.company.delete({
              where: { id: company.id },
            });
          }

          await tx.player.delete({
            where: { id: playerToKick.id },
          });
        });
      } catch (error) {
        console.error(`Failed to clean up kicked player ${playerToKick.id} from DB:`, error);
        // Stop execution if DB cleanup fails to avoid inconsistent state
        return;
      }

      // Remove player from in-memory state ONLY after successful DB cleanup
      roomState.players.delete(playerToKick.id);
      // Blocks this name from rejoining the room (invite link or Quick Play) — see
      // RoomState.kickedNames' doc comment for the limits of this without real auth.
      roomState.kickedNames.add(playerToKick.name);

      // Notify all remaining players about the kick
      engine.broadcastRoomState(roomId, ServerEvents.ROOM_PLAYER_KICKED, {
        kickedPlayerId: playerToKick.id,
        kickedPlayerName: playerToKick.name,
      });
      await logEvent(prisma, {
        eventType: 'player.kicked',
        roomId,
        playerId: playerToKick.id,
        payload: { playerName: playerToKick.name, kickedBy: host.id },
      });

      // Disconnect the kicked player's socket if connected
      if (kickedSocketId) {
        const kickedSocket = io.sockets.sockets.get(kickedSocketId);
        if (kickedSocket) {
          kickedSocket.disconnect();
        }
      }

      // Refresh the roster for remaining players — never broadcast roomState.room
      // directly, its embedded `players` array is stale from room creation (see
      // buildRoomSnapshot's doc comment).
      await engine.promoteNewHostIfNeeded(roomState);
      engine.broadcastRoomState(roomId, ServerEvents.ROOM_UPDATED, { room: engine.buildRoomSnapshot(roomState) });

      // If the host just kicked the bot itself, they're alone again — restart the
      // "join a bot after 10s" clock (see leaveRoom's identical rescheduling).
      const remainingAfterKick = Array.from(roomState.players.values());
      if (roomState.room.status === RoomStatus.WAITING && remainingAfterKick.length === 1 && !remainingAfterKick[0].isBot) {
        engine.scheduleBotJoinCheck(roomId);
      }
    });

    // Voluntary departure from the WAITING-phase lobby — "Leave Room". Distinct from
    // game:leave's GAME_PHASE forfeit (that marks the player bankrupt; this actually
    // removes them, same as a kick, since there's no game in progress).
    socket.on(ClientEvents.ROOM_LEAVE, async () => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      const result = await engine.leaveRoom(roomId, player.id);
      if (!result.success) {
        socket.emit(ServerEvents.ERROR, {
          code: 'LEAVE_ROOM_FAILED',
          message: result.reason || 'Unable to leave the room right now',
        });
        return;
      }

      socket.leave(roomId);
      socket.emit(ServerEvents.ROOM_LEFT, null);
    });

    // Host toggles Quick Play / Available Rooms discoverability — a direct room-code
    // or invite-link join is never affected by this, only auto-matching is.
    socket.on(ClientEvents.ROOM_SET_INVITE_ONLY, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.WAITING) return;

      const host = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!host || !host.isHost) {
        socket.emit(ServerEvents.ERROR, {
          code: 'NOT_HOST',
          message: 'Only the host can change room visibility',
        });
        return;
      }

      let inviteOnly: boolean;
      try {
        ({ inviteOnly } = validateRoomSetInviteOnly(payload));
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_INVITE_ONLY',
          message: error instanceof Error ? error.message : 'Invalid invite-only payload',
        });
        return;
      }

      roomState.room.inviteOnly = inviteOnly;
      await prisma.room.update({ where: { id: roomId }, data: { inviteOnly } });
      engine.broadcastRoomState(roomId, ServerEvents.ROOM_UPDATED, { room: engine.buildRoomSnapshot(roomState) });
    });

    // Start game (host only)
    socket.on(ClientEvents.ROOM_START_GAME, async () => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState) return;

      // Find the host by socketId
      const host = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id
      );
      if (!host || !host.isHost) {
        socket.emit(ServerEvents.ERROR, {
          code: 'NOT_HOST',
          message: 'Only the host can start the game',
        });
        return;
      }

      // Only start from WAITING phase
      if (roomState.room.status !== RoomStatus.WAITING) return;

      // Need at least 2 players — the host can't sue/compete against themselves.
      // Client-side the Start Game button is already disabled for this case; this
      // is the server-authoritative enforcement of the same rule.
      if (roomState.players.size < 2) {
        socket.emit(ServerEvents.ERROR, {
          code: 'NOT_ENOUGH_PLAYERS',
          message: 'At least 2 players are required to start the game',
        });
        return;
      }

      // The actual state mutation + broadcast orchestration lives in GameEngine.startGame
      // — see its own doc comment for why the initial snapshot must broadcast before
      // PHASE_CHANGED.
      await engine.startGame(roomId);
    });

    // Submit strategic/operational decisions for the current GAME_PHASE turn
    socket.on(ClientEvents.GAME_SUBMIT_DECISIONS, (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const validated = validateSubmitDecisions(payload);
        engine.submitDecisions(roomId, player.id, validated);
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_DECISIONS',
          message: error instanceof Error ? error.message : 'Invalid decision submission',
        });
      }
    });

    // "Dig Deeper" — pay to reveal the next tier of intel on an incoming attack.
    // Instant, outside the turn-resolution cycle — result goes only to this socket.
    socket.on(ClientEvents.GAME_DIG_DEEPER, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { attackId } = validateDigDeeper(payload);
        const outcome = await engine.digDeeper(roomId, player.id, attackId);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'DIG_DEEPER_FAILED',
            message: outcome.reason,
          });
          return;
        }
        socket.emit(ServerEvents.GAME_DIG_DEEPER_RESULT, {
          attackId: outcome.attackId,
          cost: outcome.cost,
          newCash: outcome.newCash,
          attack: outcome.attack,
        });
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_DIG_DEEPER',
          message: error instanceof Error ? error.message : 'Invalid dig deeper request',
        });
      }
    });

    // Charge the flat lawsuit filing fee the instant a player files (SueModal's "File"
    // button) — instant, outside the turn-resolution cycle, result goes only to this
    // socket. The client still separately queues the same { targetId, decisionName,
    // groundName } entry via game:submitDecisions for the case itself.
    socket.on(ClientEvents.GAME_FILE_LAWSUIT, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        validateFileLawsuit(payload);
        const outcome = await engine.fileLawsuit(roomId, player.id);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'FILE_LAWSUIT_FAILED',
            message: outcome.reason,
          });
          return;
        }
        socket.emit(ServerEvents.GAME_FILE_LAWSUIT_RESULT, {
          cost: outcome.cost,
          newCash: outcome.newCash,
        });
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_FILE_LAWSUIT',
          message: error instanceof Error ? error.message : 'Invalid lawsuit filing request',
        });
      }
    });

    // Make (or counter) a settlement offer on a case still 'negotiating' — instant,
    // outside the turn-resolution cycle. On success, GameEngine.makeOffer already emits
    // game:legalCaseUpdate to both parties (including this socket) — nothing further to
    // send here. Only a failure needs an explicit response, to just this socket.
    socket.on(ClientEvents.GAME_MAKE_OFFER, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { caseId, amount } = validateMakeOffer(payload);
        const outcome = await engine.makeOffer(roomId, player.id, caseId, amount);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'MAKE_OFFER_FAILED',
            message: outcome.reason,
          });
        }
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_MAKE_OFFER_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid offer request',
        });
      }
    });

    // Accept the other party's most recent offer — settles the case immediately. Same
    // "success already broadcast, only failure needs a response" shape as game:makeOffer.
    socket.on(ClientEvents.GAME_ACCEPT_OFFER, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { caseId } = validateAcceptOffer(payload);
        const outcome = await engine.acceptOffer(roomId, player.id, caseId);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'ACCEPT_OFFER_FAILED',
            message: outcome.reason,
          });
        }
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_ACCEPT_OFFER_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid accept-offer request',
        });
      }
    });

    // End negotiation and send a case to trial — either party may call this at any time
    // while the case is negotiating. Same "success already broadcast, only failure needs
    // a response" shape as game:makeOffer.
    socket.on(ClientEvents.GAME_GO_TO_COURT, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { caseId } = validateGoToCourt(payload);
        const outcome = await engine.goToCourt(roomId, player.id, caseId);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'GO_TO_COURT_FAILED',
            message: outcome.reason,
          });
        }
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_GO_TO_COURT_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid go-to-court request',
        });
      }
    });

    // Defendant pays to reveal the probability of success on a case — instant, outside
    // the turn-resolution cycle. Same "success already broadcast via game:legalCaseUpdate,
    // only failure needs a response" shape as game:makeOffer.
    socket.on(ClientEvents.GAME_DIG_DEEPER_CASE, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { caseId } = validateDigDeeperCase(payload);
        const outcome = await engine.digDeeperOnCase(roomId, player.id, caseId);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'DIG_DEEPER_CASE_FAILED',
            message: outcome.reason,
          });
        }
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_DIG_DEEPER_CASE_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid dig-deeper-on-case request',
        });
      }
    });

    // Request AI-narrated "annual report" text for one rival — on demand (opened from
    // the Full Filing modal), outside the turn-resolution cycle, result goes only to
    // this socket. Never blocks/broadcasts anything else in the room.
    socket.on(ClientEvents.GAME_GET_ANNUAL_REPORT, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { rivalPlayerId } = validateAnnualReportRequest(payload);
        const entries = await engine.getAnnualReport(roomId, rivalPlayerId);
        if (!entries) {
          socket.emit(ServerEvents.ERROR, {
            code: 'ANNUAL_REPORT_FAILED',
            message: 'Rival not found',
          });
          return;
        }
        socket.emit(ServerEvents.GAME_ANNUAL_REPORT_RESULT, { rivalPlayerId, entries });
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_ANNUAL_REPORT_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid annual report request',
        });
      }
    });

    // Request KPI history — either this player's own (+ 3-turn prediction) or a rival's
    // (history only) — on demand (opened by clicking any KPI card or breakdown line item
    // in GamePhase.tsx), outside the turn-resolution cycle. Result goes only to this
    // socket, never broadcast.
    socket.on(ClientEvents.GAME_GET_KPI_HISTORY, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { targetPlayerId } = validateKpiHistoryRequest(payload);
        const isSelf = !targetPlayerId || targetPlayerId === player.id;
        const response = await engine.getKpiHistory(roomId, isSelf ? player.id : targetPlayerId, isSelf);
        if (!response) return;
        socket.emit(ServerEvents.GAME_KPI_HISTORY_RESULT, response);
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_KPI_HISTORY_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid KPI history request',
        });
      }
    });

    // Request the whole room's game-timeline replay/spectator data — no payload, unlike
    // every other on-demand request (this always returns everyone's data, there's no
    // per-target to select). Deliberately allowed in BOTH GAME_PHASE (an eliminated
    // player who chose to keep watching) and AFTERMATH (the finished-game replay) — every
    // other on-demand handler above only allows GAME_PHASE, this one doesn't gate on
    // phase at all beyond "not WAITING" (there's nothing to replay before a game starts).
    // Result goes only to this socket, never broadcast.
    socket.on(ClientEvents.GAME_GET_GAME_TIMELINE, async () => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status === RoomStatus.WAITING) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      const response = await engine.getGameTimeline(roomId);
      if (!response) return;
      socket.emit(ServerEvents.GAME_TIMELINE_RESULT, response);
    });

    // Voluntary forfeit — "Leave Game" button, GAME_PHASE only. Instant bankruptcy
    // for the requesting player only; acks back to just this socket (GAME_LEFT) so
    // the client knows to reset and return to the landing page, separately from the
    // player:bankrupt broadcast every other player in the room also receives.
    socket.on(ClientEvents.GAME_LEAVE, async () => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      const result = await engine.forfeitGame(roomId, player.id);
      if (!result.success) {
        socket.emit(ServerEvents.ERROR, {
          code: 'LEAVE_GAME_FAILED',
          message: result.reason || 'Unable to leave the game right now',
        });
        return;
      }
      socket.emit(ServerEvents.GAME_LEFT, null);

      // The player who just left might have been the last one anyone was waiting on.
      if (result.triggerImmediateResolution) {
        engine.clearTimer(roomId);
        engine.resolveGameTurn(roomId).catch((error) => {
          console.error(`Ready-triggered turn resolution failed for room ${roomId}:`, error);
        });
      }
    });

    // Ready toggle for the in-flight turn — once every active player is ready, the
    // turn resolves immediately instead of waiting out the rest of the timer.
    socket.on(ClientEvents.GAME_READY, (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      let ready: boolean;
      try {
        ({ ready } = validateGameReady(payload));
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_READY',
          message: error instanceof Error ? error.message : 'Invalid ready payload',
        });
        return;
      }

      const readyUpdate = engine.toggleReady(roomId, player.id, ready);
      if (!readyUpdate) return;

      engine.broadcastRoomState(roomId, ServerEvents.GAME_READY_UPDATE, readyUpdate);

      if (readyUpdate.activePlayerCount > 0 && readyUpdate.readyPlayerIds.length >= readyUpdate.activePlayerCount) {
        engine.clearTimer(roomId);
        engine.resolveGameTurn(roomId).catch((error) => {
          console.error(`Ready-triggered turn resolution failed for room ${roomId}:`, error);
        });
      }
    });

    // In-room chat — see GameEngine.sendChatMessage's doc comment for what phases this
    // covers and why the actual logic lives there rather than inline here.
    socket.on(ClientEvents.CHAT_MESSAGE, (payload: unknown) => {
      try {
        engine.sendChatMessage(socket.id, payload);
      } catch (error) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_CHAT_MESSAGE',
          message: error instanceof Error ? error.message : 'Invalid chat message',
        });
      }
    });

    // Disconnect — don't delete immediately, give them RECONNECT_GRACE_PERIOD_MS to
    // reconnect via room:rejoin (network hiccup, accidental back button, refresh).
    socket.on('disconnect', async () => {
      await engine.markPlayerDisconnected(socket.id);
    });
  });

  return engine;
}
