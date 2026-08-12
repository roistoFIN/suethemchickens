import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameLoop, type EngineDataInput } from './gameLoop';
import { DEFAULT_FORMULA_SEEDS } from './defaultFormulas';
import { SELF_OWNERSHIP_KEY, EXTERNAL_MARKET_KEY } from './calcEngine';
import type { GameConfig, PlayerVariables, LegalCaseData } from '@suethemchickens/shared';

// ── Helpers ──────────────────────────────────────────────────

function makeVars(overrides: Partial<PlayerVariables> = {}): PlayerVariables {
  return {
    cash: 100000,
    assets: 50000,
    intangibleAssets: 10000,
    debt: 20000,
    reserves: 30000,
    operatingExpenses: 5000,
    staffCost: 8000,
    materialCostPerTon: 100,
    otherIncome: 1000,
    price: 500,
    capacityUtilization: 0.8,
    processingLevel: 0.7,
    energyIntensity: 0.5,
    moistureContent: 0.3,
    nutrientConsistency: 0.85,
    supplySecurity: 0.6,
    logisticsCostPerTon: 50,
    processLoss: 0.05,
    installedCapacity: 10000,
    totalSharesOutstanding: 1000,
    shareOwnership: {},
    outrage: 10,
    scrutiny: 30,
    breakdowns: 0,
    contaminationRisk: 0.02,
    odorComplaints: 0,
    tokenLiability: 0,
    carbonFootprint: 0,
    stockVolume: 0,
    demand: 8000,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    gameSettings: {
      minPlayers: 2,
      maxPlayers: 4,
      turnDurationSeconds: 120,
      maxLawsuitsPerPlayerPerTurn: 3,
      maxStrategicDecisionsPerTurn: 2,
      maxOperationalDecisionsPerTurn: 3,
      maxFinancialDecisionsPerTurn: 1,
      // 25000/player * 2 players (this file's dominant scenario) reproduces the exact
      // same 50000 flat total the old totalMarketVolumeTonnesPerYear constant gave every
      // test here — keeps every existing expected volume/revenue number in this file
      // unchanged. marketFixed: true means demandPriceElasticity/referencePrice below are
      // never actually read by these tests; see the dedicated describe blocks further
      // down for tests that flip this and exercise per-player-scaling/elasticity.
      marketVolumePerPlayerTonnesPerYear: 25000,
      marketFixed: true,
      digDeeperCost: 10000,
      negotiationPeriodTurns: 2,
      lawsuitFilingCost: 15000,
      statuteOfLimitationsYears: 10,
      permanentEffectCooldownYears: 3,
      semaphoreGreenMax: 0.15,
      semaphoreYellowMax: 0.4,
      enableBotPlayers: true,
      lateGameRoundThreshold: 18,
      lateGameLegalProbabilityBoost: 1.5,
      lateGameLegalStakesBoost: 1.5,
      lateGameTakeoverBoost: 1.5,
      mergerIntegrationCostRate: 0.25,
      wealthScaledFeeRate: 0.03,
      // 0 by default so every OTHER test in this file (which asserts exact decision-cost
      // cash numbers) is unaffected — see the dedicated describe block further down for
      // tests that override this.
      decisionCostWealthScaleRate: 0,
    },
    playerStartingValues: {
      cash: 100000,
      assets: 50000,
      intangibleAssets: 10000,
      debt: 20000,
      reserves: 30000,
      operatingExpenses: 5000,
      staffCost: 8000,
      materialCostPerTon: 100,
      otherIncome: 1000,
      price: 500,
      capacityUtilization: 0.8,
      processingLevel: 0.7,
      energyIntensity: 0.5,
      moistureContent: 0.3,
      nutrientConsistency: 0.85,
      supplySecurity: 0.6,
      logisticsCostPerTon: 50,
      processLoss: 0.05,
      installedCapacity: 10000,
      totalSharesOutstanding: 1000,
      shareOwnership: {},
      outrage: 10,
      scrutiny: 30,
      breakdowns: 0,
      contaminationRisk: 0.02,
      odorComplaints: 0,
      tokenLiability: 0,
      carbonFootprint: 0,
      stockVolume: 0,
      demand: 8000,
    },
    adminVariables: {
      competitiveness: {
        competitivenessWeight_quality_wq: 0.3,
        competitivenessWeight_supply_ws: 0.2,
        competitivenessWeight_loss_wl: 0.15,
        competitivenessWeight_demand_wd: 0.1,
        outrageDemandWeight: 0.5,
        demandPriceElasticity: 1.0,
        referencePrice: 500,
      },
      finance: {
        baseFinanceCost: 2000,
        interestRate: 0.05,
        taxRate: 0.2,
        daysSalesOutstanding_DSO: 30,
      },
      legalProcess: {
        scrutinyLegalRiskMultiplier: 0.02,
        legalExposureRatioCap: 0.8,
      },
      riskGauge: {
        riskWeightLegalExposure_w1: 0.3,
        riskWeightScrutiny_w2: 0.2,
        riskWeightOutrage_w3: 0.25,
        riskWeightOwnership_w4: 0,
      },
      ownership: {
        takeoverThresholdPercent: 0.5,
      },
      depreciation: {
        assetUsefulLifeYears: 10,
        intangibleUsefulLifeYears: 5,
      },
    },
    ...overrides,
  };
}

/** Builds the EngineDataInput[] GameLoop expects — the same shape GameEngine loads from Prisma. */
function makePlayers(
  overrides: Array<{ id: string; name: string; cash?: number; variables?: unknown; engineState?: unknown }>,
): EngineDataInput[] {
  return overrides.map(o => ({
    id: o.id,
    name: o.name,
    company: {
      cash: o.cash ?? 100000,
      variables: o.variables ?? makeVars(),
      engineState: o.engineState ?? {},
    },
  }));
}

const twoPlayers = () => makePlayers([
  { id: 'player-1', name: 'Alice' },
  { id: 'player-2', name: 'Bob' },
]);

/** A negotiating case between player-1 (defendant) and player-2 (plaintiff), for the
 * makeOffer/acceptOffer/goToCourt tests below — bypasses filing a real lawsuit through
 * resolveTurn, since those methods only need a case already sitting in engineState. */
function makeCase(overrides: Partial<LegalCaseData> = {}): LegalCaseData {
  return {
    id: 'case-1',
    roomId: 'room-1',
    plaintiffId: 'player-2',
    defendantId: 'player-1',
    decisionName: 'Water Pumping',
    groundName: 'Environmental Violation',
    description: 'Sue for environmental damage',
    baseProbability: 0.12,
    adjustedProbability: undefined,
    plaintiffFullyInvestigated: false,
    defendantInvestigated: false,
    stakes: 20000,
    status: 'negotiating',
    offers: [],
    turnsNegotiating: 0,
    verdict: undefined,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    resolvedAt: undefined,
    ...overrides,
  };
}

/** Builds the two-party fixture makeOffer/acceptOffer/goToCourt need — the same case
 * object persisted into both parties' own engineState.legalCases, matching the real
 * "one case lives in both parties' engineState" invariant `resolveTurn` maintains. */
function playersWithCase(case_: LegalCaseData, cashByPlayer: Record<string, number> = {}): EngineDataInput[] {
  return makePlayers([
    { id: 'player-1', name: 'Alice', variables: makeVars({ cash: cashByPlayer['player-1'] ?? 100000 }), engineState: { legalCases: [case_] } },
    { id: 'player-2', name: 'Bob', variables: makeVars({ cash: cashByPlayer['player-2'] ?? 100000 }), engineState: { legalCases: [case_] } },
  ]);
}

// ── Tests ────────────────────────────────────────────────────

