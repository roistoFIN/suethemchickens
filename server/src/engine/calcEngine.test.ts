import { describe, it, expect } from 'vitest';
import {
  applyDepreciation,
  addDepreciationEntry,
  calculateCompetitivenessAndMarketShare,
  calculateEffectiveTotalMarketVolume,
  calculateVolume,
  calculatePL,
  updateBalanceSheet,
  calculateAdjustedProbability,
  calculateLegalExposureRatio,
  calculateRiskGauge,
  calculateOwnershipRisk,
  applyDecisionImpacts,
  applyTargetImpacts,
  calculateMaturityYears,
  renormalizeShareOwnership,
  SELF_OWNERSHIP_KEY,
  EXTERNAL_MARKET_KEY,
} from './calcEngine';
import { buildFormulaSet } from './formulaEngine';
import { DEFAULT_FORMULA_SEEDS } from './defaultFormulas';
import type { PlayerVariables, AdminVariables } from '@suethemchickens/shared';

// The real 23 seeded formula expressions, compiled once — every calcEngine function
// that now takes a FormulaSet is exercised against the actual production formulas,
// not a stand-in, so these tests still validate real behavior, not just plumbing.
const DEFAULT_FORMULAS = buildFormulaSet(DEFAULT_FORMULA_SEEDS);

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

function makeAdmin(overrides: Partial<AdminVariables> = {}): AdminVariables {
  return {
    competitiveness: {
      competitivenessWeight_quality_wq: 0.3,
      competitivenessWeight_supply_ws: 0.2,
      competitivenessWeight_loss_wl: 0.15,
      competitivenessWeight_demand_wd: 0.1,
      outrageDemandWeight: 0.5,
      demandPriceElasticity: 1.0,
      referencePrice: 500, // matches makeVars()'s own default price, so "neutral" tests need no override
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
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('calcEngine', () => {
  describe('addDepreciationEntry', () => {
    it('should create an entry for a positive assets addition', () => {
      const entry = addDepreciationEntry('assets', 100000, 2024);
      expect(entry).not.toBeNull();
      expect(entry!.assetType).toBe('assets');
      expect(entry!.originalValue).toBe(100000);
      expect(entry!.purchaseYear).toBe(2024);
      expect(entry!.usefulLife).toBe(10);
      expect(entry!.annualAmount).toBe(10000);
      expect(entry!.remainingYears).toBe(10);
    });

    it('should use 5-year life for intangible assets', () => {
      const entry = addDepreciationEntry('intangibleAssets', 50000, 2024);
      expect(entry).not.toBeNull();
      expect(entry!.usefulLife).toBe(5);
      expect(entry!.annualAmount).toBe(10000);
    });

    // Regression: this used to be gated by a hardcoded decision-name allowlist
    // (DEPRECIATING_ASSETS) — any decision (existing, renamed, or newly admin-added) with
    // a genuine positive asset addition must depreciate, not just the ones a developer
    // happened to list by name in source. See CLAUDE.md.
    it('should create an entry for a positive assets addition regardless of which decision produced it — no hardcoded name allowlist', () => {
      expect(addDepreciationEntry('assets', 10000, 2024)).not.toBeNull();
      expect(addDepreciationEntry('assets', 5000, 2024)).not.toBeNull();
    });

    it('should return null for zero or negative values', () => {
      expect(addDepreciationEntry('assets', 0, 2024)).toBeNull();
      expect(addDepreciationEntry('assets', -100, 2024)).toBeNull();
    });
  });

  describe('applyDepreciation', () => {
    it('should depreciate existing ledger entries', () => {
      const vars = makeVars({ assets: 50000 });
      const ledger = [
        {
          id: 'e1',
          assetType: 'assets' as const,
          originalValue: 10000,
          purchaseYear: 2020,
          usefulLife: 10,
          annualAmount: 1000,
          remainingYears: 5,
        },
      ];

      const result = applyDepreciation(vars, ledger, 2024);

      expect(result.totalDepreciation).toBe(1000);
      expect(result.updatedVars.assets).toBe(49000);
      expect(result.updatedLedger[0].remainingYears).toBe(4);
    });

    it('should remove fully depreciated entries', () => {
      const vars = makeVars({ assets: 50000 });
      const ledger = [
        {
          id: 'e1',
          assetType: 'assets' as const,
          originalValue: 10000,
          purchaseYear: 2010,
          usefulLife: 10,
          annualAmount: 1000,
          remainingYears: 0,
        },
      ];

      const result = applyDepreciation(vars, ledger, 2024);

      expect(result.updatedLedger).toHaveLength(0);
    });

    it('should handle multiple entries', () => {
      const vars = makeVars({ assets: 50000, intangibleAssets: 10000 });
      const ledger = [
        {
          id: 'e1',
          assetType: 'assets' as const,
          originalValue: 10000,
          purchaseYear: 2020,
          usefulLife: 10,
          annualAmount: 1000,
          remainingYears: 5,
        },
        {
          id: 'e2',
          assetType: 'intangibleAssets' as const,
          originalValue: 5000,
          purchaseYear: 2021,
          usefulLife: 5,
          annualAmount: 1000,
          remainingYears: 3,
        },
      ];

      const result = applyDepreciation(vars, ledger, 2024);

      expect(result.totalDepreciation).toBe(2000);
      expect(result.updatedVars.assets).toBe(49000);
      expect(result.updatedVars.intangibleAssets).toBe(9000);
    });

    it('should not modify vars when ledger is empty', () => {
      const vars = makeVars({ assets: 50000 });
      const result = applyDepreciation(vars, [], 2024);

      expect(result.totalDepreciation).toBe(0);
      expect(result.updatedVars.assets).toBe(50000);
      expect(result.updatedLedger).toHaveLength(0);
    });
  });

  describe('calculateCompetitivenessAndMarketShare', () => {
    it('should calculate market shares proportional to competitiveness', () => {
      const ids = ['p1', 'p2'];
      const vars = [
        makeVars({ price: 500, processingLevel: 0.7, supplySecurity: 0.6, processLoss: 0.05, demand: 8000, outrage: 10 }),
        makeVars({ price: 600, processingLevel: 0.5, supplySecurity: 0.4, processLoss: 0.1, demand: 6000, outrage: 20 }),
      ];
      const admin = makeAdmin();

      const result = calculateCompetitivenessAndMarketShare(ids, vars, admin, DEFAULT_FORMULAS);

      expect(result.get('p1')).toBeGreaterThan(result.get('p2')!);
      const total = Array.from(result.values()).reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 4);
    });

    it('should throw when ids and vars lengths mismatch', () => {
      expect(() =>
        calculateCompetitivenessAndMarketShare(['p1'], [makeVars(), makeVars()], makeAdmin(), DEFAULT_FORMULAS),
      ).toThrow('must have the same length');
    });

    it('should give equal shares when all competitiveness is zero', () => {
      const ids = ['p1', 'p2', 'p3'];
      const vars = [
        makeVars({ price: 1, processingLevel: 0, supplySecurity: 0, processLoss: 0, demand: 0, outrage: 0 }),
        makeVars({ price: 1, processingLevel: 0, supplySecurity: 0, processLoss: 0, demand: 0, outrage: 0 }),
        makeVars({ price: 1, processingLevel: 0, supplySecurity: 0, processLoss: 0, demand: 0, outrage: 0 }),
      ];

      const result = calculateCompetitivenessAndMarketShare(ids, vars, makeAdmin(), DEFAULT_FORMULAS);

      expect(result.get('p1')).toBeCloseTo(1 / 3, 4);
      expect(result.get('p2')).toBeCloseTo(1 / 3, 4);
      expect(result.get('p3')).toBeCloseTo(1 / 3, 4);
    });

    it('should return a Map with correct keys', () => {
      const ids = ['alice', 'bob'];
      const vars = [makeVars(), makeVars()];

      const result = calculateCompetitivenessAndMarketShare(ids, vars, makeAdmin(), DEFAULT_FORMULAS);

      expect(result.has('alice')).toBe(true);
      expect(result.has('bob')).toBe(true);
    });
  });

  // Regression/new-behavior coverage for a real, reported gap: totalMarketVolume used to
  // be a flat config constant (10,000), so far above any realistic per-player capacity
  // that market share never actually bound volume/revenue in practice — see CLAUDE.md's
  // market-share section. Fixed by (a) scaling the pie by the room's own active player
  // count instead of a flat total, so a 2p and a 4p game start with the same per-player
  // headroom at parity, and (b) real-world demand elasticity: the pie now also responds
  // to the AVERAGE price across every active player, not just each player's own relative
  // share of a fixed total.
  describe('calculateEffectiveTotalMarketVolume', () => {
    it('scales the pie by active player count when marketFixed (no elasticity)', () => {
      const admin = makeAdmin();
      expect(calculateEffectiveTotalMarketVolume(400, 2, 500, true, admin, DEFAULT_FORMULAS)).toBe(800);
      expect(calculateEffectiveTotalMarketVolume(400, 4, 500, true, admin, DEFAULT_FORMULAS)).toBe(1600);
    });

    it('ignores avgPrice entirely when marketFixed is true, even far from referencePrice', () => {
      const admin = makeAdmin({ competitiveness: { ...makeAdmin().competitiveness, referencePrice: 500 } });
      const atReference = calculateEffectiveTotalMarketVolume(400, 2, 500, true, admin, DEFAULT_FORMULAS);
      const farAbove = calculateEffectiveTotalMarketVolume(400, 2, 5000, true, admin, DEFAULT_FORMULAS);
      expect(farAbove).toBe(atReference);
    });

    it('applies no elasticity adjustment when avgPrice equals referencePrice', () => {
      const admin = makeAdmin({ competitiveness: { ...makeAdmin().competitiveness, referencePrice: 500, demandPriceElasticity: 1.0 } });
      expect(calculateEffectiveTotalMarketVolume(400, 2, 500, false, admin, DEFAULT_FORMULAS)).toBe(800);
    });

    it('shrinks the pie when the average price rises above referencePrice', () => {
      const admin = makeAdmin({ competitiveness: { ...makeAdmin().competitiveness, referencePrice: 500, demandPriceElasticity: 1.0 } });
      // avgPrice 600 is 20% above referencePrice 500 -> factor = 1 - 1.0*0.2 = 0.8
      const result = calculateEffectiveTotalMarketVolume(400, 2, 600, false, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(800 * 0.8, 6);
    });

    it('grows the pie when the average price falls below referencePrice', () => {
      const admin = makeAdmin({ competitiveness: { ...makeAdmin().competitiveness, referencePrice: 500, demandPriceElasticity: 1.0 } });
      // avgPrice 400 is 20% below referencePrice 500 -> factor = 1 + 1.0*0.2 = 1.2
      const result = calculateEffectiveTotalMarketVolume(400, 2, 400, false, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(800 * 1.2, 6);
    });

    it('clamps the elasticity factor to a 0.3-2.0 band so extreme prices cannot zero out or triple the pie', () => {
      // demandPriceElasticity 3.0 makes the unclamped factor swing well outside [0.3, 2.0]
      // for these avgPrice values, so the clamp is actually exercised (not just coincidentally hit).
      const admin = makeAdmin({ competitiveness: { ...makeAdmin().competitiveness, referencePrice: 500, demandPriceElasticity: 3.0 } });
      const crashed = calculateEffectiveTotalMarketVolume(400, 2, 5000, false, admin, DEFAULT_FORMULAS); // unclamped factor deeply negative
      const free = calculateEffectiveTotalMarketVolume(400, 2, 1, false, admin, DEFAULT_FORMULAS); // unclamped factor ~4.0
      expect(crashed).toBeCloseTo(800 * 0.3, 6);
      expect(free).toBeCloseTo(800 * 2.0, 6);
    });

    it('falls back to the unscaled base when referencePrice is misconfigured to zero or negative, rather than dividing by zero', () => {
      const admin = makeAdmin({ competitiveness: { ...makeAdmin().competitiveness, referencePrice: 0, demandPriceElasticity: 1.0 } });
      const result = calculateEffectiveTotalMarketVolume(400, 2, 500, false, admin, DEFAULT_FORMULAS);
      expect(result).toBe(800);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe('calculateVolume', () => {
    it('should cap volume at max supply', () => {
      const vars = makeVars({ installedCapacity: 5000, capacityUtilization: 0.8 });
      const volume = calculateVolume(vars, 0.5, 10000, DEFAULT_FORMULAS);
      // theoretical = 0.5 * 10000 = 5000, maxSupply = 5000 * 0.8 = 4000
      expect(volume).toBe(4000);
    });

    it('should use theoretical volume when below supply cap', () => {
      const vars = makeVars({ installedCapacity: 20000, capacityUtilization: 0.9 });
      const volume = calculateVolume(vars, 0.3, 10000, DEFAULT_FORMULAS);
      // theoretical = 0.3 * 10000 = 3000, maxSupply = 20000 * 0.9 = 18000
      expect(volume).toBe(3000);
    });

    it('should return zero when market share is zero', () => {
      const vars = makeVars();
      expect(calculateVolume(vars, 0, 10000, DEFAULT_FORMULAS)).toBe(0);
    });
  });

  describe('calculatePL', () => {
    it('should calculate correct P&L values', () => {
      const vars = makeVars({
        materialCostPerTon: 100,
        logisticsCostPerTon: 50,
        operatingExpenses: 5000,
        staffCost: 8000,
        otherIncome: 1000,
        debt: 20000,
      });
      const admin = makeAdmin();
      const volume = 5000;
      const depreciation = 5000;

      const result = calculatePL(vars, volume, depreciation, admin, DEFAULT_FORMULAS);

      expect(result.revenue).toBe(5000 * 500); // volume * price
      expect(result.cogs).toBe((100 + 50) * 5000);
      expect(result.grossProfit).toBe(result.revenue - result.cogs);
      expect(result.ebitda).toBe(result.grossProfit - 5000 - 8000 + 1000);
      expect(result.ebit).toBe(result.ebitda - depreciation);
      expect(result.financeCost).toBe(2000 + 20000 * 0.05);
      expect(result.profitBeforeTax).toBe(result.ebit - result.financeCost);
      // Base rate plus the progressive 12% surcharge on profit above $200k/turn (a
      // deliberate cash sink — see defaultFormulas.ts's taxCost expression).
      expect(result.taxCost).toBe(
        Math.max(0, result.profitBeforeTax) * 0.2 + Math.max(0, result.profitBeforeTax - 200000) * 0.12,
      );
      expect(result.netProfit).toBe(result.profitBeforeTax - result.taxCost);
    });

    it('should have zero tax when profit is negative', () => {
      const vars = makeVars({
        materialCostPerTon: 1000,
        logisticsCostPerTon: 500,
        operatingExpenses: 50000,
        staffCost: 50000,
        debt: 100000,
      });
      const admin = makeAdmin();

      const result = calculatePL(vars, 100, 1000, admin, DEFAULT_FORMULAS);

      expect(result.taxCost).toBe(0);
    });
  });

  describe('updateBalanceSheet', () => {
    it('should update cash, reserves, receivables, equity, and stockValue', () => {
      const vars = makeVars({
        cash: 100000,
        reserves: 30000,
        assets: 50000,
        intangibleAssets: 10000,
        debt: 20000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const netProfit = 15000;
      const depreciation = 5000;
      const revenue = 250000;
      const legalExposure = 0;

      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin, DEFAULT_FORMULAS);

      expect(result.cash).toBe(100000 + 15000 + 5000);
      expect(result.reserves).toBe(30000 + 15000);
      expect(result.receivables).toBeCloseTo(250000 * (30 / 365), 2);
      expect(result.equity).toBeCloseTo(
        result.cash + result.receivables + 50000 + 10000 + result.reserves - 20000,
        2,
      );
      expect(result.stockValue).toBeCloseTo(result.equity / 1000, 2);
    });
  });

  describe('calculateAdjustedProbability', () => {
    it('should increase probability with scrutiny', () => {
      const result = calculateAdjustedProbability(0.5, 10, 0, makeAdmin(), DEFAULT_FORMULAS);
      // 0.5 * (1 + 0.02 * 10 / 100 + 0) = 0.5 * (1 + 0.002) = 0.501
      expect(result).toBeCloseTo(0.501, 4);
    });

    it('should return base probability when scrutiny is zero', () => {
      const result = calculateAdjustedProbability(0.3, 0, 0, makeAdmin(), DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(0.3, 4);
    });

    it('should scale linearly with scrutiny', () => {
      const r1 = calculateAdjustedProbability(0.5, 5, 0, makeAdmin(), DEFAULT_FORMULAS);
      const r2 = calculateAdjustedProbability(0.5, 10, 0, makeAdmin(), DEFAULT_FORMULAS);
      expect(r2).toBeGreaterThan(r1);
    });
  });

  describe('calculateRiskGauge', () => {
    it('should calculate risk gauge from open cases and variables', () => {
      const vars = makeVars({
        cash: 100000,
        scrutiny: 50,
        outrage: 30,
      });
      const admin = makeAdmin();
      const openCases = [
        { probability: 0.5, stakes: 20000 },
        { probability: 0.3, stakes: 10000 },
      ];

      const result = calculateRiskGauge(vars, openCases, admin, DEFAULT_FORMULAS);

      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    });

    it('should increase with more legal exposure', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 10, outrage: 5 });
      const admin = makeAdmin();

      const r1 = calculateRiskGauge(vars, [], admin, DEFAULT_FORMULAS);
      const r2 = calculateRiskGauge(vars, [{ probability: 0.8, stakes: 50000 }], admin, DEFAULT_FORMULAS);

      expect(r2).toBeGreaterThan(r1);
    });

    it('should cap at 100', () => {
      const vars = makeVars({ cash: 1, scrutiny: 100, outrage: 100 });
      const admin = makeAdmin();
      const openCases = [{ probability: 1, stakes: 1000000 }];

      const result = calculateRiskGauge(vars, openCases, admin, DEFAULT_FORMULAS);

      expect(result).toBe(75); // w1*1 + w2*1 + w3*1 = 0.3 + 0.2 + 0.25 = 0.75 -> 75
    });

    it('does not go below 0 when scrutiny is negative (regression — found by random-play simulation)', () => {
      // Unlike outrage (fed through Math.abs before the formula ever sees it), scrutiny
      // has no floor of its own and nothing drives it back up once negative — the
      // formula's scrutiny term used to be a bare MIN(1,scrutiny/100), with no lower
      // clamp, so a negative scrutiny value could push the whole gauge below its
      // documented 0-100 range.
      const vars = makeVars({ cash: 100000, scrutiny: -80, outrage: 0 });
      const admin = makeAdmin();

      const result = calculateRiskGauge(vars, [], admin, DEFAULT_FORMULAS);

      expect(result).toBe(0);
    });

    // Deliberate deviation from the Risk Gauge's original 3-term design — see
    // calcEngine.ts's calculateOwnershipRisk doc comment and CLAUDE.md's "Risk Gauge
    // takeover term" section. Majority-ownership takeover is a fully independent way to
    // lose the game; these confirm the gauge actually reflects it now.
    it('includes the ownership/takeover-risk term (w4) when a real player holds a stake', () => {
      const vars = makeVars({
        cash: 100000,
        scrutiny: 0,
        outrage: 0,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.75, rival: 0.25 },
      });
      const admin = makeAdmin({
        riskGauge: { riskWeightLegalExposure_w1: 0, riskWeightScrutiny_w2: 0, riskWeightOutrage_w3: 0, riskWeightOwnership_w4: 1 },
      });

      const result = calculateRiskGauge(vars, [], admin, DEFAULT_FORMULAS);

      // Rival holds 0.25 of a 0.5 takeoverThresholdPercent -> ownershipRisk = 0.5 -> 100*1*0.5 = 50.
      expect(result).toBeCloseTo(50, 5);
    });

    it('stays 0 when no real player holds a stake, even with w4 weighted fully', () => {
      const vars = makeVars({
        cash: 100000,
        scrutiny: 0,
        outrage: 0,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.6, [EXTERNAL_MARKET_KEY]: 0.4 },
      });
      const admin = makeAdmin({
        riskGauge: { riskWeightLegalExposure_w1: 0, riskWeightScrutiny_w2: 0, riskWeightOutrage_w3: 0, riskWeightOwnership_w4: 1 },
      });

      const result = calculateRiskGauge(vars, [], admin, DEFAULT_FORMULAS);

      expect(result).toBe(0);
    });
  });

  describe('calculateOwnershipRisk', () => {
    it('is 0 when no shareOwnership is set (e.g. before round 1)', () => {
      expect(calculateOwnershipRisk(undefined, 0.5)).toBe(0);
    });

    it('is 0 when only self and EXTERNAL_MARKET hold stakes — neither can trigger a takeover', () => {
      const ownership = { [SELF_OWNERSHIP_KEY]: 0.7, [EXTERNAL_MARKET_KEY]: 0.3 };
      expect(calculateOwnershipRisk(ownership, 0.5)).toBe(0);
    });

    it('scales linearly toward 1 as the largest real-player stake approaches the threshold', () => {
      const ownership = { [SELF_OWNERSHIP_KEY]: 0.75, rival: 0.25 };
      expect(calculateOwnershipRisk(ownership, 0.5)).toBeCloseTo(0.5, 5); // 0.25 / 0.5
    });

    it('caps at 1 once a holder is at or beyond the threshold', () => {
      const ownership = { [SELF_OWNERSHIP_KEY]: 0.1, rival: 0.9 };
      expect(calculateOwnershipRisk(ownership, 0.5)).toBe(1);
    });

    it('uses the single largest real-player stake, not a sum across multiple holders', () => {
      const ownership = { [SELF_OWNERSHIP_KEY]: 0.5, rivalA: 0.3, rivalB: 0.2 };
      // rivalA alone (0.3) is the risk signal, not rivalA+rivalB (0.5) — a takeover only
      // ever needs ONE player to cross the threshold, dilution spread across several
      // minority holders is genuinely lower risk than one concentrated buyer.
      expect(calculateOwnershipRisk(ownership, 0.5)).toBeCloseTo(0.6, 5); // 0.3 / 0.5
    });

    it('is 0 when takeoverThresholdPercent is misconfigured to 0 (guards the division)', () => {
      const ownership = { [SELF_OWNERSHIP_KEY]: 0.4, rival: 0.6 };
      expect(calculateOwnershipRisk(ownership, 0)).toBe(0);
    });
  });

  describe('applyDecisionImpacts', () => {
    it('should apply absolute impacts additively', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { 1: 0.1, 2: 0.1, default: 0.1 },
        },
      };

      const result = applyDecisionImpacts(vars, impacts, 1);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.6, 4);
    });

    it('should apply relative impacts multiplicatively for single instance', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'relative' as const,
          schedule: { 1: 0.2, default: 0.2 },
        },
      };

      // elapsedYears=3 to hit default schedule
      const result = applyDecisionImpacts(vars, impacts, 3);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.5 * 1.2, 4);
    });

    it('should accumulate multiple relative impacts additively', () => {
      // Simulates two matured New Factory instances each with installedCapacity +0.4
      const baseVars = makeVars({ installedCapacity: 10000 });
      const impacts1 = {
        installedCapacity: {
          type: 'relative' as const,
          schedule: { default: 0.4 },
        },
      };
      // First instance: 10000 * (1 + 0.4) = 14000
      const r1 = applyDecisionImpacts(baseVars, impacts1, 3);
      expect(r1.updatedVars.installedCapacity).toBeCloseTo(14000, 4);

      // Second instance on top of first: 14000 * (1 + 0.4) would be WRONG (multiplicative)
      // CORRECT: accumulated multiplier = 0.4 + 0.4 = 0.8 → 10000 * (1 + 0.8) = 18000
      // We simulate this by applying both in one call with combined multipliers
      const combinedImpacts = {
        installedCapacity: {
          type: 'relative' as const,
          schedule: { default: 0.8 }, // 0.4 + 0.4
        },
      };
      const rCombined = applyDecisionImpacts(baseVars, combinedImpacts, 3);
      expect(rCombined.updatedVars.installedCapacity).toBeCloseTo(18000, 4);
    });

    describe('absolute impacts on an initially-undefined field (regression — used to produce NaN)', () => {
      // revenue/financeCost/taxCost are optional "Derived (computed each turn)"
      // PlayerVariables fields — never seeded by startingVars(), so genuinely undefined
      // until something writes to them. A bare `v[field] += value` on `undefined` is
      // `NaN` in JS, and it stayed NaN forever afterward since nothing else in a turn
      // overwrites these three fields. Found via a random 4-player game simulation
      // (Channel Stuffing has a direct impacts.revenue field in the real library).
      it('does not produce NaN when an absolute impact targets a field the player has never had a value for', () => {
        const vars = makeVars();
        delete (vars as any).revenue;
        const impacts = { revenue: { type: 'absolute' as const, schedule: { 1: 40000, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0);

        expect(result.updatedVars.revenue).toBe(40000);
      });

      it('still accumulates additively once the field has a real value', () => {
        const vars = makeVars({ revenue: 10000 } as any);
        const impacts = { revenue: { type: 'absolute' as const, schedule: { 1: 40000, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0);

        expect(result.updatedVars.revenue).toBe(50000);
      });
    });

    describe('zero-floor fields (processingLevel/capacityUtilization/installedCapacity/price/demand)', () => {
      // Regression for a real production bug (2026-08-12): `demand` was missing from the
      // zero-floor set, and it is the one field here that ABSOLUTE `target.*` attacks
      // accumulate into every turn without limit. A live game ended with a player on
      // `demand: -124`, which fed through calculateVolume into a NEGATIVE revenue of
      // -$33,948 — a company being paid to take its own product away.
      it('clamps demand to 0 rather than letting stacked negative impacts drive it below zero', () => {
        const vars = makeVars({ demand: 5 });
        const impacts = {
          demand: {
            type: 'absolute' as const,
            schedule: { 1: -130, default: -130 },
          },
        };

        const result = applyDecisionImpacts(vars, impacts, 0);

        expect(result.updatedVars.demand).toBe(0);
      });

      it('clamps a field to 0 when accumulated relative impacts would drive it negative', () => {
        const vars = makeVars({ processingLevel: 0.5 });
        const impacts = {
          processingLevel: {
            type: 'relative' as const,
            // Combined multiplier of -1.5: 0.5 * (1 - 1.5) = -0.25, would go negative
            schedule: { default: -1.5 },
          },
        };

        const result = applyDecisionImpacts(vars, impacts, 3);

        expect(result.updatedVars.processingLevel).toBe(0);
      });

      it('clamps an absolute impact the same way', () => {
        const vars = makeVars({ capacityUtilization: 0.2 });
        const impacts = {
          capacityUtilization: {
            type: 'absolute' as const,
            schedule: { 1: -0.5, default: -0.5 },
          },
        };

        const result = applyDecisionImpacts(vars, impacts, 0);

        expect(result.updatedVars.capacityUtilization).toBe(0);
      });

      it('does not clamp a field outside the zero-floor set (e.g. outrage can go negative)', () => {
        const vars = makeVars({ outrage: 10 });
        const impacts = {
          outrage: {
            type: 'absolute' as const,
            schedule: { 1: -30, default: -30 },
          },
        };

        const result = applyDecisionImpacts(vars, impacts, 0);

        expect(result.updatedVars.outrage).toBe(-20);
      });

      it('leaves an already-positive value untouched', () => {
        const vars = makeVars({ price: 100 });
        const impacts = {
          price: {
            type: 'relative' as const,
            schedule: { default: -0.1 },
          },
        };

        const result = applyDecisionImpacts(vars, impacts, 3);

        expect(result.updatedVars.price).toBeCloseTo(90, 4);
      });
    });

    it('should use default schedule when matured', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { 1: 0.05, 2: 0.05, default: 0.1 },
        },
      };

      const result = applyDecisionImpacts(vars, impacts, 5);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.6, 4);
    });

    it('should skip competitor-targeted fields', () => {
      const vars = makeVars({ competitorPrice: 400 });
      const impacts = {
        competitorPrice: {
          type: 'absolute' as const,
          schedule: { 1: -50, default: -50 },
        },
      };

      const result = applyDecisionImpacts(vars, impacts, 1);

      expect(result.updatedVars.competitorPrice).toBe(400);
    });

    it('should skip zero multipliers', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { 1: 0, default: 0.1 },
        },
      };

      // elapsedYears=0 → key "1" (this decision's deployment-year value, which is 0)
      const result = applyDecisionImpacts(vars, impacts, 0);

      expect(result.updatedVars.processingLevel).toBe(0.5);
    });

    it('should handle multiple impacts', () => {
      const vars = makeVars({ processingLevel: 0.5, supplySecurity: 0.4 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { 1: 0.1, default: 0.1 },
        },
        supplySecurity: {
          type: 'absolute' as const,
          schedule: { 1: 0.05, default: 0.05 },
        },
      };

      // elapsedYears=3 to hit default schedule
      const result = applyDecisionImpacts(vars, impacts, 3);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.6, 4);
      expect(result.updatedVars.supplySecurity).toBeCloseTo(0.45, 4);
    });

    it('should create depreciation entries for depreciating asset purchases on year 0', () => {
      const vars = makeVars({ assets: 50000 });
      const impacts = {
        assets: {
          type: 'absolute' as const,
          schedule: { 1: 100000, 2: 150000, default: 0 },
        },
      };

      // Year 0 (deployment): should create entry for +100000
      const result = applyDecisionImpacts(vars, impacts, 0, 2024);

      expect(result.updatedVars.assets).toBeCloseTo(150000, 4); // 50000 + 100000
      expect(result.newDepreciationEntries).toHaveLength(1);
      expect(result.newDepreciationEntries![0].originalValue).toBe(100000);
      expect(result.newDepreciationEntries![0].purchaseYear).toBe(2024);
      expect(result.newDepreciationEntries![0].usefulLife).toBe(10);
      expect(result.newDepreciationEntries![0].annualAmount).toBe(10000);
    });

    it('should NOT create depreciation entries on non-deploy years', () => {
      const vars = makeVars({ assets: 50000 });
      const impacts = {
        assets: {
          type: 'absolute' as const,
          schedule: { 1: 100000, default: 0 },
        },
      };

      // Year 0 (deployment): would create entry, but we're testing year 1 (advancing)
      // At elapsedYears=1, it reads schedule key 2, but we don't have key 2, so it uses default (0)
      // Result: 50000 + 0 = 50000
      const result = applyDecisionImpacts(vars, impacts, 1, 2024);

      expect(result.updatedVars.assets).toBeCloseTo(50000, 4); // 50000 + 0
      expect(result.newDepreciationEntries || []).toHaveLength(0);
    });

    // Regression: this used to depend on a hardcoded decision-name allowlist
    // (DEPRECIATING_ASSETS) — this function has no idea which decision produced this
    // impact at all (decisionName was removed from its signature), so any positive
    // assets/intangibleAssets addition on the deployment year depreciates. See CLAUDE.md.
    it('should create a depreciation entry for a positive assets addition regardless of which decision produced it', () => {
      const vars = makeVars({ assets: 50000 });
      const impacts = {
        assets: {
          type: 'absolute' as const,
          schedule: { 1: 10000, default: 0 },
        },
      };

      const result = applyDecisionImpacts(vars, impacts, 0, 2024);

      expect(result.updatedVars.assets).toBeCloseTo(60000, 4);
      expect(result.newDepreciationEntries).toHaveLength(1);
      expect(result.newDepreciationEntries![0].originalValue).toBe(10000);
    });

    it('should not create a depreciation entry for a negative assets change (a sale/depletion, not a purchase)', () => {
      const vars = makeVars({ assets: 50000 });
      const impacts = {
        assets: {
          type: 'absolute' as const,
          schedule: { 1: -10000, default: 0 },
        },
      };

      const result = applyDecisionImpacts(vars, impacts, 0, 2024);

      expect(result.updatedVars.assets).toBeCloseTo(40000, 4);
      expect(result.newDepreciationEntries).toHaveLength(0);
    });

    it('should return updatedVars and newDepreciationEntries in result object', () => {
      const vars = makeVars({ processingLevel: 0.5 });
      const impacts = {
        processingLevel: {
          type: 'absolute' as const,
          schedule: { default: 0.1 },
        },
      };

      const result = applyDecisionImpacts(vars, impacts, 3);

      expect(result).toHaveProperty('updatedVars');
      expect(result).toHaveProperty('newDepreciationEntries');
      expect(Array.isArray(result.newDepreciationEntries)).toBe(true);
    });

    describe('sharesAmount (Share Issuance)', () => {
      it('should increase totalSharesOutstanding and credit the new shares to EXTERNAL_MARKET on the deployment year', () => {
        const vars = makeVars({ totalSharesOutstanding: 10000, shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 } });
        const impacts = { sharesAmount: { type: 'absolute' as const, schedule: { 1: 5000, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0);

        expect(result.updatedVars.totalSharesOutstanding).toBe(15000);
        // Founder diluted from 100% to 10000/15000 = 2/3; the new 5000 shares (1/3) go to EXTERNAL_MARKET.
        expect(result.updatedVars.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(2 / 3, 4);
        expect(result.updatedVars.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(1 / 3, 4);
      });

      it('should dilute an existing cross-holding proportionally too, not just the founder', () => {
        const vars = makeVars({
          totalSharesOutstanding: 10000,
          shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.6, rival: 0.4 },
        });
        const impacts = { sharesAmount: { type: 'absolute' as const, schedule: { 1: 10000, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0);

        expect(result.updatedVars.totalSharesOutstanding).toBe(20000);
        expect(result.updatedVars.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.3, 4);
        expect(result.updatedVars.shareOwnership.rival).toBeCloseTo(0.2, 4);
        expect(result.updatedVars.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(0.5, 4);
      });

      it('should not issue shares on a non-deployment year even if the schedule has a value there', () => {
        const vars = makeVars({ totalSharesOutstanding: 10000, shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 } });
        const impacts = { sharesAmount: { type: 'absolute' as const, schedule: { 1: 5000, 2: 5000, default: 0 } } };

        // elapsedYears=1 (advancing, not deploying) — sharesAmount must NOT re-trigger.
        const result = applyDecisionImpacts(vars, impacts, 1);

        expect(result.updatedVars.totalSharesOutstanding).toBe(10000);
      });

      it('should not write a literal "sharesAmount" field onto vars — it is not a real PlayerVariables field', () => {
        const vars = makeVars({ totalSharesOutstanding: 10000, shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 } });
        const impacts = { sharesAmount: { type: 'absolute' as const, schedule: { 1: 5000, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0);

        expect((result.updatedVars as any).sharesAmount).toBeUndefined();
      });

      it('should not mutate the original vars.shareOwnership object (never alias a shared reference)', () => {
        const sharedOwnership = { [SELF_OWNERSHIP_KEY]: 1.0 };
        const vars = makeVars({ totalSharesOutstanding: 10000, shareOwnership: sharedOwnership });
        const impacts = { sharesAmount: { type: 'absolute' as const, schedule: { 1: 5000, default: 0 } } };

        applyDecisionImpacts(vars, impacts, 0);

        expect(sharedOwnership).toEqual({ [SELF_OWNERSHIP_KEY]: 1.0 });
      });
    });

    // Company-size-scaled cost surcharge (costWealthScaleRate) — a real-world dynamic this
    // engine previously had no mechanism for: 119 of 212 decisions use a flat, absolute
    // `cash` cost regardless of the deploying player's own size, unlike wealthScaledFee's
    // litigation fees or a relative-type legal-risk ground's stakes, both of which already
    // scale off the payer/defendant's own current cash/equity. See applyDecisionImpacts'
    // own doc comment.
    describe('costWealthScaleRate (company-size-scaled cost surcharge)', () => {
      it('adds a surcharge on top of a negative absolute cash cost, proportional to the player\'s OWN current cash', () => {
        const vars = makeVars({ cash: 500000 });
        const impacts = { cash: { type: 'absolute' as const, schedule: { 1: -50000, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0, undefined, 0.01);

        // -50,000 base cost, plus 1% of $500,000 current cash = -5,000 surcharge.
        expect(result.updatedVars.cash).toBe(500000 - 50000 - 5000);
        expect(result.absDeltas.cashDelta).toBe(-55000);
      });

      it('charges a poorer player a smaller surcharge for the exact same decision', () => {
        const richVars = makeVars({ cash: 1000000 });
        const poorVars = makeVars({ cash: 20000 });
        const impacts = { cash: { type: 'absolute' as const, schedule: { 1: -10000, default: 0 } } };

        const richResult = applyDecisionImpacts(richVars, impacts, 0, undefined, 0.01);
        const poorResult = applyDecisionImpacts(poorVars, impacts, 0, undefined, 0.01);

        const richTotalCost = richVars.cash - richResult.updatedVars.cash;
        const poorTotalCost = poorVars.cash - poorResult.updatedVars.cash;
        expect(richTotalCost).toBeGreaterThan(poorTotalCost);
        expect(richTotalCost).toBe(10000 + 10000); // 10,000 base + 1% of 1,000,000
        expect(poorTotalCost).toBe(10000 + 200); // 10,000 base + 1% of 20,000
      });

      it('never scales down a POSITIVE cash value (a windfall) — costs-only, by explicit design', () => {
        const vars = makeVars({ cash: 1000000 });
        const impacts = { cash: { type: 'absolute' as const, schedule: { 1: 30000, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0, undefined, 0.01);

        expect(result.updatedVars.cash).toBe(1000000 + 30000);
      });

      it('does not touch a RELATIVE-type cash impact — it already scales itself off the player\'s own cash', () => {
        const vars = makeVars({ cash: 500000 });
        const impacts = { cash: { type: 'relative' as const, schedule: { 1: -0.1, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0, undefined, 0.01);

        expect(result.updatedVars.cash).toBeCloseTo(500000 * 0.9, 6);
      });

      it('leaves behavior completely unchanged when the rate is the default (0) — safe, backward-compatible default', () => {
        const vars = makeVars({ cash: 500000 });
        const impacts = { cash: { type: 'absolute' as const, schedule: { 1: -50000, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0);

        expect(result.updatedVars.cash).toBe(450000);
      });

      it('does not surcharge other absolute-type fields (e.g. operatingExpenses) — scoped to the literal cash field only', () => {
        const vars = makeVars({ cash: 1000000, operatingExpenses: 5000 });
        const impacts = { operatingExpenses: { type: 'absolute' as const, schedule: { 1: 10000, default: 0 } } };

        const result = applyDecisionImpacts(vars, impacts, 0, undefined, 0.01);

        expect(result.updatedVars.operatingExpenses).toBe(15000);
      });
    });
  });

  describe('applyTargetImpacts', () => {
    it('clamps a routed target.* field to 0 the same way applyDecisionImpacts does for its own fields', () => {
      const targetVars = makeVars({ processingLevel: 0.3 });
      const targetImpacts = new Map([
        ['processingLevel', { type: 'relative' as const, schedule: { default: -2 } }],
      ]);

      // A schedule with only 'default' has maturity 0, so this only ever applies at
      // elapsedYears 0 — see the compounding-prevention tests below for why elapsedYears
      // 3 no longer applies anything at all post-fix.
      const result = applyTargetImpacts(targetVars, targetImpacts, 0);

      expect(result.processingLevel).toBe(0);
    });

    it('leaves a field outside the zero-floor set free to go negative (e.g. target.outrage)', () => {
      const targetVars = makeVars({ outrage: 5 });
      const targetImpacts = new Map([
        ['outrage', { type: 'absolute' as const, schedule: { 1: -20, default: -20 } }],
      ]);

      const result = applyTargetImpacts(targetVars, targetImpacts, 0);

      expect(result.outrage).toBe(-15);
    });

    it('does not produce NaN for an absolute target.* impact on an initially-undefined field (regression)', () => {
      const targetVars = makeVars();
      delete (targetVars as any).financeCost;
      const targetImpacts = new Map([
        ['financeCost', { type: 'absolute' as const, schedule: { 1: 9000, default: 9000 } }],
      ]);

      const result = applyTargetImpacts(targetVars, targetImpacts, 0);

      expect(result.financeCost).toBe(9000);
    });

    // Regression for a real, reported bug found via live play: `collectTargetImpacts`
    // calls this function every turn for as long as an attacking instance is active
    // (deliberate — target effects are meant to keep re-applying, see CLAUDE.md). For an
    // ABSOLUTE field that's fine (bounded, linear). For a RELATIVE field, reapplying the
    // same percentage against the field's own already-shrunk value every turn is
    // exponential decay — a single Union Agitation-shaped attack
    // (`target.capacityUtilization`, relative, `{1: -0.3, default: -0.15}`) crushed an
    // idle victim from 1.0 to 0.26 in six turns and bankrupted them by round 12 in a real
    // test game. Fixed by making a RELATIVE field stop re-applying once elapsedYears
    // passes its own schedule's maturity (mirrors `advanceAndApply`'s own-effect
    // semantics: apply through explicit years + once when 'default' is first reached,
    // then hold forever).
    describe('relative field compounding prevention (regression)', () => {
      it('applies a relative field with only a default value exactly once, at elapsedYears 0, then holds', () => {
        const targetImpacts = new Map([
          ['capacityUtilization', { type: 'relative' as const, schedule: { default: -0.2 } }],
        ]);

        let vars = makeVars({ capacityUtilization: 1.0 });
        vars = applyTargetImpacts(vars, targetImpacts, 0); // deployment turn
        expect(vars.capacityUtilization).toBeCloseTo(0.8, 6);

        vars = applyTargetImpacts(vars, targetImpacts, 1); // next turn — must NOT compound further
        expect(vars.capacityUtilization).toBeCloseTo(0.8, 6);

        vars = applyTargetImpacts(vars, targetImpacts, 5); // many turns later — still held
        expect(vars.capacityUtilization).toBeCloseTo(0.8, 6);
      });

      it('applies a two-stage relative schedule (Union Agitation shape) through its own explicit year, then holds — never compounds beyond that', () => {
        const targetImpacts = new Map([
          ['capacityUtilization', { type: 'relative' as const, schedule: { 1: -0.3, default: -0.15 } }],
        ]);

        let vars = makeVars({ capacityUtilization: 1.0 });
        vars = applyTargetImpacts(vars, targetImpacts, 0); // year 1 value: -30%
        expect(vars.capacityUtilization).toBeCloseTo(0.7, 6);

        vars = applyTargetImpacts(vars, targetImpacts, 1); // maturity turn — 'default' (-15%) applies once
        expect(vars.capacityUtilization).toBeCloseTo(0.595, 6);

        const afterMaturity = vars.capacityUtilization;
        vars = applyTargetImpacts(vars, targetImpacts, 2); // must hold — this used to keep multiplying by 0.85 forever
        expect(vars.capacityUtilization).toBeCloseTo(afterMaturity, 6);

        vars = applyTargetImpacts(vars, targetImpacts, 8);
        expect(vars.capacityUtilization).toBeCloseTo(afterMaturity, 6);
      });

      it('keeps re-applying an ABSOLUTE target field every turn, unaffected by the relative-only fix', () => {
        const targetImpacts = new Map([
          ['outrage', { type: 'absolute' as const, schedule: { default: 25 } }],
        ]);

        let vars = makeVars({ outrage: 0 });
        for (let elapsedYears = 0; elapsedYears < 5; elapsedYears++) {
          vars = applyTargetImpacts(vars, targetImpacts, elapsedYears);
        }
        // Five applications of +25, same as before this fix — absolute fields are untouched.
        expect(vars.outrage).toBe(125);
      });

      it('gates a relative field and keeps applying an absolute field on the SAME decision independently (Bot Attack shape)', () => {
        const targetImpacts = new Map([
          ['outrage', { type: 'absolute' as const, schedule: { default: 20 } }],
          ['capacityUtilization', { type: 'relative' as const, schedule: { default: -0.2 } }],
        ]);

        let vars = makeVars({ outrage: 0, capacityUtilization: 1.0 });
        for (let elapsedYears = 0; elapsedYears < 4; elapsedYears++) {
          vars = applyTargetImpacts(vars, targetImpacts, elapsedYears);
        }

        // outrage keeps accumulating every turn (absolute, unaffected)...
        expect(vars.outrage).toBe(80);
        // ...while capacityUtilization only ever took the one deployment-turn hit.
        expect(vars.capacityUtilization).toBeCloseTo(0.8, 6);
      });
    });
  });

  describe('renormalizeShareOwnership', () => {
    it('should leave an already-normalized map unchanged', () => {
      const result = renormalizeShareOwnership({ [SELF_OWNERSHIP_KEY]: 0.6, [EXTERNAL_MARKET_KEY]: 0.4 });
      expect(result[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.6, 6);
      expect(result[EXTERNAL_MARKET_KEY]).toBeCloseTo(0.4, 6);
    });

    it('should rescale a map that drifted away from summing to 1.0', () => {
      const result = renormalizeShareOwnership({ [SELF_OWNERSHIP_KEY]: 0.3, [EXTERNAL_MARKET_KEY]: 0.3 });
      expect(result[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.5, 6);
      expect(result[EXTERNAL_MARKET_KEY]).toBeCloseTo(0.5, 6);
      expect(Object.values(result).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    });

    it('should return a new object, never mutate the input', () => {
      const input = { [SELF_OWNERSHIP_KEY]: 0.5, [EXTERNAL_MARKET_KEY]: 0.5 };
      const result = renormalizeShareOwnership(input);
      expect(result).not.toBe(input);
    });

    it('should return a shallow copy for an all-zero map rather than dividing by zero', () => {
      const result = renormalizeShareOwnership({ [SELF_OWNERSHIP_KEY]: 0 });
      expect(result[SELF_OWNERSHIP_KEY]).toBe(0);
    });
  });

  describe('calculateLegalExposureRatio', () => {
    it('should calculate ratio as legalExposure / cash', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(50000, 100000, admin, DEFAULT_FORMULAS);
      // 50000 / 100000 = 0.5
      expect(ratio).toBeCloseTo(0.5, 4);
    });

    it('should cap at legalExposureRatioCap', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(100000, 100000, admin, DEFAULT_FORMULAS);
      // 100000 / 100000 = 1.0, but cap is 0.8
      expect(ratio).toBeCloseTo(0.8, 4);
    });

    it('should return 0 when cash is zero', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(50000, 0, admin, DEFAULT_FORMULAS);
      expect(ratio).toBe(0);
    });

    it('should return 0 when legal exposure is zero', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(0, 100000, admin, DEFAULT_FORMULAS);
      expect(ratio).toBe(0);
    });

    it('should respect custom cap value', () => {
      const admin = makeAdmin({
        legalProcess: {
          scrutinyLegalRiskMultiplier: 0.02,
          legalExposureRatioCap: 0.5, // Custom cap
        },
      });
      const ratio = calculateLegalExposureRatio(60000, 100000, admin, DEFAULT_FORMULAS);
      // 60000 / 100000 = 0.6, but cap is 0.5
      expect(ratio).toBeCloseTo(0.5, 4);
    });

    it('should not cap when ratio is below cap', () => {
      const admin = makeAdmin();
      const ratio = calculateLegalExposureRatio(30000, 100000, admin, DEFAULT_FORMULAS);
      // 30000 / 100000 = 0.3 < 0.8 (cap)
      expect(ratio).toBeCloseTo(0.3, 4);
    });
  });

  describe('calculateAdjustedProbability', () => {
    it('should increase probability with scrutiny alone', () => {
      const admin = makeAdmin();
      const result = calculateAdjustedProbability(0.5, 10, 0, admin, DEFAULT_FORMULAS);
      // 0.5 * (1 + 0.02 * 10 / 100 + 0) = 0.5 * (1 + 0.002) = 0.5 * 1.002 = 0.501
      // Actually wait, let me re-read the formula: (scrutinyLegalRiskMultiplier * scrutiny) / 100
      // So: 0.5 * (1 + 0.02 * 10) = 0.5 * 1.2 = 0.6 (when scrutiny is not divided by 100)
      // Let me check the actual implementation...
      // The implementation is: 1 + (scrutinyLegalRiskMultiplier * defendantScrutiny) / 100 + defendantLegalExposureRatio
      // So with scrutiny=10: 1 + (0.02 * 10) / 100 + 0 = 1 + 0.002 + 0 = 1.002
      // Then: 0.5 * 1.002 = 0.501
      expect(result).toBeCloseTo(0.501, 4);
    });

    it('should increase probability with legal exposure ratio alone', () => {
      const admin = makeAdmin();
      const result = calculateAdjustedProbability(0.5, 0, 0.5, admin, DEFAULT_FORMULAS);
      // 0.5 * (1 + 0 + 0.5) = 0.5 * 1.5 = 0.75
      expect(result).toBeCloseTo(0.75, 4);
    });

    it('should increase probability with both scrutiny and legal exposure ratio', () => {
      const admin = makeAdmin();
      const result = calculateAdjustedProbability(0.5, 10, 0.4, admin, DEFAULT_FORMULAS);
      // 0.5 * (1 + 0.02 * 10 / 100 + 0.4) = 0.5 * (1 + 0.002 + 0.4) = 0.5 * 1.402 = 0.701
      expect(result).toBeCloseTo(0.701, 4);
    });

    it('should return base probability when both scrutiny and legal exposure are zero', () => {
      const admin = makeAdmin();
      const result = calculateAdjustedProbability(0.3, 0, 0, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(0.3, 4);
    });

    it('should scale linearly with increasing legal exposure ratio', () => {
      const admin = makeAdmin();
      const r1 = calculateAdjustedProbability(0.5, 0, 0.1, admin, DEFAULT_FORMULAS);
      const r2 = calculateAdjustedProbability(0.5, 0, 0.3, admin, DEFAULT_FORMULAS);
      const r3 = calculateAdjustedProbability(0.5, 0, 0.5, admin, DEFAULT_FORMULAS);
      
      expect(r1).toBeLessThan(r2);
      expect(r2).toBeLessThan(r3);
    });

    it('should cap probability contribution at legal exposure cap', () => {
      const admin = makeAdmin();
      // Even if legal exposure ratio is provided as 1.0, it still contributes linearly
      const result = calculateAdjustedProbability(0.1, 0, 0.8, admin, DEFAULT_FORMULAS);
      // 0.1 * (1 + 0.8) = 0.18
      expect(result).toBeCloseTo(0.18, 4);
    });
  });

  describe('calculateRiskGauge with legal exposure', () => {
    it('should normalize legal exposure ratio by dividing by cap', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 0, outrage: 0 });
      const admin = makeAdmin();
      const openCases = [{ probability: 0.5, stakes: 40000 }];
      
      // legalExposure = 0.5 * 40000 = 20000
      // legalExposureRatio = MIN(0.8, 20000 / 100000) = MIN(0.8, 0.2) = 0.2
      // normalized = 0.2 / 0.8 = 0.25
      // risk = 100 * (0.3 * 0.25 + 0.2 * 0 + 0.25 * 0) = 100 * 0.075 = 7.5
      
      const result = calculateRiskGauge(vars, openCases, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(7.5, 1);
    });

    it('should normalize scrutiny by dividing by 100', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 50, outrage: 0 });
      const admin = makeAdmin();
      const openCases = [];
      
      // legalExposureRatio = 0
      // normalized scrutiny = MIN(1, 50 / 100) = 0.5
      // risk = 100 * (0.3 * 0 + 0.2 * 0.5 + 0.25 * 0) = 100 * 0.1 = 10
      
      const result = calculateRiskGauge(vars, openCases, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(10, 1);
    });

    it('should normalize outrage by dividing by 100', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 0, outrage: 75 });
      const admin = makeAdmin();
      const openCases = [];
      
      // legalExposureRatio = 0
      // normalized outrage = MIN(1, 75 / 100) = 0.75
      // risk = 100 * (0.3 * 0 + 0.2 * 0 + 0.25 * 0.75) = 100 * 0.1875 = 18.75
      
      const result = calculateRiskGauge(vars, openCases, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(18.75, 1);
    });

    it('should combine all three components with correct weights', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 50, outrage: 50 });
      const admin = makeAdmin();
      const openCases = [{ probability: 0.5, stakes: 40000 }];
      
      // legalExposure = 0.5 * 40000 = 20000
      // legalExposureRatio = MIN(0.8, 0.2) = 0.2, normalized = 0.2 / 0.8 = 0.25
      // normalized scrutiny = 0.5
      // normalized outrage = 0.5
      // risk = 100 * (0.3 * 0.25 + 0.2 * 0.5 + 0.25 * 0.5) = 100 * (0.075 + 0.1 + 0.125) = 30
      
      const result = calculateRiskGauge(vars, openCases, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(30, 1);
    });

    it('should cap scrutiny and outrage normalization at 1.0', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 150, outrage: 200 });
      const admin = makeAdmin();
      const openCases = [];
      
      // normalized scrutiny = MIN(1, 1.5) = 1.0
      // normalized outrage = MIN(1, 2.0) = 1.0
      // risk = 100 * (0 + 0.2 * 1.0 + 0.25 * 1.0) = 100 * 0.45 = 45
      
      const result = calculateRiskGauge(vars, openCases, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(45, 1);
    });

    it('should handle negative outrage (use absolute value)', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 0, outrage: -60 });
      const admin = makeAdmin();
      const openCases = [];
      
      // normalized outrage = MIN(1, ABS(-60) / 100) = 0.6
      // risk = 100 * (0 + 0 + 0.25 * 0.6) = 15
      
      const result = calculateRiskGauge(vars, openCases, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(15, 1);
    });

    it('should handle multiple open cases accumulating legal exposure', () => {
      const vars = makeVars({ cash: 100000, scrutiny: 0, outrage: 0 });
      const admin = makeAdmin();
      const openCases = [
        { probability: 0.3, stakes: 20000 },
        { probability: 0.4, stakes: 30000 },
      ];
      
      // legalExposure = 0.3 * 20000 + 0.4 * 30000 = 6000 + 12000 = 18000
      // legalExposureRatio = MIN(0.8, 0.18) = 0.18
      // normalized = 0.18 / 0.8 = 0.225
      // risk = 100 * 0.3 * 0.225 = 6.75
      
      const result = calculateRiskGauge(vars, openCases, admin, DEFAULT_FORMULAS);
      expect(result).toBeCloseTo(6.75, 1);
    });
  });

  describe('updateBalanceSheet with legal exposure', () => {
    it('should include legal exposure in equity calculation', () => {
      const vars = makeVars({
        cash: 100000,
        reserves: 30000,
        assets: 50000,
        intangibleAssets: 10000,
        debt: 20000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const netProfit = 10000;
      const depreciation = 5000;
      const revenue = 200000;

      const legalExposure = 10000;
      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin, DEFAULT_FORMULAS);

      expect(result).toHaveProperty('cash');
      expect(result).toHaveProperty('reserves');
      expect(result).toHaveProperty('receivables');
      expect(result).toHaveProperty('equity');
      expect(result).toHaveProperty('stockValue');
      expect(result.cash).toBeGreaterThan(100000); // cash + profit + depreciation
      expect(result.legalExposure).toBe(10000);
    });

    it('should calculate receivables based on DSO', () => {
      const vars = makeVars({
        cash: 50000,
        reserves: 10000,
        assets: 30000,
        intangibleAssets: 5000,
        debt: 10000,
        totalSharesOutstanding: 500,
      });
      const admin = makeAdmin();
      const netProfit = 5000;
      const depreciation = 2000;
      const revenue = 100000;
      const legalExposure = 5000;

      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin, DEFAULT_FORMULAS);

      // DSO = 30 days, so receivables = 100000 * (30 / 365)
      expect(result.receivables).toBeCloseTo(100000 * (30 / 365), 2);
    });

    it('should calculate stock value per share correctly', () => {
      const vars = makeVars({
        cash: 100000,
        reserves: 30000,
        assets: 50000,
        intangibleAssets: 10000,
        debt: 20000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const netProfit = 15000;
      const depreciation = 5000;
      const revenue = 250000;
      const legalExposure = 0;

      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin, DEFAULT_FORMULAS);

      // market equity = equity - legalExposure = equity
      // stock value = market equity / shares
      expect(result.stockValue).toBeGreaterThan(0);
      expect(result.legalExposure).toBe(0);
    });

    it('should reduce stock value when legal exposure exceeds equity', () => {
      const vars = makeVars({
        cash: 50000,
        reserves: 10000,
        assets: 30000,
        intangibleAssets: 5000,
        debt: 10000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const netProfit = 5000;
      const depreciation = 2000;
      const revenue = 100000;
      const legalExposure = 200000; // Huge legal exposure

      const result = updateBalanceSheet(vars, netProfit, depreciation, revenue, legalExposure, admin, DEFAULT_FORMULAS);

      // market equity should be capped at 0, so stock value should be 0
      expect(result.stockValue).toBe(0);
    });

    it('should preserve original variables without mutation', () => {
      const vars = makeVars({
        cash: 100000,
        reserves: 30000,
        assets: 50000,
        intangibleAssets: 10000,
        debt: 20000,
        totalSharesOutstanding: 1000,
      });
      const admin = makeAdmin();
      const originalCash = vars.cash;

      updateBalanceSheet(vars, 15000, 5000, 250000, 5000, admin, DEFAULT_FORMULAS);

      expect(vars.cash).toBe(originalCash); // Original should be unchanged
    });
  });

  describe('calculateMaturityYears', () => {
    it('should return max numeric schedule key', () => {
      const impacts = {
        field1: { type: 'absolute' as const, schedule: { 1: 0.1, 2: 0.1, 3: 0.1, default: 0.2 } },
        field2: { type: 'absolute' as const, schedule: { 1: 0.05, 2: 0.05, default: 0.1 } },
      };

      expect(calculateMaturityYears(impacts)).toBe(3);
    });

    it('should return 0 when only default exists', () => {
      const impacts = {
        field1: { type: 'absolute' as const, schedule: { default: 0.1 } },
      };

      expect(calculateMaturityYears(impacts)).toBe(0);
    });

    it('should ignore non-numeric keys', () => {
      const impacts = {
        field1: { type: 'absolute' as const, schedule: { 1: 0.1, 3: 0.1, default: 0.2 } },
      };

      expect(calculateMaturityYears(impacts)).toBe(3);
    });
  });
});