describe('GameLoop', () => {
  let gameLoop: GameLoop;
  let config: GameConfig;

  beforeEach(() => {
    config = makeConfig();

    gameLoop = new GameLoop(config);
    gameLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
    gameLoop.loadDecisions([
      {
        decision: 'New Factory',
        level: 'Strategic',
        description: 'Build a new factory',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: [],
        impacts: {
          installedCapacity: { type: 'absolute', schedule: { 1: 5000, default: 5000 } },
          cash: { type: 'absolute', schedule: { 1: -30000, default: -30000 } },
        },
      },
      {
        decision: 'Quality Certification',
        level: 'Operational',
        description: 'Get quality certification',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: [],
        impacts: {
          processingLevel: { type: 'absolute', schedule: { 1: 0.1, 2: 0.1, default: 0.2 } },
          cash: { type: 'absolute', schedule: { 1: -5000, default: -5000 } },
        },
      },
      {
        decision: 'Water Pumping',
        level: 'Operational',
        description: 'Pump water from competitor territory',
        nature: 'Dirty',
        offensiveAction: true,
        excludes: [],
        impacts: {
          materialCostPerTon: { type: 'absolute', schedule: { default: -50 } },
        },
        legalRisks: [
          {
            name: 'Environmental Violation',
            description: 'Sue for environmental damage',
            probability: { 1: 0.06, 2: 0.12, default: 0.18 },
            impact: {
              type: 'absolute',
              target: 'cash',
              schedule: { 1: 7350, 2: 14700, default: 22050 },
            },
          },
        ],
      },
      {
        decision: 'Exclusive Deal',
        level: 'Strategic',
        description: 'Sign exclusive supplier deal',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: ['Competitor Lock-in'],
        impacts: {
          supplySecurity: { type: 'absolute', schedule: { default: 0.15 } },
        },
      },
      {
        decision: 'Competitor Lock-in',
        level: 'Strategic',
        description: 'Lock in competitor suppliers',
        nature: 'Grey Area',
        offensiveAction: true,
        excludes: ['Exclusive Deal'],
        impacts: {
          supplySecurity: { type: 'absolute', schedule: { default: 0.1 } },
        },
      },
      {
        decision: 'Bot Attack',
        level: 'Operational',
        description: 'Launch a coordinated cyberattack against a competitor',
        nature: 'Dirty',
        offensiveAction: true,
        excludes: [],
        impacts: {
          cash: { type: 'absolute', schedule: { default: -12000 } },
          'target.outrage': { type: 'absolute', schedule: { default: 20 } },
          'target.capacityUtilization': { type: 'relative', schedule: { default: -0.2 } },
        },
        legalRisks: [
          {
            name: 'CFAA Digital Sabotage Lawsuit',
            description: 'Sue for the DDoS attack that crashed your logistics infrastructure.',
            probability: { 1: 0.2, default: 0.6 },
            impact: { type: 'absolute', target: 'cash', schedule: { 1: -50000, default: -120000 } },
          },
        ],
      },
      {
        decision: 'Buy Shares',
        level: 'Strategic',
        description: 'Buy a block of another company\'s shares',
        nature: 'Grey Area',
        offensiveAction: true,
        excludes: [],
        requiresTarget: true,
        variableAmount: true,
        shareTransactionType: 'buy',
        impacts: {},
        legalRisks: [
          {
            name: 'Breach of Corporate Fiduciary Duty & Raiding Injunction',
            description: 'Sue for the hostile stake acquisition',
            probability: { 1: 0.1, default: 0.08 },
            impact: { type: 'absolute', target: 'cash', schedule: { default: -35000 } },
          },
        ],
        legalRiskConditions: { minPercentAcquiredInSingleTransaction: 0.05 },
      },
      {
        decision: 'Sell Shares',
        level: 'Strategic',
        description: 'Sell held shares back to the external market',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: [],
        requiresTarget: true,
        variableAmount: true,
        shareTransactionType: 'sell',
        impacts: {},
        legalRisks: [],
      },
      {
        decision: 'Share Issuance',
        level: 'Strategic',
        description: 'Issue new equity to the market',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: [],
        impacts: {
          cash: { type: 'absolute', schedule: { 1: 150000, default: 0 } },
          sharesAmount: { type: 'absolute', schedule: { 1: 5000, default: 0 } },
        },
        legalRisks: [],
      },
      {
        decision: 'Risky Fundraising',
        level: 'Operational',
        description: 'Raise cash through a legally dubious scheme (relative-type legal-risk fixture)',
        nature: 'Dirty',
        offensiveAction: false,
        excludes: [],
        impacts: {
          cash: { type: 'absolute', schedule: { 1: 100000, default: 0 } },
        },
        legalRisks: [
          {
            name: 'Fraudulent Capital Procurement',
            description: 'Sue over the fraudulent fundraising scheme',
            probability: { 1: 0.3, default: 0.75 },
            impact: { type: 'relative', target: 'equity', schedule: { 1: -0.15, default: -0.45 } },
          },
          {
            name: 'Unfair Competition via Fundraising',
            description: 'Sue over the resulting unfair competitive advantage',
            probability: { 1: 0.1, default: 0.4 },
            impact: { type: 'relative', target: 'revenue', schedule: { 1: -0.1, default: -0.4 } },
          },
        ],
      },
      {
        decision: 'Revenue Manipulation Scheme',
        level: 'Operational',
        description: 'A decision with a single, revenue-relative legal-risk ground (regression fixture — see "incoming-attack hint stakes" below)',
        nature: 'Dirty',
        offensiveAction: false,
        excludes: [],
        impacts: {
          cash: { type: 'absolute', schedule: { 1: 50000, default: 0 } },
        },
        legalRisks: [
          {
            name: 'Revenue Misrepresentation Claim',
            description: 'Sue over misrepresented revenue figures',
            probability: { 1: 0.2, default: 0.6 },
            impact: { type: 'relative', target: 'revenue', schedule: { 1: -0.1, default: -0.4 } },
          },
        ],
      },
    ]);
  });

  describe('Phase A — Decision Collection', () => {
    it('should accept decision submissions', () => {
      const decisions = {
        strategic: [{ name: 'New Factory' }],
        operational: [{ name: 'Quality Certification' }], financial: [],
        lawsuits: [],
      };

      const result = gameLoop.submitDecisions('room-1', 'player-1', decisions);

      expect(result).toBe(true);
      expect(gameLoop.getSubmissionCount('room-1')).toBe(1);
    });

    it('should track multiple player submissions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [], financial: [],
        lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [],
        operational: [{ name: 'Quality Certification' }], financial: [],
        lawsuits: [],
      });

      expect(gameLoop.getSubmissionCount('room-1')).toBe(2);
    });

    it('should clear submissions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      gameLoop.clearSubmissions('room-1');
      expect(gameLoop.getSubmissionCount('room-1')).toBe(0);
    });

    it('should return 0 for non-existent room', () => {
      expect(gameLoop.getSubmissionCount('nonexistent-room')).toBe(0);
    });
  });

  describe('resolveTurn — basic flow', () => {
    it('should return empty result when no players exist', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, []);

      expect(outcome.result.players).toHaveLength(0);
      expect(outcome.result.gameOver).toBe(false);
      expect(outcome.companyUpdates).toHaveLength(0);
      expect(outcome.bankruptedPlayers).toHaveLength(0);
    });

    it('should process a turn with two players', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.players).toHaveLength(2);
      expect(outcome.result.players[0].playerId).toBe('player-1');
      expect(outcome.result.players[0].playerName).toBe('Alice');
      expect(outcome.result.gameOver).toBe(false);
      expect(outcome.result.round).toBe(1);
    });

    it('should seed starting values on first turn when vars are empty', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', cash: 0, variables: {} },
        { id: 'player-2', name: 'Bob', cash: 0, variables: {} },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 1, players);

      // Starting values should be seeded from playerStartingValues when vars are empty.
      // With two players the full game loop runs (P&L, balance sheet), so cash may differ from raw seed.
      expect(outcome.result.players).toHaveLength(2);
      expect(outcome.result.players[0].variables.cash).toBeGreaterThan(0);
    });

    it('should not trigger game over with two players', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.gameOver).toBe(false);
    });
  });

  describe('resolveTurn — decision processing', () => {
    it('should deploy submitted strategic decisions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.players[0].activeDecisions).toHaveLength(1);
      expect(outcome.result.players[0].activeDecisions[0].decisionName).toBe('New Factory');
    });

    it('should deploy submitted operational decisions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Quality Certification' }], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.players[0].activeDecisions).toHaveLength(1);
      expect(outcome.result.players[0].activeDecisions[0].decisionName).toBe('Quality Certification');
    });

    it('carries a target-bearing decision\'s targetId through to the client-facing activeDecisions entry (regression)', () => {
      // ActiveDecisionInstance used to have no targetId at all — the client's "Active
      // Decisions" box had no way to show/sort by who a player's own decision targeted,
      // even though the underlying deployed instance always tracked it.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }, { name: 'Quality Certification' }], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const activeDecisions = outcome.result.players[0].activeDecisions;

      expect(activeDecisions.find((d) => d.decisionName === 'Bot Attack')?.targetId).toBe('player-2');
      // A decision with no target concept at all carries no targetId, not an empty string.
      expect(activeDecisions.find((d) => d.decisionName === 'Quality Certification')?.targetId).toBeUndefined();
    });

    it('does not silently drop a later turn\'s decisions just because an earlier turn already used the same-level per-turn budget (regression)', () => {
      // A real, reported bug: canDeploy used to re-derive "how many decisions of this
      // level does this player have" from the player's ENTIRE historical
      // engineState.activeDecisions list (never pruned — matured decisions stay forever),
      // making the "max N per turn" check a lifetime cap in practice. Turn 1 here uses
      // the full strategic (2) and operational (3) budget this room's config allows —
      // completely normal play, not an edge case. Turn 2 then submits ONE more decision
      // of each level; both used to be silently dropped (canDeploy rejected them, so
      // processNewDecisions just `continue`d past them with no error, no active decision
      // created, and no trace left anywhere) even though they're entirely new decisions,
      // unrelated to anything deployed in turn 1.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }, { name: 'Share Issuance' }],
        operational: [{ name: 'Quality Certification' }, { name: 'Water Pumping' }], financial: [],
        lawsuits: [],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      expect(outcome1.result.players[0].activeDecisions.map((d) => d.decisionName).sort()).toEqual(
        ['New Factory', 'Quality Certification', 'Share Issuance', 'Water Pumping'].sort(),
      );

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Buy Shares' }],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }], financial: [],
        lawsuits: [],
      });
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);

      const aliceNames = outcome2.result.players.find((p) => p.playerId === 'player-1')!.activeDecisions.map((d) => d.decisionName);
      expect(aliceNames).toContain('Buy Shares');
      expect(aliceNames).toContain('Bot Attack');
      // The other player must see the effect too — Bot Attack targets them, so it should
      // show up as an incoming attack, not just silently vanish for both parties.
      const bobIncoming = outcome2.result.players.find((p) => p.playerId === 'player-2')!.incomingAttacks;
      expect(bobIncoming.length).toBeGreaterThan(0);
    });

    it('should block deploying same decision twice before maturity', () => {
      // Quality Certification matures in 2 years (impacts at years 1 and 2), so after
      // one resolved turn it's still maturing — a real test of cross-turn blocking via
      // the actual persisted engineState (Company.engineState round-trip through
      // outcome.companyUpdates), not just same-turn duplicate-submission handling.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Quality Certification' }], financial: [],
        lawsuits: [],
      });

      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      expect(outcome1.result.players[0].activeDecisions[0].isMatured).toBe(false);

      const persisted = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: persisted.variables, engineState: persisted.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);

      // Second turn: try to deploy again while the first instance is still maturing
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Quality Certification' }], financial: [],
        lawsuits: [],
      });

      const outcome2 = gameLoop.resolveTurn('room-1', 2, players);

      // Should still have only 1 active decision (the second was blocked)
      expect(outcome2.result.players[0].activeDecisions).toHaveLength(1);
    });

    it('should enforce strategic decision limit', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }, { name: 'Exclusive Deal' }, { name: 'Competitor Lock-in' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      // Max 2 strategic decisions per turn
      const strategicCount = outcome.result.players[0].activeDecisions.filter(
        (d) => d.decisionName === 'New Factory' || d.decisionName === 'Exclusive Deal' || d.decisionName === 'Competitor Lock-in',
      ).length;
      expect(strategicCount).toBeLessThanOrEqual(2);
    });

    it('should enforce financial decision limit independently of strategic/operational (Buy/Sell Shares is its own budget)', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [],
        financial: [
          { name: 'Buy Shares', targetId: 'player-2', amount: 1000 },
          { name: 'Sell Shares', targetId: 'player-1', amount: 1000 },
        ],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      // makeConfig's maxFinancialDecisionsPerTurn is 1 — only the first submitted
      // financial entry (Buy Shares) should have deployed, regardless of the
      // (much higher) strategic/operational limits this fixture also sets.
      const financialCount = outcome.result.players[0].activeDecisions.filter(
        (d) => d.decisionName === 'Buy Shares' || d.decisionName === 'Sell Shares',
      ).length;
      expect(financialCount).toBe(1);
      expect(outcome.result.players[0].activeDecisions[0].decisionName).toBe('Buy Shares');
    });

    it('should block mutually exclusive decisions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Exclusive Deal' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      // Exclusive Deal should be deployed (Competitor Lock-in not submitted)
      const decisionNames = outcome.result.players[0].activeDecisions.map((d) => d.decisionName);
      expect(decisionNames).toContain('Exclusive Deal');
    });

    it('should route target.* impacts to the targeted player, not the deploying player', () => {
      // Regression test: GameLoop.resolveTurn used to extract target.* impacts but
      // never apply them, so offensive decisions (Bot Attack, Social Astroturf, etc.)
      // silently had no effect on the chosen opponent.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      // Target absolute impact landed on the target (starting outrage: 10 + 20)
      expect(bob.variables.outrage).toBe(30);
      // Target relative impact landed on the target (starting capacityUtilization: 0.8 * (1 - 0.2))
      expect(bob.variables.capacityUtilization).toBeCloseTo(0.64, 5);

      // The deploying player's own state is untouched by the target.* fields —
      // no stray "target.outrage" pollution and no self-inflicted effect.
      expect(alice.variables.outrage).toBe(10);
      expect(alice.variables.capacityUtilization).toBe(0.8);
      expect((alice.variables as any)['target.outrage']).toBeUndefined();
      expect((alice.variables as any)['target.capacityUtilization']).toBeUndefined();
    });

    it('should NOT keep compounding a RELATIVE target.* effect turn after turn, while an ABSOLUTE one keeps accumulating (regression)', () => {
      // A real, reported bug found via live play: Bot Attack's own instance stays active
      // (and keeps being fed into collectTargetImpacts) turn after turn with no
      // resubmission needed — that's deliberate ("target effects keep re-applying every
      // turn," see CLAUDE.md). But for the RELATIVE `target.capacityUtilization` field,
      // reapplying the same -20% against the already-shrunk value every turn used to
      // compound exponentially (0.8 → 0.64 → 0.512 → 0.4096 → ...) — a single attack left
      // un-countered would crush a victim's capacity toward zero and, in a real test
      // game, bankrupted an idle player by round 12. The ABSOLUTE `target.outrage` field
      // has no such bug (bounded, linear +20/turn) and must keep accumulating unchanged.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }], financial: [],
        lawsuits: [],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const bob1 = outcome1.result.players.find((p) => p.playerId === 'player-2')!;
      expect(bob1.variables.capacityUtilization).toBeCloseTo(0.64, 5); // 0.8 * (1 - 0.2)
      expect(bob1.variables.outrage).toBe(30); // 10 + 20

      // No new submission for round 2 — the attack's own instance stays active and keeps
      // contributing to collectTargetImpacts on its own, matching real gameplay.
      const alice1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const bobUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-2')!;
      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: alice1.variables, engineState: alice1.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: bobUpdate1.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);
      const bob2 = outcome2.result.players.find((p) => p.playerId === 'player-2')!;
      // Must HOLD at the deployment-turn value, not compound to 0.64 * 0.8 = 0.512.
      expect(bob2.variables.capacityUtilization).toBeCloseTo(0.64, 5);
      expect(bob2.variables.outrage).toBe(50); // keeps accumulating: 30 + 20

      const alice2 = outcome2.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const bobUpdate2 = outcome2.companyUpdates.find((u) => u.playerId === 'player-2')!;
      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: alice2.variables, engineState: alice2.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate2.variables, engineState: bobUpdate2.engineState },
      ]);
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      const bob3 = outcome3.result.players.find((p) => p.playerId === 'player-2')!;
      expect(bob3.variables.capacityUtilization).toBeCloseTo(0.64, 5);
      expect(bob3.variables.outrage).toBe(70); // 50 + 20
    });

    it('should surface an incomingAttacks entry for the victim, un-investigated by default', () => {
      // Three active players (not the usual twoPlayers() fixture) specifically to stay
      // OUT of the heads-up shortcut below — see effectiveInvestigationLevel's doc
      // comment — so this covers the plain, un-shortcut "nothing revealed below level 1"
      // baseline that still applies whenever more than one other player could be the
      // attacker.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice' },
        { id: 'player-2', name: 'Bob' },
        { id: 'player-3', name: 'Carol' },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      expect(bob.incomingAttacks).toHaveLength(1);
      expect(bob.incomingAttacks[0].investigationLevel).toBe(0);
      // Nothing revealed yet — no attacker identity below investigation level 1.
      expect(bob.incomingAttacks[0].attackerId).toBeUndefined();
      expect(bob.incomingAttacks[0].attackerName).toBeUndefined();
      // Alice isn't being attacked by anyone.
      expect(alice.incomingAttacks).toHaveLength(0);
    });

    it('should reveal the attacker\'s identity for free in a heads-up (2-active-player) game — there is no one else it could be', () => {
      // With only one other active player, level 1's only content (who attacked me) is
      // never actually ambiguous, so it's surfaced without spending a dig — see
      // effectiveInvestigationLevel's doc comment in gameLoop.ts.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      expect(bob.incomingAttacks).toHaveLength(1);
      expect(bob.incomingAttacks[0].investigationLevel).toBe(1);
      expect(bob.incomingAttacks[0].attackerId).toBe('player-1');
      expect(bob.incomingAttacks[0].attackerName).toBe('Alice');
      // Level 2 content (what the decision is/does) still isn't free — that's what the
      // first paid dig is for.
      expect(bob.incomingAttacks[0].decisionName).toBeUndefined();
    });

    it('should broadcast an indirect-effect hint (a non-targeted, legalRisks-bearing decision) to EVERY other active player, not just one', () => {
      // Water Pumping has no target.* impacts at all — nobody is "the target" of it —
      // but it does carry legalRisks (weight-fraud suits), so it should still surface
      // as an incoming-attacks-style hint, just to everyone rather than one victim.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice' },
        { id: 'player-2', name: 'Bob' },
        { id: 'player-3', name: 'Carol' },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;

      for (const rival of [bob, carol]) {
        expect(rival.incomingAttacks).toHaveLength(1);
        expect(rival.incomingAttacks[0].isIndirect).toBe(true);
        expect(rival.incomingAttacks[0].investigationLevel).toBe(0);
        // Un-investigated (3 active players, no heads-up shortcut) — nothing revealed yet.
        expect(rival.incomingAttacks[0].attackerId).toBeUndefined();
      }
      // Alice deployed it, so it's not "incoming" to herself.
      expect(alice.incomingAttacks).toHaveLength(0);
    });

    it('should NOT surface a hint at all for a decision with neither target.* impacts nor any legalRisks', () => {
      // New Factory (this test file's fixture definition, not the real game data) has
      // no target.* impacts and no legalRisks — nothing to reveal or sue over, so it's
      // neither a direct nor an indirect hint, just silent.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }], operational: [], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      expect(bob.incomingAttacks).toHaveLength(0);
    });

    // Regression: a real, reported gap — once an attacking instance is past
    // statuteOfLimitationsYears, suing over it is already forced to 0% and (for a direct
    // attack) its own target.* effect has already stopped re-applying every turn, so the
    // hint card has nothing left to warn about or act on. It used to keep appearing
    // forever anyway, a stale, un-actionable notification. Covers BOTH the direct
    // ("did something to you") and indirect ("indirectly affects you") hint shapes.
    it('stops surfacing a DIRECT attack hint once the instance ages past statuteOfLimitationsYears (10)', () => {
      const players = makePlayers([
        {
          id: 'player-1', name: 'Alice',
          engineState: { activeDecisions: [{ id: 'ba-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 9, isMatured: true, targetId: 'player-2' }] },
        },
        { id: 'player-2', name: 'Bob' },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 11, players);
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      // elapsedYears becomes 10 this turn — at the statute — so the hint must disappear.
      expect(bob.incomingAttacks).toHaveLength(0);
    });

    it('still surfaces a DIRECT attack hint the turn before it ages past the statute', () => {
      const players = makePlayers([
        {
          id: 'player-1', name: 'Alice',
          engineState: { activeDecisions: [{ id: 'ba-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 8, isMatured: true, targetId: 'player-2' }] },
        },
        { id: 'player-2', name: 'Bob' },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 10, players);
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      expect(bob.incomingAttacks).toHaveLength(1);
    });

    it('stops surfacing an INDIRECT effect hint once the instance ages past statuteOfLimitationsYears (10)', () => {
      const players = makePlayers([
        {
          id: 'player-1', name: 'Alice',
          engineState: { activeDecisions: [{ id: 'wp-1', definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 9, isMatured: true }] },
        },
        { id: 'player-2', name: 'Bob' },
        { id: 'player-3', name: 'Carol' },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 11, players);
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;

      expect(bob.incomingAttacks).toHaveLength(0);
      expect(carol.incomingAttacks).toHaveLength(0);
    });
  });

  describe('resolveTurn — decisionEvents/durationMs telemetry (regression)', () => {
    // Server-only fields on TurnResolutionOutcome (never part of the client-facing
    // TurnResolutionResult) — GameEngine logs these to EventLog for the admin
    // Analytics tab's decision-balance dashboard and bug-tracing feed. See CLAUDE.md's
    // EventLog section. `canDeploy` already computed a `reason` string for every
    // rejection before this existed (processNewDecisions just discarded it via a bare
    // `continue`) — decisionEvents only starts collecting what was already there.
    it('records a deployed entry for a decision that actually deploys', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }], operational: [], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.decisionEvents).toContainEqual({
        playerId: 'player-1',
        bucket: 'strategic',
        decisionName: 'New Factory',
        targetId: undefined,
        outcome: 'deployed',
      });
    });

    it('records a rejected entry with canDeploy\'s real reason when a decision is still maturing', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Quality Certification' }], financial: [], lawsuits: [],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const persisted = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: persisted.variables, engineState: persisted.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);

      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Quality Certification' }], financial: [], lawsuits: [],
      });
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);

      const rejectedEvent = outcome2.decisionEvents.find((e) => e.playerId === 'player-1' && e.outcome === 'rejected');
      expect(rejectedEvent).toBeDefined();
      expect(rejectedEvent?.decisionName).toBe('Quality Certification');
      expect(rejectedEvent?.reason).toContain('matur');
    });

    it('records a targetId on a target-bearing decision\'s event, matching the deployed instance', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Bot Attack', targetId: 'player-2' }], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const event = outcome.decisionEvents.find((e) => e.decisionName === 'Bot Attack');
      expect(event).toMatchObject({ outcome: 'deployed', targetId: 'player-2' });
    });

    it('is empty when nobody submits anything, and durationMs is a real non-negative measurement', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      expect(outcome.decisionEvents).toEqual([]);
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(outcome.durationMs)).toBe(true);
    });
  });

  describe('resolveTurn — financial calculations', () => {
    it('should calculate derived values correctly', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const derived = outcome.result.players[0].derived;
      expect(derived.equity).toBeDefined();
      expect(derived.revenue).toBeDefined();
      expect(derived.volume).toBeDefined();
      expect(derived.marketShare).toBeDefined();
      expect(derived.competitiveness).toBeDefined();
      expect(derived.depreciation).toBeDefined();
      expect(derived.financeCost).toBeDefined();
      expect(derived.taxCost).toBeDefined();
    });

    it('should calculate market share across multiple players', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ price: 500, processingLevel: 0.7 }) },
        { id: 'player-2', name: 'Bob', variables: makeVars({ price: 600, processingLevel: 0.5 }) },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 1, players);

      const aliceShare = outcome.result.players.find((p) => p.playerId === 'player-1')?.derived.marketShare;
      const bobShare = outcome.result.players.find((p) => p.playerId === 'player-2')?.derived.marketShare;

      // Alice has better competitiveness (lower price + higher processing level)
      expect(aliceShare).toBeGreaterThan(0);
      expect(bobShare).toBeGreaterThan(0);
    });

    it('should calculate volume with supply cap', () => {
      const players = makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          variables: makeVars({ installedCapacity: 2000, capacityUtilization: 0.8, marketShare: 0.5 }),
        },
        { id: 'player-2', name: 'Bob' },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 1, players);

      const volume = outcome.result.players[0].derived.volume;
      // maxSupply = 2000 * 0.8 = 1600, theoretical = 0.5 * 50000 = 25000
      // volume should be capped at 1600
      expect(volume).toBe(1600);
    });

    it('should calculate risk gauge', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.players[0].riskGauge).toBeDefined();
      expect(outcome.result.players[0].riskGauge).toBeGreaterThanOrEqual(0);
      expect(outcome.result.players[0].riskGauge).toBeLessThanOrEqual(100);
    });

  });

  // Regression/new-behavior coverage for a real, reported gap: the market pie used to be
  // a flat config constant so far above any realistic per-player capacity that market
  // share never actually bound volume/revenue in practice — see CLAUDE.md's market-share
  // section. These tests use their OWN small GameLoop/config (not the shared
  // beforeEach's, which deliberately keeps its pie huge/inert for every other test in
  // this file) so the pie is small enough to actually bind, the way a real game's default
  // marketVolumePerPlayerTonnesPerYear (400) does against the real default maxSupply (350).
  describe('resolveTurn — market share & demand elasticity actually affect revenue (real-world dynamics)', () => {
    function makeMarketConfig(overrides: { marketVolumePerPlayerTonnesPerYear?: number; marketFixed?: boolean; referencePrice?: number; demandPriceElasticity?: number } = {}): GameConfig {
      const base = makeConfig();
      return {
        ...base,
        gameSettings: {
          ...base.gameSettings,
          marketVolumePerPlayerTonnesPerYear: overrides.marketVolumePerPlayerTonnesPerYear ?? 4000,
          marketFixed: overrides.marketFixed ?? false,
        },
        adminVariables: {
          ...base.adminVariables,
          competitiveness: {
            ...base.adminVariables.competitiveness,
            referencePrice: overrides.referencePrice ?? 500,
            demandPriceElasticity: overrides.demandPriceElasticity ?? 1.0,
          },
        },
      };
    }

    function makeMarketLoop(config: GameConfig): GameLoop {
      const loop = new GameLoop(config);
      loop.loadFormulas(DEFAULT_FORMULA_SEEDS);
      loop.loadDecisions([]);
      return loop;
    }

    it('a competitiveness disadvantage now actually costs revenue, once the pie is right-sized (the core bug this fixes)', () => {
      const loop = makeMarketLoop(makeMarketConfig({ marketFixed: true })); // isolate the pie-sizing fix from elasticity
      const players = makePlayers([
        { id: 'strong', name: 'Strong', variables: makeVars({ processingLevel: 0.9, supplySecurity: 0.9, processLoss: 0.02 }) },
        { id: 'weak', name: 'Weak', variables: makeVars({ processingLevel: 0.2, supplySecurity: 0.1, processLoss: 0.3 }) },
      ]);

      const outcome = loop.resolveTurn('room-1', 1, players);
      const strong = outcome.result.players.find((p) => p.playerId === 'strong')!;
      const weak = outcome.result.players.find((p) => p.playerId === 'weak')!;

      expect(strong.derived.marketShare).toBeGreaterThan(weak.derived.marketShare);
      // The actual bug: with the old flat 10,000-ton pie, BOTH of these would be capacity-
      // bound (8000) regardless of the share gap, and this assertion would fail.
      expect(strong.derived.revenue).toBeGreaterThan(weak.derived.revenue);
    });

    it('scales the pie by active player count — a 2-player and a 4-player game at parity get the same per-player theoretical volume', () => {
      const config = makeMarketConfig({ marketFixed: true, marketVolumePerPlayerTonnesPerYear: 100 }); // small enough to stay share-bound (never hits maxSupply 8000) at any of these player counts
      const twoP = makeMarketLoop(config).resolveTurn('room-2p', 1, makePlayers([
        { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' },
      ]));
      const fourP = makeMarketLoop(config).resolveTurn('room-4p', 1, makePlayers([
        { id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }, { id: 'p3', name: 'P3' }, { id: 'p4', name: 'P4' },
      ]));

      expect(twoP.result.players[0].derived.volume).toBeCloseTo(fourP.result.players[0].derived.volume, 4);
    });

    it('demand elasticity shrinks the WHOLE pie when the average price rises, not just each player\'s own share of a fixed pie', () => {
      // Both players priced identically in both scenarios, so their SHARE split stays
      // 50/50 either way — any volume difference between scenarios must come from the
      // pie itself changing size (elasticity), not redistribution between players.
      const atReference = makeMarketLoop(makeMarketConfig({ referencePrice: 500 })).resolveTurn('room-a', 1, makePlayers([
        { id: 'p1', name: 'P1', variables: makeVars({ price: 500 }) },
        { id: 'p2', name: 'P2', variables: makeVars({ price: 500 }) },
      ]));
      const aboveReference = makeMarketLoop(makeMarketConfig({ referencePrice: 500 })).resolveTurn('room-b', 1, makePlayers([
        { id: 'p1', name: 'P1', variables: makeVars({ price: 750 }) }, // 50% above reference
        { id: 'p2', name: 'P2', variables: makeVars({ price: 750 }) },
      ]));

      // factor = 1 - 1.0*0.5 = 0.5 -> pie (and therefore each player's volume) halved.
      expect(aboveReference.result.players[0].derived.volume).toBeCloseTo(atReference.result.players[0].derived.volume * 0.5, 1);
      expect(aboveReference.result.players[1].derived.volume).toBeCloseTo(atReference.result.players[1].derived.volume * 0.5, 1);
    });

    it('a price hike by ONE player shrinks total volume for the OTHER player too, once elasticity is enabled — a real macro effect, not just relative redistribution', () => {
      const baseline = makeMarketLoop(makeMarketConfig({ referencePrice: 500 })).resolveTurn('room-c', 1, makePlayers([
        { id: 'raiser', name: 'Raiser', variables: makeVars({ price: 500 }) },
        { id: 'bystander', name: 'Bystander', variables: makeVars({ price: 500 }) },
      ]));
      const afterHike = makeMarketLoop(makeMarketConfig({ referencePrice: 500 })).resolveTurn('room-d', 1, makePlayers([
        { id: 'raiser', name: 'Raiser', variables: makeVars({ price: 900 }) }, // raiser's own move only
        { id: 'bystander', name: 'Bystander', variables: makeVars({ price: 500 }) }, // unchanged
      ]));

      const bystanderBefore = baseline.result.players.find((p) => p.playerId === 'bystander')!.derived.volume;
      const bystanderAfter = afterHike.result.players.find((p) => p.playerId === 'bystander')!.derived.volume;
      expect(bystanderAfter).toBeLessThan(bystanderBefore);
    });

    it('marketFixed disables elasticity entirely — symmetric price moves leave volume unchanged', () => {
      const atReference = makeMarketLoop(makeMarketConfig({ marketFixed: true, referencePrice: 500 })).resolveTurn('room-e', 1, makePlayers([
        { id: 'p1', name: 'P1', variables: makeVars({ price: 500 }) },
        { id: 'p2', name: 'P2', variables: makeVars({ price: 500 }) },
      ]));
      const aboveReference = makeMarketLoop(makeMarketConfig({ marketFixed: true, referencePrice: 500 })).resolveTurn('room-f', 1, makePlayers([
        { id: 'p1', name: 'P1', variables: makeVars({ price: 750 }) },
        { id: 'p2', name: 'P2', variables: makeVars({ price: 750 }) },
      ]));

      expect(aboveReference.result.players[0].derived.volume).toBeCloseTo(atReference.result.players[0].derived.volume, 4);
    });
  });

  // Company-size-scaled decision cost surcharge — real-world dynamics: a decision's own
  // flat, absolute `cash` cost previously stayed identical for a round-1 startup and a
  // late-game giant, unlike wealthScaledFee's litigation fees or a relative legal-risk
  // ground's stakes, both of which already scale off the payer/defendant's own size. See
  // calcEngine.ts's `applyDecisionImpacts` doc comment.
  describe('resolveTurn — decision costs scale with the deploying player\'s own company size (real-world dynamics)', () => {
    function makeWealthScaleConfig(rate: number): GameConfig {
      const base = makeConfig();
      return { ...base, gameSettings: { ...base.gameSettings, decisionCostWealthScaleRate: rate } };
    }

    it('charges a wealthy player a real surcharge on top of a decision\'s flat cost', () => {
      const decisions = [{
        decision: 'Costly Move', level: 'Strategic' as const, description: 'x', nature: 'Traditional' as const, offensiveAction: false, excludes: [],
        impacts: { cash: { type: 'absolute' as const, schedule: { 1: -10000, default: 0 } } },
      }];
      const players = () => makePlayers([
        { id: 'rich', name: 'Rich', variables: makeVars({ cash: 1000000 }) },
        { id: 'other', name: 'Other', variables: makeVars({ cash: 1000000 }) },
      ]);

      const noSurcharge = new GameLoop(makeWealthScaleConfig(0));
      noSurcharge.loadFormulas(DEFAULT_FORMULA_SEEDS);
      noSurcharge.loadDecisions(decisions);
      noSurcharge.submitDecisions('room-a', 'rich', { strategic: [{ name: 'Costly Move' }], operational: [], financial: [], lawsuits: [] });
      noSurcharge.submitDecisions('room-a', 'other', { strategic: [], operational: [], financial: [], lawsuits: [] });
      const baseline = noSurcharge.resolveTurn('room-a', 1, players());

      const withSurcharge = new GameLoop(makeWealthScaleConfig(0.02));
      withSurcharge.loadFormulas(DEFAULT_FORMULA_SEEDS);
      withSurcharge.loadDecisions(decisions);
      withSurcharge.submitDecisions('room-b', 'rich', { strategic: [{ name: 'Costly Move' }], operational: [], financial: [], lawsuits: [] });
      withSurcharge.submitDecisions('room-b', 'other', { strategic: [], operational: [], financial: [], lawsuits: [] });
      const surcharged = withSurcharge.resolveTurn('room-b', 1, players());

      const baselineCash = baseline.result.players.find((p) => p.playerId === 'rich')!.variables.cash;
      const surchargedCash = surcharged.result.players.find((p) => p.playerId === 'rich')!.variables.cash;

      // Same starting cash, same P&L, same decision — the only difference is the 2% of
      // $1,000,000 (=$20,000) surcharge, which must show up as a real, matching cash gap.
      expect(baselineCash - surchargedCash).toBeCloseTo(20000, 0);
    });

    it('the exact same decision costs a poorer player noticeably less in absolute terms', () => {
      const richLoop = new GameLoop(makeWealthScaleConfig(0.02));
      richLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
      richLoop.loadDecisions([{
        decision: 'Costly Move', level: 'Strategic', description: 'x', nature: 'Traditional', offensiveAction: false, excludes: [],
        impacts: { cash: { type: 'absolute', schedule: { 1: -10000, default: 0 } } },
      }]);
      const poorLoop = new GameLoop(makeWealthScaleConfig(0.02));
      poorLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
      poorLoop.loadDecisions([{
        decision: 'Costly Move', level: 'Strategic', description: 'x', nature: 'Traditional', offensiveAction: false, excludes: [],
        impacts: { cash: { type: 'absolute', schedule: { 1: -10000, default: 0 } } },
      }]);

      const richPlayers = makePlayers([{ id: 'rich', name: 'Rich', variables: makeVars({ cash: 1000000 }) }, { id: 'other', name: 'Other', variables: makeVars({ cash: 1000000 }) }]);
      const poorPlayers = makePlayers([{ id: 'poor', name: 'Poor', variables: makeVars({ cash: 30000 }) }, { id: 'other', name: 'Other', variables: makeVars({ cash: 30000 }) }]);
      richLoop.submitDecisions('room-r', 'rich', { strategic: [{ name: 'Costly Move' }], operational: [], financial: [], lawsuits: [] });
      richLoop.submitDecisions('room-r', 'other', { strategic: [], operational: [], financial: [], lawsuits: [] });
      poorLoop.submitDecisions('room-p', 'poor', { strategic: [{ name: 'Costly Move' }], operational: [], financial: [], lawsuits: [] });
      poorLoop.submitDecisions('room-p', 'other', { strategic: [], operational: [], financial: [], lawsuits: [] });

      const richOutcome = richLoop.resolveTurn('room-r', 1, richPlayers);
      const poorOutcome = poorLoop.resolveTurn('room-p', 1, poorPlayers);
      const rich = richOutcome.result.players.find((p) => p.playerId === 'rich')!;
      const poor = poorOutcome.result.players.find((p) => p.playerId === 'poor')!;

      const richCostThisTurn = 1000000 - rich.variables.cash;
      const poorCostThisTurn = 30000 - poor.variables.cash;
      // Both deployed the identical decision — the rich player's total out-of-pocket cost
      // this turn is meaningfully larger, purely from the wealth-scaled surcharge.
      expect(richCostThisTurn).toBeGreaterThan(poorCostThisTurn);
    });

    it('does not scale a decision\'s cost at all when decisionCostWealthScaleRate is 0 (default, backward-compatible)', () => {
      const loop = new GameLoop(makeWealthScaleConfig(0));
      loop.loadFormulas(DEFAULT_FORMULA_SEEDS);
      loop.loadDecisions([{
        decision: 'Costly Move', level: 'Strategic', description: 'x', nature: 'Traditional', offensiveAction: false, excludes: [],
        impacts: { cash: { type: 'absolute', schedule: { 1: -10000, default: 0 } } },
      }]);
      const players = makePlayers([
        { id: 'rich', name: 'Rich', variables: makeVars({ cash: 1000000 }) },
        { id: 'other', name: 'Other' },
      ]);
      loop.submitDecisions('room-1', 'rich', { strategic: [{ name: 'Costly Move' }], operational: [], financial: [], lawsuits: [] });
      loop.submitDecisions('room-1', 'other', { strategic: [], operational: [], financial: [], lawsuits: [] });

      const outcome = loop.resolveTurn('room-1', 1, players);
      const rich = outcome.result.players.find((p) => p.playerId === 'rich')!;
      const costThisTurn = 1000000 - rich.variables.cash;

      // Only the flat 10,000 base cost (plus/minus ordinary P&L noise) — no 20,000 surcharge.
      expect(costThisTurn).toBeLessThan(15000);
    });
  });

  describe('resolveTurn — legal risks (deliberate filing only)', () => {
    it('should NOT create a legal case just because a decision has legalRisks — filing is required', () => {
      // Alice deploys a risky decision but nobody files suit over it
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases).toEqual([]);
    });

    it('should create a legal case when another player deliberately files suit over a decision the target actually deployed', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases!.length).toBe(1);
      expect(aliceCases![0].groundName).toBe('Environmental Violation');
      expect(aliceCases![0].defendantId).toBe('player-1');
      expect(aliceCases![0].plaintiffId).toBe('player-2');
    });

    it('should not duplicate a case across turns just because it is persisted into both the plaintiff and defendant\'s own engineState (regression)', () => {
      // A case is persisted into BOTH parties' own engineState.legalCases at the end
      // of the turn it's filed in — each side needs it in their own persisted state.
      // Reconstructing allCases naively by concatenating every player's persisted
      // list would therefore double-count it (and double it again every subsequent
      // turn, since the duplicate gets re-persisted into both copies again).
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate = outcome1.companyUpdates.find(u => u.playerId === 'player-2')!;

      // Sanity check: both parties' own persisted state carries a copy of the same case.
      expect(aliceUpdate.engineState.legalCases).toHaveLength(1);
      expect(bobUpdate.engineState.legalCases).toHaveLength(1);
      expect(aliceUpdate.engineState.legalCases[0].id).toBe(bobUpdate.engineState.legalCases[0].id);

      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players);

      const aliceCasesTurn2 = outcome2.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      const bobCasesTurn2 = outcome2.result.players.find((p) => p.playerId === 'player-2')?.legalCases;
      expect(aliceCasesTurn2).toHaveLength(1);
      expect(bobCasesTurn2).toHaveLength(1);

      // And it must stay deduplicated on yet another turn, not just the first reload.
      const aliceUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-2')!;
      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate2.variables, engineState: aliceUpdate2.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate2.variables, engineState: bobUpdate2.engineState },
      ]);
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      expect(outcome3.result.players.find((p) => p.playerId === 'player-1')?.legalCases).toHaveLength(1);
      expect(outcome3.result.players.find((p) => p.playerId === 'player-2')?.legalCases).toHaveLength(1);
    });

    it('should force a case to trial after negotiationPeriodTurns, resolving it that same turn (regression — a case had no path out of "negotiating" at all before this)', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      // Turn 1: freshly filed — never incremented the same turn it's created.
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate1 = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate1 = outcome1.companyUpdates.find(u => u.playerId === 'player-2')!;
      const case1 = aliceUpdate1.engineState.legalCases[0];
      expect(case1.status).toBe('negotiating');
      expect(case1.turnsNegotiating).toBe(0);

      // Turn 2: one full turn spent negotiating — makeConfig's negotiationPeriodTurns is 2, not reached yet.
      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: bobUpdate1.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);
      const aliceUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-2')!;
      const case2 = aliceUpdate2.engineState.legalCases[0];
      expect(case2.status).toBe('negotiating');
      expect(case2.turnsNegotiating).toBe(1);

      // Turn 3: crosses the threshold and resolves in this same turn.
      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate2.variables, engineState: aliceUpdate2.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate2.variables, engineState: bobUpdate2.engineState },
      ]);
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      const aliceCase3 = outcome3.result.players.find((p) => p.playerId === 'player-1')?.legalCases[0];
      expect(aliceCase3?.status).toBe('resolved');
      expect(['won', 'lost']).toContain(aliceCase3?.verdict);
    });

    it('should still create a case — a hopeless, 0%-probability one — when the cited decision was never deployed by the target (a guess)', () => {
      // Alice deploys nothing risky; Bob guesses (wrongly) that she did — the SUE THEIR
      // ASSES modal offers the whole decision library's grounds, not just what a target
      // actually did, so this must still be a real, visible (if unwinnable) case, not a
      // silently-dropped filing.
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases).toHaveLength(1);
      expect(aliceCases![0].baseProbability).toBe(0);
    });

    it('should force baseProbability to 0 for a CORRECT ground once the target\'s decision instance is past the statute of limitations (makeConfig: 10 years)', () => {
      // Unlike the wrong-guess test above, Alice genuinely deployed Water Pumping — the
      // ground is real, just too old to sue over (elapsedYears already at the 10-year cap).
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: 'wp-1', definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 10, isMatured: true }] } },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 11, players);

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases).toHaveLength(1);
      expect(aliceCases![0].groundName).toBe('Environmental Violation');
      expect(aliceCases![0].baseProbability).toBe(0);
    });

    it('should still price a real, non-zero probability for a correct ground just under the statute of limitations', () => {
      // Step 2 (advanceAndApply) increments elapsedYears BEFORE Step 8 reads it for
      // filing, so an instance that's 8 years old entering this turn is 9 by the time
      // the lawsuit is priced — still one year under makeConfig's 10-year cap.
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: 'wp-1', definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 8, isMatured: true }] } },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 10, players);

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases![0].baseProbability).toBeGreaterThan(0);
    });

    describe('plaintiffFullyInvestigated (persisted at filing time)', () => {
      // Bot Attack targets whoever `targetId` names and carries exactly one legal
      // ground ('CFAA Digital Sabotage Lawsuit') — Alice deploys it against Bob. Carol is
      // a third, otherwise-uninvolved active player included purely to keep this fixture
      // OUT of the heads-up investigation shortcut (effectiveInvestigationLevel) — the
      // "dug in but not all the way (level 2)" test below specifically needs level 2 to
      // still mean "not fully investigated," which only holds with more than one other
      // active player in the game.
      const withBotAttack = (investigations: Record<string, number> = {}) => makePlayers([
        {
          id: 'player-1', name: 'Alice',
          engineState: { activeDecisions: [{ id: 'attack-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: false, targetId: 'player-2' }] },
        },
        { id: 'player-2', name: 'Bob', engineState: { investigations } },
        { id: 'player-3', name: 'Carol' },
      ]);

      it('should stamp plaintiffFullyInvestigated true when the victim dug all the way in before suing over the matching ground', () => {
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [], financial: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Bot Attack', groundName: 'CFAA Digital Sabotage Lawsuit' }],
        });

        const outcome = gameLoop.resolveTurn('room-1', 1, withBotAttack({ 'attack-1': 3 }));

        const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(true);
      });

      it('should leave plaintiffFullyInvestigated false when the victim never dug at all', () => {
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [], financial: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Bot Attack', groundName: 'CFAA Digital Sabotage Lawsuit' }],
        });

        const outcome = gameLoop.resolveTurn('room-1', 1, withBotAttack());

        const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(false);
      });

      it('should leave plaintiffFullyInvestigated false when the victim dug in but not all the way (level 2)', () => {
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [], financial: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Bot Attack', groundName: 'CFAA Digital Sabotage Lawsuit' }],
        });

        const outcome = gameLoop.resolveTurn('room-1', 1, withBotAttack({ 'attack-1': 2 }));

        const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(false);
      });

      it('should leave plaintiffFullyInvestigated false when suing over a different decision instance than the one investigated', () => {
        // Fully investigated 'attack-1', but files against a decision that isn't
        // actually targeting them at all (Water Pumping has no targetId concept).
        gameLoop.submitDecisions('room-1', 'player-1', {
          strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
        });
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [], financial: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
        });

        const outcome = gameLoop.resolveTurn('room-1', 1, withBotAttack({ 'attack-1': 3 }));

        const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(false);
      });

      it('should also stamp plaintiffFullyInvestigated true for an INDIRECT decision (no targetId at all) fully dug in before suing the right ground', () => {
        // Water Pumping never sets targetId — the old lookup (d.targetId === ctx.playerId)
        // could never match it, so this path used to be structurally impossible to earn
        // regardless of investigation depth. Alice deploys it this same turn; Bob (an
        // otherwise-uninvolved bystander here, not Water Pumping's "victim" — it has none)
        // fully investigates it and sues over the real suggested ground.
        gameLoop.submitDecisions('room-1', 'player-1', {
          strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
        });

        // First turn: deploy Water Pumping and capture its freshly generated instance id.
        const deployOutcome = gameLoop.resolveTurn('room-1', 1, withBotAttack());
        const wpInstance = deployOutcome.result.players
          .find((p) => p.playerId === 'player-1')!.activeDecisions
          .find((d) => d.decisionName === 'Water Pumping')!;

        // Second turn: Bob is already fully dug into that specific instance, and sues
        // over its real suggested ground.
        const persistedAlice = deployOutcome.companyUpdates.find((u) => u.playerId === 'player-1')!;
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [], financial: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
        });
        const players2 = makePlayers([
          { id: 'player-1', name: 'Alice', variables: persistedAlice.variables, engineState: persistedAlice.engineState },
          { id: 'player-2', name: 'Bob', engineState: { investigations: { [wpInstance.id]: 3 } } },
          { id: 'player-3', name: 'Carol' },
        ]);
        const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);

        const bobCase = outcome2.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(true);
      });

      it('stamps true when fully investigated and suing over ANY suggested ground on a multi-ground decision, not just the strongest one', () => {
        // 'Risky Fundraising' carries two legalRisks — a fully-investigated player now
        // sees both (see the dedicated "surfaces ALL of them" describe block above), and
        // choosing the weaker of the two should count exactly the same as choosing the
        // strongest: both were genuinely shown to them.
        gameLoop.submitDecisions('room-1', 'player-1', {
          strategic: [], operational: [{ name: 'Risky Fundraising' }], financial: [], lawsuits: [],
        });
        const deployOutcome = gameLoop.resolveTurn('room-1', 1, withBotAttack());
        const rfInstance = deployOutcome.result.players
          .find((p) => p.playerId === 'player-1')!.activeDecisions
          .find((d) => d.decisionName === 'Risky Fundraising')!;

        const persistedAlice = deployOutcome.companyUpdates.find((u) => u.playerId === 'player-1')!;
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [], financial: [],
          // The WEAKER of the two suggested grounds, not the top-sorted one.
          lawsuits: [{ targetId: 'player-1', decisionName: 'Risky Fundraising', groundName: 'Unfair Competition via Fundraising' }],
        });
        const players2 = makePlayers([
          { id: 'player-1', name: 'Alice', variables: persistedAlice.variables, engineState: persistedAlice.engineState },
          { id: 'player-2', name: 'Bob', engineState: { investigations: { [rfInstance.id]: 3 } } },
          { id: 'player-3', name: 'Carol' },
        ]);
        const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);

        const bobCase = outcome2.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(true);
      });
    });
  });

  describe('resolveTurn — relative-type legal-risk stakes are priced off the defendant\'s own current field, not the raw schedule fraction (regression)', () => {
    // A real, reported bug: a `relative`-type legal risk's schedule value is a fraction
    // (e.g. -0.45), meant to be scaled against the defendant's own current value of
    // `impact.target` (equity/revenue) — not read as a raw dollar figure the way an
    // `absolute`-type risk's schedule already is. Reading it as a raw figure silently
    // produced stakes like 0.45, which rounds to display as "$0" everywhere stakes are
    // shown (the settlement offer bracket, the "You paid/received" trial-outcome line).
    it('prices an equity-relative ground off the defendant\'s own turn-computed equity, not the raw schedule fraction', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Risky Fundraising' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Risky Fundraising', groundName: 'Fraudulent Capital Procurement' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceEquity = outcome.result.players.find((p) => p.playerId === 'player-1')!.derived.equity;
      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      // Stakes always use the default schedule value regardless of elapsedYears — same
      // "not time-scaled the way probability is" convention absolute-type grounds already
      // follow (see the Environmental Violation test below, unaffected by this fix).
      expect(aliceCase.stakes).toBeCloseTo(aliceEquity * 0.45, 4);
      expect(aliceCase.stakes).toBeGreaterThan(1); // sanity check against the bug's sub-$1 output
    });

    it('prices a revenue-relative ground off the defendant\'s own turn-computed revenue, not the raw schedule fraction', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Risky Fundraising' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Risky Fundraising', groundName: 'Unfair Competition via Fundraising' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceRevenue = outcome.result.players.find((p) => p.playerId === 'player-1')!.derived.revenue;
      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      expect(aliceCase.stakes).toBeCloseTo(aliceRevenue * 0.4, 4);
      expect(aliceCase.stakes).toBeGreaterThan(1);
    });

    it('still prices an absolute-type ground (e.g. Environmental Violation) exactly as before, unaffected by the relative-type fix', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      expect(aliceCase.stakes).toBe(22050);
    });
  });

  describe('resolveTurn — incoming-attack hint stakes correctly price a revenue-relative ground (regression)', () => {
    // A real, reported bug, one step over from the filing-time fix above: `revealAttack`
    // (populates the incoming-attack hint's `suggestedGrounds[].stakes`, via `pickAllGrounds`)
    // reads `attackerCtx.vars.revenue` directly — but like `equity`, `revenue` is never
    // actually persisted onto `PlayerVariables`, only ever materialized fresh into a
    // turn's own local `plMap`. Every relative-type ground targeting revenue (17 of the
    // 25 in the real library) showed a flatly wrong "$0" stakes on the hint card as a
    // result — fixed by patching the same plMap-sourced revenue into the vars
    // `buildIncomingAttacks` passes to `revealAttack`, mirroring Step 8's own fix.
    it('does not show $0 stakes for a revenue-relative ground on a fully-investigated incoming-attack hint', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Revenue Manipulation Scheme' }], financial: [], lawsuits: [],
      });
      const deployOutcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const rfInstance = deployOutcome.result.players
        .find((p) => p.playerId === 'player-1')!.activeDecisions
        .find((d) => d.decisionName === 'Revenue Manipulation Scheme')!;

      const persistedAlice = deployOutcome.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const persistedBob = deployOutcome.companyUpdates.find((u) => u.playerId === 'player-2')!;
      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: persistedAlice.variables, engineState: persistedAlice.engineState },
        {
          id: 'player-2', name: 'Bob', variables: persistedBob.variables,
          engineState: { ...(persistedBob.engineState as object), investigations: { [rfInstance.id]: 3 } },
        },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);

      const bobAttacks = outcome2.result.players.find((p) => p.playerId === 'player-2')!.incomingAttacks;
      const rfAttack = bobAttacks.find((a) => a.decisionName === 'Revenue Manipulation Scheme');
      expect(rfAttack).toBeDefined();
      expect(rfAttack!.suggestedGrounds?.[0]?.name).toBe('Revenue Misrepresentation Claim');

      const aliceRevenueTurn2 = outcome2.result.players.find((p) => p.playerId === 'player-1')!.derived.revenue;
      expect(rfAttack!.suggestedGrounds?.[0]?.stakes).toBeCloseTo(aliceRevenueTurn2 * 0.4, 4);
      expect(rfAttack!.suggestedGrounds?.[0]?.stakes).toBeGreaterThan(1); // sanity check against the $0 bug
    });
  });

  describe('resolveTurn — lawsuit voids the sued decision (regression)', () => {
    /** Alice deploys Water Pumping (permanent -50/year materialCostPerTon effect,
     * matures instantly since it has only a 'default' schedule key) in turn 1; Bob
     * sues over it the same turn. Advances two more turns so the case crosses
     * makeConfig's negotiationPeriodTurns (2) and is forced to trial, resolving in
     * that same third turn — the same sequence as the "should force a case to
     * trial..." test above. Returns the players array for that third, trial-resolving
     * call so each test can control the verdict via Math.random. */
    function fileAndForceToTrial() {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate1 = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate1 = outcome1.companyUpdates.find(u => u.playerId === 'player-2')!;

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: bobUpdate1.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);
      const aliceUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-2')!;

      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate2.variables, engineState: aliceUpdate2.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate2.variables, engineState: bobUpdate2.engineState },
      ]);
      return players3;
    }

    it('should void the sued instance when the plaintiff wins at trial — cancels forthcoming effects, matures it immediately, and frees it for redeployment', () => {
      const players3 = fileAndForceToTrial();

      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // Math.random() < adjProb is always true → plaintiff wins
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      randomSpy.mockRestore();

      const alice3 = outcome3.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice3.legalCases[0].verdict).toBe('won');

      const wpInstance3 = alice3.activeDecisions.find((d) => d.decisionName === 'Water Pumping')!;
      expect(wpInstance3.isMatured).toBe(true);
      expect(wpInstance3.voidedByLawsuit).toBe(true);

      // Forthcoming effects are cancelled — materialCostPerTon must not move again on
      // the very next turn (Water Pumping's -50/year would otherwise keep applying
      // forever, since it only has a 'default' schedule key).
      const aliceUpdate3 = outcome3.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const players4 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate3.variables, engineState: aliceUpdate3.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);
      const outcome4 = gameLoop.resolveTurn('room-1', 4, players4);
      const alice4 = outcome4.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice4.variables.materialCostPerTon).toBe(alice3.variables.materialCostPerTon);

      // The decision is now redeployable — canDeploy no longer blocks it now that its
      // only matured instance was voided rather than a successful completion.
      const aliceUpdate4 = outcome4.companyUpdates.find((u) => u.playerId === 'player-1')!;
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      const players5 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate4.variables, engineState: aliceUpdate4.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);
      const outcome5 = gameLoop.resolveTurn('room-1', 5, players5);
      const alice5 = outcome5.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice5.activeDecisions.filter((d) => d.decisionName === 'Water Pumping')).toHaveLength(2);
    });

    it('should NOT void the sued instance when the defendant wins at trial', () => {
      const players3 = fileAndForceToTrial();

      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999); // Math.random() < adjProb is always false → defendant wins
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      randomSpy.mockRestore();

      const alice3 = outcome3.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice3.legalCases[0].verdict).toBe('lost');

      const wpInstance3 = alice3.activeDecisions.find((d) => d.decisionName === 'Water Pumping')!;
      expect(wpInstance3.voidedByLawsuit).toBe(false);
    });
  });

  describe("resolveTurn — a WON trial verdict is capped to the defendant's actual available cash (regression)", () => {
    it('pays the full stakes when the defendant has enough cash — no change to the common case', () => {
      const case_ = makeCase({ status: 'awaiting_trial', stakes: 20000, baseProbability: 1 });
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // Math.random() < adjProb → plaintiff wins
      const outcome = gameLoop.resolveTurn('room-1', 1, playersWithCase(case_, { 'player-1': 500000 }));
      randomSpy.mockRestore();

      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice.legalCases[0].verdict).toBe('won');
      expect(alice.legalCases[0].actualAmountPaid).toBeUndefined();
    });

    it("caps the payout to the defendant's actual available cash when stakes exceed it, and eliminates the defendant for insolvency", () => {
      // The cap still applies (a plaintiff can never collect money that doesn't exist),
      // but a defendant who couldn't cover the judgment is now eliminated — see
      // `insolventFromJudgment`. Before that fix they survived on exactly $0.00, because
      // Step 10's bankruptcy test is `cash < 0` and the cap deliberately stops at zero;
      // a real 2026-08-12 game had two different players survive judgments they could not
      // pay, one of them sitting on exactly 0.00 for two consecutive rounds. Alice is
      // therefore excluded from outcome.result.players (see BankruptedPlayer's own doc
      // comment), so the payout is read back off Bob's copy of the same case.
      const case_ = makeCase({ status: 'awaiting_trial', stakes: 10000000, baseProbability: 1 });
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const outcome = gameLoop.resolveTurn('room-1', 1, playersWithCase(case_, { 'player-1': 5000 }));
      randomSpy.mockRestore();

      const bankruptAlice = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1')!;
      expect(bankruptAlice).toBeDefined();
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      expect(bob.legalCases[0].verdict).toBe('won');
      expect(bob.legalCases[0].actualAmountPaid).toBeDefined();
      expect(bob.legalCases[0].actualAmountPaid!).toBeLessThan(10000000);
      expect(bob.legalCases[0].actualAmountPaid!).toBeGreaterThanOrEqual(0);
      // Fully drained by this payment, but never pushed negative purely by it — the
      // elimination comes from the unpayable judgment, not from a negative balance.
      expect(bankruptAlice.finalVariables.cash).toBeCloseTo(0, 0);
    });

    it('does NOT eliminate a defendant who covered the judgment in full', () => {
      // The insolvency rule above must key off "the cap actually bit", never off landing
      // near zero — a defendant who pays the whole judgment and happens to end up broke is
      // still solvent and stays in the game.
      const case_ = makeCase({ status: 'awaiting_trial', stakes: 20000, baseProbability: 1 });
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const outcome = gameLoop.resolveTurn('room-1', 1, playersWithCase(case_, { 'player-1': 500000 }));
      randomSpy.mockRestore();

      expect(outcome.bankruptedPlayers.map((b) => b.playerId)).not.toContain('player-1');
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice.legalCases[0].actualAmountPaid).toBeUndefined();
    });

    it("shares the defendant's available cash across multiple simultaneous WON verdicts, oldest filed case first (FIFO)", () => {
      const caseA = makeCase({
        id: 'case-a',
        plaintiffId: 'player-2',
        defendantId: 'player-1',
        stakes: 10000000,
        status: 'awaiting_trial',
        baseProbability: 1,
        createdAt: new Date('2024-01-01T00:00:00Z'),
      });
      const caseB = makeCase({
        id: 'case-b',
        plaintiffId: 'player-3',
        defendantId: 'player-1',
        stakes: 10000000,
        status: 'awaiting_trial',
        baseProbability: 1,
        createdAt: new Date('2024-01-02T00:00:00Z'), // filed later than caseA
      });
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 8000 }), engineState: { legalCases: [caseA, caseB] } },
        { id: 'player-2', name: 'Bob', engineState: { legalCases: [caseA] } },
        { id: 'player-3', name: 'Carol', engineState: { legalCases: [caseB] } },
      ]);
      const outcome = gameLoop.resolveTurn('room-1', 1, players);
      randomSpy.mockRestore();

      // Alice cannot cover either judgment, so she is eliminated for insolvency and drops
      // out of result.players — read each case back off its own plaintiff's copy.
      const bankruptAlice = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1')!;
      expect(bankruptAlice).toBeDefined();
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;
      const caseAResult = bob.legalCases.find((c) => c.id === 'case-a')!;
      const caseBResult = carol.legalCases.find((c) => c.id === 'case-b')!;

      expect(caseAResult.verdict).toBe('won');
      expect(caseBResult.verdict).toBe('won');
      // The older case (filed first) gets whatever cash was actually available...
      expect(caseAResult.actualAmountPaid!).toBeGreaterThan(0);
      // ...leaving nothing left over for the later-filed case.
      expect(caseBResult.actualAmountPaid).toBe(0);
      expect(bankruptAlice.finalVariables.cash).toBeCloseTo(0, 0);
    });

    it("pays nothing to the plaintiff when the defendant's cash is already negative before this payment — only positive cash is ever shared", () => {
      // Alice's cash is so deeply negative (and her production zeroed out, so this turn's
      // ordinary P&L can't rescue her) that she also goes bankrupt this same turn — Step 9's
      // payout still has to run (and cap to $0) before Step 10's bankruptcy check does, so
      // Alice herself is excluded from outcome.result.players (see BankruptedPlayer's own
      // doc comment); read the payout back off Bob's copy of the same case instead, kept in
      // sync between both parties' engineState.legalCases by design.
      const case_ = makeCase({ status: 'awaiting_trial', stakes: 20000, baseProbability: 1 });
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const players = makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          variables: makeVars({ cash: -50000, installedCapacity: 0, capacityUtilization: 0 }),
          engineState: { legalCases: [case_] },
        },
        { id: 'player-2', name: 'Bob', engineState: { legalCases: [case_] } },
      ]);
      const outcome = gameLoop.resolveTurn('room-1', 1, players);
      randomSpy.mockRestore();

      expect(outcome.bankruptedPlayers.map((b) => b.playerId)).toContain('player-1');
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;
      expect(bob.legalCases[0].verdict).toBe('won');
      expect(bob.legalCases[0].actualAmountPaid).toBe(0);
    });
  });

  describe('resolveTurn — a case whose dates came back from JSONB as strings (regression)', () => {
    // A real production outage (2026-08-12). `LegalCaseData.createdAt` is typed `Date` and
    // created as `new Date()`, but it lives in `Company.engineState` — a Postgres JSONB
    // column — and comes back as an ISO **string**. Nothing in the type system notices,
    // because the JSONB read is cast straight to `LegalCaseData`. The FIFO comparators in
    // `distributeCaseWaterfall` and Step 9 then called `.getTime()` on a string and threw
    // `TypeError: b.createdAt.getTime is not a function`, which aborted the entire turn
    // mid-elimination and (because `startTimer` sat inside the try) left the room with no
    // turn timer at all — a permanently frozen game.
    //
    // No pre-existing test layer could catch this: GameLoop is pure and in-memory, so
    // `createdAt` stays a real Date for the whole life of every unit test and simulation.
    // These tests deliberately feed the engine what Postgres actually hands back.
    const asJsonbRoundTrip = (c: LegalCaseData): LegalCaseData =>
      JSON.parse(JSON.stringify(c)) as LegalCaseData;

    it('sorts string-dated cases in the waterfall without throwing, when a defendant is eliminated', () => {
      // Two unresolved cases against a defendant who bankrupts this turn — the exact shape
      // that reached the waterfall's `.sort()`. A single-element sort never invokes the
      // comparator, which is why this only ever blew up once a player had 2+ open cases.
      const caseA = asJsonbRoundTrip(makeCase({
        id: 'case-a', plaintiffId: 'player-2', defendantId: 'player-1',
        stakes: 5000, status: 'negotiating', createdAt: new Date('2024-01-01T00:00:00Z'),
      }));
      const caseB = asJsonbRoundTrip(makeCase({
        id: 'case-b', plaintiffId: 'player-3', defendantId: 'player-1',
        stakes: 5000, status: 'negotiating', createdAt: new Date('2024-01-02T00:00:00Z'),
      }));
      expect(typeof (caseA.createdAt as unknown)).toBe('string'); // guard: the fixture really is what Postgres returns

      const players = makePlayers([
        {
          id: 'player-1', name: 'Alice',
          variables: makeVars({ cash: -50000, installedCapacity: 0, capacityUtilization: 0 }),
          engineState: { legalCases: [caseA, caseB] },
        },
        { id: 'player-2', name: 'Bob', engineState: { legalCases: [caseA] } },
        { id: 'player-3', name: 'Carol', engineState: { legalCases: [caseB] } },
      ]);

      expect(() => gameLoop.resolveTurn('room-1', 1, players)).not.toThrow();
      const outcome = gameLoop.resolveTurn('room-1', 1, players);
      expect(outcome.bankruptedPlayers.map((b) => b.playerId)).toContain('player-1');
    });

    it('sorts string-dated cases in Step 9 FIFO order, oldest filed first', () => {
      const caseA = asJsonbRoundTrip(makeCase({
        id: 'case-a', plaintiffId: 'player-2', defendantId: 'player-1',
        stakes: 10000000, status: 'awaiting_trial', baseProbability: 1,
        createdAt: new Date('2024-01-01T00:00:00Z'),
      }));
      const caseB = asJsonbRoundTrip(makeCase({
        id: 'case-b', plaintiffId: 'player-3', defendantId: 'player-1',
        stakes: 10000000, status: 'awaiting_trial', baseProbability: 1,
        createdAt: new Date('2024-01-02T00:00:00Z'),
      }));
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 8000 }), engineState: { legalCases: [caseA, caseB] } },
        { id: 'player-2', name: 'Bob', engineState: { legalCases: [caseA] } },
        { id: 'player-3', name: 'Carol', engineState: { legalCases: [caseB] } },
      ]);
      const outcome = gameLoop.resolveTurn('room-1', 1, players);
      randomSpy.mockRestore();

      // Ordering survives the string dates: the older case is paid first and takes it all.
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;
      expect(bob.legalCases.find((c) => c.id === 'case-a')!.actualAmountPaid!).toBeGreaterThan(0);
      expect(carol.legalCases.find((c) => c.id === 'case-b')!.actualAmountPaid).toBe(0);
    });
  });

  describe('resolveTurn — settlement/void-instance behavior (existing coverage, unrelated to the payout cap above)', () => {
    it('should void the sued instance when an unanswered offer auto-settles at a turn boundary (Step 8b)', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const bobUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-2')!;
      const caseId = aliceUpdate1.engineState.legalCases[0].id;

      // The defendant (Alice) makes an offer out-of-band, the plaintiff (Bob) counters
      // — genuine back-and-forth — and then nobody responds before the next turn
      // boundary, so Step 8b treats the standing offer as accepted (a single one-sided
      // offer alone no longer auto-settles — see this describe block's own regression
      // tests — so this fixture needs real back-and-forth to exercise this path).
      const offerPlayers = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: bobUpdate1.engineState },
      ]);
      const offerOutcome = gameLoop.makeOffer('player-1', caseId, 5000, offerPlayers);
      expect(offerOutcome.success).toBe(true);
      if (!offerOutcome.success) return;

      const counterPlayers = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: offerOutcome.defendant.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: offerOutcome.plaintiff.engineState },
      ]);
      const counterOutcome = gameLoop.makeOffer('player-2', caseId, 8000, counterPlayers);
      expect(counterOutcome.success).toBe(true);
      if (!counterOutcome.success) return;

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: counterOutcome.defendant.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: counterOutcome.plaintiff.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);

      const alice2 = outcome2.result.players.find((p) => p.playerId === 'player-1')!;
      const case2 = alice2.legalCases[0];
      expect(case2.status).toBe('resolved');
      expect(case2.verdict).toBe('settled');

      const wpInstance2 = alice2.activeDecisions.find((d) => d.decisionName === 'Water Pumping')!;
      expect(wpInstance2.isMatured).toBe(true);
      expect(wpInstance2.voidedByLawsuit).toBe(true);
    });
  });

  describe('resolveTurn — a permanent effect naturally expires at the statute of limitations (regression)', () => {
    it('stops applying New Factory\'s permanent installedCapacity effect once it ages past makeConfig\'s statuteOfLimitationsYears (10)', () => {
      const players = makePlayers([
        {
          id: 'player-1', name: 'Alice',
          variables: makeVars({ installedCapacity: 20000 }),
          engineState: { activeDecisions: [{ id: 'nf-1', definitionName: 'New Factory', deployedYear: 1, elapsedYears: 9, isMatured: true }] },
        },
        { id: 'player-2', name: 'Bob' },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 11, players);
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // elapsedYears becomes 10 this turn — at the statute — so New Factory's permanent
      // +5000/turn installedCapacity effect no longer applies (it would have, pre-feature).
      expect(alice.variables.installedCapacity).toBe(20000);

      const nfInstance = alice.activeDecisions.find((d) => d.decisionName === 'New Factory')!;
      expect(nfInstance.elapsedYears).toBe(10);
      expect(nfInstance.isMatured).toBe(true);
      expect(nfInstance.voidedByLawsuit).toBe(false); // expired naturally, not sued over
    });
  });

  describe('resolveTurn — permanentEffectCooldownYears gates redeployment independently of the (much longer) legal statute of limitations (regression)', () => {
    // Confirms the actual fix requested for CLAUDE.md's "matured decisions never come
    // back" gap: canDeploy used to reuse gameSettings.statuteOfLimitationsYears (10 in
    // makeConfig) for its permanent-effect redeploy lock, which — given typical games run
    // ~12-15 rounds — made a permanent-effect decision an effective one-time-per-game
    // pick. It's now gated on the separate, shorter makeConfig().gameSettings.
    // permanentEffectCooldownYears (3) instead, well before the statute (10) would ever
    // be reached.
    it('still blocks redeployment while the instance is younger than permanentEffectCooldownYears (3)', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: 'nf-1', definitionName: 'New Factory', deployedYear: 1, elapsedYears: 1, isMatured: true }] } },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-1', { strategic: [{ name: 'New Factory' }], operational: [], financial: [], lawsuits: [] });

      const outcome = gameLoop.resolveTurn('room-1', 2, players);
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice.activeDecisions.filter((d) => d.decisionName === 'New Factory')).toHaveLength(1);
    });

    it('allows redeployment once the instance ages past permanentEffectCooldownYears (3) — long before the statute of limitations (10) would free it', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: 'nf-1', definitionName: 'New Factory', deployedYear: 1, elapsedYears: 3, isMatured: true }] } },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-1', { strategic: [{ name: 'New Factory' }], operational: [], financial: [], lawsuits: [] });

      const outcome = gameLoop.resolveTurn('room-1', 4, players);
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice.activeDecisions.filter((d) => d.decisionName === 'New Factory')).toHaveLength(2);
    });
  });

  describe('resolveTurn — one lawsuit per decision instance, ever (regression)', () => {
    it('gives the first plaintiff a real case and a same-turn second plaintiff a hopeless (0%) one, first come first served', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      gameLoop.submitDecisions('room-1', 'player-3', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const players = makePlayers([
        { id: 'player-1', name: 'Alice' },
        { id: 'player-2', name: 'Bob' },
        { id: 'player-3', name: 'Carol' },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 1, players);
      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases;
      expect(aliceCases).toHaveLength(2);

      const bobCase = aliceCases.find((c) => c.plaintiffId === 'player-2')!;
      const carolCase = aliceCases.find((c) => c.plaintiffId === 'player-3')!;
      expect(bobCase.baseProbability).toBeGreaterThan(0);
      expect(bobCase.defendantDecisionInstanceId).toBeDefined();
      expect(carolCase.baseProbability).toBe(0);
      expect(carolCase.defendantDecisionInstanceId).toBeUndefined();
    });

    it('keeps blocking a second lawsuit against the same instance even after the first case resolves and drops out of legalCases history', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const originalCaseId = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!.engineState.legalCases[0].id;
      let aliceUpdate = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      let bobUpdate = outcome1.companyUpdates.find((u) => u.playerId === 'player-2')!;

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);
      aliceUpdate = outcome2.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome2.companyUpdates.find((u) => u.playerId === 'player-2')!;

      // Forced to trial this turn (negotiationPeriodTurns crossed) — force a defendant win
      // (verdict 'lost') so the instance stays un-voided, isolating the everSued mechanism
      // from the separate lawsuit-voiding one tested elsewhere.
      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999);
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      randomSpy.mockRestore();
      const alice3 = outcome3.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice3.legalCases[0].verdict).toBe('lost');
      expect(alice3.activeDecisions.find((d) => d.decisionName === 'Water Pumping')!.voidedByLawsuit).toBe(false);
      aliceUpdate = outcome3.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome3.companyUpdates.find((u) => u.playerId === 'player-2')!;

      // One more turn — the resolved case drops out of persisted engineState.legalCases
      // entirely (the pre-existing "resolved cases are transient" behavior).
      const players4 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome4 = gameLoop.resolveTurn('room-1', 4, players4);
      aliceUpdate = outcome4.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome4.companyUpdates.find((u) => u.playerId === 'player-2')!;
      expect(aliceUpdate.engineState.legalCases.find((c) => c.id === originalCaseId)).toBeUndefined();

      // A fresh lawsuit against the same still-live (not voided) instance must still be
      // hopeless — the instance itself remembers it was already sued, independent of
      // whether the original case is still visible in anyone's persisted history.
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const players5 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome5 = gameLoop.resolveTurn('room-1', 5, players5);
      const newCase = outcome5.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      expect(newCase.baseProbability).toBe(0);
      expect(newCase.defendantDecisionInstanceId).toBeUndefined();
    });

    it('allows suing a freshly redeployed instance of the same decision name — the block is per instance, not per name', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      let aliceUpdate = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      let bobUpdate = outcome1.companyUpdates.find((u) => u.playerId === 'player-2')!;

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);
      aliceUpdate = outcome2.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome2.companyUpdates.find((u) => u.playerId === 'player-2')!;

      // Force a plaintiff win this turn — voids the original instance and frees it for
      // redeployment (the separate lawsuit-voiding feature tested elsewhere).
      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      randomSpy.mockRestore();
      aliceUpdate = outcome3.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome3.companyUpdates.find((u) => u.playerId === 'player-2')!;

      // Redeploy Water Pumping (allowed now the old instance is voided) and sue the NEW
      // instance in the very same turn.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const players4 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome4 = gameLoop.resolveTurn('room-1', 4, players4);
      const alice4 = outcome4.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice4.activeDecisions.filter((d) => d.decisionName === 'Water Pumping')).toHaveLength(2);
      expect(alice4.legalCases).toHaveLength(1);
      expect(alice4.legalCases[0].baseProbability).toBeGreaterThan(0);
    });

    it('with two simultaneously-live instances of the same decision, a filing carrying attackId attaches to that EXACT instance, not just the first name match (regression)', () => {
      // Two genuinely live, un-sued Water Pumping instances at once — normal, intended
      // play (stacking a permanent-effect decision), not a contrived edge case. Without
      // attackId, a filing would always resolve to 'wp-old' (array order) regardless of
      // which one the plaintiff actually investigated — the real bug this test guards.
      const players = makePlayers([
        {
          id: 'player-1', name: 'Alice',
          engineState: {
            activeDecisions: [
              { id: 'wp-old', definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 5, isMatured: true },
              { id: 'wp-new', definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 0, isMatured: false },
            ],
          },
        },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation', attackId: 'wp-new' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, players);
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      expect(alice.legalCases).toHaveLength(1);
      expect(alice.legalCases[0].defendantDecisionInstanceId).toBe('wp-new');
      const wpNew = alice.activeDecisions.find((d) => d.id === 'wp-new')!;
      const wpOld = alice.activeDecisions.find((d) => d.id === 'wp-old')!;
      expect(wpNew.voidedByLawsuit).toBe(false); // not voided yet — just claimed as sued, verdict pending
      expect(wpOld.voidedByLawsuit).toBe(false);
      // Confirm the OLD instance is still freely suable — the bug this test guards against
      // would have claimed IT instead, permanently shielding wp-new from ever being sued.
      gameLoop.submitDecisions('room-2', 'player-2', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation', attackId: 'wp-old' }],
      });
      const outcome2 = gameLoop.resolveTurn('room-2', 1, players);
      const alice2 = outcome2.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice2.legalCases.find((c) => c.defendantDecisionInstanceId === 'wp-old')).toBeDefined();
      expect(alice2.legalCases.find((c) => c.defendantDecisionInstanceId === 'wp-old')!.baseProbability).toBeGreaterThan(0);
    });
  });

  describe('resolveTurn — Buy/Sell Shares (share-ownership & takeover mechanic)', () => {
    // Fresh objects every call — GameLoop reads `company.variables` by reference
    // (no internal clone), so reusing one binding across two independent resolveTurn
    // calls in the same test (e.g. a baseline-vs-actual comparison) would let the first
    // call's mutations leak into the second's "starting" fixture.
    const makeTargetVars = (overrides: Partial<PlayerVariables> = {}) => makeVars({
      cash: 50000, totalSharesOutstanding: 10000, stockValue: 10,
      shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 }, ...overrides,
    });
    const makeBuyerVars = (overrides: Partial<PlayerVariables> = {}) => makeVars({ cash: 100000, ...overrides });

    // Regression coverage for a real, reported bug: a bot bought 100% of a human
    // player's company on round 1 for a trivial spend. Root cause: `stockValue` is a
    // `"derived"` field, never seeded by `startingVars()` — it's genuinely `undefined`
    // before a company's first turn has ever resolved, not a real computed 0. Buy
    // Shares' pricing has a deliberate "price is exactly 0 → treat as a free takeover of
    // a distressed company" rule, and the old `stockValue ?? 0` fallback silently folded
    // "never computed" into that same 0-price case, firing the free-takeover rule for
    // EVERY company on round 1. Fixed via `startingStockValue` (book value per share —
    // equity / totalSharesOutstanding, no legalExposure/receivables since neither exists
    // pre-turn-1), used only when `stockValue` is strictly `undefined`.
    it('prices Buy Shares against a real starting book value on round 1, instead of treating a never-yet-computed stockValue as a free-takeover $0 (regression)', () => {
      // makeVars() deliberately leaves stockValue unset — mirrors a company that has
      // never had a turn resolve yet. equity = 100000+50000+10000+30000-20000 = 170000;
      // book value = 170000 / 10000 shares = $17/share.
      const neverResolvedTargetVars = makeVars({
        totalSharesOutstanding: 10000,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 },
      });
      expect(neverResolvedTargetVars.stockValue).toBeUndefined();

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [{ name: 'Buy Shares', targetId: 'player-1', amount: 8500 }], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: neverResolvedTargetVars },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // 8500 / 17 = 500 shares of 10000 = 5% — NOT the pre-fix 100%.
      expect(alice.variables.shareOwnership['player-2']).toBeCloseTo(0.05, 4);
      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.95, 4);
    });

    it('still treats a REAL computed stockValue of exactly 0 (a genuinely underwater company, post-turn-1) as a free takeover — the round-1 fix must not touch this intentional case', () => {
      const distressedTargetVars = makeTargetVars({ stockValue: 0 });

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [{ name: 'Buy Shares', targetId: 'player-1', amount: 1 }], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: distressedTargetVars },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
      ]));

      // Acquiring 100% crosses the majority-ownership takeover threshold within the SAME
      // turn, so Alice is merged out (Step 10) rather than appearing in result.players —
      // same "buying the whole company for $1" outcome the pre-fix bug produced BY
      // ACCIDENT on round 1, still correctly reachable here on purpose for a real $0 price.
      const merged = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1');
      expect(merged?.reason).toBe('merger');
      expect(merged?.acquirerId).toBe('player-2');
    });

    it('dilutes the target pro-rata and pays cash to the diluted owner', () => {
      const baseline = gameLoop.resolveTurn('room-baseline', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
      ]));
      const baselineAlice = baseline.result.players.find((p) => p.playerId === 'player-1')!;
      const baselineBob = baseline.result.players.find((p) => p.playerId === 'player-2')!;

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], operational: [], financial: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      // 20000 / stockValue(10) = 2000 shares of 10000 total = 20%.
      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.8, 4);
      expect(alice.variables.shareOwnership['player-2']).toBeCloseTo(0.2, 4);

      // Isolate the transaction's cash effect from everything else a turn's P&L also
      // moves (same technique CLAUDE.md's Bot Attack regression test uses). Alice is
      // the SOLE existing owner (fraction 1.0, no EXTERNAL_MARKET) — every dollar Bob
      // spends must land in her pocket 1:1, not scaled down again by fractionBought
      // (regression: an earlier version paid `fraction * fractionBought * spend`,
      // double-counting the dilution fraction and paying Alice only 20% of what Bob
      // actually spent).
      expect(bob.variables.cash - baselineBob.variables.cash).toBeCloseTo(-20000, 2);
      expect(alice.variables.cash - baselineAlice.variables.cash).toBeCloseTo(20000, 2);
    });

    it('splits the buyer\'s spend pro-rata across multiple existing owners, paying nothing to EXTERNAL_MARKET\'s share (regression)', () => {
      // Alice's own cap table already has three kinds of holder: herself (0.5),
      // another real player (player-3, 0.2), and the public float (0.3, no counterparty).
      const capTable = { [SELF_OWNERSHIP_KEY]: 0.5, 'player-3': 0.2, [EXTERNAL_MARKET_KEY]: 0.3 };
      const makeThreeWayPlayers = () => makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars({ shareOwnership: { ...capTable } }) },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
        { id: 'player-3', name: 'Carol', variables: makeVars({ cash: 10000 }) },
      ]);
      const baseline = gameLoop.resolveTurn('room-baseline', 1, makeThreeWayPlayers());
      const baselineAlice = baseline.result.players.find((p) => p.playerId === 'player-1')!;
      const baselineBob = baseline.result.players.find((p) => p.playerId === 'player-2')!;
      const baselineCarol = baseline.result.players.find((p) => p.playerId === 'player-3')!;

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], operational: [], financial: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makeThreeWayPlayers());
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;

      // fractionBought = 20000/10/10000 = 0.2. Each real seller receives their ORIGINAL
      // fraction of the full $20,000 spend — 0.5*20000=10000 for Alice, 0.2*20000=4000
      // for Carol — never scaled down again by fractionBought. EXTERNAL_MARKET's 0.3
      // share of the dilution has no counterparty and is paid to nobody, so the total
      // paid out (14000) is deliberately less than the full $20,000 Bob spent.
      expect(bob.variables.cash - baselineBob.variables.cash).toBeCloseTo(-20000, 2);
      expect(alice.variables.cash - baselineAlice.variables.cash).toBeCloseTo(10000, 2);
      expect(carol.variables.cash - baselineCarol.variables.cash).toBeCloseTo(4000, 2);
    });

    it('surfaces a genuine other-player purchase as sharesBoughtThisTurn on the TARGET\'s own result (news-item feed)', () => {
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      // Only the TARGET (Alice) sees the event — the buyer already knows about their own trade.
      expect(alice.sharesBoughtThisTurn).toHaveLength(1);
      expect(alice.sharesBoughtThisTurn[0]).toEqual({ buyerId: 'player-2', buyerName: 'Bob', fractionBought: expect.closeTo(0.2, 4) });
      expect(bob.sharesBoughtThisTurn).toHaveLength(0);
    });

    it('does not surface a self-buyback as sharesBoughtThisTurn — reclaiming your own diluted stake is not news to yourself', () => {
      const vars = makeTargetVars({
        cash: 50000,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.6, [EXTERNAL_MARKET_KEY]: 0.4 },
      });
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [], financial: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: vars },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      expect(alice.sharesBoughtThisTurn).toHaveLength(0);
    });

    it('produces one sharesBoughtThisTurn entry per buyer when multiple players buy into the same target in one turn', () => {
      const vars = makeTargetVars();
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-3', {
        strategic: [], operational: [], financial: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: vars },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
        { id: 'player-3', name: 'Carol', variables: makeBuyerVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      expect(alice.sharesBoughtThisTurn).toHaveLength(2);
      expect(alice.sharesBoughtThisTurn.map((e) => e.buyerName).sort()).toEqual(['Bob', 'Carol']);
    });

    it('does not surface a Sell Shares transaction as sharesBoughtThisTurn', () => {
      const vars = makeTargetVars({
        cash: 10000,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.7, [EXTERNAL_MARKET_KEY]: 0.3 },
      });
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [], financial: [{ name: 'Sell Shares', targetId: 'player-1', amount: 15000 }], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([{ id: 'player-1', name: 'Alice', variables: vars }]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      expect(alice.sharesBoughtThisTurn).toHaveLength(0);
    });

    it('self-buyback reclaims a stake from EXTERNAL_MARKET without paying itself', () => {
      const vars = makeTargetVars({
        cash: 50000,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.6, [EXTERNAL_MARKET_KEY]: 0.4 },
      });
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], operational: [], financial: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: vars },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // fractionBought = 20000/10/10000 = 0.2. Founder's own 0.6 dilutes to 0.48, then
      // gains the full 0.2 back on top (self-targeting is the same buyer key as the
      // diluted "self" row) -> 0.68. EXTERNAL_MARKET dilutes from 0.4 to 0.32.
      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.68, 4);
      expect(alice.variables.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(0.32, 4);
      // A single player was loaded — if self-buyback incorrectly tried to pay "itself"
      // as a separate diluted owner, this would double-count into a cash change beyond
      // just the "-20000 spent" side; can't isolate cleanly without a baseline here, but
      // the ownership math above is the real proof the self-referential leg netted to zero.
    });

    it('Sell Shares returns shares to EXTERNAL_MARKET only, never pro-rata to other players', () => {
      const vars = makeTargetVars({
        cash: 10000,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.7, [EXTERNAL_MARKET_KEY]: 0.3 },
      });
      const baseline = gameLoop.resolveTurn('room-baseline', 1, makePlayers([{ id: 'player-1', name: 'Alice', variables: makeTargetVars({ cash: 10000, shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.7, [EXTERNAL_MARKET_KEY]: 0.3 } }) }]));
      const baselineAlice = baseline.result.players.find((p) => p.playerId === 'player-1')!;

      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Sell Shares', targetId: 'player-1', amount: 15000 }], operational: [], financial: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([{ id: 'player-1', name: 'Alice', variables: vars }]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // fractionSold = 15000/10/10000 = 0.15.
      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.55, 4);
      expect(alice.variables.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(0.45, 4);
      expect(alice.variables.cash - baselineAlice.variables.cash).toBeCloseTo(15000, 2);
    });

    it('caps a Sell Shares sale at the current value of the actual holding', () => {
      const vars = makeTargetVars({ shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.1, [EXTERNAL_MARKET_KEY]: 0.9 } });
      // Holding value = 0.1 * 10000 shares * $10 = $10,000 — request far more than that.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Sell Shares', targetId: 'player-1', amount: 500000 }], operational: [], financial: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([{ id: 'player-1', name: 'Alice', variables: vars }]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0, 4);
      expect(alice.variables.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(1, 4);
    });

    it('resolves two same-target Buy Shares purchases in submission-arrival order (FIFO) — the second computes against the first\'s already-diluted cap table', () => {
      const vars = makeTargetVars();
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-3', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: vars },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
        { id: 'player-3', name: 'Carol', variables: makeBuyerVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // Both buy the same fixed 50% of TOTAL shares outstanding (fractionBought is
      // always sharesBought/totalShares, independent of who currently holds what) — but
      // applied SEQUENTIALLY, each purchase dilutes EVERY existing holder at that moment,
      // including any earlier buyer. Bob (first) starts by diluting only "self" (0.5/0.5
      // split). Carol (second) then dilutes BOTH existing holders — self and Bob — by
      // another 50%, landing self=0.25, Bob=0.25, Carol=0.5. This is the correct,
      // intentional consequence of "always pro-rata from ALL current owners" applied
      // in strict arrival order, not a bug — a later buyer of the same size
      // ends up proportionally larger, since they dilute every earlier buyer too.
      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.25, 4);
      expect(alice.variables.shareOwnership['player-2']).toBeCloseTo(0.25, 4);
      expect(alice.variables.shareOwnership['player-3']).toBeCloseTo(0.5, 4);
      const total = Object.values(alice.variables.shareOwnership).reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 4);
    });

    it('applies a resubmit-but-unrelated-change without resetting an already-queued Buy Shares entry\'s FIFO timestamp', () => {
      // player-2 queues Buy Shares first, then (still before the turn resolves) submits
      // an unrelated second decision — the full-replacement submission architecture means
      // this resends player-2's ENTIRE pending state, but Buy Shares' own timestamp must
      // stay pinned to when IT was first queued, not reset to "now".
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-3', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [], financial: [], lawsuits: [],
      });
      // player-2 touches something unrelated — full-replacement resend of their whole
      // submission, Buy Shares entry included verbatim.
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [{ name: 'Quality Certification' }], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
        { id: 'player-3', name: 'Carol', variables: makeBuyerVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // If player-2's resubmit had wrongly reset their Buy Shares timestamp to "now"
      // (after player-3's), the two buyers' resulting fractions would be swapped —
      // whichever result actually matches "Bob still resolved first" (same numbers as
      // the FIFO ordering test above) proves the timestamp survived the unrelated resubmit.
      expect(alice.variables.shareOwnership['player-2']).toBeCloseTo(0.25, 4);
      expect(alice.variables.shareOwnership['player-3']).toBeCloseTo(0.5, 4);
    });

    it('classifies Buy Shares as a direct attack (not broadcast to everyone) despite having no target.* impacts (isIndirectEffect regression)', () => {
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], operational: [], financial: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-3', { strategic: [], operational: [], financial: [], lawsuits: [] });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
        { id: 'player-3', name: 'Carol', variables: makeVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;

      expect(alice.incomingAttacks).toHaveLength(1);
      expect(alice.incomingAttacks[0].isIndirect).toBe(false);
      expect(alice.incomingAttacks[0].decisionName === undefined || alice.incomingAttacks[0].decisionName === undefined).toBe(true); // not yet dug into
      // Carol was never the target — Buy Shares must not broadcast to her the way a
      // genuinely indirect (no-target) decision like Water Pumping would.
      expect(carol.incomingAttacks).toHaveLength(0);
    });

    it('cannot be sued over once the acquisition fraction falls short of legalRiskConditions.minPercentAcquiredInSingleTransaction', () => {
      gameLoop.submitDecisions('room-1', 'player-2', {
        // 1000 / 10 / 10000 = 1% — below the fixture's 5% minPercentAcquiredInSingleTransaction.
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 1000 }], operational: [], financial: [], lawsuits: [],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
      ]));
      const aliceUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const bobUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-2')!;

      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: 'player-2', decisionName: 'Buy Shares', groundName: 'Breach of Corporate Fiduciary Duty & Raiding Injunction' }],
      });
      const outcome2 = gameLoop.resolveTurn('room-1', 2, makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: bobUpdate1.engineState },
      ]));
      const bobCase = outcome2.result.players.find((p) => p.playerId === 'player-2')!.legalCases[0];

      expect(bobCase.baseProbability).toBe(0);
    });
  });

  describe('resolveTurn — late-game escalation (regression)', () => {
    it('boosts a genuine lawsuit\'s probability (capped at 0.95) and stakes once round >= lateGameRoundThreshold, leaves an earlier round untouched', () => {
      const buildPlayers = () => [
        { id: 'player-1', name: 'Alice' },
        { id: 'player-2', name: 'Bob' },
      ];
      const fileCase = (round: number) => {
        gameLoop.submitDecisions('room-1', 'player-1', {
          strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
        });
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [], financial: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
        });
        const outcome = gameLoop.resolveTurn('room-1', round, makePlayers(buildPlayers()));
        return outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      };

      const earlyCase = fileCase(1);
      // Different room, fresh (empty) engineState for player-1 each call via
      // makePlayers(buildPlayers()) — this is a brand new decision instance, so the "one
      // lawsuit per instance, ever" rule (scoped to the instance, not the room) never
      // engages here regardless of room id.
      const lateCase = (() => {
        gameLoop.submitDecisions('room-2', 'player-1', {
          strategic: [], operational: [{ name: 'Water Pumping' }], financial: [], lawsuits: [],
        });
        gameLoop.submitDecisions('room-2', 'player-2', {
          strategic: [], operational: [], financial: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
        });
        const outcome = gameLoop.resolveTurn('room-2', config.gameSettings.lateGameRoundThreshold, makePlayers(buildPlayers()));
        return outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      })();

      expect(earlyCase.baseProbability).toBeGreaterThan(0);
      expect(lateCase.baseProbability).toBeCloseTo(
        Math.min(0.95, earlyCase.baseProbability * config.gameSettings.lateGameLegalProbabilityBoost), 6,
      );
      expect(lateCase.stakes).toBeCloseTo(earlyCase.stakes * config.gameSettings.lateGameLegalStakesBoost, 2);
    });

    it('never boosts a hopeless (wrong-guess) case above 0% — multiplying zero stays zero', () => {
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [], financial: [],
        // player-1 never deployed Water Pumping — a wrong guess, baseProbability forced to 0.
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const outcome = gameLoop.resolveTurn('room-1', config.gameSettings.lateGameRoundThreshold, twoPlayers());
      const bobCase = outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      expect(bobCase.baseProbability).toBe(0);
    });

    it('boosts a Buy Shares purchase\'s effective buying power (more shares for the same spend) once round >= lateGameRoundThreshold, without changing the cash actually paid', () => {
      // Fresh objects every call — see the "Fresh objects every call" comment on the
      // Buy/Sell Shares describe block above: GameLoop mutates variables by reference,
      // so reusing one binding across the two resolveTurn calls below would let the
      // first (early) call's dilution leak into the second (late) call's starting state.
      const buildPlayers = () => makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({
          cash: 50000, totalSharesOutstanding: 10000, stockValue: 10,
          shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 },
        }) },
        { id: 'player-2', name: 'Bob', variables: makeVars({ cash: 100000 }) },
      ]);

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], operational: [], financial: [], lawsuits: [],
      });
      const earlyOutcome = gameLoop.resolveTurn('room-1', 1, buildPlayers());
      const earlyAlice = earlyOutcome.result.players.find((p) => p.playerId === 'player-1')!;
      const earlyBob = earlyOutcome.result.players.find((p) => p.playerId === 'player-2')!;

      gameLoop.submitDecisions('room-2', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], operational: [], financial: [], lawsuits: [],
      });
      const lateOutcome = gameLoop.resolveTurn('room-2', config.gameSettings.lateGameRoundThreshold, buildPlayers());
      const lateAlice = lateOutcome.result.players.find((p) => p.playerId === 'player-1')!;
      const lateBob = lateOutcome.result.players.find((p) => p.playerId === 'player-2')!;

      // Same $20,000 spend, same starting cap table — round 1 buys 20% (2000/10000
      // shares); round >= lateGameRoundThreshold buys 30% (boosted 1.5x effective spend).
      expect(earlyAlice.variables.shareOwnership['player-2']).toBeCloseTo(0.2, 4);
      expect(lateAlice.variables.shareOwnership['player-2']).toBeCloseTo(0.3, 4);
      // The buyer still only pays the amount they submitted, either way.
      expect(earlyBob.variables.cash).toBeCloseTo(lateBob.variables.cash, 2);
    });
  });

  describe('resolveTurn — majority-ownership takeover elimination', () => {
    it('eliminates the target once an acquirer crosses 50%, reusing the bankruptcy case waterfall to pay off open cases against the eliminated player', () => {
      const targetVars = makeVars({
        cash: 20000, totalSharesOutstanding: 10000, stockValue: 10,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.55, 'player-3': 0.45 },
      });
      // player-3 already holds a case against player-1 (the target) that should be paid
      // from the waterfall pool exactly like a bankruptcy would pay it.
      const existingCase: LegalCaseData = {
        id: 'case-1', roomId: 'room-1', plaintiffId: 'player-3', defendantId: 'player-1',
        decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x',
        baseProbability: 0.5, adjustedProbability: undefined, plaintiffFullyInvestigated: false,
        defendantInvestigated: false, stakes: 5000, status: 'negotiating', offers: [], turnsNegotiating: 0,
        verdict: undefined, createdAt: new Date('2024-01-01'), resolvedAt: undefined,
      };

      gameLoop.submitDecisions('room-1', 'player-2', {
        // 60000/10/10000 = 60% — crosses the 50% threshold, on top of the existing 45%
        // held by player-3 (a different acquirer — only ONE acquirer can be found; the
        // buyer here, player-2, is the one who ends up over 50%).
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 60000 }], operational: [], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars, engineState: { legalCases: [existingCase] } },
        { id: 'player-2', name: 'Bob', variables: makeVars({ cash: 200000 }) },
        { id: 'player-3', name: 'Carol', variables: makeVars(), engineState: { legalCases: [existingCase] } },
      ]));

      expect(outcome.result.players.find((p) => p.playerId === 'player-1')).toBeUndefined();
      expect(outcome.result.gameOver).toBe(false); // player-3 (and the acquirer) still active
      const merged = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1')!;
      expect(merged.reason).toBe('merger');
      expect(merged.acquirerId).toBe('player-2');
      // A merger elimination gets the same final-snapshot capture as a bankruptcy —
      // both reasons flow through the same buildFinalSnapshot call.
      expect(merged.finalVariables).toBeDefined();
      expect(merged.finalDerived).toBeDefined();
      expect(typeof merged.finalRiskGauge).toBe('number');

      // Carol's case against Alice gets paid from the waterfall pool, same as a bankruptcy would.
      // Regression: this used to be stamped verdict 'settled', indistinguishable from a
      // real negotiated settlement — a real, reported bug (a case a player explicitly sent
      // to trial, or never negotiated at all, showed up as "Settled" once the defendant
      // was eliminated before it could resolve any other way). It's now its own distinct
      // 'waterfall_payout' verdict, with the actual amount paid tracked separately from
      // `stakes` (see LegalCaseData.verdict's own doc comment).
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;
      expect(carol.legalCases[0].status).toBe('resolved');
      expect(carol.legalCases[0].verdict).toBe('waterfall_payout');
      expect(carol.legalCases[0].waterfallPayoutAmount).toBe(5000); // full stakes — pool covered it
      expect(carol.variables.cash).toBeGreaterThan(makeVars().cash); // received a payout
    });

    // Regression counterpart: when the waterfall pool can't cover every open case, the
    // ones left unpaid must stay 'cancelled' (no waterfallPayoutAmount) — the paid/unpaid
    // distinction is the whole point of this fix, so both branches need their own coverage.
    it('leaves a case unpaid (cancelled, not waterfall_payout) when the waterfall pool runs out before reaching it', () => {
      const targetVars = makeVars({
        cash: 1000, totalSharesOutstanding: 10000, stockValue: 10,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.55, 'player-3': 0.45 },
      });
      // Filed earlier — first in the payout queue, and expensive enough it consumes the
      // ENTIRE pool by itself (a partial payment — still 'waterfall_payout', just less
      // than its own `stakes`).
      const earlyCase: LegalCaseData = {
        id: 'case-1', roomId: 'room-1', plaintiffId: 'player-3', defendantId: 'player-1',
        decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x',
        baseProbability: 0.5, adjustedProbability: undefined, plaintiffFullyInvestigated: false,
        defendantInvestigated: false, stakes: 50_000_000, status: 'negotiating', offers: [], turnsNegotiating: 0,
        verdict: undefined, createdAt: new Date('2024-01-01'), resolvedAt: undefined,
      };
      // Filed later — by the time the (now-exhausted) pool reaches this one, nothing's left.
      const lateCase: LegalCaseData = {
        id: 'case-2', roomId: 'room-1', plaintiffId: 'player-3', defendantId: 'player-1',
        decisionName: 'Bank Loan', groundName: 'Fraudulent Misrepresentation', description: 'y',
        baseProbability: 0.5, adjustedProbability: undefined, plaintiffFullyInvestigated: false,
        defendantInvestigated: false, stakes: 500, status: 'negotiating', offers: [], turnsNegotiating: 0,
        verdict: undefined, createdAt: new Date('2024-06-01'), resolvedAt: undefined,
      };

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 60000 }], operational: [], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars, engineState: { legalCases: [earlyCase, lateCase] } },
        { id: 'player-2', name: 'Bob', variables: makeVars({ cash: 200000 }) },
        { id: 'player-3', name: 'Carol', variables: makeVars(), engineState: { legalCases: [earlyCase, lateCase] } },
      ]));

      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;
      const resolvedEarly = carol.legalCases.find((c) => c.id === 'case-1')!;
      const resolvedLate = carol.legalCases.find((c) => c.id === 'case-2')!;
      expect(resolvedEarly.status).toBe('resolved');
      expect(resolvedEarly.verdict).toBe('waterfall_payout');
      expect(resolvedEarly.waterfallPayoutAmount).toBeGreaterThan(0);
      expect(resolvedEarly.waterfallPayoutAmount).toBeLessThan(earlyCase.stakes); // partial — pool ran out
      expect(resolvedLate.status).toBe('resolved');
      expect(resolvedLate.verdict).toBe('cancelled');
      expect(resolvedLate.waterfallPayoutAmount).toBeUndefined();
    });

    it('transfers the eliminated company\'s cash/assets/intangibleAssets to the acquirer', () => {
      const targetVars = makeVars({
        cash: 20000, assets: 80000, intangibleAssets: 5000,
        totalSharesOutstanding: 10000, stockValue: 10,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 },
      });
      const buyerVars = makeVars({ cash: 200000, assets: 10000, intangibleAssets: 1000 });

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 60000 }], operational: [], financial: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars },
        { id: 'player-2', name: 'Bob', variables: buyerVars },
      ]));
      const merged = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      // Bob's own assets/intangibleAssets grew by (at least) Alice's contributed values —
      // not an exact equality since Bob's own turn P&L/depreciation also move these fields,
      // but the eliminated company's finalCash/assets/intangibleAssets were all positive
      // contributions on top of whatever Bob's own turn produced.
      expect(merged.finalCash).toBeGreaterThan(0);
      expect(bob.variables.assets).toBeGreaterThanOrEqual(targetVars.assets + 10000 - 1000); // generous slack for Bob's own depreciation this turn
      expect(bob.variables.intangibleAssets).toBeGreaterThanOrEqual(targetVars.intangibleAssets + 1000 - 100);
    });

    it('does not complete a takeover if the prospective acquirer is bankrupt the same turn', () => {
      // Zero production (installedCapacity/capacityUtilization: 0) on BOTH players
      // suppresses volume/revenue entirely, so each player's cash change this turn is
      // just fixed costs — small and predictable — never enough to flip a deeply
      // negative or comfortably positive starting cash to the other sign.
      const targetVars = makeVars({
        cash: 500000, installedCapacity: 0, capacityUtilization: 0,
        totalSharesOutstanding: 10000, stockValue: 10,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.4, 'player-2': 0.6 },
      });
      // Bob (the would-be acquirer) is deeply insolvent this turn regardless of Alice.
      const buyerVars = makeVars({ cash: -500000, installedCapacity: 0, capacityUtilization: 0 });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars },
        { id: 'player-2', name: 'Bob', variables: buyerVars },
      ]));

      const bankruptedIds = outcome.bankruptedPlayers.map((b) => b.playerId);
      expect(bankruptedIds).toContain('player-2');
      expect(bankruptedIds).not.toContain('player-1');
      // Alice survives — Bob's >50% stake never gets to trigger her elimination.
      expect(outcome.result.players.find((p) => p.playerId === 'player-1')).toBeDefined();
    });

    it('sweeps an eliminated player\'s cross-holdings in other, still-active companies back to EXTERNAL_MARKET', () => {
      // player-2 (going bankrupt this turn) holds a 30% cross-stake in player-3's company.
      const survivorVars = makeVars({
        cash: 500000, installedCapacity: 0, capacityUtilization: 0,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.7, 'player-2': 0.3 },
      });
      const bankruptVars = makeVars({ cash: -100000, installedCapacity: 0, capacityUtilization: 0 });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-2', name: 'Bob', variables: bankruptVars },
        { id: 'player-3', name: 'Carol', variables: survivorVars },
      ]));

      expect(outcome.bankruptedPlayers.map((b) => b.playerId)).toContain('player-2');
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;
      expect(carol.variables.shareOwnership['player-2']).toBeUndefined();
      expect(carol.variables.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(0.3, 4);
      expect(carol.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.7, 4);

      // BankruptedPlayer must also carry a full final snapshot — persistKpiSnapshots
      // (the caller) excludes eliminated players from its normal per-turn write, so this
      // is the only place a bankrupted player's true end-of-game KPI numbers come from
      // (see CLAUDE.md's game-timeline section).
      const bob = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-2')!;
      expect(bob.finalVariables.cash).toBeLessThan(0);
      expect(bob.finalDerived).toEqual(
        expect.objectContaining({
          equity: expect.any(Number),
          revenue: expect.any(Number),
          stockValue: expect.any(Number),
          marketShare: expect.any(Number),
        }),
      );
      expect(typeof bob.finalRiskGauge).toBe('number');
      expect(bob.finalRiskGauge).toBeGreaterThanOrEqual(0);
    });

    // Regression for the dead-config bug fixed alongside the Risk Gauge's ownership-risk
    // term: the elimination check used to hardcode `> 0.5` directly, ignoring
    // `adminVariables.ownership.takeoverThresholdPercent` even though it was seeded,
    // validated, and admin-editable the whole time. Confirms an admin-lowered threshold
    // actually takes effect on the real elimination trigger, not just on the gauge.
    it('honors an admin-configured takeoverThresholdPercent below 50%', () => {
      gameLoop.updateConfig({ ...config, adminVariables: { ...config.adminVariables, ownership: { takeoverThresholdPercent: 0.3 } } });

      const targetVars = makeVars({
        cash: 500000, installedCapacity: 0, capacityUtilization: 0,
        // Only 35% held by player-2 — would NOT trigger at the default 50% threshold,
        // but does at the admin-configured 30%.
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.65, 'player-2': 0.35 },
      });
      const buyerVars = makeVars({ cash: 200000, installedCapacity: 0, capacityUtilization: 0 });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars },
        { id: 'player-2', name: 'Bob', variables: buyerVars },
      ]));

      const merged = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1');
      expect(merged?.reason).toBe('merger');
      expect(merged?.acquirerId).toBe('player-2');
    });

    it('does not trigger at 35% under the default 50% threshold (control for the test above)', () => {
      const targetVars = makeVars({
        cash: 500000, installedCapacity: 0, capacityUtilization: 0,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.65, 'player-2': 0.35 },
      });
      const buyerVars = makeVars({ cash: 200000, installedCapacity: 0, capacityUtilization: 0 });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars },
        { id: 'player-2', name: 'Bob', variables: buyerVars },
      ]));

      expect(outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1')).toBeUndefined();
      expect(outcome.result.players.find((p) => p.playerId === 'player-1')).toBeDefined();
    });
  });

  describe('resolveTurn — persistence output', () => {
    it('should include engine state in the returned company updates', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const update = outcome.companyUpdates.find(u => u.playerId === 'player-1');
      expect(update).toBeDefined();
      expect(update!.engineState.activeDecisions).toBeDefined();
      expect(update!.engineState.activeDecisions).toHaveLength(1);
    });

    it('should serialize activeDecisions with a definitionName the next turn can look up (round-trip regression)', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const persisted = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;

      expect(persisted.engineState.activeDecisions[0]).toMatchObject({ definitionName: 'New Factory' });

      // Feeding the exact persisted engineState back in must not blow up — this is
      // the real DB round-trip (readEngineState resolves definitionName back to a
      // full DecisionDefinition), not a hand-built stand-in for it.
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: persisted.variables, engineState: persisted.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players);

      expect(outcome2.result.players[0].activeDecisions[0].decisionName).toBe('New Factory');
      // Deployed turn 1 (elapsedYears 0, its one deployment-year impact already applied
      // in Step 1) then advanced exactly once at turn 2 — not twice (see the
      // "double-applying its own impact" regression test below for why this used to be 2).
      expect(outcome2.result.players[0].activeDecisions[0].elapsedYears).toBe(1);
    });

    it('should include updated variables in the returned company updates', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.companyUpdates).toHaveLength(2);
      expect(outcome.companyUpdates[0].variables).toBeDefined();
      expect(outcome.companyUpdates[0].cash).toBeDefined();
    });

    it('should not include a company update for a player it just bankrupted', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', cash: 100, variables: makeVars({ cash: 100, reserves: 0 }) },
        { id: 'player-2', name: 'Bob' },
      ]);
      // Force Alice into negative cash via a large strategic spend she can't cover.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, players);

      const aliceBankrupt = outcome.bankruptedPlayers.find(b => b.playerId === 'player-1');
      if (aliceBankrupt) {
        expect(outcome.companyUpdates.find(u => u.playerId === 'player-1')).toBeUndefined();
        // Regression: finalCash must carry the real negative balance since the caller can't
        // get it from companyUpdates (this player is excluded from it) — without it, the
        // Company row's cash column is never updated off whatever positive value it had
        // before this turn, which surfaced as a bankrupt player showing positive cash on
        // the Game Over screen.
        expect(aliceBankrupt.finalCash).toBeLessThan(0);
      }
    });
  });

  describe('resolveTurn — turn progression', () => {
    it('should advance active decisions across turns', () => {
      // Turn 1: deploy decision
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      expect(outcome1.result.players[0].activeDecisions).toHaveLength(1);
      // Just deployed this same turn — Step 1 already applied its one deployment-year
      // impact; it must NOT also be advanced by Step 2 in the same turn (that was the
      // "double-applying its own impact" bug — see the regression test below).
      expect(outcome1.result.players[0].activeDecisions[0].elapsedYears).toBe(0);

      // Turn 2: no new decisions, but existing ones advance.
      // The engine state (including activeDecisions) is persisted to the DB after turn 1
      // (GameEngine writes outcome1.companyUpdates) — simulate that by feeding it back in.
      const persisted = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: persisted.variables, engineState: persisted.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);

      const outcome2 = gameLoop.resolveTurn('room-1', 2, players);
      expect(outcome2.result.players[0].activeDecisions).toHaveLength(1);
      // First real advance — turn 2 is the first turn this decision existed BEFORE
      // Step 1 ran, so this is the first time Step 2 is allowed to touch it.
      expect(outcome2.result.players[0].activeDecisions[0].elapsedYears).toBe(1);
    });

    it('does not double-apply a decision\'s own impact in the same turn it is deployed (regression)', () => {
      // Real, reported bug: Step 1 (processNewDecisions) already applies a newly
      // deployed decision's deployment-year impact (elapsedYears 0) directly to
      // ctx.vars and pushes the instance into activeDecisions; Step 2
      // (advanceAndApply) used to then process ALL activeDecisions unconditionally,
      // including the one Step 1 had just pushed — incrementing its elapsedYears to
      // 1 and applying its impact AGAIN, all within the deployment turn itself.
      // 'Bot Attack' has only a flat `cash: -12000` self-effect with no per-year
      // schedule (single 'default' key), so a double-application shows up as an
      // unmistakable -24000 instead of -12000. Isolated via a baseline run with no
      // decision deployed at all, exactly like the negotiation Step 8b tests above —
      // diffing out everything else a turn's P&L/balance-sheet math also moves.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Bot Attack', targetId: 'player-2' }], financial: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      // Baseline: identical fixture, different (submission-free) room, no decision
      // deployed at all — isolates exactly Bot Attack's cash effect from everything
      // else a turn's P&L/balance-sheet math also moves, same technique the
      // negotiation Step 8b tests above use.
      const baselineOutcome = gameLoop.resolveTurn('room-2', 1, twoPlayers());

      const aliceCash = outcome.result.players.find(p => p.playerId === 'player-1')!.variables.cash;
      const aliceBaselineCash = baselineOutcome.result.players.find(p => p.playerId === 'player-1')!.variables.cash;

      expect(aliceBaselineCash - aliceCash).toBeCloseTo(12000, 5);
      // And the instance itself must still be at elapsedYears 0 after its own deployment turn.
      const alice = outcome.result.players.find(p => p.playerId === 'player-1')!;
      expect(alice.activeDecisions.find(d => d.decisionName === 'Bot Attack')?.elapsedYears).toBe(0);
    });

    it('should clear submissions after turn resolution', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(gameLoop.getSubmissionCount('room-1')).toBe(0);
    });
  });

  describe('digDeeper', () => {
    // Builds a fixture where player-1 has one persisted Bot Attack decision instance
    // targeting player-2 — bypasses a full resolveTurn cycle since digDeeper only
    // needs cash + engineState, letting each test set up cash/investigation state
    // directly for the exact scenario under test. A third, otherwise-uninvolved active
    // player (Carol) is included specifically so this describe block's byId.size is 3,
    // NOT 2 — keeping it OUT of the heads-up shortcut (effectiveInvestigationLevel) so
    // these tests exercise the plain, un-shortcut 1-2-3 progression. The heads-up
    // (exactly 2 active players) shortcut has its own dedicated describe block below.
    const ATTACK_ID = 'attack-1';
    function makeAttackFixture(overrides: { victimCash?: number; victimInvestigations?: Record<string, number>; attackerElapsedYears?: number } = {}): EngineDataInput[] {
      return makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          engineState: {
            activeDecisions: [
              { id: ATTACK_ID, definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: overrides.attackerElapsedYears ?? 0, isMatured: true, targetId: 'player-2' },
            ],
          },
        },
        {
          id: 'player-2',
          name: 'Bob',
          // GameLoop reads cash from `variables.cash`, not the `company.cash` column
          // (that's only kept in sync by the persistence layer) — override it here.
          variables: makeVars({ cash: overrides.victimCash ?? 100000 }),
          engineState: { investigations: overrides.victimInvestigations ?? {} },
        },
        { id: 'player-3', name: 'Carol' },
      ]);
    }

    it('dig 1 reveals only the attacker identity', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture());

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      // Flat digDeeperCost (10000) plus wealthScaledFeeRate (0.03) of the payer's own
      // 100000 cash — a deliberate cash-sink surcharge (see GameSettings doc comment).
      expect(outcome.cost).toBe(13000);
      expect(outcome.newCash).toBe(87000);
      // GameLoop reads cash from variables.cash (readVariables), not a separate column —
      // the caller must persist this alongside engineStateUpdate or the next call (or the
      // next normal turn) reads stale, pre-deduction cash back out.
      expect(outcome.variables.cash).toBe(87000);
      expect(outcome.attack.investigationLevel).toBe(1);
      expect(outcome.attack.attackerId).toBe('player-1');
      expect(outcome.attack.attackerName).toBe('Alice');
      expect(outcome.attack.decisionName).toBeUndefined();
      expect(outcome.attack.suggestedGrounds).toBeUndefined();
      expect(outcome.engineStateUpdate.investigations[ATTACK_ID]).toBe(1);
    });

    it('dig 2 adds the decision name and effect summary', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimInvestigations: { [ATTACK_ID]: 1 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(2);
      expect(outcome.attack.decisionName).toBe('Bot Attack');
      expect(outcome.attack.effectSummary).toContain('Outrage');
      expect(outcome.attack.suggestedGrounds).toBeUndefined();
    });

    it('dig 3 adds the suggested lawsuit ground, a success probability, and its estimated stakes', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimInvestigations: { [ATTACK_ID]: 2 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(3);
      expect(outcome.attack.suggestedGrounds?.[0]?.name).toBe('CFAA Digital Sabotage Lawsuit');
      expect(outcome.attack.suggestedGrounds?.[0]?.probability).toBeGreaterThan(0);
      expect(outcome.attack.suggestedGrounds?.[0]?.probability).toBeLessThanOrEqual(1);
      // Same figure a real filed case's LegalCaseData.stakes would carry — see
      // pickAllGrounds/fileLawsuit's shared stakes calc.
      expect(outcome.attack.suggestedGrounds?.[0]?.stakes).toBeGreaterThan(0);
    });

    it('dig 3 still names a suggested ground but quotes 0% once the attack is past the statute of limitations (makeConfig: 10 years)', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimInvestigations: { [ATTACK_ID]: 2 }, attackerElapsedYears: 10 }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.suggestedGrounds?.[0]?.name).toBe('CFAA Digital Sabotage Lawsuit');
      expect(outcome.attack.suggestedGrounds?.[0]?.probability).toBe(0);
    });

    it('sequential digs accumulate cost — the second dig charges from the already-decremented cash', () => {
      // Regression test: GameEngine.digDeeper originally persisted the `cash` column but
      // not `variables.cash` (the JSONB field GameLoop actually reads via readVariables),
      // so every dig recomputed its cost against the same stale starting cash instead of
      // accumulating. Simulates that exact caller pattern: feed each dig's full persisted
      // output (variables + engineStateUpdate) as the next call's input.
      const dig1 = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture());
      expect(dig1.success).toBe(true);
      if (!dig1.success) return;
      // 10000 flat + 0.03*100000 wealth-scaled surcharge = 13000.
      expect(dig1.newCash).toBe(87000);

      const playersAfterDig1 = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: ATTACK_ID, definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true, targetId: 'player-2' }] } },
        { id: 'player-2', name: 'Bob', variables: dig1.variables, engineState: dig1.engineStateUpdate },
      ]);

      const dig2 = gameLoop.digDeeper('player-2', ATTACK_ID, playersAfterDig1);
      expect(dig2.success).toBe(true);
      if (!dig2.success) return;
      // 10000 flat + 0.03*87000 = 12610 — charged against the already-decremented 87000,
      // not 100000 again, so the deduction from dig 1 must carry forward.
      expect(dig2.newCash).toBe(74390);
      expect(dig2.variables.cash).toBe(74390);
    });

    it('dig 4 fails — already fully investigated, no charge', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimInvestigations: { [ATTACK_ID]: 3 } }));

      expect(outcome).toEqual({ success: false, reason: 'already_fully_investigated' });
    });

    it('fails with insufficient_funds and does not charge when cash is below the cost', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimCash: 5000 }));

      expect(outcome).toEqual({ success: false, reason: 'insufficient_funds' });
    });

    it('fails with invalid_attack for a bogus attack id', () => {
      const outcome = gameLoop.digDeeper('player-2', 'not-a-real-attack', makeAttackFixture());

      expect(outcome).toEqual({ success: false, reason: 'invalid_attack' });
    });

    it('fails with invalid_attack when the attack does not target the caller', () => {
      // player-1's Bot Attack targets player-2 — player-1 can't dig on their own attack.
      const outcome = gameLoop.digDeeper('player-1', ATTACK_ID, makeAttackFixture());

      expect(outcome).toEqual({ success: false, reason: 'invalid_attack' });
    });

    it('investigations persisted via digDeeper survive an unrelated normal turn resolving', () => {
      const digOutcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture());
      expect(digOutcome.success).toBe(true);
      if (!digOutcome.success) return;

      // Simulate GameEngine persisting the dig, then a normal turn resolving afterward —
      // regression guard for readEngineState/Step-12 dropping unknown engineState keys.
      // Carol stays in the roster here too, for the same "stay out of the heads-up
      // shortcut" reason makeAttackFixture includes her.
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: ATTACK_ID, definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true, targetId: 'player-2' }] } },
        { id: 'player-2', name: 'Bob', cash: digOutcome.newCash, engineState: digOutcome.engineStateUpdate },
        { id: 'player-3', name: 'Carol' },
      ]);

      const turnOutcome = gameLoop.resolveTurn('room-1', 2, players);
      const bobUpdate = turnOutcome.companyUpdates.find((u) => u.playerId === 'player-2')!;
      expect(bobUpdate.engineState.investigations[ATTACK_ID]).toBe(1);

      const bob = turnOutcome.result.players.find((p) => p.playerId === 'player-2')!;
      expect(bob.incomingAttacks[0].investigationLevel).toBe(1);
      expect(bob.incomingAttacks[0].attackerName).toBe('Alice');
    });
  });

  describe('digDeeper — heads-up (exactly 2 active players)', () => {
    // Same Bot Attack fixture as the digDeeper describe block above, minus Carol — with
    // only one other active player, who attacked me is never actually in question, so
    // investigation effectively starts one tier ahead (see effectiveInvestigationLevel's
    // doc comment in gameLoop.ts). This means only 2 paid digs are ever needed here, not
    // 3, and the raw persisted level this describe block reaches maxes out at 2.
    const ATTACK_ID = 'attack-1';
    function makeHeadsUpFixture(overrides: { victimInvestigations?: Record<string, number> } = {}): EngineDataInput[] {
      return makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          engineState: {
            activeDecisions: [
              { id: ATTACK_ID, definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true, targetId: 'player-2' },
            ],
          },
        },
        {
          id: 'player-2',
          name: 'Bob',
          variables: makeVars({ cash: 100000 }),
          engineState: { investigations: overrides.victimInvestigations ?? {} },
        },
      ]);
    }

    it('dig 1 skips straight to the decision name and effect summary — identity was already free', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeHeadsUpFixture());

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(2);
      expect(outcome.attack.attackerId).toBe('player-1');
      expect(outcome.attack.attackerName).toBe('Alice');
      expect(outcome.attack.decisionName).toBe('Bot Attack');
      expect(outcome.attack.effectSummary).toContain('Outrage');
      expect(outcome.attack.suggestedGrounds).toBeUndefined();
      // The persisted RAW level still only advances by 1 per dig, same as always — it's
      // only what gets revealed for a given raw level that shifts in a heads-up game.
      expect(outcome.engineStateUpdate.investigations[ATTACK_ID]).toBe(1);
    });

    it('dig 2 adds the suggested lawsuit ground and a success probability', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeHeadsUpFixture({ victimInvestigations: { [ATTACK_ID]: 1 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(3);
      expect(outcome.attack.suggestedGrounds?.[0]?.name).toBe('CFAA Digital Sabotage Lawsuit');
      expect(outcome.attack.suggestedGrounds?.[0]?.probability).toBeGreaterThan(0);
    });

    it('dig 3 fails — already fully investigated after only 2 paid digs, no charge', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeHeadsUpFixture({ victimInvestigations: { [ATTACK_ID]: 2 } }));

      expect(outcome).toEqual({ success: false, reason: 'already_fully_investigated' });
    });
  });

  describe('digDeeper — indirect effects (no target.* impacts, just legalRisks)', () => {
    // Water Pumping has no targetId concept at all — Alice deploys it for her own
    // benefit, and it's Bob (or anyone else active) digging into background market
    // activity, not investigating a personal attack. Carol keeps this non-heads-up,
    // matching the direct-attack digDeeper describe block above.
    const WATER_PUMPING_ID = 'wp-1';
    function makeIndirectFixture(overrides: { investigatorInvestigations?: Record<string, number> } = {}): EngineDataInput[] {
      return makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          engineState: {
            activeDecisions: [
              { id: WATER_PUMPING_ID, definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 0, isMatured: false },
            ],
          },
        },
        {
          id: 'player-2',
          name: 'Bob',
          variables: makeVars({ cash: 100000 }),
          engineState: { investigations: overrides.investigatorInvestigations ?? {} },
        },
        { id: 'player-3', name: 'Carol' },
      ]);
    }

    it('dig 1 reveals only the deployer\'s identity, same as a direct attack', () => {
      const outcome = gameLoop.digDeeper('player-2', WATER_PUMPING_ID, makeIndirectFixture());

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.isIndirect).toBe(true);
      expect(outcome.attack.investigationLevel).toBe(1);
      expect(outcome.attack.attackerId).toBe('player-1');
      expect(outcome.attack.attackerName).toBe('Alice');
      expect(outcome.attack.decisionName).toBeUndefined();
    });

    it('dig 2 summarizes the deployer\'s OWN effects (there is no target.* effect to summarize)', () => {
      const outcome = gameLoop.digDeeper('player-2', WATER_PUMPING_ID, makeIndirectFixture({ investigatorInvestigations: { [WATER_PUMPING_ID]: 1 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(2);
      expect(outcome.attack.decisionName).toBe('Water Pumping');
      expect(outcome.attack.effectSummary).toContain('Material Cost Per Ton');
      expect(outcome.attack.suggestedGrounds).toBeUndefined();
    });

    it('dig 3 adds the suggested lawsuit ground and a success probability, same mechanism as a direct attack', () => {
      const outcome = gameLoop.digDeeper('player-2', WATER_PUMPING_ID, makeIndirectFixture({ investigatorInvestigations: { [WATER_PUMPING_ID]: 2 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(3);
      expect(outcome.attack.suggestedGrounds?.[0]?.name).toBe('Environmental Violation');
      expect(outcome.attack.suggestedGrounds?.[0]?.probability).toBeGreaterThan(0);
    });

    it('lets any other active player dig in, not just a single "victim" (there is none)', () => {
      // Carol digs instead of Bob — should work exactly the same, since indirect
      // effects have no single target to gate digging by.
      const outcome = gameLoop.digDeeper('player-3', WATER_PUMPING_ID, makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: WATER_PUMPING_ID, definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 0, isMatured: false }] } },
        { id: 'player-2', name: 'Bob' },
        { id: 'player-3', name: 'Carol', variables: makeVars({ cash: 100000 }) },
      ]));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.attackerId).toBe('player-1');
    });

    it('fails with invalid_attack — the deployer cannot dig into their own indirect decision', () => {
      const outcome = gameLoop.digDeeper('player-1', WATER_PUMPING_ID, makeIndirectFixture());

      expect(outcome).toEqual({ success: false, reason: 'invalid_attack' });
    });
  });

  describe('digDeeper — a decision with several legal risks surfaces ALL of them at level 3, not just the strongest', () => {
    // 'Risky Fundraising' (shared fixture library above) carries two legalRisks entries —
    // the exact scenario a player reported: only one ground was ever suggested, silently
    // hiding the other. No target.* impacts, so this is an indirect-effect hint.
    const RF_ID = 'rf-1';
    function makeMultiGroundFixture(): EngineDataInput[] {
      // Carol is a third, otherwise-uninvolved active player — keeps this fixture OUT of
      // the heads-up (exactly 2 active players) investigation shortcut, same reasoning
      // as the Bot Attack fixture above: with only 2 players, raw level 2 would already
      // count as fully-investigated (effectiveInvestigationLevel's +1 bump), leaving
      // nothing left for this dig to reveal.
      return makePlayers([
        {
          id: 'player-1', name: 'Alice',
          // Both of Risky Fundraising's grounds are relative-type (equity/revenue) —
          // both fields need a real non-zero value here for their stakes to price above
          // $0, since digDeeper reads the attacker's CURRENT persisted vars directly
          // (no fresh balance-sheet recompute, unlike a real turn resolution).
          variables: makeVars({ equity: 500000, revenue: 200000 }),
          engineState: { activeDecisions: [{ id: RF_ID, definitionName: 'Risky Fundraising', deployedYear: 1, elapsedYears: 0, isMatured: true }] },
        },
        { id: 'player-2', name: 'Bob', variables: makeVars({ cash: 100000 }), engineState: { investigations: { [RF_ID]: 2 } } },
        { id: 'player-3', name: 'Carol' },
      ]);
    }

    it('dig 3 lists every legal risk the decision carries, sorted by estimated probability descending', () => {
      const outcome = gameLoop.digDeeper('player-2', RF_ID, makeMultiGroundFixture());

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(3);
      expect(outcome.attack.suggestedGrounds).toHaveLength(2);
      expect(outcome.attack.suggestedGrounds!.map((g) => g.name)).toEqual([
        'Fraudulent Capital Procurement',
        'Unfair Competition via Fundraising',
      ]);
      expect(outcome.attack.suggestedGrounds![0].probability).toBeGreaterThan(outcome.attack.suggestedGrounds![1].probability);
      // Both grounds' stakes are real, non-zero numbers — not just the top one's.
      expect(outcome.attack.suggestedGrounds!.every((g) => g.stakes > 0)).toBe(true);
    });
  });

  describe('chargeLawsuitFilingFee', () => {
    function makeFeeFixture(cash = 100000): EngineDataInput[] {
      return makePlayers([{ id: 'player-1', name: 'Alice', variables: makeVars({ cash }) }]);
    }

    it('charges the flat lawsuitFilingCost plus the wealth-scaled surcharge, and returns the new cash', () => {
      // makeConfig's lawsuitFilingCost is 15000, plus wealthScaledFeeRate (0.03) of the
      // payer's own 100000 cash = 18000 total.
      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'player-1', makeFeeFixture());

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.cost).toBe(18000);
      expect(outcome.newCash).toBe(82000);
      expect(outcome.variables.cash).toBe(82000);
    });

    it('fails with insufficient_funds and does not charge when cash is below the cost', () => {
      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'player-1', makeFeeFixture(5000));

      expect(outcome).toEqual({ success: false, reason: 'insufficient_funds' });
    });

    it('fails with player_not_found for an unknown player', () => {
      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'nonexistent', makeFeeFixture());

      expect(outcome).toEqual({ success: false, reason: 'player_not_found' });
    });

    it('fails with limit_reached once this player has already queued maxLawsuitsPerPlayerPerTurn lawsuits this round', () => {
      // makeConfig's maxLawsuitsPerPlayerPerTurn is 3.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [], financial: [],
        lawsuits: [
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-a' },
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-b' },
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-c' },
        ],
      });

      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'player-1', makeFeeFixture());

      expect(outcome).toEqual({ success: false, reason: 'limit_reached' });
    });

    it('does not count another player\'s queued lawsuits toward this player\'s limit', () => {
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [],
        operational: [], financial: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'New Factory', groundName: 'ground-a' }],
      });

      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'player-1', makeFeeFixture());

      expect(outcome.success).toBe(true);
    });

    it('does not carry a room\'s queued-lawsuit count over to a different room', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [], financial: [],
        lawsuits: [
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-a' },
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-b' },
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-c' },
        ],
      });

      const outcome = gameLoop.chargeLawsuitFilingFee('room-2', 'player-1', makeFeeFixture());

      expect(outcome.success).toBe(true);
    });
  });

  describe('makeOffer', () => {
    it('lets the defendant make the opening offer', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 10000, playersWithCase(makeCase()));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.offers).toEqual([{ by: 'defendant', amount: 10000 }]);
      expect(outcome.case.status).toBe('negotiating');
      // Neither party's cash moves on an offer — only accepting one does.
      expect(outcome.plaintiff.cash).toBeUndefined();
      expect(outcome.defendant.cash).toBeUndefined();
      // Both parties' own persisted copy of the case must carry the new offer.
      expect(outcome.plaintiff.engineState.legalCases[0].offers).toEqual(outcome.case.offers);
      expect(outcome.defendant.engineState.legalCases[0].offers).toEqual(outcome.case.offers);
    });

    it('rejects the plaintiff trying to make the opening offer — the defendant always moves first', () => {
      const outcome = gameLoop.makeOffer('player-2', 'case-1', 10000, playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'not_your_turn' });
    });

    it('lets the plaintiff counter after the defendant\'s opening offer', () => {
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.makeOffer('player-2', 'case-1', 15000, playersWithCase(case_));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.offers).toEqual([
        { by: 'defendant', amount: 10000 },
        { by: 'plaintiff', amount: 15000 },
      ]);
    });

    it('rejects a party trying to counter their own just-made offer', () => {
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 12000, playersWithCase(case_));

      expect(outcome).toEqual({ success: false, reason: 'not_your_turn' });
    });

    it('rejects an amount above the case\'s stakes', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 999999, playersWithCase(makeCase({ stakes: 20000 })));

      expect(outcome).toEqual({ success: false, reason: 'invalid_amount' });
    });

    it('rejects a negative amount', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', -1, playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'invalid_amount' });
    });

    it('allows exactly 0 as the opening offer — the bracket floor is inclusive', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 0, playersWithCase(makeCase()));

      expect(outcome.success).toBe(true);
    });

    describe('offer bracket narrows with each move (regression)', () => {
      // The valid range for the NEXT offer is always [defendant's own latest offer (0 if
      // none), plaintiff's own latest offer (stakes if none)] — narrowing inward on every
      // move rather than staying fixed at (0, stakes] for the whole negotiation. See
      // GameLoop.computeOfferBracket's doc comment for the full reasoning.
      const stakes = 20000;

      it('bounds the defendant\'s opening offer to [0, stakes]', () => {
        expect(gameLoop.makeOffer('player-1', 'case-1', -1, playersWithCase(makeCase({ stakes }))).success).toBe(false);
        expect(gameLoop.makeOffer('player-1', 'case-1', stakes + 1, playersWithCase(makeCase({ stakes }))).success).toBe(false);
        expect(gameLoop.makeOffer('player-1', 'case-1', 0, playersWithCase(makeCase({ stakes }))).success).toBe(true);
        expect(gameLoop.makeOffer('player-1', 'case-1', stakes, playersWithCase(makeCase({ stakes }))).success).toBe(true);
      });

      it('bounds the plaintiff\'s first counter to [defendant\'s offer, stakes]', () => {
        const case_ = makeCase({ stakes, offers: [{ by: 'defendant', amount: 8000 }] });
        expect(gameLoop.makeOffer('player-2', 'case-1', 7999, playersWithCase(case_)).success).toBe(false);
        expect(gameLoop.makeOffer('player-2', 'case-1', stakes + 1, playersWithCase(case_)).success).toBe(false);
        expect(gameLoop.makeOffer('player-2', 'case-1', 8000, playersWithCase(case_)).success).toBe(true);
        expect(gameLoop.makeOffer('player-2', 'case-1', stakes, playersWithCase(case_)).success).toBe(true);
      });

      it('bounds the defendant\'s second offer to [their own first offer, the plaintiff\'s counter] — NOT [0, stakes]', () => {
        const case_ = makeCase({
          stakes,
          offers: [
            { by: 'defendant', amount: 8000 },
            { by: 'plaintiff', amount: 15000 },
          ],
        });
        // Below the defendant's own first offer — rejected even though it's still > 0.
        expect(gameLoop.makeOffer('player-1', 'case-1', 7999, playersWithCase(case_)).success).toBe(false);
        // Above the plaintiff's counter — rejected even though it's still <= stakes.
        expect(gameLoop.makeOffer('player-1', 'case-1', 15001, playersWithCase(case_)).success).toBe(false);
        // Anywhere between the two latest offers is valid.
        expect(gameLoop.makeOffer('player-1', 'case-1', 8000, playersWithCase(case_)).success).toBe(true);
        expect(gameLoop.makeOffer('player-1', 'case-1', 12000, playersWithCase(case_)).success).toBe(true);
        expect(gameLoop.makeOffer('player-1', 'case-1', 15000, playersWithCase(case_)).success).toBe(true);
      });

      it('bounds the plaintiff\'s second counter to [the defendant\'s latest offer, the plaintiff\'s own first counter]', () => {
        const case_ = makeCase({
          stakes,
          offers: [
            { by: 'defendant', amount: 8000 },
            { by: 'plaintiff', amount: 15000 },
            { by: 'defendant', amount: 10000 },
          ],
        });
        expect(gameLoop.makeOffer('player-2', 'case-1', 9999, playersWithCase(case_)).success).toBe(false);
        expect(gameLoop.makeOffer('player-2', 'case-1', 15001, playersWithCase(case_)).success).toBe(false);
        expect(gameLoop.makeOffer('player-2', 'case-1', 10000, playersWithCase(case_)).success).toBe(true);
        expect(gameLoop.makeOffer('player-2', 'case-1', 15000, playersWithCase(case_)).success).toBe(true);
      });
    });

    it('rejects an offer on a case that has already left negotiation', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 10000, playersWithCase(makeCase({ status: 'awaiting_trial' })));

      expect(outcome).toEqual({ success: false, reason: 'not_negotiating' });
    });

    it('rejects an unknown case id', () => {
      const outcome = gameLoop.makeOffer('player-1', 'nonexistent-case', 10000, playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'case_not_found' });
    });

    it('rejects a player who is neither the plaintiff nor the defendant on this case', () => {
      const players = [
        ...playersWithCase(makeCase()),
        ...makePlayers([{ id: 'player-3', name: 'Carol' }]),
      ];
      const outcome = gameLoop.makeOffer('player-3', 'case-1', 10000, players);

      expect(outcome).toEqual({ success: false, reason: 'not_a_party' });
    });
  });

  describe('acceptOffer', () => {
    it('settles the case at the last offer\'s amount, defendant paying plaintiff', () => {
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.acceptOffer('player-2', 'case-1', playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.status).toBe('resolved');
      expect(outcome.case.verdict).toBe('settled');
      expect(outcome.case.resolvedAt).toBeInstanceOf(Date);
      expect(outcome.defendant.cash).toBe(90000);
      expect(outcome.plaintiff.cash).toBe(60000);
      expect(outcome.defendant.variables?.cash).toBe(90000);
      expect(outcome.plaintiff.variables?.cash).toBe(60000);
      // Both parties' own persisted copy must carry the resolved case.
      expect(outcome.plaintiff.engineState.legalCases[0].status).toBe('resolved');
      expect(outcome.defendant.engineState.legalCases[0].status).toBe('resolved');
    });

    it('rejects the party who made the offer trying to accept their own offer', () => {
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.acceptOffer('player-1', 'case-1', playersWithCase(case_));

      expect(outcome).toEqual({ success: false, reason: 'not_your_turn' });
    });

    it('rejects accepting when no offer has been made yet', () => {
      const outcome = gameLoop.acceptOffer('player-2', 'case-1', playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'no_offer_to_accept' });
    });

    it('accepts the most recent offer after a counter, not an earlier one', () => {
      const case_ = makeCase({
        offers: [
          { by: 'defendant', amount: 10000 },
          { by: 'plaintiff', amount: 15000 },
        ],
      });
      const outcome = gameLoop.acceptOffer('player-1', 'case-1', playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.defendant.cash).toBe(85000);
      expect(outcome.plaintiff.cash).toBe(65000);
    });
  });

  describe('goToCourt', () => {
    it('lets the defendant end negotiation and send the case to trial without a verdict yet', () => {
      const outcome = gameLoop.goToCourt('player-1', 'case-1', playersWithCase(makeCase()));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.status).toBe('awaiting_trial');
      expect(outcome.case.verdict).toBeUndefined();
      expect(outcome.plaintiff.cash).toBeUndefined();
      expect(outcome.defendant.cash).toBeUndefined();
    });

    it('lets the plaintiff end negotiation too — either party can walk away at any time, no turn-gating', () => {
      // Even mid-exchange, with the defendant's offer still awaiting the plaintiff's
      // response, the plaintiff can go straight to court instead of countering/accepting.
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.goToCourt('player-2', 'case-1', playersWithCase(case_));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.status).toBe('awaiting_trial');
    });

    it('rejects a case that has already left negotiation', () => {
      const outcome = gameLoop.goToCourt('player-1', 'case-1', playersWithCase(makeCase({ status: 'resolved', verdict: 'settled' })));

      expect(outcome).toEqual({ success: false, reason: 'not_negotiating' });
    });

    it('rejects a player who is neither the plaintiff nor the defendant on this case', () => {
      const players = [
        ...playersWithCase(makeCase()),
        ...makePlayers([{ id: 'player-3', name: 'Carol' }]),
      ];
      const outcome = gameLoop.goToCourt('player-3', 'case-1', players);

      expect(outcome).toEqual({ success: false, reason: 'not_a_party' });
    });
  });

  describe('digDeeperOnCase', () => {
    // Fixture: plaintiffId 'player-2', defendantId 'player-1' (see makeCase).
    it('charges the defendant digDeeperCost plus the wealth-scaled surcharge, and reveals the odds by flipping defendantInvestigated', () => {
      const case_ = makeCase({ defendantInvestigated: false });
      const outcome = gameLoop.digDeeperOnCase('player-1', 'case-1', playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.defendantInvestigated).toBe(true);
      // 10000 flat + 0.03*100000 wealth-scaled surcharge = 13000.
      expect(outcome.defendant.cash).toBe(87000);
      expect(outcome.defendant.variables?.cash).toBe(87000);
      // The plaintiff's own persisted copy carries the updated flag too, but their cash
      // never moves — this is a defendant-only cost.
      expect(outcome.plaintiff.cash).toBeUndefined();
      expect(outcome.plaintiff.engineState.legalCases[0].defendantInvestigated).toBe(true);
      expect(outcome.defendant.engineState.legalCases[0].defendantInvestigated).toBe(true);
    });

    it('rejects the plaintiff trying to dig deeper on their own filed case', () => {
      const outcome = gameLoop.digDeeperOnCase('player-2', 'case-1', playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'not_defendant' });
    });

    it('rejects a case already investigated', () => {
      const case_ = makeCase({ defendantInvestigated: true });
      const outcome = gameLoop.digDeeperOnCase('player-1', 'case-1', playersWithCase(case_));

      expect(outcome).toEqual({ success: false, reason: 'already_investigated' });
    });

    it('rejects the defendant when they cannot afford digDeeperCost', () => {
      const case_ = makeCase();
      const outcome = gameLoop.digDeeperOnCase('player-1', 'case-1', playersWithCase(case_, { 'player-1': 5000 }));

      expect(outcome).toEqual({ success: false, reason: 'insufficient_funds' });
    });

    it('rejects an unknown case id', () => {
      const outcome = gameLoop.digDeeperOnCase('player-1', 'no-such-case', playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'case_not_found' });
    });
  });

  describe('negotiation turn-boundary fallbacks (Step 8b)', () => {
    it('auto-settles a case with genuine back-and-forth (2+ offers) left unanswered at the very next turn boundary — the standing offer is treated as accepted', () => {
      // Defendant opened at 8000, plaintiff countered to 10000 last turn; nobody
      // accepted/countered/went to court before this turn resolved. makeConfig's
      // negotiationPeriodTurns is 2 — this must settle on this very first boundary
      // check, not wait for the cap, since real back-and-forth already happened.
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 8000 }, { by: 'plaintiff', amount: 10000 }] });
      const withOffer = playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 });
      // Identical fixture but with no case at all — isolates exactly the settlement's
      // cash effect from everything else a turn's P&L/balance-sheet math also moves,
      // by diffing this run against the one with the pending offer.
      const withoutCase = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 100000 }) },
        { id: 'player-2', name: 'Bob', variables: makeVars({ cash: 50000 }) },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 2, withOffer);
      const baseline = gameLoop.resolveTurn('room-1', 2, withoutCase);

      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases[0];
      const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
      expect(aliceCase?.status).toBe('resolved');
      expect(aliceCase?.verdict).toBe('settled');
      expect(bobCase?.status).toBe('resolved');
      expect(bobCase?.verdict).toBe('settled');

      const aliceCash = outcome.result.players.find((p) => p.playerId === 'player-1')!.variables.cash;
      const bobCash = outcome.result.players.find((p) => p.playerId === 'player-2')!.variables.cash;
      const aliceBaselineCash = baseline.result.players.find((p) => p.playerId === 'player-1')!.variables.cash;
      const bobBaselineCash = baseline.result.players.find((p) => p.playerId === 'player-2')!.variables.cash;

      // Defendant (Alice, player-1) paid the plaintiff (Bob, player-2) exactly the
      // standing (plaintiff's counter) offer, on top of whatever the rest of the
      // turn's math already did.
      expect(aliceBaselineCash - aliceCash).toBeCloseTo(10000, 5);
      expect(bobCash - bobBaselineCash).toBeCloseTo(10000, 5);
    });

    it('does not auto-settle a case with no offers yet on its first boundary check — the original negotiationPeriodTurns cap still applies', () => {
      // No offer was ever made — must NOT be settled or forced to trial after just one
      // turn (negotiationPeriodTurns is 2); this is the pre-existing timeout path,
      // unaffected by the offer-driven settle branch.
      const players = playersWithCase(makeCase());

      const outcome = gameLoop.resolveTurn('room-1', 2, players);

      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases[0];
      expect(aliceCase?.status).toBe('negotiating');
      expect(aliceCase?.turnsNegotiating).toBe(1);
    });

    // Regression: a real, reported bug — a single one-sided opening offer (e.g. the
    // defendant's own opening move) used to auto-settle at the very next boundary purely
    // because SOME offer existed, even though the OTHER side never engaged at all
    // (never accepted, countered, or forced a trial). This produced a confusing "Settled"
    // outcome for a case nobody actually agreed to anything on — most visibly when the
    // lone offer was $0 on a provably-hopeless (time-barred/already-sued) case. A single
    // unanswered offer must now be treated exactly like no offer at all.
    it('does NOT auto-settle a case with only ONE one-sided offer (no back-and-forth) on its first boundary check', () => {
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 0 }] });
      const players = playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 });

      const outcome = gameLoop.resolveTurn('room-1', 2, players);

      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases[0];
      expect(aliceCase?.status).toBe('negotiating');
      expect(aliceCase?.verdict).toBeUndefined();
      expect(aliceCase?.turnsNegotiating).toBe(1);
      // Neither party's cash moved — a real, reported bug had the defendant's $0 offer
      // silently "pay" nothing while still stamping the case resolved/settled.
      const aliceCash = outcome.result.players.find((p) => p.playerId === 'player-1')!.variables.cash;
      const bobCash = outcome.result.players.find((p) => p.playerId === 'player-2')!.variables.cash;
      const baseline = gameLoop.resolveTurn('room-1', 2, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 100000 }) },
        { id: 'player-2', name: 'Bob', variables: makeVars({ cash: 50000 }) },
      ]));
      expect(aliceCash).toBeCloseTo(baseline.result.players.find((p) => p.playerId === 'player-1')!.variables.cash, 5);
      expect(bobCash).toBeCloseTo(baseline.result.players.find((p) => p.playerId === 'player-2')!.variables.cash, 5);
    });

    it('forces a one-sided-offer case to trial once negotiationPeriodTurns is reached, same as a genuinely untouched case', () => {
      // turnsNegotiating already at 1 (one prior boundary check already passed) —
      // makeConfig's negotiationPeriodTurns is 2, so this next check must cross the cap.
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 0 }], turnsNegotiating: 1 });
      const players = playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 });

      const outcome = gameLoop.resolveTurn('room-1', 3, players);

      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases[0];
      // Resolved THIS turn via the normal trial loop (not left dangling as
      // 'awaiting_trial' until a future turn) — same "resolves in the same turn it
      // crosses the threshold" guarantee the no-offer path already has.
      expect(aliceCase?.status).toBe('resolved');
      expect(aliceCase?.verdict === 'won' || aliceCase?.verdict === 'lost').toBe(true);
    });
  });

  describe('predictFutureKpis', () => {
    // 'New Factory' (this file's fixture decision, not the real game_engine.json's) has
    // cash: { 1: -30000, default: -30000 } — it keeps draining 30k every year forever
    // once deployed, which makes it a convenient known quantity to isolate.
    function makePredictFixture(aliceCash: number, opts: { withDecision?: boolean; suppressRevenue?: boolean } = {}): EngineDataInput[] {
      const { withDecision = true, suppressRevenue = false } = opts;
      return makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          // Zeroing out capacityUtilization/installedCapacity drives volume (and so
          // revenue) to ~0, isolating fixed costs (operatingExpenses/staffCost, which
          // apply regardless of production) as the only meaningful cash drain — used
          // by the bankruptcy test below, since this fixture's default economy
          // otherwise grows cash by millions/turn (revenue swamps any single
          // decision's cash-schedule effect, real game_engine.json numbers aside).
          variables: makeVars(suppressRevenue ? { cash: aliceCash, capacityUtilization: 0, installedCapacity: 0 } : { cash: aliceCash }),
          engineState: {
            activeDecisions: withDecision
              ? [{ id: 'inst-1', definitionName: 'New Factory', deployedYear: 1, elapsedYears: 0, isMatured: false }]
              : [],
          },
        },
        { id: 'player-2', name: 'Bob' },
      ]);
    }

    it('does not keep re-applying an already-matured decision\'s effect into future predicted turns (regression — a decision\'s own effect lands once, at maturity, then holds)', () => {
      // 'Bot Attack' only touches the deploying player's own vars via a flat, instant-
      // maturity `cash: -12000` (no explicit schedule years — its other two impact fields
      // are `target.*`, routed to whichever rival is targeted, never back onto the
      // attacker themselves). In real play that -12000 lands exactly once, at deployment
      // (Step 1's applyImpactsForYear call) — by the time an instance like this sits in
      // engineState at isMatured:true, its one-time cost has already happened and is
      // already baked into whatever cash value is persisted alongside it; nothing further
      // should ever come from it again, in a real turn or in a sandboxed prediction. This
      // used to assert the opposite (`toBeLessThan`, an ever-widening gap) — a real,
      // reported finding from a randomized-play simulation that a matured decision's
      // 'default' effect was being re-applied every single subsequent turn forever
      // (bounded only by the statute of limitations) instead of landing once and holding.
      const withAttack = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 500000 }), engineState: { activeDecisions: [{ id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true, targetId: 'player-2' }] } },
        { id: 'player-2', name: 'Bob' },
      ]);
      const withoutAttack = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 500000 }) },
        { id: 'player-2', name: 'Bob' },
      ]);

      const predictedWithAttack = gameLoop.predictFutureKpis('no-submission-room', 'player-1', 5, withAttack, 3);
      const predictedWithoutAttack = gameLoop.predictFutureKpis('no-submission-room', 'player-1', 5, withoutAttack, 3);

      expect(predictedWithAttack.predicted).toHaveLength(3);
      expect(predictedWithoutAttack.predicted).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(predictedWithAttack.predicted[i].variables.cash).toBeCloseTo(predictedWithoutAttack.predicted[i].variables.cash, 5);
      }
    });

    it('keeps applying a still-maturing decision\'s remaining schedule into predicted turns, but stops for good once it matures', () => {
      // 'New Factory' (this file's fixture) has cash: {1: -30000, default: -30000} — a
      // one-year-explicit-then-permanent schedule, maturity threshold 1 — deployed fresh
      // (elapsedYears 0, not yet matured). suppressRevenue pins capacityUtilization at 0
      // for the whole prediction (nothing in this fixture's New Factory ever changes
      // capacityUtilization), which pins maxSupply/volume/revenue at 0 regardless of
      // installedCapacity's own growth — isolating New Factory's direct cash-schedule
      // effect from the revenue-side confound its installedCapacity bump would otherwise
      // introduce (see makePredictFixture's own doc comment on why New Factory normally
      // "swamps its own cash schedule").
      const withDecision = makePredictFixture(500000, { withDecision: true, suppressRevenue: true });
      const withoutDecision = makePredictFixture(500000, { withDecision: false, suppressRevenue: true });

      const predictedWith = gameLoop.predictFutureKpis('no-submission-room', 'player-1', 5, withDecision, 3);
      const predictedWithout = gameLoop.predictFutureKpis('no-submission-room', 'player-1', 5, withoutDecision, 3);

      // Predicted turn 1 (elapsedYears 0->1, exactly at the maturity threshold): the
      // 'default' cash value is consulted for the first time here — the gap opens up.
      const gapTurn1 = predictedWithout.predicted[0].variables.cash - predictedWith.predicted[0].variables.cash;
      expect(gapTurn1).toBeCloseTo(30000, 1);

      // Predicted turns 2 and 3 (elapsedYears 1->2, 2->3: both past the threshold): no
      // further cash is drained by this instance — the gap must not keep growing.
      const gapTurn2 = predictedWithout.predicted[1].variables.cash - predictedWith.predicted[1].variables.cash;
      const gapTurn3 = predictedWithout.predicted[2].variables.cash - predictedWith.predicted[2].variables.cash;
      expect(gapTurn2).toBeCloseTo(gapTurn1, 1);
      expect(gapTurn3).toBeCloseTo(gapTurn1, 1);
    });

    it('rounds are sequential starting at currentRound + 1', () => {
      const prediction = gameLoop.predictFutureKpis('no-submission-room', 'player-1', 5, makePredictFixture(500000), 3);

      expect(prediction.predicted.map(p => p.round)).toEqual([6, 7, 8]);
    });

    it('stops at (not before) the bankrupt round, with that round\'s real negative cash included (regression — the graph used to stop one turn short of the drop)', () => {
      // Revenue suppressed (see makePredictFixture) so fixed costs alone drain this
      // small starting cash negative well within the 3-turn window.
      const prediction = gameLoop.predictFutureKpis('no-submission-room', 'player-1', 1, makePredictFixture(20000, { suppressRevenue: true }), 3);

      expect(prediction.predicted.length).toBeLessThan(3);
      expect(prediction.bankruptAtRound).toBeDefined();
      expect(prediction.bankruptAtRound).toBeGreaterThan(1);

      // The last predicted point IS the bankrupt round — a player needs to actually see
      // cash cross zero to react (e.g. sell shares) before it happens for real.
      const last = prediction.predicted[prediction.predicted.length - 1];
      expect(last.round).toBe(prediction.bankruptAtRound);
      expect(last.variables.cash).toBeLessThan(0);
    });

    it('returns no predicted points for an unknown player id', () => {
      const prediction = gameLoop.predictFutureKpis('no-submission-room', 'nonexistent', 5, makePredictFixture(500000), 3);

      expect(prediction).toEqual({ predicted: [] });
    });

    it('reads, but never clears/consumes, the real room\'s in-flight submissions — a queued decision for the real room still applies after a prediction runs', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Exclusive Deal' }],
        operational: [], financial: [],
        lawsuits: [],
      });

      // Run a prediction in between — folds the queued decision into the sandbox (see the
      // tests below), but must not clear or otherwise disturb 'room-1'.
      gameLoop.predictFutureKpis('room-1', 'player-1', 1, makePredictFixture(500000), 3);

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const alice = outcome.result.players.find(p => p.playerId === 'player-1')!;
      expect(alice.activeDecisions.some(d => d.decisionName === 'Exclusive Deal')).toBe(true);
    });

    // Regression: predictFutureKpis used to assume the player submits nothing, even while
    // they had a real, in-progress selection queued right next to the graph in the UI —
    // defeating the point of a "preview my future" prediction. Fixed by seeding the
    // sandbox's very first predicted turn with the player's own live `this.submissions`
    // entry for the real room (never a rival's — see the test right after this one).
    it('folds the player\'s OWN currently-queued (not yet turn-resolved) decision into the very first predicted turn', () => {
      // withDecision: false (no PRE-existing New Factory — that's the whole point, this
      // one is only ever QUEUED, not yet deployed) + suppressRevenue: true (isolates the
      // cash-schedule effect from the installedCapacity/revenue-side confound New
      // Factory's own capacity bump would otherwise introduce — see this fixture's own
      // doc comment on why New Factory normally "swamps its own cash schedule").
      const opts = { withDecision: false, suppressRevenue: true };
      const baseline = gameLoop.predictFutureKpis('room-1', 'player-1', 5, makePredictFixture(500000, opts), 3);

      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }], operational: [], financial: [], lawsuits: [],
      });
      const withQueued = gameLoop.predictFutureKpis('room-1', 'player-1', 5, makePredictFixture(500000, opts), 3);

      // New Factory's own cash schedule ({1: -30000, default: -30000}, this file's
      // fixture) is an extra drain the baseline (nothing queued) never sees.
      expect(withQueued.predicted[0].variables.cash).toBeLessThan(baseline.predicted[0].variables.cash);
    });

    it('does NOT fold in a rival\'s currently-queued decision in the same real room — predicts your own decisions, not others\'', () => {
      const opts = { withDecision: false, suppressRevenue: true };
      const baseline = gameLoop.predictFutureKpis('room-1', 'player-1', 5, makePredictFixture(500000, opts), 3);

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'New Factory' }], operational: [], financial: [], lawsuits: [],
      });
      const afterRivalQueued = gameLoop.predictFutureKpis('room-1', 'player-1', 5, makePredictFixture(500000, opts), 3);

      expect(afterRivalQueued.predicted[0].variables.cash).toBeCloseTo(baseline.predicted[0].variables.cash, 5);
    });
  });

  describe('getActiveDecisionSummaries', () => {
    it('returns each active decision with its definition description, deployed year, and elapsed years', () => {
      const players = makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          engineState: {
            activeDecisions: [
              { id: 'inst-1', definitionName: 'New Factory', deployedYear: 1, elapsedYears: 2, isMatured: true },
              { id: 'inst-2', definitionName: 'Bot Attack', deployedYear: 3, elapsedYears: 0, isMatured: false, targetId: 'player-2' },
            ],
          },
        },
      ]);

      const summaries = gameLoop.getActiveDecisionSummaries('player-1', players);

      expect(summaries).toEqual([
        { instanceId: 'inst-1', decisionName: 'New Factory', description: 'Build a new factory', deployedYear: 1, elapsedYears: 2 },
        { instanceId: 'inst-2', decisionName: 'Bot Attack', description: 'Launch a coordinated cyberattack against a competitor', deployedYear: 3, elapsedYears: 0 },
      ]);
    });

    it('returns an empty array for a player with no active decisions', () => {
      const players = makePlayers([{ id: 'player-1', name: 'Alice' }]);

      expect(gameLoop.getActiveDecisionSummaries('player-1', players)).toEqual([]);
    });

    it('returns null for an unknown player id', () => {
      expect(gameLoop.getActiveDecisionSummaries('nobody', twoPlayers())).toBeNull();
    });

    it('returns null for a player with no company row (e.g. already bankrupted)', () => {
      const players: EngineDataInput[] = [{ id: 'player-1', name: 'Alice', company: null }];

      expect(gameLoop.getActiveDecisionSummaries('player-1', players)).toBeNull();
    });
  });

  describe('getInitialSnapshot', () => {
    it('should return empty result when no players exist', () => {
      const result = gameLoop.getInitialSnapshot('room-1', 1, []);

      expect(result.players).toHaveLength(0);
      expect(result.gameOver).toBe(false);
    });

    it('should compute a starting-position snapshot with no decisions applied', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', cash: 0, variables: {} },
        { id: 'player-2', name: 'Bob', cash: 0, variables: {} },
      ]);

      const result = gameLoop.getInitialSnapshot('room-1', 1, players);

      expect(result.round).toBe(1);
      expect(result.gameOver).toBe(false);
      expect(result.players).toHaveLength(2);
      // Starting values seeded, market share/volume computed across both players
      expect(result.players[0].variables.cash).toBeGreaterThan(0);
      expect(result.players[0].derived.marketShare).toBeGreaterThan(0);
      expect(result.players[0].derived.volume).toBeGreaterThan(0);
      // No decisions have been submitted yet — nothing active, no lawsuits
      expect(result.players[0].activeDecisions).toEqual([]);
      expect(result.players[0].legalCases).toEqual([]);
    });

    it('should never report gameOver, even for a single-player room', () => {
      // Unlike resolveTurn, this is a preview before any real round has been played —
      // it must never end the game, regardless of player count.
      const players = makePlayers([
        { id: 'player-1', name: 'SoloPlayer', cash: 0, variables: {} },
      ]);

      const result = gameLoop.getInitialSnapshot('room-1', 1, players);

      expect(result.gameOver).toBe(false);
      expect(result.winnerId).toBeUndefined();
    });

    it('stamps isInitialSnapshot: true, on both the empty-players and normal paths (regression — the client relies on this to tell round 1\'s empty starting broadcast apart from round 1\'s real resolveTurn result, which carries the same round number)', () => {
      expect(gameLoop.getInitialSnapshot('room-1', 1, []).isInitialSnapshot).toBe(true);

      const players = makePlayers([{ id: 'player-1', name: 'Alice', cash: 0, variables: {} }]);
      expect(gameLoop.getInitialSnapshot('room-1', 1, players).isInitialSnapshot).toBe(true);
    });
  });

  describe('resolveTurn never marks its result as an initial snapshot (regression)', () => {
    it('leaves isInitialSnapshot unset on a real turn resolution, even for round 1', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', cash: 100000, variables: { cash: 100000, assets: 500000 } },
        { id: 'player-2', name: 'Bob', cash: 100000, variables: { cash: 100000, assets: 500000 } },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 1, players);

      expect(outcome.result.isInitialSnapshot).toBeFalsy();
    });
  });
});
