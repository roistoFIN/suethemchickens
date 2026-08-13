import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameEngine } from './gameEngine';
import { RoomStatus, ServerEvents, PHASE_TIMERS, PHASE_ORDER, type DecisionDefinition, type GameConfig } from '@suethemchickens/shared';
import type { Server } from 'socket.io';
import type { PrismaClient, Room as PrismaRoom, Player as PrismaPlayer, Company as PrismaCompany } from '@prisma/client';
import gameEngineData from '../data/game_engine.json' with { type: 'json' };
import gameConfigData from '../data/game_config.json' with { type: 'json' };
import { DEFAULT_FORMULA_SEEDS } from '../engine/defaultFormulas.js';

// Real network I/O (llama.cpp) is out of scope for this layer per CLAUDE.md's test-layer
// guidance — mocked deterministically here; llmService's own fallback/caching/sanitizing
// behavior is covered separately in llmService.test.ts.
vi.mock('../services/llmService.js', () => ({
  generateAnnualReportBlurb: vi.fn(async ({ decisionName }: { decisionName: string }) => `blurb: ${decisionName}`),
}));
import { generateAnnualReportBlurb } from '../services/llmService.js';

const createMockIo = () => ({
  on: vi.fn(),
  to: vi.fn().mockReturnThis(),
  emit: vi.fn().mockReturnThis(),
  // `leaveStaleSocketRoom` looks a socket up here to call `.leave(oldRoomId)` on it —
  // empty by default (every existing test's `player.socketId` values have no
  // corresponding entry, so `.get(...)` returns undefined and the optional-chained
  // `?.leave(...)` is a harmless no-op); tests that care about the leave behavior
  // itself register a fake socket into this map directly.
  sockets: { sockets: new Map<string, { leave: ReturnType<typeof vi.fn> }>() },
}) as unknown as Server;

let playerCounter = 0;

const createMockPrisma = () => {
  const createdPlayers: Record<string, unknown>[] = [];
  const createdCompanies: PrismaCompany[] = [];

  const mockRoom = {
    create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const playerId = `db-player-${++playerCounter}`;
      const companyId = `company-${playerId}`;
      const dbPlayer = {
        id: playerId,
        name: (data.players.create as Record<string, unknown>).name as string,
        roomId: data.id as string,
        isHost: (data.players.create as Record<string, unknown>).isHost as boolean,
        bankrupt: false,
        socketId: (data.players.create as Record<string, unknown>).socketId as string,
        isBot: false,
        companyId,
        company: {
          id: companyId,
          playerId,
          cash: 100000,
          debt: 0,
          createdAt: new Date(),
          assets: [],
        },
      };
      createdPlayers.push(dbPlayer);

      const room: PrismaRoom = {
        id: data.id as string,
        status: data.status as RoomStatus,
        maxPlayers: (data.maxPlayers as number) ?? 4,
        currentPhaseRound: (data.currentPhaseRound as number) ?? 1,
        createdAt: (data.createdAt as Date) || new Date(),
        inviteOnly: (data.inviteOnly as boolean) ?? false,
      };

      return Promise.resolve({
        ...room,
        players: [dbPlayer],
      });
    }),
    findFirst: vi.fn().mockImplementation((_args: { where: Record<string, unknown> }) => {
      return Promise.resolve(null);
    }),
    findUnique: vi.fn().mockImplementation((_args: { where: Record<string, unknown> }) => {
      return Promise.resolve(null);
    }),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };

  const mockPlayer = {
    create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const playerId = `db-player-${++playerCounter}`;
      const companyId = `company-${playerId}`;
      const player: PrismaPlayer & { company: PrismaCompany } = {
        id: playerId,
        name: data.name as string,
        roomId: data.roomId as string,
        isHost: data.isHost as boolean,
        bankrupt: (data.bankrupt as boolean) || false,
        socketId: data.socketId as string,
        isBot: (data.isBot as boolean) ?? false,
        companyId,
        company: {
          id: companyId,
          playerId,
          cash: ((data.company as Record<string, unknown>)?.create as Record<string, unknown>)?.cash as number ?? 100000,
          debt: 0,
          createdAt: new Date(),
          assets: [],
        },
      };
      createdPlayers.push(player);
      createdCompanies.push(player.company);
      return Promise.resolve(player);
    }),
    findMany: vi.fn().mockImplementation(({ where }: { where?: Record<string, unknown> } = {}) => {
      return Promise.resolve(
        createdPlayers.filter((p: any) => {
          if (where?.roomId && p.roomId !== where.roomId) return false;
          if (where?.bankrupt !== undefined && p.bankrupt !== where.bankrupt) return false;
          return true;
        }),
      );
    }),
    findUnique: vi.fn(),
    delete: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };

  const mockCompany = {
    findUnique: vi.fn().mockImplementation(({ where }: { where: { playerId: string } }) => {
      return Promise.resolve(createdCompanies.find((c) => c.playerId === where.playerId) || null);
    }),
    // Backs GameEngine.isDecisionInUse — mirrors the real `where: { player: { bankrupt: false } }`
    // relational filter by cross-referencing each company's owning player's bankrupt flag.
    findMany: vi.fn().mockImplementation(({ where }: any = {}) => {
      const wantNonBankrupt = where?.player?.bankrupt === false;
      return Promise.resolve(
        createdCompanies
          .filter((c: any) => {
            if (!wantNonBankrupt) return true;
            const owner = createdPlayers.find((p: any) => p.id === c.playerId);
            return owner ? owner.bankrupt === false : true;
          })
          .map((c: any) => ({ engineState: c.engineState ?? {} })),
      );
    }),
    delete: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  };

  // Seeded from the real decision library/config, exactly like production data —
  // so every existing assertion depending on real decision content (e.g. the
  // getAnnualReport "Bot Attack" tests) keeps passing unchanged now that it's
  // sourced through the mocked DB instead of a direct JSON import.
  const decisionRows = new Map<string, { name: string; data: DecisionDefinition }>(
    (gameEngineData as unknown as DecisionDefinition[]).map((d) => [d.decision, { name: d.decision, data: d }]),
  );
  const seedConfig = gameConfigData as unknown as GameConfig;
  let gameConfigRow: { id: number; gameSettings: unknown; playerStartingValues: unknown; adminVariables: unknown } = {
    id: 1,
    gameSettings: seedConfig.gameSettings,
    playerStartingValues: seedConfig.playerStartingValues,
    adminVariables: seedConfig.adminVariables,
  };

  const mockDecision = {
    findMany: vi.fn().mockImplementation(() => Promise.resolve(Array.from(decisionRows.values()))),
    upsert: vi.fn().mockImplementation(({ where, create, update }: any) => {
      const row = decisionRows.has(where.name)
        ? { name: where.name, data: update.data }
        : { name: create.name, data: create.data };
      decisionRows.set(where.name, row);
      return Promise.resolve(row);
    }),
    delete: vi.fn().mockImplementation(({ where }: any) => {
      decisionRows.delete(where.name);
      return Promise.resolve({});
    }),
  };

  const mockGameConfigRow = {
    findUnique: vi.fn().mockImplementation(() => Promise.resolve(gameConfigRow)),
    update: vi.fn().mockImplementation(({ data }: any) => {
      gameConfigRow = { ...gameConfigRow, ...data };
      return Promise.resolve(gameConfigRow);
    }),
  };

  // Seeded from the real 23 formulas (same source prisma/seed.ts uses), so every
  // existing assertion depending on real formula content keeps passing unchanged.
  const formulaRows = new Map<string, { key: string; expression: string; description: string }>(
    DEFAULT_FORMULA_SEEDS.map((f) => [f.key, { ...f }]),
  );
  const mockFormula = {
    findMany: vi.fn().mockImplementation(() => Promise.resolve(Array.from(formulaRows.values()))),
    update: vi.fn().mockImplementation(({ where, data }: any) => {
      const existing = formulaRows.get(where.key);
      if (!existing) throw new Error(`Formula "${where.key}" not found`);
      const updated = { ...existing, ...data };
      formulaRows.set(where.key, updated);
      return Promise.resolve(updated);
    }),
  };

  // In-memory-backed, stateful mock (same shape as mockDecision/mockFormula above) so
  // tests can both seed rows and assert on the resulting state — used by
  // GameEngine.persistLegalCaseHistory/recordLegalCaseHistory's tests.
  const legalCaseHistoryRows = new Map<string, Record<string, unknown>>();
  const mockLegalCaseHistory = {
    _rows: legalCaseHistoryRows,
    upsert: vi.fn().mockImplementation(({ where, create }: any) => {
      if (!legalCaseHistoryRows.has(where.id)) {
        legalCaseHistoryRows.set(where.id, { ...create });
      }
      return Promise.resolve(legalCaseHistoryRows.get(where.id));
    }),
    updateMany: vi.fn().mockImplementation(({ where, data }: any) => {
      const row = legalCaseHistoryRows.get(where.id);
      if (!row || (where.resolvedRound === null && row.resolvedRound !== null)) {
        return Promise.resolve({ count: 0 });
      }
      Object.assign(row, data);
      return Promise.resolve({ count: 1 });
    }),
    findMany: vi.fn().mockImplementation(({ where }: any = {}) => {
      return Promise.resolve(
        Array.from(legalCaseHistoryRows.values()).filter((r: any) => (where?.roomId ? r.roomId === where.roomId : true)),
      );
    }),
  };

  // In-memory-backed, stateful mock so tests can assert on which EventLog rows a given
  // action actually wrote — see eventLogService.ts's own "never throws" doc comment for
  // why `create`/`createMany` never reject here (a real `eventLog.create` failure must
  // never abort the caller, so nothing about this mock needs to simulate that).
  const eventLogRows: Record<string, unknown>[] = [];
  const mockEventLog = {
    _rows: eventLogRows,
    create: vi.fn().mockImplementation(({ data }: any) => {
      const row = { id: `event-${eventLogRows.length + 1}`, createdAt: new Date(), ...data };
      eventLogRows.push(row);
      return Promise.resolve(row);
    }),
    createMany: vi.fn().mockImplementation(({ data }: any) => {
      for (const d of data) {
        eventLogRows.push({ id: `event-${eventLogRows.length + 1}`, createdAt: new Date(), ...d });
      }
      return Promise.resolve({ count: data.length });
    }),
    findMany: vi.fn().mockImplementation(({ where }: any = {}) => {
      return Promise.resolve(
        eventLogRows.filter((r: any) => {
          if (where?.eventType && r.eventType !== where.eventType) return false;
          if (where?.roomId && r.roomId !== where.roomId) return false;
          return true;
        }),
      );
    }),
  };

  const mockPrisma: Partial<PrismaClient> = {
    room: mockRoom,
    player: mockPlayer,
    company: mockCompany,
    decision: mockDecision as any,
    gameConfigRow: mockGameConfigRow as any,
    formula: mockFormula as any,
    asset: {
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    kpiSnapshot: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    } as any,
    legalCaseHistory: mockLegalCaseHistory as any,
    eventLog: mockEventLog as any,
    $transaction: vi.fn().mockImplementation(async (fn: (tx: Partial<PrismaClient>) => Promise<unknown>) => {
      return fn(mockPrisma as Partial<PrismaClient>);
    }),
  };

  return mockPrisma as unknown as PrismaClient;
};

/** Typed accessor for `createMockPrisma`'s in-memory `eventLog._rows` — a single, named
 * assertion helper instead of repeating `(prisma.eventLog as any)._rows` at every call
 * site (see the many EventLog regression tests below). */
interface LoggedEventRow {
  eventType: string;
  severity: string;
  roomId: string | null;
  playerId: string | null;
  payload: Record<string, unknown>;
}
function getLoggedEvents(prisma: PrismaClient): LoggedEventRow[] {
  return (prisma as unknown as { eventLog: { _rows: LoggedEventRow[] } }).eventLog._rows;
}

describe('GameEngine', () => {
  let engine: GameEngine;
  let mockIo: Server;
  let mockPrisma: PrismaClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIo = createMockIo();
    mockPrisma = createMockPrisma();
    // Update prismaRef to point to the newly created mock
    (mockPrisma as Partial<PrismaClient>).room = mockPrisma.room;
    (mockPrisma as Partial<PrismaClient>).player = mockPrisma.player;
    (mockPrisma as Partial<PrismaClient>).company = mockPrisma.company;
    (mockPrisma as Partial<PrismaClient>).asset = mockPrisma.asset;
    engine = new GameEngine(mockIo, mockPrisma);
    // Decisions/config now load from the DB (see GameEngine.loadGameData) instead
    // of a synchronous JSON import — every test needs this awaited first.
    await engine.loadGameData();
  });

  describe('createRoom', () => {
    it('should create a new room with the player', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);

      expect(roomState).toBeDefined();
      expect(roomState.room.status).toBe(RoomStatus.WAITING);
      expect(roomState.room.maxPlayers).toBe(4);
      expect(roomState.players.size).toBe(1);
      expect(mockPrisma.room.create).toHaveBeenCalled();
    });

    it('should initialize room with WAITING status', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      await engine.createRoom(player);

      const createCall = (mockPrisma.room.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.status).toBe(RoomStatus.WAITING);
    });

    it('should create a company for the player with $100,000 cash', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      await engine.createRoom(player);

      const createCall = (mockPrisma.room.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.players.create.company.create.cash).toBe(100000);
    });

    it('should generate a unique room ID', async () => {
      const player1 = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const player2 = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      const room1 = await engine.createRoom(player1);
      const room2 = await engine.createRoom(player2);

      expect(room1.room.id).not.toBe(room2.room.id);
    });

    it('should store the room in the rooms map', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);
      const storedRoom = engine.getRoom(roomState.room.id);

      expect(storedRoom).toBeDefined();
      expect(storedRoom?.room.id).toBe(roomState.room.id);
    });

    it('should map the player socket to the room', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);
      const playerRoom = engine.getPlayerRoom('socket-1');

      expect(playerRoom).toBe(roomState.room.id);
    });

    it('should set player isHost to true when creating room', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);
      const roomPlayer = Array.from(roomState.players.values())[0];

      expect(roomPlayer.isHost).toBe(true);
    });

    // Regression coverage for a real, reproduced bug: a player who forfeits a game
    // (game:leave) keeps their socket fully connected — they can choose to keep
    // spectating that same room — but the server never called `socket.leave(roomId)`
    // for it (unlike room:leave's WAITING-lobby departure, which already does). If that
    // same socket went on to create/join a SECOND room without reloading the page, it
    // stayed subscribed to BOTH rooms' broadcasts: the old room's later `game:over`/
    // `player:bankrupt`/`phase:changed` events landed on it too, silently overwriting
    // the second game's Game Over screen with the first game's stale winner/eliminated-
    // player data — confirmed via a live 2-game Playwright repro before this fix. See
    // CLAUDE.md.
    it('leaves the previous room\'s Socket.IO channel when the same socket creates a second room (regression)', async () => {
      const leaveSpy = vi.fn();
      (mockIo as unknown as { sockets: { sockets: Map<string, { leave: typeof leaveSpy }> } })
        .sockets.sockets.set('socket-1', { leave: leaveSpy });

      const player = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const room1 = await engine.createRoom(player);
      expect(leaveSpy).not.toHaveBeenCalled(); // nothing stale yet on the very first room

      const room2 = await engine.createRoom({ ...player, id: '', roomId: '' });
      expect(leaveSpy).toHaveBeenCalledWith(room1.room.id);
      expect(engine.getPlayerRoom('socket-1')).toBe(room2.room.id);
    });
  });

  describe('joinRoom', () => {
   it('should join an existing room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const roomId = roomState.room.id;

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      const joinedRoom = await engine.joinRoom(roomId, joiner);

      // joinRoom returns the roomState reference
      expect(joinedRoom).toBe(roomState);
      expect(engine.getPlayerRoom('socket-2')).toBe(roomId);
      expect(mockPrisma.player.create).toHaveBeenCalled();
    });

    it('should return the same roomState reference after joining', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const roomId = roomState.room.id;

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      const joinedRoom = await engine.joinRoom(roomId, joiner);

      // Both should reference the same Map
      expect(joinedRoom.players).toBe(roomState.players);
    });

    it('should throw when joining a non-existent room', async () => {
      const player = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await expect(engine.joinRoom('nonexistent-room', player)).rejects.toThrow('Room not found');
    });

    it('should throw when joining a full room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      // Set maxPlayers to 1 to simulate a full room
      roomState.room.maxPlayers = 1;

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await expect(engine.joinRoom(roomState.room.id, joiner)).rejects.toThrow('Room is full');
    });

    it('should throw when player name is already taken', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const duplicate = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await expect(engine.joinRoom(roomState.room.id, duplicate)).rejects.toThrow('Player name already taken');
    });

    it('should throw when the name was kicked from this room, even after the name is free again', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      roomState.kickedNames.add('Bob');

      const rejoinAttempt = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await expect(engine.joinRoom(roomState.room.id, rejoinAttempt)).rejects.toThrow(
        'You were removed from this room and cannot rejoin',
      );
    });

    it('should set joining player isHost to false', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      const joinedRoom = await engine.joinRoom(roomState.room.id, joiner);
      const joinerPlayer = Array.from(joinedRoom.players.values()).find((p) => p.socketId === 'socket-2');

      expect(joinerPlayer?.isHost).toBe(false);
    });

    it('should create a company for the joining player', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await engine.joinRoom(roomState.room.id, joiner);

      expect(mockPrisma.player.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            company: expect.objectContaining({
              create: expect.objectContaining({ cash: 100000 }),
            }),
          }),
        }),
      );
    });

    // Same regression as createRoom's — joining a second (different) room on a socket
    // still mapped to an earlier one must leave that earlier room's Socket.IO channel.
    it('leaves the previous room\'s Socket.IO channel when the same socket joins a second, different room (regression)', async () => {
      const leaveSpy = vi.fn();
      (mockIo as unknown as { sockets: { sockets: Map<string, { leave: typeof leaveSpy }> } })
        .sockets.sockets.set('socket-2', { leave: leaveSpy });

      const room1 = await engine.createRoom({ id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' });
      const room2 = await engine.createRoom({ id: '', name: 'Carol', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-3' });

      const bob = { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' };
      await engine.joinRoom(room1.room.id, bob);
      expect(leaveSpy).not.toHaveBeenCalled();

      await engine.joinRoom(room2.room.id, { ...bob, id: '', name: 'Bob2', roomId: '' });
      expect(leaveSpy).toHaveBeenCalledWith(room1.room.id);
      expect(engine.getPlayerRoom('socket-2')).toBe(room2.room.id);
    });
  });

  describe('buildRoomSnapshot', () => {
    it('should rebuild players fresh from roomState.players, not the stale roomState.room.players', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      // roomState.room.players (the embedded array from room creation) never gets
      // updated by joinRoom — this is exactly the staleness buildRoomSnapshot exists
      // to route around. Confirm the raw embedded array really is stale...
      expect(roomState.room.players).toHaveLength(1);

      // ...but the snapshot is not.
      const snapshot = engine.buildRoomSnapshot(roomState);
      expect(snapshot.players).toHaveLength(2);
      expect(snapshot.players.map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
    });

    it('should include inviteOnly', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      roomState.room.inviteOnly = true;

      expect(engine.buildRoomSnapshot(roomState).inviteOnly).toBe(true);
    });
  });

  describe('promoteNewHostIfNeeded', () => {
    it('should no-op when a host already exists', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      await engine.promoteNewHostIfNeeded(roomState);

      const hosts = Array.from(roomState.players.values()).filter((p) => p.isHost);
      expect(hosts).toHaveLength(1);
      expect(hosts[0].name).toBe('Alice');
    });

    it('should no-op on an empty room', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      roomState.players.clear();

      await expect(engine.promoteNewHostIfNeeded(roomState)).resolves.not.toThrow();
    });

    it('should promote the earliest-remaining-joined player when no host exists', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Carol', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-3' });

      // Simulate the original host having just left — no one is host anymore.
      const alice = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!;
      roomState.players.delete(alice.id);

      await engine.promoteNewHostIfNeeded(roomState);

      const bob = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!;
      const carol = Array.from(roomState.players.values()).find((p) => p.name === 'Carol')!;
      expect(bob.isHost).toBe(true);
      expect(carol.isHost).toBe(false);
      expect(mockPrisma.player.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: bob.id }, data: { isHost: true } }),
      );
    });

    it('never promotes a bot to host, even as the sole remaining player', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      // Simulate a bot having joined and the human host having since left, leaving only
      // the bot behind — a bot must never end up as host (it has no client to exercise
      // host-only actions with).
      const alice = Array.from(roomState.players.values())[0];
      roomState.players.delete(alice.id);
      roomState.players.set('bot-1', {
        id: 'bot-1', name: '🤖 RoboRival', roomId: roomState.room.id, isHost: false, bankrupt: false, socketId: null, isBot: true,
      });

      await engine.promoteNewHostIfNeeded(roomState);

      expect(roomState.players.get('bot-1')!.isHost).toBe(false);
      expect(mockPrisma.player.update).not.toHaveBeenCalled();
    });
  });

  describe('leaveRoom', () => {
    it('should fail outside WAITING phase', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      roomState.room.status = RoomStatus.GAME_PHASE;
      const alice = Array.from(roomState.players.values())[0];

      const result = await engine.leaveRoom(roomState.room.id, alice.id);

      expect(result).toEqual({ success: false, reason: 'not_in_lobby' });
    });

    it('should fail for an unknown player', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);

      const result = await engine.leaveRoom(roomState.room.id, 'not-a-real-player');

      expect(result).toEqual({ success: false, reason: 'not_found' });
    });

    it('should remove the player and delete their DB rows', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      const bobRoomState = await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const bob = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!;

      const result = await engine.leaveRoom(roomState.room.id, bob.id);

      expect(result).toEqual({ success: true });
      expect(roomState.players.has(bob.id)).toBe(false);
      expect(mockPrisma.player.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: bob.id } }));
      expect(engine.getPlayerRoom('socket-2')).toBeUndefined();
    });

    it('should promote a new host when the host leaves and others remain', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const alice = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!;

      const result = await engine.leaveRoom(roomState.room.id, alice.id);

      expect(result).toEqual({ success: true });
      const bob = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!;
      expect(bob.isHost).toBe(true);
    });

    it('should delete the room when the last player leaves', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      const alice = Array.from(roomState.players.values())[0];
      const roomId = roomState.room.id;

      const result = await engine.leaveRoom(roomId, alice.id);

      expect(result).toEqual({ success: true });
      expect(engine.getRoom(roomId)).toBeUndefined();
    });
  });

  describe('bot players', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    describe('scheduleBotJoinCheck / addBotPlayer', () => {
      it('adds a clearly-named bot after 10s to a public room left with exactly one player', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        expect(roomState.players.size).toBe(1);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(roomState.players.size).toBe(2);
        const bot = Array.from(roomState.players.values()).find((p) => p.isBot)!;
        expect(bot).toBeDefined();
        expect(bot.isHost).toBe(false);
        expect(bot.socketId).toBeNull();
        expect(localIo.emit).toHaveBeenCalledWith(
          ServerEvents.ROOM_UPDATED,
          expect.objectContaining({ room: expect.objectContaining({ players: expect.arrayContaining([expect.objectContaining({ isBot: true })]) }) }),
        );

        localEngine.stop();
      });

      it('does not add a bot if a second human joins before the 10s elapses', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        await vi.advanceTimersByTimeAsync(3_000);
        await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

        await vi.advanceTimersByTimeAsync(10_000);

        expect(roomState.players.size).toBe(2);
        expect(Array.from(roomState.players.values()).some((p) => p.isBot)).toBe(false);

        localEngine.stop();
      });

      it('does not add a bot to an invite-only room', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        roomState.room.inviteOnly = true;

        await vi.advanceTimersByTimeAsync(10_000);

        expect(roomState.players.size).toBe(1);

        localEngine.stop();
      });

      it('does not add a bot when enableBotPlayers is disabled', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();
        const snapshot = localEngine.getGameConfigSnapshot();
        await localEngine.updateGameConfigData({ ...snapshot, gameSettings: { ...snapshot.gameSettings, enableBotPlayers: false } });

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(roomState.players.size).toBe(1);

        localEngine.stop();
      });

      it('does not add a second bot to a room that already has one', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(roomState.players.size).toBe(2);

        // Nothing re-schedules a check while a bot is already present, but even if it
        // somehow fired again, the "exactly one player, not a bot" gate must hold.
        localEngine.scheduleBotJoinCheck(roomState.room.id);
        await vi.advanceTimersByTimeAsync(10_000);

        expect(roomState.players.size).toBe(2);

        localEngine.stop();
      });

      it('restarts the 10s clock once a room is back down to exactly one human (leaveRoom)', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        const bobRoomState = await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
        const bob = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!;

        // Two humans present well past the original 10s window — no bot should have
        // joined, since the room was never left with exactly one player during it.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(roomState.players.size).toBe(2);

        await localEngine.leaveRoom(roomState.room.id, bob.id);
        expect(roomState.players.size).toBe(1);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(roomState.players.size).toBe(2);
        expect(Array.from(roomState.players.values()).some((p) => p.isBot)).toBe(true);

        localEngine.stop();
      });
    });

    // The lobby renders a live "a bot opponent joins in Ns" counter off this value (see
    // botJoinNotice.ts client-side). It has to disappear the moment the join stops being
    // real — otherwise a lobby counts down to an opponent that never arrives.
    describe('botJoinInMs on the room snapshot', () => {
      it('reports the time remaining until the bot joins a freshly-created room', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);

        expect(localEngine.buildRoomSnapshot(roomState).botJoinInMs).toBe(10_000);

        await vi.advanceTimersByTimeAsync(4_000);
        expect(localEngine.buildRoomSnapshot(roomState).botJoinInMs).toBe(6_000);

        localEngine.stop();
      });

      it('is undefined once the bot has actually joined', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        await vi.advanceTimersByTimeAsync(10_000);

        expect(Array.from(roomState.players.values()).some((p) => p.isBot)).toBe(true);
        expect(localEngine.buildRoomSnapshot(roomState).botJoinInMs).toBeUndefined();

        localEngine.stop();
      });

      it('is undefined the instant a real human joins — the pending join is cancelled outright', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(localEngine.buildRoomSnapshot(roomState).botJoinInMs).toBe(7_000);

        await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

        expect(localEngine.buildRoomSnapshot(roomState).botJoinInMs).toBeUndefined();

        // ...and stays cancelled: no bot ever materialises for the rest of the window.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(Array.from(roomState.players.values()).some((p) => p.isBot)).toBe(false);

        localEngine.stop();
      });

      it('is undefined for an invite-only room, without waiting for the timer to no-op', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        roomState.room.inviteOnly = true;

        expect(localEngine.buildRoomSnapshot(roomState).botJoinInMs).toBeUndefined();

        localEngine.stop();
      });

      it('is undefined when enableBotPlayers is off', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();
        const snapshot = localEngine.getGameConfigSnapshot();
        await localEngine.updateGameConfigData({ ...snapshot, gameSettings: { ...snapshot.gameSettings, enableBotPlayers: false } });

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);

        expect(localEngine.buildRoomSnapshot(roomState).botJoinInMs).toBeUndefined();

        localEngine.stop();
      });

      it('re-arms with a full window when a departure leaves one human alone again', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        const bobRoomState = await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
        const bob = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!;
        expect(localEngine.buildRoomSnapshot(roomState).botJoinInMs).toBeUndefined();

        await localEngine.leaveRoom(roomState.room.id, bob.id);

        expect(localEngine.buildRoomSnapshot(roomState).botJoinInMs).toBe(10_000);

        localEngine.stop();
      });

      it('is carried on the ROOM_UPDATED broadcast that announces the re-armed countdown', async () => {
        // The re-arm happens BEFORE the broadcast in leaveRoom for exactly this reason —
        // the lone remaining player's counter has to start immediately, not on whatever
        // unrelated ROOM_UPDATED happens to come next.
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        const bobRoomState = await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
        const bob = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!;

        localIo.emit.mockClear();
        await localEngine.leaveRoom(roomState.room.id, bob.id);

        expect(localIo.emit).toHaveBeenCalledWith(
          ServerEvents.ROOM_UPDATED,
          expect.objectContaining({ room: expect.objectContaining({ botJoinInMs: 10_000 }) }),
        );

        localEngine.stop();
      });
    });

    describe('removed the instant a human joins', () => {
      it('removes the bot (DB rows + roster entry) when a real human joins the room', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        await vi.advanceTimersByTimeAsync(10_000);
        const bot = Array.from(roomState.players.values()).find((p) => p.isBot)!;
        expect(bot).toBeDefined();

        await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

        expect(roomState.players.has(bot.id)).toBe(false);
        expect(Array.from(roomState.players.values()).map((p) => p.name)).toEqual(expect.arrayContaining(['Alice', 'Bob']));
        expect(localPrisma.player.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: bot.id } }));

        localEngine.stop();
      });
    });

    describe('cleanup when only bots remain', () => {
      it('leaveRoom tears the room down immediately when the departing human leaves only a bot behind', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        await vi.advanceTimersByTimeAsync(10_000);
        const alice = Array.from(roomState.players.values()).find((p) => !p.isBot)!;

        const result = await localEngine.leaveRoom(roomState.room.id, alice.id);

        expect(result).toEqual({ success: true });
        expect(localEngine.getRoom(roomState.room.id)).toBeUndefined();
        expect(localPrisma.room.delete).toHaveBeenCalledWith({ where: { id: roomState.room.id } });

        localEngine.stop();
      });

      it('the heartbeat stale-room sweep reclaims a room where every remaining player is a bot (e.g. the human disconnected mid-game and never came back)', async () => {
        vi.useFakeTimers();
        const localIo = createMockIo();
        const localPrisma = createMockPrisma();
        const localEngine = new GameEngine(localIo, localPrisma);
        await localEngine.loadGameData();

        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await localEngine.createRoom(creator);
        await vi.advanceTimersByTimeAsync(10_000);
        const alice = Array.from(roomState.players.values()).find((p) => !p.isBot)!;
        // Simulate Alice having vanished mid-game already (e.g. finalizePlayerRemoval
        // ran for her separately) — the bot is the sole remaining player, never
        // bankrupt, with no socketId of its own.
        roomState.players.delete(alice.id);
        roomState.room.status = RoomStatus.GAME_PHASE;

        await vi.advanceTimersByTimeAsync(70_000); // past STALE_ROOM_THRESHOLD

        expect(localEngine.getRoom(roomState.room.id)).toBeUndefined();
        expect(localPrisma.room.delete).toHaveBeenCalledWith({ where: { id: roomState.room.id } });

        localEngine.stop();
      });
    });

    describe('runBotTurn orchestration', () => {
      async function makeWaitingRoomWithBot() {
        vi.useFakeTimers();
        const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
        const roomState = await engine.createRoom(creator);
        await vi.advanceTimersByTimeAsync(10_000);
        vi.useRealTimers();
        return roomState;
      }

      it('submits decisions and readies up after round 1, without ever being asked to', async () => {
        const roomState = await makeWaitingRoomWithBot();
        const bot = Array.from(roomState.players.values()).find((p) => p.isBot)!;

        await engine.startGame(roomState.room.id);

        await vi.waitFor(() => {
          expect(roomState.readyPlayerIds.has(bot.id)).toBe(true);
        });
      });

      it('never acts for a bankrupt bot', async () => {
        const roomState = await makeWaitingRoomWithBot();
        const bot = Array.from(roomState.players.values()).find((p) => p.isBot)!;
        bot.bankrupt = true;
        const submitSpy = vi.spyOn(engine, 'submitDecisions');

        await engine.startGame(roomState.room.id);
        // Give any (there shouldn't be any) fire-and-forget bot work a chance to run.
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(submitSpy).not.toHaveBeenCalledWith(roomState.room.id, bot.id, expect.anything());
      });

      it('charges lawsuit filing fees one at a time, reflecting each in the submission before charging the next (regression — chargeLawsuitFilingFee\'s per-turn cap reads the already-queued count)', async () => {
        const roomState = await makeWaitingRoomWithBot();
        const bot = Array.from(roomState.players.values()).find((p) => p.isBot)!;
        roomState.room.status = RoomStatus.GAME_PHASE;
        roomState.room.currentPhaseRound = 2;
        roomState.decisionSubset = engine.getDecisionsSnapshot().map((d) => d.decision);

        // Seed two already-fully-revealed, easily-winnable incoming attacks — bypasses
        // needing several real rounds of digging to reach this state naturally (the
        // heads-up investigation shortcut plus this bot's own "one dig per attack per
        // turn" pacing would otherwise take multiple rounds to fully reveal even one).
        (engine as unknown as { lastTurnResults: Map<string, unknown> }).lastTurnResults.set(roomState.room.id, {
          round: 1,
          gameOver: false,
          players: [
            {
              playerId: bot.id,
              playerName: bot.name,
              variables: { cash: 500_000 },
              derived: {},
              activeDecisions: [],
              legalCases: [],
              riskGauge: 0,
              sharesBoughtThisTurn: [],
              incomingAttacks: [
                {
                  attackId: 'attack-a', isIndirect: false, investigationLevel: 3,
                  attackerId: 'attacker-a', attackerName: 'Attacker A',
                  decisionName: 'Bot Attack', suggestedGrounds: [{ name: 'Ground A', description: 'x', probability: 0.9, stakes: 1000 }],
                },
                {
                  attackId: 'attack-b', isIndirect: false, investigationLevel: 3,
                  attackerId: 'attacker-b', attackerName: 'Attacker B',
                  decisionName: 'Bot Attack', suggestedGrounds: [{ name: 'Ground B', description: 'x', probability: 0.9, stakes: 1000 }],
                },
              ],
            },
          ],
        });

        const fileLawsuitSpy = vi.spyOn(engine, 'fileLawsuit');
        const submitSpy = vi.spyOn(engine, 'submitDecisions');

        await engine.runBotTurn(roomState.room.id, bot.id);

        expect(fileLawsuitSpy).toHaveBeenCalledTimes(2);

        // Each fee charge must be reflected in a submitDecisions call (growing the
        // lawsuits array) before the NEXT fee is charged — otherwise the 2nd charge's
        // per-turn cap check would read a stale (too-low) queued count.
        const fileLawsuitCallOrder = fileLawsuitSpy.mock.invocationCallOrder;
        const submitCallOrder = submitSpy.mock.invocationCallOrder;
        expect(submitCallOrder.some((t) => t > fileLawsuitCallOrder[0] && t < fileLawsuitCallOrder[1])).toBe(true);

        // Both lawsuits ultimately end up in the final submission.
        const lastSubmitCall = submitSpy.mock.calls[submitSpy.mock.calls.length - 1];
        const finalDecisions = lastSubmitCall[2] as { lawsuits: { groundName: string }[] };
        expect(finalDecisions.lawsuits.map((l) => l.groundName).sort()).toEqual(['Ground A', 'Ground B']);
      });

      it('never spends below the cash reserve on lawsuit filing fees', async () => {
        const roomState = await makeWaitingRoomWithBot();
        const bot = Array.from(roomState.players.values()).find((p) => p.isBot)!;
        roomState.room.status = RoomStatus.GAME_PHASE;
        roomState.room.currentPhaseRound = 2;
        roomState.decisionSubset = engine.getDecisionsSnapshot().map((d) => d.decision);

        (engine as unknown as { lastTurnResults: Map<string, unknown> }).lastTurnResults.set(roomState.room.id, {
          round: 1,
          gameOver: false,
          players: [
            {
              playerId: bot.id,
              playerName: bot.name,
              // Barely below reserve + filing cost — cannot afford to sue at all.
              variables: { cash: 20_000 },
              derived: {},
              activeDecisions: [],
              legalCases: [],
              riskGauge: 0,
              sharesBoughtThisTurn: [],
              incomingAttacks: [
                {
                  attackId: 'attack-a', isIndirect: false, investigationLevel: 3,
                  attackerId: 'attacker-a', attackerName: 'Attacker A',
                  decisionName: 'Bot Attack', suggestedGrounds: [{ name: 'Ground A', description: 'x', probability: 0.9, stakes: 1000 }],
                },
              ],
            },
          ],
        });

        const fileLawsuitSpy = vi.spyOn(engine, 'fileLawsuit');

        await engine.runBotTurn(roomState.room.id, bot.id);

        expect(roomState.readyPlayerIds.has(bot.id)).toBe(true);
        expect(fileLawsuitSpy).not.toHaveBeenCalled();
      });

      it('accepts a favorable settlement offer instead of leaving it to sit until the turn-boundary timeout (regression — bot used to never actively negotiate)', async () => {
        const roomState = await makeWaitingRoomWithBot();
        const bot = Array.from(roomState.players.values()).find((p) => p.isBot)!;
        const human = Array.from(roomState.players.values()).find((p) => !p.isBot)!;
        roomState.room.status = RoomStatus.GAME_PHASE;
        roomState.room.currentPhaseRound = 2;
        roomState.decisionSubset = engine.getDecisionsSnapshot().map((d) => d.decision);

        // Plaintiff's ask (5,000) is far below the ~90,000 fair value implied by a 0.9
        // win probability the bot already knows (defendantInvestigated) — a rational
        // defendant accepts a bargain like this outright rather than countering.
        const case_ = {
          id: 'case-1', roomId: roomState.room.id,
          plaintiffId: human.id, defendantId: bot.id,
          decisionName: 'Water Pumping', groundName: 'Environmental Violation',
          description: 'x', baseProbability: 0.9, stakes: 100_000,
          defendantInvestigated: true,
          status: 'negotiating' as const,
          offers: [{ by: 'plaintiff' as const, amount: 5_000 }],
          turnsNegotiating: 0, createdAt: new Date(),
        };

        (engine as unknown as { lastTurnResults: Map<string, unknown> }).lastTurnResults.set(roomState.room.id, {
          round: 1,
          gameOver: false,
          players: [
            {
              playerId: bot.id, playerName: bot.name,
              variables: { cash: 500_000 }, derived: {}, activeDecisions: [],
              legalCases: [case_], riskGauge: 0, sharesBoughtThisTurn: [], incomingAttacks: [],
            },
          ],
        });

        (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
          Promise.resolve(
            where?.roomId === roomState.room.id
              ? [
                  { id: bot.id, name: bot.name, roomId: roomState.room.id, bankrupt: false, company: { variables: { cash: 500_000 }, engineState: { legalCases: [case_] } } },
                  { id: human.id, name: human.name, roomId: roomState.room.id, bankrupt: false, company: { variables: { cash: 100_000 }, engineState: { legalCases: [case_] } } },
                ]
              : [],
          ),
        );

        const acceptSpy = vi.spyOn(engine, 'acceptOffer');
        const makeOfferSpy = vi.spyOn(engine, 'makeOffer');
        const goToCourtSpy = vi.spyOn(engine, 'goToCourt');

        await engine.runBotTurn(roomState.room.id, bot.id);

        expect(acceptSpy).toHaveBeenCalledWith(roomState.room.id, bot.id, 'case-1');
        expect(makeOfferSpy).not.toHaveBeenCalled();
        expect(goToCourtSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('markPlayerDisconnected', () => {
    it('keeps the player in the room and clears their socketId — no DB delete', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];

      await engine.markPlayerDisconnected('socket-1');

      // The old socketId->room mapping is gone (it's dead)...
      expect(engine.getPlayerRoom('socket-1')).toBeUndefined();
      // ...but the room and player are both still there, untouched in the DB.
      const room = engine.getRoom(roomState.room.id);
      expect(room).toBeDefined();
      expect(room!.players.has(playerId)).toBe(true);
      expect(room!.players.get(playerId)!.socketId).toBeNull();
      expect(mockPrisma.player.delete).not.toHaveBeenCalled();
      expect(mockPrisma.company.delete).not.toHaveBeenCalled();

      // See CLAUDE.md's EventLog section — a disconnect is a lifecycle event the admin
      // Analytics tab's raw feed surfaces, distinct from the later, terminal removal.
      const eventRows = getLoggedEvents(mockPrisma);
      expect(eventRows).toContainEqual(expect.objectContaining({
        eventType: 'player.disconnected',
        roomId: roomState.room.id,
        playerId,
      }));
    });

    it('should do nothing for unknown socket', async () => {
      await expect(engine.markPlayerDisconnected('unknown-socket')).resolves.toBeUndefined();
    });
  });

  describe('reconnect grace period (finalizePlayerRemoval via heartbeat sweep)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('finalizes removal — DB delete, room cleanup, ROOM_PLAYER_LEFT broadcast — once the grace period elapses without a rejoin', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);

      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await localEngine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];

      await localEngine.markPlayerDisconnected('socket-1');
      expect(localPrisma.player.delete).not.toHaveBeenCalled();

      // Past both the 10s heartbeat tick and the 120s grace period.
      await vi.advanceTimersByTimeAsync(130_000);

      expect(localPrisma.player.delete).toHaveBeenCalled();
      expect(localEngine.getRoom(roomState.room.id)).toBeUndefined();
      expect(localIo.emit).toHaveBeenCalledWith(
        ServerEvents.ROOM_PLAYER_LEFT,
        expect.objectContaining({ playerId, playerName: 'Alice' }),
      );

      localEngine.stop();
    });

    it('reconnecting via rejoinRoom within the grace period cancels the pending removal', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);

      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await localEngine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];

      await localEngine.markPlayerDisconnected('socket-1');
      await vi.advanceTimersByTimeAsync(5_000); // well within the grace period

      const result = await localEngine.rejoinRoom(roomState.room.id, playerId, 'socket-2');
      expect(result.success).toBe(true);

      // Advance well past what would have been the original 120s deadline.
      await vi.advanceTimersByTimeAsync(130_000);

      expect(localPrisma.player.delete).not.toHaveBeenCalled();
      expect(localEngine.getRoom(roomState.room.id)).toBeDefined();

      localEngine.stop();
    });

    it('promotes a new host and broadcasts ROOM_UPDATED when the host\'s grace period expires and others remain', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);

      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await localEngine.createRoom(creator);
      await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      await localEngine.markPlayerDisconnected('socket-1'); // the host
      await vi.advanceTimersByTimeAsync(130_000);

      const bob = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!;
      expect(bob.isHost).toBe(true);
      expect(localIo.emit).toHaveBeenCalledWith(
        ServerEvents.ROOM_UPDATED,
        expect.objectContaining({ room: expect.objectContaining({ players: expect.arrayContaining([expect.objectContaining({ name: 'Bob', isHost: true })]) }) }),
      );

      localEngine.stop();
    });

    it('defers finalizing removal while this room\'s turn is already resolving, then finalizes it once that resolution finishes (regression — the race this app used to have no protection against)', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);
      await localEngine.loadGameData();

      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await localEngine.createRoom(creator);
      await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      // Bob disconnects (network hiccup, backgrounded tab, whatever) — his grace
      // period starts now.
      await localEngine.markPlayerDisconnected('socket-2');

      // Block resolveGameTurn's per-player persistence mid-flight, so it stays inside
      // its advancingRooms-held critical section for as long as this test needs —
      // simulating the round timer independently firing at almost the same moment
      // Bob's grace period is about to expire.
      let releaseUpdate: () => void = () => {};
      const blocker = new Promise<void>((resolve) => { releaseUpdate = resolve; });
      (localPrisma.company.update as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await blocker;
        return {};
      });

      const turnPromise = localEngine.resolveGameTurn(roomState.room.id);

      // Cross both the 10s heartbeat tick and the 120s grace-period deadline while
      // resolveGameTurn is still stuck mid-flight (advancingRooms still holds this room).
      await vi.advanceTimersByTimeAsync(130_000);
      expect(localPrisma.player.delete).not.toHaveBeenCalled();

      // Let resolveGameTurn finish and release the lock.
      releaseUpdate();
      await turnPromise;

      // The next heartbeat tick (10s later) now finds the lock free and finalizes it.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(localPrisma.player.delete).toHaveBeenCalled();

      localEngine.stop();
    });

    it('never finalizes removal for an eliminated (bankrupt) player while another player is still around — their data (and a game-timeline replay) must survive them closing their tab', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);

      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await localEngine.createRoom(creator);
      await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      const bob = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!;
      bob.bankrupt = true; // eliminated — mirrors resolveGameTurn's/forfeitGame's in-memory sync

      await localEngine.markPlayerDisconnected('socket-2');
      // Well past the grace period, repeatedly, across several heartbeat ticks.
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(localPrisma.player.delete).not.toHaveBeenCalled();
      // Alice is still connected, so the room itself isn't stale either — Bob can
      // still room:rejoin to keep spectating whenever he likes.
      expect(localEngine.getRoom(roomState.room.id)).toBeDefined();

      localEngine.stop();
    });

    it('still cleans up the whole room (and, via cascade, its exempted eliminated players) once every remaining player has disconnected past the stale threshold', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);

      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await localEngine.createRoom(creator);
      const alice = Array.from(roomState.players.values())[0];
      alice.bankrupt = true; // the sole remaining player, eliminated, and about to disconnect too

      await localEngine.markPlayerDisconnected('socket-1');
      // Individual removal is exempted (bankrupt), but the room itself is a different
      // signal ("no player in the room still has a live socket") — once nobody at all
      // is left connected, the room (and everything cascading from it) is fair to
      // reclaim, same as any other genuinely abandoned room.
      await vi.advanceTimersByTimeAsync(70_000);

      expect(localPrisma.player.delete).not.toHaveBeenCalled();
      expect(localEngine.getRoom(roomState.room.id)).toBeUndefined();
      expect(localPrisma.room.delete).toHaveBeenCalledWith({ where: { id: roomState.room.id } });

      localEngine.stop();
    });
  });

  describe('rejoinRoom', () => {
    it('returns failure when the room no longer exists', async () => {
      const result = await engine.rejoinRoom('nonexistent-room', 'some-player', 'socket-2');
      expect(result.success).toBe(false);
    });

    it('returns failure when the player no longer exists in the room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const result = await engine.rejoinRoom(roomState.room.id, 'bogus-player-id', 'socket-2');
      expect(result.success).toBe(false);
    });

    it('re-associates the player with the new socket and returns a ROOM_JOINED payload', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];
      await engine.markPlayerDisconnected('socket-1');

      const result = await engine.rejoinRoom(roomState.room.id, playerId, 'socket-2');

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.roomJoined.player.id).toBe(playerId);
      expect(engine.getPlayerRoom('socket-2')).toBe(roomState.room.id);
      expect(engine.getRoom(roomState.room.id)!.players.get(playerId)!.socketId).toBe('socket-2');
      // WAITING phase — no game deck or turn snapshot to resend yet.
      expect(result.gameDeck).toBeUndefined();
      expect(result.turnResolved).toBeUndefined();
      expect(result.gameOver).toBeUndefined();

      const eventRows = getLoggedEvents(mockPrisma);
      expect(eventRows).toContainEqual(expect.objectContaining({
        eventType: 'player.reconnected',
        roomId: roomState.room.id,
        playerId,
      }));
    });

    it('resends the game deck + cached last-turn snapshot when rejoining mid-GAME_PHASE', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];
      roomState.room.status = RoomStatus.GAME_PHASE;
      await engine.broadcastInitialSnapshot(roomState.room.id, 1); // populates the lastTurnResults cache
      await engine.markPlayerDisconnected('socket-1');

      const result = await engine.rejoinRoom(roomState.room.id, playerId, 'socket-2');

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.gameDeck).toBeDefined();
      expect(result.turnResolved).toBeDefined();
      expect(result.turnResolved!.round).toBe(1);
      expect(result.gameOver).toBeUndefined();
    });

    it('resends the game-over payload when rejoining during AFTERMATH', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];
      roomState.room.status = RoomStatus.AFTERMATH;
      await engine.markPlayerDisconnected('socket-1');

      const result = await engine.rejoinRoom(roomState.room.id, playerId, 'socket-2');

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.gameOver).toBeDefined();
      expect(result.gameOver!.winner.id).toBe(playerId);
      expect(result.gameDeck).toBeUndefined();
      expect(result.turnResolved).toBeUndefined();
    });

    // Defense-in-depth version of the same createRoom/joinRoom regression above — a
    // socket already mapped to a different room (e.g. it never got the chance to leave
    // one for some other reason) must leave that stale room before rejoinRoom points it
    // at a new one.
    it('leaves a different room\'s Socket.IO channel if the rejoining socket was still mapped to one (regression)', async () => {
      const leaveSpy = vi.fn();
      (mockIo as unknown as { sockets: { sockets: Map<string, { leave: typeof leaveSpy }> } })
        .sockets.sockets.set('socket-2', { leave: leaveSpy });

      const room1 = await engine.createRoom({ id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' });
      const playerId = Array.from(room1.players.keys())[0];
      const room2 = await engine.createRoom({ id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      expect(engine.getPlayerRoom('socket-2')).toBe(room2.room.id);

      await engine.rejoinRoom(room1.room.id, playerId, 'socket-2');

      expect(leaveSpy).toHaveBeenCalledWith(room2.room.id);
      expect(engine.getPlayerRoom('socket-2')).toBe(room1.room.id);
    });
  });

  describe('getRoom', () => {
    it('should return undefined for non-existent room', () => {
      const room = engine.getRoom('nonexistent');
      expect(room).toBeUndefined();
    });

    it('should return room state for existing room', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      const room = engine.getRoom(roomState.room.id);
      expect(room).toBeDefined();
      expect(room?.room.id).toBe(roomState.room.id);
    });
  });

  describe('getPlayerRoom', () => {
    it('should return undefined for unknown socket', () => {
      const roomId = engine.getPlayerRoom('unknown');
      expect(roomId).toBeUndefined();
    });

    it('should return room ID for known socket', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      const roomId = engine.getPlayerRoom('socket-1');
      expect(roomId).toBe(roomState.room.id);
    });
  });

  describe('startTimer', () => {
    it('should start a timer with the given seconds', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 120);

      expect(roomState.timerValue).toBe(120);
      expect(mockIo.to).toHaveBeenCalledWith(roomState.room.id);
    });

    it('should broadcast timer update on start', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 60);

      expect(mockIo.emit).toHaveBeenCalledWith(
        ServerEvents.TIMER_UPDATE,
        expect.objectContaining({ timeLeft: 60 }),
      );
    });

    it('should decrement timer every second', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 3);

      // Wait for timer to tick
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(roomState.timerValue).toBeLessThan(3);
    });

    it('should broadcast timer updates as it counts down', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 3);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const emitCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls;
      const timerCalls = emitCalls.filter((call: [string, ...unknown[]]) => call[0] === ServerEvents.TIMER_UPDATE);
      expect(timerCalls.length).toBeGreaterThan(1);
    });
  });

  describe('clearTimer', () => {
    it('should clear an active timer', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 120);
      engine.clearTimer(roomState.room.id);

      expect(roomState.timer).toBeNull();
    });

    it('should do nothing for non-existent room', () => {
      engine.clearTimer('nonexistent');
      // Should not throw
    });
  });

  describe('advancePhase', () => {
    it('should advance to the next phase in order', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(roomState.room.status).toBe(RoomStatus.GAME_PHASE);
    });

    it('should broadcast phase change event', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(mockIo.emit).toHaveBeenCalledWith(
        ServerEvents.PHASE_CHANGED,
        expect.objectContaining({
          phase: RoomStatus.GAME_PHASE,
        }),
      );
    });

    it('should start timer for the new phase', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(roomState.timer).toBeDefined();
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.GAME_PHASE]);
    });

    it('should not advance past the last phase', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      // Advance through all phases to reach the final one
      for (let i = 1; i < PHASE_ORDER.length; i++) {
        await engine.advancePhase(roomState.room.id);
      }

      const lastPhase = PHASE_ORDER[PHASE_ORDER.length - 1];
      expect(roomState.room.status).toBe(lastPhase);
    });

    it('should advance from GAME_PHASE to AFTERMATH', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      // Advance to GAME_PHASE
      await engine.advancePhase(roomState.room.id);
      // Advance to AFTERMATH
      await engine.advancePhase(roomState.room.id);

      expect(roomState.room.status).toBe(RoomStatus.AFTERMATH);
      // AFTERMATH phase should have an active timer
      expect(roomState.timer).toBeDefined();
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.AFTERMATH]);
    });

    it('should sync room state to database', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(mockPrisma.room.update).toHaveBeenCalled();
    });

    it('should skip concurrent advancePhase calls for the same room (race condition guard)', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      // Spy on internal methods to track calls
      const syncRoomToDBSpy = vi.spyOn(engine as unknown as GameEngine, 'syncRoomToDB');
      const broadcastRoomStateSpy = vi.spyOn(engine as unknown as GameEngine, 'broadcastRoomState');

      // Fire two advancePhase calls concurrently
      const [result1, result2] = await Promise.all([
        engine.advancePhase(roomState.room.id),
        engine.advancePhase(roomState.room.id),
      ]);

      // Both should resolve without error
      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();

      // But internal operations should only execute once (second call skipped)
      expect(syncRoomToDBSpy).toHaveBeenCalledTimes(1);
      expect(broadcastRoomStateSpy).toHaveBeenCalledTimes(1);

      // Room should be in the next phase (GAME_PHASE), not advanced twice
      expect(roomState.room.status).toBe(RoomStatus.GAME_PHASE);
    });
  });

  describe('resolveGameTurn', () => {
    it('should resolve the turn and loop into another GAME_PHASE round when the game is not over', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      await engine.resolveGameTurn(roomState.room.id);

      // Two solvent players, neither bankrupt — game continues into round 2
      expect(roomState.room.status).toBe(RoomStatus.GAME_PHASE);
      expect(roomState.room.currentPhaseRound).toBe(2);
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.GAME_PHASE]);

      const phaseChangedCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.PHASE_CHANGED,
      );
      expect(phaseChangedCalls.some((call) => (call[1] as any).round === 2)).toBe(true);

      // See CLAUDE.md's EventLog section — one turn.resolved row per resolveGameTurn
      // call, carrying round/duration/counts for the admin Analytics tab's Performance view.
      const eventRows = getLoggedEvents(mockPrisma);
      const turnResolvedEvents = eventRows.filter((r: any) => r.eventType === 'turn.resolved');
      expect(turnResolvedEvents).toHaveLength(1);
      expect(turnResolvedEvents[0]).toMatchObject({
        roomId: roomState.room.id,
        payload: expect.objectContaining({ round: 1, activePlayerCount: 2, bankruptedCount: 0 }),
      });
      expect(typeof turnResolvedEvents[0].payload.computeDurationMs).toBe('number');
      expect(typeof turnResolvedEvents[0].payload.totalDurationMs).toBe('number');
    });

    it('re-arms the turn timer when turn resolution throws, so an engine error costs one turn instead of freezing the room forever (regression)', async () => {
      // A real production outage (2026-08-12): a TypeError inside GameLoop.resolveTurn was
      // caught by the outer try/catch, but `startTimer` sits INSIDE that try — so no new
      // timer was ever scheduled and the room silently stopped advancing altogether. The
      // observed symptom was "the timer ran out but the turn never changed"; the game only
      // unstuck when an unrelated player action happened to re-trigger resolution.
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      const boom = vi.spyOn(engine.gameLoop, 'resolveTurn').mockImplementation(() => {
        throw new TypeError('b.createdAt.getTime is not a function');
      });
      await engine.resolveGameTurn(roomState.room.id);
      boom.mockRestore();

      // The turn itself is lost (round not advanced) — but the room is still ticking.
      expect(roomState.room.currentPhaseRound).toBe(1);
      expect(roomState.timer).not.toBeNull();
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.GAME_PHASE]);

      // ...and the failure is still recorded rather than swallowed silently.
      const errorRows = getLoggedEvents(mockPrisma).filter((r: any) => r.eventType === 'error.persistence');
      expect(errorRows.length).toBeGreaterThan(0);
    });

    it('broadcasts round 1\'s real TURN_RESOLVED without isInitialSnapshot, even though it carries the same round number as startGame\'s earlier initial-snapshot broadcast (regression — see gameLoop.test.ts\'s matching isInitialSnapshot coverage and GamePhase.tsx\'s processedTurnKeyRef)', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      await engine.resolveGameTurn(roomState.room.id);

      const calls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
      const turnResolvedCall = calls.find((c) => c[0] === ServerEvents.TURN_RESOLVED)!;
      expect((turnResolvedCall[1] as { round: number; isInitialSnapshot?: boolean }).round).toBe(1);
      expect((turnResolvedCall[1] as { isInitialSnapshot?: boolean }).isInitialSnapshot).toBeFalsy();
    });

    it('logs a decision.deployed EventLog row for a decision that actually deploys this turn', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      engine.submitDecisions(roomState.room.id, aliceId, { strategic: [{ name: 'New Factory' }], operational: [], financial: [], lawsuits: [] });
      await engine.resolveGameTurn(roomState.room.id);

      const eventRows = getLoggedEvents(mockPrisma);
      expect(eventRows).toContainEqual(expect.objectContaining({
        eventType: 'decision.deployed',
        roomId: roomState.room.id,
        playerId: aliceId,
        payload: expect.objectContaining({ bucket: 'strategic', decisionName: 'New Factory' }),
      }));
    });

    it('should transition to AFTERMATH and emit GAME_OVER when only one player remains', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 3;

      // Simulate every other player already bankrupt in the DB — only the host remains
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                {
                  id: 'db-player-1',
                  name: 'Alice',
                  roomId: roomState.room.id,
                  bankrupt: false,
                  companyId: 'company-db-player-1',
                  company: { id: 'company-db-player-1', playerId: 'db-player-1', cash: 100000, debt: 0, assets: [] },
                },
              ]
            : [],
        ),
      );

      await engine.resolveGameTurn(roomState.room.id);

      expect(roomState.room.status).toBe(RoomStatus.AFTERMATH);
      const gameOverCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_OVER,
      );
      expect(gameOverCalls).toHaveLength(1);
      expect(gameOverCalls[0][1]).toHaveProperty('winner');
      expect(gameOverCalls[0][1]).toHaveProperty('finalStandings');

      // See CLAUDE.md's EventLog section — game.completed is logged exactly once, at the
      // one moment a game actually just ended, never from buildGameOverPayload itself
      // (which rejoinRoom also calls on every reconnect to an already-finished room).
      const eventRows = getLoggedEvents(mockPrisma);
      const completedEvents = eventRows.filter((r: any) => r.eventType === 'game.completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({
        roomId: roomState.room.id,
        playerId: 'db-player-1',
        payload: expect.objectContaining({ winnerName: 'Alice', endReason: 'natural' }),
      });
    });

    it('should skip concurrent resolveGameTurn calls for the same room (race condition guard)', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      await Promise.all([
        engine.resolveGameTurn(roomState.room.id),
        engine.resolveGameTurn(roomState.room.id),
      ]);

      // Only one resolution should have gone through — round advances by exactly 1
      expect(roomState.room.currentPhaseRound).toBe(2);
    });

    it('should still complete and broadcast the turn even if one player\'s row disappeared mid-resolution (regression — a heartbeat-sweep/resolveGameTurn race)', async () => {
      // Simulates a player whose reconnect grace period expired (their Company/Player
      // rows deleted by finalizePlayerRemoval) at almost the exact moment this room's
      // turn was already resolving — a real race this app used to have no protection
      // against at all. Before the fix, one player's Prisma "record not found" here
      // would throw, abort the whole persistence loop, and the outer catch would
      // swallow it silently — turn:resolved/phase:changed never fire, the round timer
      // (already cleared by the caller) never restarts, and the room is stuck until
      // every client manually refreshes. Each player's persistence must be isolated.
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      const bobId = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!.id;

      const realUpdate = (mockPrisma.company.update as ReturnType<typeof vi.fn>).getMockImplementation();
      (mockPrisma.company.update as ReturnType<typeof vi.fn>).mockImplementation((args: any) => {
        if (args.where.playerId === bobId) {
          return Promise.reject(new Error('P2025: Record to update not found (simulated concurrent deletion)'));
        }
        return realUpdate ? realUpdate(args) : Promise.resolve({});
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(engine.resolveGameTurn(roomState.room.id)).resolves.not.toThrow();

      // The room still fully resolved and looped into round 2 — Bob's missing row
      // didn't take the rest of the turn down with it.
      expect(roomState.room.status).toBe(RoomStatus.GAME_PHASE);
      expect(roomState.room.currentPhaseRound).toBe(2);
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.GAME_PHASE]);

      const turnResolvedCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED,
      );
      expect(turnResolvedCalls).toHaveLength(1);

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();

      // The same failure is also logged to EventLog (severity 'error') — the admin
      // Analytics tab's Errors view surfaces exactly this class of previously-
      // console.error-only failure. See CLAUDE.md's EventLog section.
      const eventRows = getLoggedEvents(mockPrisma);
      expect(eventRows).toContainEqual(expect.objectContaining({
        eventType: 'error.persistence',
        severity: 'error',
        roomId: roomState.room.id,
        playerId: bobId,
        payload: expect.objectContaining({ context: 'resolveGameTurn:companyUpdate' }),
      }));
    });

    it('carries the annual-report blurb into the turn:resolved broadcast for an attack still sitting at investigationLevel 1 (not just right after the dig that reached it)', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                {
                  id: 'player-1',
                  name: 'Alice',
                  roomId: roomState.room.id,
                  bankrupt: false,
                  companyId: 'company-player-1',
                  company: {
                    id: 'company-player-1', playerId: 'player-1', cash: 100000, debt: 0, assets: [],
                    variables: {},
                    // Already dug once on a prior turn — this turn's own resolution (no
                    // new dig involved) must still carry the blurb through.
                    engineState: { investigations: { 'inst-1': 1 } },
                  },
                },
                {
                  id: 'player-2',
                  name: 'Bob',
                  roomId: roomState.room.id,
                  bankrupt: false,
                  companyId: 'company-player-2',
                  company: {
                    id: 'company-player-2', playerId: 'player-2', cash: 100000, debt: 0, assets: [],
                    variables: {},
                    engineState: {
                      activeDecisions: [
                        { id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 1, isMatured: true, targetId: 'player-1' },
                      ],
                    },
                  },
                },
                {
                  id: 'player-3',
                  name: 'Carol',
                  roomId: roomState.room.id,
                  bankrupt: false,
                  companyId: 'company-player-3',
                  company: { id: 'company-player-3', playerId: 'player-3', cash: 100000, debt: 0, assets: [], variables: {}, engineState: {} },
                },
              ]
            : [],
        ),
      );

      await engine.resolveGameTurn(roomState.room.id);

      const turnResolvedCall = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED,
      );
      const alice = (turnResolvedCall![1] as any).players.find((p: any) => p.playerId === 'player-1');
      const attack = alice.incomingAttacks.find((a: any) => a.attackId === 'inst-1');
      expect(attack.investigationLevel).toBe(1);
      expect(attack.decisionName).toBeUndefined();
      expect(attack.annualReportBlurb).toBe('blurb: Bot Attack');
    });

    it('persists eliminatedRound (DB write + in-memory sync) and a final KpiSnapshot for a player who naturally goes bankrupt this turn', async () => {
      // Full, valid PlayerVariables — capacityUtilization/installedCapacity: 0
      // suppresses volume/revenue entirely (this file's own established "bankruptcy-
      // determinism" pattern, see CLAUDE.md), so a deeply negative starting cash stays
      // negative regardless of this turn's ordinary P&L movement.
      const bankruptVars = {
        cash: -50000, assets: 10000, intangibleAssets: 0, debt: 0, reserves: 0,
        operatingExpenses: 5000, staffCost: 5000, materialCostPerTon: 100, otherIncome: 0,
        price: 500, capacityUtilization: 0, processingLevel: 0.5, energyIntensity: 0.5,
        moistureContent: 0.3, nutrientConsistency: 0.5, supplySecurity: 0.5,
        logisticsCostPerTon: 50, processLoss: 0.05, installedCapacity: 0,
        totalSharesOutstanding: 1000, shareOwnership: { self: 1 },
        outrage: 0, scrutiny: 0, breakdowns: 0, contaminationRisk: 0, odorComplaints: 0,
        tokenLiability: 0, carbonFootprint: 0, stockVolume: 0, demand: 0,
      };
      const solventVars = { ...bankruptVars, cash: 500000 };

      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 4;

      // Real, engine-generated ids — must match roomState.players' actual keys, or the
      // in-memory roster sync this test checks would silently no-op against a mismatch.
      const aliceRoomEntry = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!;
      const bobRoomEntry = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!;

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                { id: aliceRoomEntry.id, name: 'Alice', roomId: roomState.room.id, bankrupt: false, companyId: 'company-alice', company: { id: 'company-alice', playerId: aliceRoomEntry.id, cash: -50000, debt: 0, assets: [], variables: bankruptVars, engineState: {} } },
                { id: bobRoomEntry.id, name: 'Bob', roomId: roomState.room.id, bankrupt: false, companyId: 'company-bob', company: { id: 'company-bob', playerId: bobRoomEntry.id, cash: 500000, debt: 0, assets: [], variables: solventVars, engineState: {} } },
              ]
            : [],
        ),
      );

      await engine.resolveGameTurn(roomState.room.id);

      // DB write
      expect(mockPrisma.player.update).toHaveBeenCalledWith({
        where: { id: aliceRoomEntry.id },
        data: { bankrupt: true, eliminatedRound: 4 },
      });
      // In-memory roster sync — the pre-existing gap this feature needed fixed, since
      // the disconnect-cleanup exemption depends on this flag being accurate.
      expect(aliceRoomEntry.bankrupt).toBe(true);
      expect(aliceRoomEntry.eliminatedRound).toBe(4);

      // Final KpiSnapshot — persistKpiSnapshots excludes eliminated players entirely, so
      // this has to be a separate upsert call using BankruptedPlayer's own captured
      // finalVariables/finalDerived/finalRiskGauge.
      const kpiUpsertCalls = (mockPrisma.kpiSnapshot.upsert as ReturnType<typeof vi.fn>).mock.calls;
      const aliceFinalSnapshot = kpiUpsertCalls.find((call: any) => call[0].where.playerId_round.playerId === aliceRoomEntry.id);
      expect(aliceFinalSnapshot).toBeDefined();
      expect(aliceFinalSnapshot![0].where.playerId_round.round).toBe(4);
      expect(aliceFinalSnapshot![0].create.variables.cash).toBeLessThan(0);
      expect(typeof aliceFinalSnapshot![0].create.riskGauge).toBe('number');
    });
  });

  describe('toggleReady', () => {
    it('should return null outside GAME_PHASE', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const playerId = Array.from(roomState.players.values())[0].id;

      expect(engine.toggleReady(roomState.room.id, playerId, true)).toBeNull();
    });

    it('should return null for an unknown player', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      roomState.room.status = RoomStatus.GAME_PHASE;

      expect(engine.toggleReady(roomState.room.id, 'not-a-real-player', true)).toBeNull();
    });

    it('should return null for an already-bankrupt player', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const playerId = Array.from(roomState.players.values())[0].id;
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.players.get(playerId)!.bankrupt = true;

      expect(engine.toggleReady(roomState.room.id, playerId, true)).toBeNull();
    });

    it('should add the player to readyPlayerIds and report activePlayerCount', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      const result = engine.toggleReady(roomState.room.id, aliceId, true);

      expect(result).toEqual({ readyPlayerIds: [aliceId], activePlayerCount: 2 });
    });

    it('should remove the player from readyPlayerIds when un-readying', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const aliceId = Array.from(roomState.players.values())[0].id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      engine.toggleReady(roomState.room.id, aliceId, true);
      const result = engine.toggleReady(roomState.room.id, aliceId, false);

      expect(result).toEqual({ readyPlayerIds: [], activePlayerCount: 1 });
    });

    it('should exclude bankrupt players from activePlayerCount', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const bobRoomState = await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      const bobId = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.players.get(bobId)!.bankrupt = true;

      const result = engine.toggleReady(roomState.room.id, aliceId, true);

      expect(result).toEqual({ readyPlayerIds: [aliceId], activePlayerCount: 1 });
    });
  });

  describe('resolveGameTurn — ready reset', () => {
    it('should clear readyPlayerIds and broadcast an empty game:readyUpdate for the next round', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;
      roomState.readyPlayerIds.add(aliceId);

      await engine.resolveGameTurn(roomState.room.id);

      expect(roomState.readyPlayerIds.size).toBe(0);
      const readyUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_READY_UPDATE,
      );
      expect(readyUpdateCalls.length).toBeGreaterThan(0);
      expect(readyUpdateCalls[readyUpdateCalls.length - 1][1]).toEqual({ readyPlayerIds: [], activePlayerCount: 2 });
    });
  });

  describe('forfeitGame — ready interaction', () => {
    it('should drop the forfeiting player from readyPlayerIds and signal immediate resolution once everyone remaining is ready', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const bobRoomState = await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Carol', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-3' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      const bobId = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!.id;
      const carolId = Array.from(roomState.players.values()).find((p) => p.name === 'Carol')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      // Bob and Carol are both ready; Alice (about to forfeit) never clicked ready.
      roomState.readyPlayerIds.add(bobId);
      roomState.readyPlayerIds.add(carolId);

      // Two players remain non-bankrupt after Alice forfeits.
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id && where?.bankrupt === false
            ? [{ id: bobId }, { id: carolId }]
            : [],
        ),
      );

      const result = await engine.forfeitGame(roomState.room.id, aliceId);

      expect(result).toEqual({ success: true, triggerImmediateResolution: true });
      expect(roomState.readyPlayerIds.has(aliceId)).toBe(false);
    });

    it('persists eliminatedRound (DB write + in-memory sync) for the forfeiting player', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Carol', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-3' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      const bobId = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!.id;
      const carolId = Array.from(roomState.players.values()).find((p) => p.name === 'Carol')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 4;

      // Two players remain active after Alice forfeits — avoids the "only one left"
      // game-over branch (buildGameOverPayload), which isn't what this test is about.
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(where?.roomId === roomState.room.id && where?.bankrupt === false ? [{ id: bobId }, { id: carolId }] : []),
      );

      await engine.forfeitGame(roomState.room.id, aliceId);

      expect(mockPrisma.player.update).toHaveBeenCalledWith({
        where: { id: aliceId },
        data: { bankrupt: true, eliminatedRound: 4 },
      });
      expect(roomState.players.get(aliceId)!.eliminatedRound).toBe(4);

      // See CLAUDE.md's EventLog section — a forfeit is one of the three
      // player.eliminated reasons (bankruptcy/merger/forfeit), logged the same way
      // regardless of which one it is.
      const eventRows = getLoggedEvents(mockPrisma);
      expect(eventRows).toContainEqual(expect.objectContaining({
        eventType: 'player.eliminated',
        roomId: roomState.room.id,
        playerId: aliceId,
        payload: expect.objectContaining({ reason: 'forfeit', round: 4 }),
      }));
    });

    // Regression: a forfeit used to broadcast `player:bankrupt` with no `reason` field at
    // all, which every other still-in-the-game player's client folded into the generic
    // "gone bankrupt" BankruptcyModal copy — indistinguishable from a natural cash<0
    // elimination. `reason: 'forfeit'` is what lets those other players' modal instead
    // read "X chickened out" with its own art. See CLAUDE.md.
    it('broadcasts player:bankrupt with reason: \'forfeit\' for everyone else in the room', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Carol', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-3' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      const bobId = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!.id;
      const carolId = Array.from(roomState.players.values()).find((p) => p.name === 'Carol')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(where?.roomId === roomState.room.id && where?.bankrupt === false ? [{ id: bobId }, { id: carolId }] : []),
      );

      await engine.forfeitGame(roomState.room.id, aliceId);

      expect(mockIo.to).toHaveBeenCalledWith(roomState.room.id);
      expect(mockIo.emit).toHaveBeenCalledWith(
        ServerEvents.PLAYER_BANKRUPT,
        expect.objectContaining({ playerId: aliceId, playerName: 'Alice', reason: 'forfeit' }),
      );
    });

    it('should not signal immediate resolution while a remaining active player still isn\'t ready', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const bobRoomState = await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Carol', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-3' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      const bobId = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!.id;
      const carolId = Array.from(roomState.players.values()).find((p) => p.name === 'Carol')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      // Only Bob is ready — Carol is not.
      roomState.readyPlayerIds.add(bobId);

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id && where?.bankrupt === false
            ? [{ id: bobId }, { id: carolId }]
            : [],
        ),
      );

      const result = await engine.forfeitGame(roomState.room.id, aliceId);

      expect(result).toEqual({ success: true, triggerImmediateResolution: false });
    });

    // Regression: getGameTimeline() reads winnerId from the same lastTurnResults cache
    // every normal resolveGameTurn call keeps current — but a forfeit that itself ends
    // the game (last player standing) never goes through resolveGameTurn at all, so
    // without forfeitGame also updating that cache, the finished-game replay's win
    // badge/art never appears for a forfeit-ended game. Found while verifying the Game
    // Over screen's new art actually renders after a real forfeit, not just a natural
    // elimination during a normal turn.
    it('updates the lastTurnResults cache so getGameTimeline reports the right winner after a forfeit ends the game', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      const bobId = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) => {
        if (where?.roomId === roomState.room.id && where?.bankrupt === false) {
          return Promise.resolve([{ id: bobId }]); // only Bob remains after Alice forfeits
        }
        if (where?.roomId === roomState.room.id) {
          return Promise.resolve([
            { id: aliceId, name: 'Alice', roomId: roomState.room.id, bankrupt: true, eliminatedRound: 1, company: { id: 'c1', playerId: aliceId, cash: 0, debt: 0, assets: [], engineState: {} } },
            { id: bobId, name: 'Bob', roomId: roomState.room.id, bankrupt: false, eliminatedRound: null, company: { id: 'c2', playerId: bobId, cash: 100000, debt: 0, assets: [], engineState: {} } },
          ]);
        }
        return Promise.resolve([]);
      });

      await engine.forfeitGame(roomState.room.id, aliceId);

      const timeline = await engine.getGameTimeline(roomState.room.id);

      expect(timeline).not.toBeNull();
      expect(timeline!.gameOver).toBe(true);
      expect(timeline!.winnerId).toBe(bobId);

      // See CLAUDE.md's EventLog section — logged once, right at forfeitGame's own
      // game-ending branch, with endReason: 'forfeit' distinguishing it from a natural
      // resolveGameTurn-driven completion. getGameTimeline (a read-only reconnect/replay
      // path) must not have triggered a second one.
      const eventRows = getLoggedEvents(mockPrisma);
      const completedEvents = eventRows.filter((r: any) => r.eventType === 'game.completed');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({
        roomId: roomState.room.id,
        playerId: bobId,
        payload: expect.objectContaining({ winnerName: 'Bob', endReason: 'forfeit' }),
      });
    });
  });

  describe('submitDecisions', () => {
    it('should forward validated decisions to the game loop for the room', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const playerId = Array.from(roomState.players.values())[0].id;

      engine.submitDecisions(roomState.room.id, playerId, { strategic: [{ name: 'New Factory' }], operational: [], financial: [], lawsuits: [] });

      // No direct getter for submissions, but resolving the turn should not throw
      // and should reflect the submission was accepted without error.
      roomState.room.status = RoomStatus.GAME_PHASE;
      await expect(engine.resolveGameTurn(roomState.room.id)).resolves.not.toThrow();
    });

    it('silently drops a decision naming something outside this game\'s fixed decision set, but still deploys one that is in it (regression)', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.startGame(roomState.room.id);
      const [aliceId] = Array.from(roomState.players.keys());

      const included = engine.getDecisionsSnapshot().find((d) => roomState.decisionSubset.includes(d.decision) && d.level === 'Operational')!;
      const excluded = engine.getDecisionsSnapshot().find((d) => !roomState.decisionSubset.includes(d.decision))!;
      expect(excluded).toBeDefined(); // sanity: the library is bigger than the 50-decision draw

      engine.submitDecisions(roomState.room.id, aliceId, {
        strategic: [], operational: [{ name: included.decision }, { name: excluded.decision }], financial: [], lawsuits: [],
      });

      await engine.resolveGameTurn(roomState.room.id);

      // .filter().pop() — not .find() — since startGame's own initial-snapshot
      // broadcast already emitted one earlier (empty-decisions) TURN_RESOLVED; the
      // one from this resolveGameTurn call (the one that actually reflects the
      // submission above) is the LAST one emitted.
      const turnResolvedCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED,
      );
      const alice = (turnResolvedCalls.pop()![1] as any).players.find((p: any) => p.playerId === aliceId);
      const deployedNames = alice.activeDecisions.map((d: any) => d.decisionName);
      expect(deployedNames).toContain(included.decision);
      expect(deployedNames).not.toContain(excluded.decision);
    });

    it('silently drops a lawsuit citing a decision outside this game\'s fixed decision set (regression)', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.startGame(roomState.room.id);
      const [aliceId, bobId] = Array.from(roomState.players.keys());

      const excluded = engine.getDecisionsSnapshot().find((d) => !roomState.decisionSubset.includes(d.decision) && (d.legalRisks?.length ?? 0) > 0)!;
      expect(excluded).toBeDefined();

      engine.submitDecisions(roomState.room.id, aliceId, {
        strategic: [], operational: [], financial: [],
        lawsuits: [{ targetId: bobId, decisionName: excluded.decision, groundName: excluded.legalRisks![0].name }],
      });

      await engine.resolveGameTurn(roomState.room.id);

      // .filter().pop() — see the sibling test above for why not .find().
      const turnResolvedCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED,
      );
      const alice = (turnResolvedCalls.pop()![1] as any).players.find((p: any) => p.playerId === aliceId);
      expect(alice.legalCases.some((c: any) => c.decisionName === excluded.decision)).toBe(false);
    });
  });

  describe('broadcastInitialSnapshot', () => {
    it('should broadcast turn:resolved with starting values immediately, without waiting for a real round', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);

      await engine.broadcastInitialSnapshot(roomState.room.id, 1);

      const turnResolvedCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED,
      );
      expect(turnResolvedCalls).toHaveLength(1);
      const payload = turnResolvedCalls[0][1] as any;
      expect(payload.round).toBe(1);
      expect(payload.gameOver).toBe(false);
      expect(payload.players).toHaveLength(1);
      expect(payload.players[0].activeDecisions).toEqual([]);
    });

    it('should persist a KpiSnapshot row for round 1 for every player in the snapshot', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);

      await engine.broadcastInitialSnapshot(roomState.room.id, 1);

      expect(mockPrisma.kpiSnapshot!.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { playerId_round: { playerId: expect.any(String), round: 1 } },
        }),
      );
    });
  });

  describe('startGame', () => {
    async function makeTwoPlayerWaitingRoom() {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const joiner = { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' };
      await engine.joinRoom(roomState.room.id, joiner);
      return roomState;
    }

    it('enters GAME_PHASE round 1 and broadcasts the initial snapshot, ready update, and deck', async () => {
      const roomState = await makeTwoPlayerWaitingRoom();

      await engine.startGame(roomState.room.id);

      expect(roomState.room.status).toBe(RoomStatus.GAME_PHASE);
      expect(roomState.room.currentPhaseRound).toBe(1);
      expect(roomState.readyPlayerIds.size).toBe(0);

      const calls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
      expect(calls.some((c) => c[0] === ServerEvents.TURN_RESOLVED)).toBe(true);
      expect(calls.some((c) => c[0] === ServerEvents.PHASE_CHANGED)).toBe(true);
      expect(calls.some((c) => c[0] === ServerEvents.GAME_READY_UPDATE)).toBe(true);
      expect(calls.some((c) => c[0] === ServerEvents.GAME_DECK)).toBe(true);
    });

    it('stamps the initial-snapshot TURN_RESOLVED payload with isInitialSnapshot: true (regression — round 1\'s real resolveTurn result later carries the SAME round number, and the client needs this flag to tell the two apart rather than silently discarding round 1\'s real decisions; see GamePhase.tsx\'s processedTurnKeyRef)', async () => {
      const roomState = await makeTwoPlayerWaitingRoom();

      await engine.startGame(roomState.room.id);

      const calls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
      const turnResolvedCall = calls.find((c) => c[0] === ServerEvents.TURN_RESOLVED)!;
      expect((turnResolvedCall[1] as { isInitialSnapshot?: boolean }).isInitialSnapshot).toBe(true);
    });

    it('broadcasts TURN_RESOLVED (the initial snapshot) BEFORE PHASE_CHANGED (regression — a fast client readying up on PHASE_CHANGED must never be able to race past the initial snapshot)', async () => {
      const roomState = await makeTwoPlayerWaitingRoom();

      await engine.startGame(roomState.room.id);

      const calls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
      const turnResolvedIndex = calls.findIndex((c) => c[0] === ServerEvents.TURN_RESOLVED);
      const phaseChangedIndex = calls.findIndex((c) => c[0] === ServerEvents.PHASE_CHANGED);

      expect(turnResolvedIndex).toBeGreaterThanOrEqual(0);
      expect(phaseChangedIndex).toBeGreaterThanOrEqual(0);
      expect(turnResolvedIndex).toBeLessThan(phaseChangedIndex);
    });

    it('is a no-op for a room id that does not exist', async () => {
      await expect(engine.startGame('nonexistent-room')).resolves.toBeUndefined();
      expect(mockIo.emit).not.toHaveBeenCalled();
    });

    it('picks a fixed random decision set (48 + every share-transaction decision) and broadcasts exactly that set as the deck (regression)', async () => {
      const roomState = await makeTwoPlayerWaitingRoom();
      const fullLibrary = engine.getDecisionsSnapshot();
      const shareDecisionNames = fullLibrary.filter((d) => !!d.shareTransactionType).map((d) => d.decision);
      expect(shareDecisionNames.length).toBeGreaterThan(0); // sanity: the seed data actually has Buy/Sell Shares

      await engine.startGame(roomState.room.id);

      expect(roomState.decisionSubset).toHaveLength(48 + shareDecisionNames.length);
      // Every share-transaction decision must be present, regardless of the random draw.
      for (const name of shareDecisionNames) expect(roomState.decisionSubset).toContain(name);
      // No duplicates, and every name is a real decision from the full library.
      expect(new Set(roomState.decisionSubset).size).toBe(roomState.decisionSubset.length);
      const fullNames = new Set(fullLibrary.map((d) => d.decision));
      for (const name of roomState.decisionSubset) expect(fullNames.has(name)).toBe(true);

      const calls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls as [string, ...unknown[]][];
      const deckCall = calls.find((c) => c[0] === ServerEvents.GAME_DECK)!;
      const deckPayload = deckCall[1] as { decisions: { decision: string }[] };
      expect(deckPayload.decisions.map((d) => d.decision).sort()).toEqual([...roomState.decisionSubset].sort());
    });

    it('gives two different rooms different random decision sets (not deterministic/identical every game)', async () => {
      const roomA = await makeTwoPlayerWaitingRoom();
      const roomB = await makeTwoPlayerWaitingRoom();

      await engine.startGame(roomA.room.id);
      await engine.startGame(roomB.room.id);

      // Not a hard guarantee for any single seed, but with a large library and a
      // random draw of 48, two independent draws being byte-for-byte identical is
      // astronomically unlikely — a real regression (e.g. reverting to "always the
      // first 48") would fail this reliably.
      expect(roomA.decisionSubset.slice().sort()).not.toEqual(roomB.decisionSubset.slice().sort());
    });

    it('a mid-game rejoin resends the exact same decision set the game started with (fixed per game, regression)', async () => {
      const roomState = await makeTwoPlayerWaitingRoom();
      await engine.startGame(roomState.room.id);
      const startingSubset = [...roomState.decisionSubset].sort();

      const [aliceId] = Array.from(roomState.players.keys());
      await engine.markPlayerDisconnected('socket-1');
      const result = await engine.rejoinRoom(roomState.room.id, aliceId, 'socket-1-new');

      expect(result.success).toBe(true);
      if (!result.success) return;
      const rejoinedNames = result.gameDeck!.decisions.map((d) => d.decision).sort();
      expect(rejoinedNames).toEqual(startingSubset);
    });
  });

  describe('makeOffer / acceptOffer / goToCourt', () => {
    /** A negotiating case between two real room players — `player.findMany` overridden
     * to carry `company.variables`/`engineState` (the default mock company fixture, per
     * `createMockPrisma`, only has `cash`/`debt`/`assets`), since these are the fields
     * GameLoop's pure makeOffer/acceptOffer/goToCourt methods actually read. */
    async function makeTwoPartyCaseRoom() {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;

      const [aliceId, bobId] = Array.from(roomState.players.keys());
      const case_ = {
        id: 'case-1',
        roomId: roomState.room.id,
        plaintiffId: bobId,
        defendantId: aliceId,
        decisionName: 'Water Pumping',
        groundName: 'Environmental Violation',
        description: 'Sue for environmental damage',
        baseProbability: 0.12,
        stakes: 20000,
        status: 'negotiating' as const,
        offers: [] as Array<{ by: 'plaintiff' | 'defendant'; amount: number }>,
        turnsNegotiating: 0,
        createdAt: new Date(),
      };

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                {
                  id: aliceId,
                  name: 'Alice',
                  roomId: roomState.room.id,
                  bankrupt: false,
                  company: { variables: { cash: 100000 }, engineState: { legalCases: [case_] } },
                },
                {
                  id: bobId,
                  name: 'Bob',
                  roomId: roomState.room.id,
                  bankrupt: false,
                  company: { variables: { cash: 50000 }, engineState: { legalCases: [case_] } },
                },
              ]
            : [],
        ),
      );

      return { roomState, aliceId, bobId };
    }

    it('makeOffer persists both parties\' Company rows and emits the update to both sockets', async () => {
      const { roomState, aliceId } = await makeTwoPartyCaseRoom();

      const outcome = await engine.makeOffer(roomState.room.id, aliceId, 'case-1', 10000);

      expect(outcome.success).toBe(true);
      expect(mockPrisma.company.update).toHaveBeenCalledTimes(2);
      const emittedTo = (mockIo.to as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(emittedTo).toEqual(expect.arrayContaining(['socket-1', 'socket-2']));
      const legalCaseUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_LEGAL_CASE_UPDATE,
      );
      expect(legalCaseUpdateCalls).toHaveLength(2);
      // An offer never moves cash — neither recipient gets a newCash figure.
      for (const call of legalCaseUpdateCalls) {
        expect((call[1] as any).newCash).toBeUndefined();
        expect((call[1] as any).case.offers).toEqual([{ by: 'defendant', amount: 10000 }]);
      }
    });

    it('acceptOffer settles the case and gives each recipient their OWN new cash figure, not the other party\'s', async () => {
      const { roomState, aliceId, bobId } = await makeTwoPartyCaseRoom();
      // Seed a pending offer directly, bypassing a real makeOffer call.
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                { id: aliceId, name: 'Alice', roomId: roomState.room.id, bankrupt: false, company: { variables: { cash: 100000 }, engineState: { legalCases: [{ id: 'case-1', roomId: roomState.room.id, plaintiffId: bobId, defendantId: aliceId, decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', baseProbability: 0.12, stakes: 20000, status: 'negotiating', offers: [{ by: 'defendant', amount: 10000 }], turnsNegotiating: 0, createdAt: new Date() }] } } },
                { id: bobId, name: 'Bob', roomId: roomState.room.id, bankrupt: false, company: { variables: { cash: 50000 }, engineState: { legalCases: [{ id: 'case-1', roomId: roomState.room.id, plaintiffId: bobId, defendantId: aliceId, decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', baseProbability: 0.12, stakes: 20000, status: 'negotiating', offers: [{ by: 'defendant', amount: 10000 }], turnsNegotiating: 0, createdAt: new Date() }] } } },
              ]
            : [],
        ),
      );

      const outcome = await engine.acceptOffer(roomState.room.id, bobId, 'case-1');

      expect(outcome.success).toBe(true);
      const legalCaseUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_LEGAL_CASE_UPDATE,
      );
      expect(legalCaseUpdateCalls).toHaveLength(2);
      const newCashValues = legalCaseUpdateCalls.map((call) => (call[1] as any).newCash).sort((a, b) => a - b);
      // Alice (defendant, started at 100000) pays 10000 -> 90000; Bob (plaintiff, started
      // at 50000) receives it -> 60000. Each socket gets only its own figure.
      expect(newCashValues).toEqual([60000, 90000]);
    });

    it('acceptOffer also records the resolution in LegalCaseHistory — the one out-of-band case action that can resolve a case outside resolveTurn', async () => {
      const { roomState, aliceId, bobId } = await makeTwoPartyCaseRoom();
      roomState.room.currentPhaseRound = 7;
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                { id: aliceId, name: 'Alice', roomId: roomState.room.id, bankrupt: false, company: { variables: { cash: 100000 }, engineState: { legalCases: [{ id: 'case-1', roomId: roomState.room.id, plaintiffId: bobId, defendantId: aliceId, decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', baseProbability: 0.12, stakes: 20000, status: 'negotiating', offers: [{ by: 'defendant', amount: 10000 }], turnsNegotiating: 0, createdAt: new Date() }] } } },
                { id: bobId, name: 'Bob', roomId: roomState.room.id, bankrupt: false, company: { variables: { cash: 50000 }, engineState: { legalCases: [{ id: 'case-1', roomId: roomState.room.id, plaintiffId: bobId, defendantId: aliceId, decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', baseProbability: 0.12, stakes: 20000, status: 'negotiating', offers: [{ by: 'defendant', amount: 10000 }], turnsNegotiating: 0, createdAt: new Date() }] } } },
              ]
            : [],
        ),
      );

      // Pre-seed the LegalCaseHistory row exactly as persistLegalCaseHistory would have
      // when the case was originally filed (a prior turn) — acceptOffer's defensive
      // `create` branch is not expected to run in practice since filing always happens
      // via resolveTurn first.
      (mockPrisma.legalCaseHistory as any)._rows.set('case-1', {
        id: 'case-1', roomId: roomState.room.id, plaintiffId: bobId, plaintiffName: 'Bob', defendantId: aliceId, defendantName: 'Alice',
        decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', stakes: 20000, filedRound: 3, resolvedRound: null, verdict: null,
      });

      await engine.acceptOffer(roomState.room.id, bobId, 'case-1');

      const row = (mockPrisma.legalCaseHistory as any)._rows.get('case-1');
      expect(row.resolvedRound).toBe(7);
      expect(row.verdict).toBe('settled');
      // The original filedRound is untouched by the resolution write.
      expect(row.filedRound).toBe(3);
      // The actual accepted offer amount (10000), not the pre-trial stakes estimate
      // (20000) — a real, reported gap: the game-timeline replay had no way to show what
      // a settlement actually resolved for.
      expect(row.resolvedAmount).toBe(10000);
    });

    it('goToCourt marks the case awaiting_trial and moves no cash', async () => {
      const { roomState, aliceId } = await makeTwoPartyCaseRoom();

      const outcome = await engine.goToCourt(roomState.room.id, aliceId, 'case-1');

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.status).toBe('awaiting_trial');
      const legalCaseUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_LEGAL_CASE_UPDATE,
      );
      for (const call of legalCaseUpdateCalls) {
        expect((call[1] as any).newCash).toBeUndefined();
      }
    });

    it('does not write to the DB or emit anything on a validation failure (e.g. not this player\'s turn)', async () => {
      const { roomState, bobId } = await makeTwoPartyCaseRoom();

      // Plaintiff (Bob) tries to make the opening offer — only the defendant may move first.
      const outcome = await engine.makeOffer(roomState.room.id, bobId, 'case-1', 10000);

      expect(outcome).toEqual({ success: false, reason: 'not_your_turn' });
      expect(mockPrisma.company.update).not.toHaveBeenCalled();
      const legalCaseUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_LEGAL_CASE_UPDATE,
      );
      expect(legalCaseUpdateCalls).toHaveLength(0);
    });

    it('rejects makeOffer/acceptOffer/goToCourt/digDeeperOnCase with turn_resolving while this room\'s turn is mid-resolution, then allows them again once it finishes (regression — a real, reported bug where goToCourt landing at the same moment a turn resolved could be silently overwritten by that turn\'s own stale-offer auto-settle)', async () => {
      const { roomState, aliceId, bobId } = await makeTwoPartyCaseRoom();
      roomState.room.currentPhaseRound = 1;

      // Block resolveGameTurn's per-player persistence mid-flight, so it stays inside
      // its advancingRooms-held critical section for as long as this test needs — same
      // technique as the player-removal race regression test above.
      let releaseUpdate: () => void = () => {};
      const blocker = new Promise<void>((resolve) => { releaseUpdate = resolve; });
      (mockPrisma.company.update as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await blocker;
        return {};
      });

      const turnPromise = engine.resolveGameTurn(roomState.room.id);

      // All four negotiation actions must reject outright — before touching the DB —
      // while the lock is held, regardless of which player or case action.
      await expect(engine.makeOffer(roomState.room.id, aliceId, 'case-1', 5000))
        .resolves.toEqual({ success: false, reason: 'turn_resolving' });
      await expect(engine.acceptOffer(roomState.room.id, bobId, 'case-1'))
        .resolves.toEqual({ success: false, reason: 'turn_resolving' });
      await expect(engine.goToCourt(roomState.room.id, aliceId, 'case-1'))
        .resolves.toEqual({ success: false, reason: 'turn_resolving' });
      await expect(engine.digDeeperOnCase(roomState.room.id, aliceId, 'case-1'))
        .resolves.toEqual({ success: false, reason: 'turn_resolving' });

      // Let resolveGameTurn finish and release the lock.
      releaseUpdate();
      await turnPromise;

      // Once the lock is free, the exact same call succeeds normally again.
      const outcome = await engine.goToCourt(roomState.room.id, aliceId, 'case-1');
      expect(outcome.success).toBe(true);
    });

    it('logs a case.negotiation_action event for a successful makeOffer, capturing the case state immediately before the call', async () => {
      const { roomState, aliceId } = await makeTwoPartyCaseRoom();

      await engine.makeOffer(roomState.room.id, aliceId, 'case-1', 5000);

      const events = getLoggedEvents(mockPrisma).filter((e) => e.eventType === 'case.negotiation_action');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          severity: 'info',
          roomId: roomState.room.id,
          playerId: aliceId,
          payload: expect.objectContaining({
            action: 'makeOffer',
            caseId: 'case-1',
            success: true,
            amount: 5000,
            beforeOffers: [],
            afterOffers: [{ by: 'defendant', amount: 5000 }],
          }),
        }),
      );
    });

    it('logs a case.negotiation_action event for a rejected action too, including the reason and the case state that caused it', async () => {
      const { roomState, bobId } = await makeTwoPartyCaseRoom();

      // Plaintiff (Bob) tries to make the opening offer — only the defendant may move first.
      await engine.makeOffer(roomState.room.id, bobId, 'case-1', 10000);

      const events = getLoggedEvents(mockPrisma).filter((e) => e.eventType === 'case.negotiation_action');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          severity: 'warning',
          playerId: bobId,
          payload: expect.objectContaining({
            action: 'makeOffer',
            success: false,
            reason: 'not_your_turn',
            beforeOffers: [],
          }),
        }),
      );
    });

    it('logs turn_resolving rejections too, even though there is no case snapshot available for them', async () => {
      const { roomState, aliceId } = await makeTwoPartyCaseRoom();
      let releaseUpdate: () => void = () => {};
      const blocker = new Promise<void>((resolve) => { releaseUpdate = resolve; });
      (mockPrisma.company.update as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await blocker;
        return {};
      });
      const turnPromise = engine.resolveGameTurn(roomState.room.id);

      await engine.goToCourt(roomState.room.id, aliceId, 'case-1');

      releaseUpdate();
      await turnPromise;

      const events = getLoggedEvents(mockPrisma).filter((e) => e.eventType === 'case.negotiation_action');
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ action: 'goToCourt', success: false, reason: 'turn_resolving', beforeOffers: undefined }),
          }),
        ]),
      );
    });
  });

  describe('getKpiHistory', () => {
    it('returns this player\'s persisted history (oldest round first) plus a 3-turn prediction, tagged with their own playerId', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const aliceId = Array.from(roomState.players.keys())[0];
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 2;

      (mockPrisma.kpiSnapshot!.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { round: 1, variables: {}, derived: {}, riskGauge: 5 },
      ]);

      const response = await engine.getKpiHistory(roomState.room.id, aliceId, true);

      expect(response).not.toBeNull();
      expect(response!.playerId).toBe(aliceId);
      expect(response!.history).toEqual([{ round: 1, variables: {}, derived: {}, riskGauge: 5 }]);
      expect(Array.isArray(response!.predicted)).toBe(true);
    });

    it('returns only real history for a rival lookup — no prediction is ever run', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const rivalId = 'rival-player-id';
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 2;

      (mockPrisma.kpiSnapshot!.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { round: 1, variables: {}, derived: {}, riskGauge: 3 },
      ]);

      const response = await engine.getKpiHistory(roomState.room.id, rivalId, false);

      expect(response).not.toBeNull();
      expect(response!.playerId).toBe(rivalId);
      expect(response!.history).toEqual([{ round: 1, variables: {}, derived: {}, riskGauge: 3 }]);
      expect(response!.predicted).toEqual([]);
      expect(response!.bankruptAtRound).toBeUndefined();
      expect(mockPrisma.kpiSnapshot!.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { playerId: rivalId, player: { roomId: roomState.room.id } } }),
      );
    });

    it('returns null for a room that does not exist', async () => {
      const response = await engine.getKpiHistory('nonexistent-room', 'player-1', true);

      expect(response).toBeNull();
    });
  });

  describe('persistLegalCaseHistory (via resolveGameTurn)', () => {
    it('records a lawsuit filed and resolved (stale-offer auto-settle) within the same real turn', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 5;
      const [aliceId, bobId] = Array.from(roomState.players.keys());

      // Genuine back-and-forth (defendant opened, plaintiff countered) left pending from
      // a prior turn — Step 8b's "leave a standing offer hanging" rule treats this as
      // accepted the moment a new turn boundary hits, regardless of turnsNegotiating,
      // settling the case this same turn. A SINGLE one-sided offer no longer auto-settles
      // this way (see gameLoop.test.ts's own regression coverage) — this fixture needs
      // real back-and-forth to exercise this path.
      const case_ = {
        id: 'case-history-1', roomId: roomState.room.id, plaintiffId: bobId, defendantId: aliceId,
        decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'Sue for environmental damage',
        baseProbability: 0.12, plaintiffFullyInvestigated: true, stakes: 15000, status: 'negotiating' as const,
        offers: [{ by: 'defendant' as const, amount: 8000 }, { by: 'plaintiff' as const, amount: 12000 }], turnsNegotiating: 1, createdAt: new Date(),
      };

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                { id: aliceId, name: 'Alice', roomId: roomState.room.id, bankrupt: false, companyId: 'c-alice', company: { id: 'c-alice', playerId: aliceId, cash: 100000, debt: 0, assets: [], variables: {}, engineState: { legalCases: [case_] } } },
                { id: bobId, name: 'Bob', roomId: roomState.room.id, bankrupt: false, companyId: 'c-bob', company: { id: 'c-bob', playerId: bobId, cash: 50000, debt: 0, assets: [], variables: {}, engineState: { legalCases: [case_] } } },
              ]
            : [],
        ),
      );

      await engine.resolveGameTurn(roomState.room.id);

      const row = (mockPrisma.legalCaseHistory as any)._rows.get('case-history-1');
      expect(row).toBeDefined();
      expect(row.plaintiffId).toBe(bobId);
      expect(row.plaintiffName).toBe('Bob');
      expect(row.defendantId).toBe(aliceId);
      expect(row.defendantName).toBe('Alice');
      expect(row.filedRound).toBe(5);
      expect(row.resolvedRound).toBe(5);
      expect(row.verdict).toBe('settled');
      // The plaintiff's own known odds at filing time, stamped once into history.
      expect(row.baseProbability).toBe(0.12);
      expect(row.plaintiffFullyInvestigated).toBe(true);
      // The stale standing offer's own amount (the plaintiff's counter, 12000), not the
      // pre-trial stakes estimate (15000).
      expect(row.resolvedAmount).toBe(12000);
    });

    it('does not write any history row for a turn with no legal cases at all', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      roomState.room.status = RoomStatus.GAME_PHASE;

      await engine.resolveGameTurn(roomState.room.id);

      expect(mockPrisma.legalCaseHistory!.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getGameTimeline', () => {
    it('returns null for a room that does not exist', async () => {
      const response = await engine.getGameTimeline('nonexistent-room');
      expect(response).toBeNull();
    });

    it('includes every player regardless of bankrupt status, grouped KPI history, decisions derived from engineState, and lawsuits from LegalCaseHistory', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 6;
      const [aliceId, bobId] = Array.from(roomState.players.keys());

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                {
                  id: aliceId, name: 'Alice', roomId: roomState.room.id, bankrupt: false, eliminatedRound: null,
                  company: { engineState: { activeDecisions: [{ id: 'inst-1', definitionName: 'New Factory', deployedYear: 2, elapsedYears: 4, isMatured: true, voidedByLawsuit: false }] } },
                },
                {
                  id: bobId, name: 'Bob', roomId: roomState.room.id, bankrupt: true, eliminatedRound: 4,
                  company: { engineState: { activeDecisions: [] } },
                },
              ]
            : [],
        ),
      );
      (mockPrisma.kpiSnapshot!.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { playerId: aliceId, round: 1, variables: {}, derived: {}, riskGauge: 5 },
        { playerId: aliceId, round: 2, variables: {}, derived: {}, riskGauge: 6 },
        { playerId: bobId, round: 1, variables: {}, derived: {}, riskGauge: 2 },
      ]);
      (mockPrisma.legalCaseHistory as any)._rows.set('case-tl-1', {
        id: 'case-tl-1', roomId: roomState.room.id, plaintiffId: aliceId, plaintiffName: 'Alice', defendantId: bobId, defendantName: 'Bob',
        decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', stakes: 12000, filedRound: 3, resolvedRound: 4, verdict: 'won',
        baseProbability: 0.72, plaintiffFullyInvestigated: true, resolvedAmount: 12000,
      });

      const response = await engine.getGameTimeline(roomState.room.id);

      expect(response).not.toBeNull();
      expect(response!.currentRound).toBe(6);
      expect(response!.players).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ playerId: aliceId, playerName: 'Alice', bankrupt: false, eliminatedRound: undefined }),
          expect.objectContaining({ playerId: bobId, playerName: 'Bob', bankrupt: true, eliminatedRound: 4 }),
        ]),
      );
      expect(response!.kpiHistory[aliceId]).toHaveLength(2);
      expect(response!.kpiHistory[bobId]).toHaveLength(1);
      expect(response!.decisions).toEqual([
        { instanceId: 'inst-1', playerId: aliceId, decisionName: 'New Factory', deployedYear: 2, targetId: undefined, voidedByLawsuit: false },
      ]);
      expect(response!.lawsuits).toEqual([
        expect.objectContaining({ id: 'case-tl-1', plaintiffName: 'Alice', defendantName: 'Bob', filedRound: 3, resolvedRound: 4, verdict: 'won' }),
      ]);
      // The plaintiff's own known odds at filing time — stamped once, never recomputed.
      expect(response!.lawsuits[0].baseProbability).toBe(0.72);
      expect(response!.lawsuits[0].plaintiffFullyInvestigated).toBe(true);
      expect(response!.lawsuits[0].resolvedAmount).toBe(12000);
    });

    it('maps a missing resolvedAmount (a row from before this column existed) to undefined, not NaN', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      roomState.room.status = RoomStatus.GAME_PHASE;
      const [aliceId] = Array.from(roomState.players.keys());

      (mockPrisma.legalCaseHistory as any)._rows.set('case-legacy-1', {
        id: 'case-legacy-1', roomId: roomState.room.id, plaintiffId: aliceId, plaintiffName: 'Alice', defendantId: 'bob', defendantName: 'Bob',
        decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', stakes: 9000, filedRound: 1, resolvedRound: 2, verdict: 'lost',
        baseProbability: 0.3, plaintiffFullyInvestigated: false,
        // No resolvedAmount key at all — simulates a row written before the column existed.
      });

      const response = await engine.getGameTimeline(roomState.room.id);

      expect(response!.lawsuits[0].resolvedAmount).toBeUndefined();
    });

    it('is reachable during AFTERMATH, not just GAME_PHASE — the finished-game replay depends on this', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      roomState.room.status = RoomStatus.AFTERMATH;

      const response = await engine.getGameTimeline(roomState.room.id);

      expect(response).not.toBeNull();
      expect(response!.gameOver).toBe(true);
    });
  });

  describe('syncRoomToDB', () => {
    it('should update room status in database', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);
      roomState.room.status = RoomStatus.GAME_PHASE;

      await engine.syncRoomToDB(roomState.room.id);

      expect(mockPrisma.room.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: roomState.room.id },
          data: expect.objectContaining({
            status: RoomStatus.GAME_PHASE,
          }),
        }),
      );
    });
  });

  describe('syncPlayerToDB', () => {
    it('should update player in database', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);
      const dbPlayer = Array.from(roomState.players.values())[0];

      await engine.syncPlayerToDB(dbPlayer.id, { isHost: true });

      expect(mockPrisma.player.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: dbPlayer.id },
          data: expect.objectContaining({
            isHost: true,
          }),
        }),
      );
    });
  });

  describe('broadcastRoomState', () => {
    it('should emit event to room', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.broadcastRoomState(roomState.room.id, 'custom:event', { data: 'test' });

      expect(mockIo.to).toHaveBeenCalledWith(roomState.room.id);
      expect(mockIo.emit).toHaveBeenCalledWith('custom:event', { data: 'test' });
    });
  });

  describe('sendChatMessage', () => {
    // Regression coverage for expanding chat beyond the WAITING lobby (see CLAUDE.md) —
    // this used to be gated behind `roomState.room.status !== RoomStatus.WAITING`
    // directly in the `chat:message` handler; that whole status check is gone now, so
    // chat must keep working identically across every room phase.
    it.each([RoomStatus.WAITING, RoomStatus.GAME_PHASE, RoomStatus.AFTERMATH])(
      'broadcasts a validated chat message to the room during %s',
      async (status) => {
        const player = {
          id: '',
          name: 'Alice',
          roomId: '',
          isHost: false,
          bankrupt: false,
          socketId: 'socket-1',
        };
        const roomState = await engine.createRoom(player);
        const playerId = Array.from(roomState.players.keys())[0];
        roomState.room.status = status;

        engine.sendChatMessage('socket-1', { message: 'Hello!' });

        expect(mockIo.to).toHaveBeenCalledWith(roomState.room.id);
        expect(mockIo.emit).toHaveBeenCalledWith(
          ServerEvents.CHAT_MESSAGE,
          expect.objectContaining({ playerId, playerName: 'Alice', message: 'Hello!' }),
        );
      },
    );

    it('silently no-ops for a socket that cannot be resolved to a room', () => {
      expect(() => engine.sendChatMessage('unknown-socket', { message: 'Hello!' })).not.toThrow();
      expect(mockIo.emit).not.toHaveBeenCalled();
    });

    it('throws for an invalid payload, leaving the message unbroadcast', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      await engine.createRoom(player);

      expect(() => engine.sendChatMessage('socket-1', { message: '' })).toThrow();
      expect(mockIo.emit).not.toHaveBeenCalled();
    });
  });

  describe('ROOM_PLAYER_JOINED - Multi-player room state', () => {
    it('should have all players in roomState.players after multiple joins', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner1 = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner1);

      const joiner2 = {
        id: '',
        name: 'Charlie',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-3',
      };
      await engine.joinRoom(roomState.room.id, joiner2);

      expect(roomState.players.size).toBe(3);
      expect(Array.from(roomState.players.values()).map((p) => p.name)).toEqual(
        expect.arrayContaining(['Alice', 'Bob', 'Charlie']),
      );
    });

    it('should store each player with their correct socketId', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner);

      const players = Array.from(roomState.players.values());
      const alice = players.find((p) => p.socketId === 'socket-1');
      const bob = players.find((p) => p.socketId === 'socket-2');

      expect(alice).toBeDefined();
      expect(alice?.name).toBe('Alice');
      expect(bob).toBeDefined();
      expect(bob?.name).toBe('Bob');
    });

    it('should allow finding a player by socketId after join', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner);

      // This is the pattern used in the ROOM_JOIN handler to find the joining player
      const joiningPlayer = Array.from(roomState.players.values()).find(
        (p) => p.socketId === 'socket-2',
      );

      expect(joiningPlayer).toBeDefined();
      expect(joiningPlayer?.name).toBe('Bob');
      expect(joiningPlayer?.id).not.toBe(creator.id); // DB-generated ID
    });

    it('should maintain player order independence - finding by socketId works regardless of map position', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      // Add 3 more players
      for (let i = 2; i <= 4; i++) {
        const joiner = {
          id: '',
          name: `Player${i}`,
          roomId: '',
          isHost: false,
          bankrupt: false,
          socketId: `socket-${i}`,
        };
        await engine.joinRoom(roomState.room.id, joiner);
      }

      // Verify we can find each player by their socketId
      for (let i = 1; i <= 4; i++) {
        const player = Array.from(roomState.players.values()).find(
          (p) => p.socketId === `socket-${i}`,
        );
        expect(player).toBeDefined();
        expect(player?.name).toBe(i === 1 ? 'Alice' : `Player${i}`);
      }
    });

    it('should have unique player IDs for each player in the room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner1 = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner1);

      const joiner2 = {
        id: '',
        name: 'Charlie',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-3',
      };
      await engine.joinRoom(roomState.room.id, joiner2);

      const playerIds = Array.from(roomState.players.values()).map((p) => p.id);
      const uniqueIds = new Set(playerIds);
      expect(uniqueIds.size).toBe(3);
      expect(playerIds.length).toBe(3);
    });

    it('should preserve player isHost state after join', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner);

      const players = Array.from(roomState.players.values());
      expect(players[0].isHost).toBe(true); // Creator is host
      expect(players[1].isHost).toBe(false); // Joiner is not host
    });
  });

  describe('getAnnualReport', () => {
    it('returns AI-narrated text per active decision, requesting the correct static fallback and elapsed years', async () => {
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'player-2',
          name: 'Bob',
          company: {
            variables: {},
            engineState: {
              activeDecisions: [
                { id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 2, elapsedYears: 1, isMatured: true, targetId: 'player-1' },
              ],
            },
          },
        },
      ]);

      const entries = await engine.getAnnualReport('room-1', 'player-2');

      expect(entries).toEqual([{ decisionName: 'Bot Attack', text: 'blurb: Bot Attack', year: 3 }]);
      // Second arg is the onComplete telemetry callback (see llmService.ts's
      // LlmCallTelemetry) — only the request shape matters here, so match it loosely.
      expect(generateAnnualReportBlurb).toHaveBeenCalledWith(
        {
          decisionName: 'Bot Attack',
          description: "Launch a coordinated cyberattack against a competitor's digital infrastructure to disrupt their logistics and operations.",
          elapsedYears: 1,
          fallback: 'Proactive digital capacity-loading evaluations of external logistical networks.',
        },
        expect.any(Function),
      );
    });

    it('returns null for a rival not found among active players', async () => {
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const entries = await engine.getAnnualReport('room-1', 'nobody');

      expect(entries).toBeNull();
    });

    it('silently skips a decision instance whose definitionName no longer exists in the loaded library', async () => {
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'player-2',
          name: 'Bob',
          company: {
            variables: {},
            engineState: {
              activeDecisions: [
                { id: 'inst-1', definitionName: 'Some Retired Decision', deployedYear: 1, elapsedYears: 0, isMatured: true },
              ],
            },
          },
        },
      ]);

      const entries = await engine.getAnnualReport('room-1', 'player-2');

      expect(entries).toEqual([]);
    });
  });

  describe('digDeeper — incoming-attack annual report blurb', () => {
    // Three active players (not two) — a heads-up (2-player) game would make
    // effectiveInvestigationLevel skip straight past level 1 to level 2 (see
    // CLAUDE.md's "Dig Deeper's investigation ladder skips the free tier" section),
    // which would never exercise the level-1-exactly case this feature targets.
    const threeActivePlayers = () => [
      {
        id: 'player-1',
        name: 'Alice',
        company: { variables: {}, engineState: {} },
      },
      {
        id: 'player-2',
        name: 'Bob',
        company: {
          variables: {},
          engineState: {
            activeDecisions: [
              { id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 1, isMatured: true, targetId: 'player-1' },
            ],
          },
        },
      },
      { id: 'player-3', name: 'Carol', company: { variables: {}, engineState: {} } },
    ];

    it('attaches the annual-report blurb the moment a dig lands exactly on investigationLevel 1 (attacker known, decision not yet revealed)', async () => {
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(threeActivePlayers());

      const outcome = await engine.digDeeper('room-1', 'player-1', 'inst-1');

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(1);
      expect(outcome.attack.attackerId).toBe('player-2');
      // Level 1 doesn't reveal the decision name itself — the blurb is deliberately
      // the only hint at this tier.
      expect(outcome.attack.decisionName).toBeUndefined();
      expect(outcome.attack.annualReportBlurb).toBe('blurb: Bot Attack');
      expect(generateAnnualReportBlurb).toHaveBeenCalledWith(
        {
          decisionName: 'Bot Attack',
          description: "Launch a coordinated cyberattack against a competitor's digital infrastructure to disrupt their logistics and operations.",
          elapsedYears: 1,
          fallback: 'Proactive digital capacity-loading evaluations of external logistical networks.',
        },
        expect.any(Function),
      );
    });

    it('does not attach a blurb once investigation goes past level 1 (the real decision is already revealed instead)', async () => {
      const players = threeActivePlayers();
      // player-1 already dug once — this next dig lands on level 2.
      (players[0].company.engineState as any).investigations = { 'inst-1': 1 };
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(players);

      const outcome = await engine.digDeeper('room-1', 'player-1', 'inst-1');

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(2);
      expect(outcome.attack.decisionName).toBe('Bot Attack');
      expect(outcome.attack.annualReportBlurb).toBeUndefined();
      expect(generateAnnualReportBlurb).not.toHaveBeenCalled();
    });

    it('omits the blurb for a decision with no competitorsView to draw a fallback from, mirroring getAnnualReport\'s own filter', async () => {
      // Every decision in the real seeded library happens to have competitorsView, so
      // this state is reached here via a live /admin-style edit removing it, not a
      // decision that ships without one.
      const botAttack = engine.getDecisionsSnapshot().find((d) => d.decision === 'Bot Attack')!;
      await engine.upsertDecision({ ...botAttack, competitorsView: [] }, false);

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(threeActivePlayers());

      const outcome = await engine.digDeeper('room-1', 'player-1', 'inst-1');

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(1);
      expect(outcome.attack.annualReportBlurb).toBeUndefined();
      expect(generateAnnualReportBlurb).not.toHaveBeenCalled();
    });
  });

  describe('digDeeper — revenue-relative ground stakes (regression)', () => {
    // A real, reported bug: `Company.variables` never actually carries `revenue` (it's a
    // derived P&L figure GameLoop only ever materializes fresh inside `resolveTurn` —
    // see gameLoop.ts's Step 8 stakes-calculation note), so `digDeeper` — an out-of-band
    // action with no live turn in progress — had no way to price a relative-type legal-
    // risk ground targeting revenue; it always fell back to $0. Fixed by patching in the
    // attacker's latest known revenue from KpiSnapshot history before delegating to
    // `GameLoop.digDeeper`. 'Vertical Integration' is a real seeded decision whose two
    // legal-risk grounds are both revenue-relative (Sherman Act Section 2 Private
    // Antitrust Litigation / Breach of Exclusivity and Supply Poaching Claim).
    it('prices the fully-revealed ground off the attacker\'s latest known revenue, not $0', async () => {
      const players = [
        {
          id: 'player-1', name: 'Alice',
          company: { variables: {}, engineState: { investigations: { 'inst-1': 1 } } },
        },
        {
          id: 'player-2', name: 'Bob',
          company: {
            // Non-empty (cash set) so digDeeper's own "first turn hasn't resolved yet"
            // fallback (readVariables -> startingVars() when both cash and assets are
            // falsy) doesn't kick in and wipe out the revenue patch this test exists to
            // verify.
            variables: { cash: 50000 },
            engineState: {
              activeDecisions: [
                { id: 'inst-1', definitionName: 'Vertical Integration', deployedYear: 1, elapsedYears: 1, isMatured: true },
              ],
            },
          },
        },
      ];
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(players);
      (mockPrisma.kpiSnapshot!.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { playerId: 'player-2', round: 3, derived: { revenue: 300000 } },
      ]);

      const outcome = await engine.digDeeper('room-1', 'player-1', 'inst-1');

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(3);
      expect(outcome.attack.suggestedGrounds).toBeDefined();
      // Both of Vertical Integration's grounds are revenue-relative with a `default`
      // multiplier of -0.05/-0.06 — either way, every ground's stakes must be a real
      // fraction of the mocked $300,000 revenue, not a number computed off an undefined
      // field (the actual $0 bug this test guards against), and neither ground should be
      // silently dropped from the list.
      expect(outcome.attack.suggestedGrounds!.length).toBeGreaterThanOrEqual(1);
      for (const ground of outcome.attack.suggestedGrounds!) {
        expect(ground.stakes).toBeGreaterThan(1000);
        expect(ground.stakes).toBeLessThanOrEqual(300000 * 0.06);
      }
    });

    it('falls back gracefully (no crash, real ground selection still works) when no KpiSnapshot history exists yet', async () => {
      const players = [
        {
          id: 'player-1', name: 'Alice',
          company: { variables: {}, engineState: { investigations: { 'inst-1': 1 } } },
        },
        {
          id: 'player-2', name: 'Bob',
          company: {
            // Non-empty (cash set) so digDeeper's own "first turn hasn't resolved yet"
            // fallback (readVariables -> startingVars() when both cash and assets are
            // falsy) doesn't kick in and wipe out the revenue patch this test exists to
            // verify.
            variables: { cash: 50000 },
            engineState: {
              activeDecisions: [
                { id: 'inst-1', definitionName: 'Vertical Integration', deployedYear: 1, elapsedYears: 1, isMatured: true },
              ],
            },
          },
        },
      ];
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(players);
      // Default mock: kpiSnapshot.findMany resolves to [] (no history yet — round 1).

      const outcome = await engine.digDeeper('room-1', 'player-1', 'inst-1');

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.suggestedGrounds).toBeDefined();
      expect(outcome.attack.suggestedGrounds!.every((g) => g.stakes === 0)).toBe(true);
    });
  });

  describe('getAdminRoomsSnapshot', () => {
    it('returns an empty array when there are no in-memory rooms', () => {
      expect(engine.getAdminRoomsSnapshot()).toEqual([]);
    });

    it('reflects every room, in every phase, with every player — including disconnected and bankrupt ones', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      const joiner = { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' };
      await engine.joinRoom(roomState.room.id, joiner);

      const [aliceId, bobId] = Array.from(roomState.players.keys());
      // Bob disconnects (kept in the room during the grace period, not removed)...
      await engine.markPlayerDisconnected('socket-2');
      // ...and Alice goes bankrupt (flagged in-memory the same way resolveGameTurn does).
      roomState.players.get(aliceId)!.bankrupt = true;

      const snapshot = engine.getAdminRoomsSnapshot();

      expect(snapshot).toHaveLength(1);
      const room = snapshot[0];
      expect(room.id).toBe(roomState.room.id);
      expect(room.status).toBe(RoomStatus.WAITING);
      expect(room.maxPlayers).toBe(4);
      expect(room.players).toHaveLength(2);

      const alice = room.players.find((p) => p.id === aliceId)!;
      expect(alice).toMatchObject({ name: 'Alice', isHost: true, bankrupt: true, connected: true });

      const bob = room.players.find((p) => p.id === bobId)!;
      expect(bob).toMatchObject({ name: 'Bob', isHost: false, bankrupt: false, connected: false });
    });
  });

  describe('upsertDecision', () => {
    const newDecision = {
      decision: 'Test Admin Decision',
      level: 'Operational' as const,
      description: 'A decision created for testing.',
      nature: 'Traditional' as const,
      offensiveAction: false,
      excludes: [],
      impacts: { cash: { type: 'absolute' as const, schedule: { default: -1000 } } },
    };

    it('creates a new decision and live-reloads it into GameLoop', async () => {
      const result = await engine.upsertDecision(newDecision, true);

      expect(result).toEqual({ success: true });
      expect(engine.getDecisionsSnapshot().find((d) => d.decision === 'Test Admin Decision')).toEqual(newDecision);
    });

    it('rejects creating a decision that already exists', async () => {
      const result = await engine.upsertDecision({ ...newDecision, decision: 'Bot Attack' }, true);

      expect(result).toEqual({ success: false, reason: 'already_exists' });
    });

    it('updates an existing decision and live-reloads the change', async () => {
      const updated = { ...newDecision, decision: 'Bot Attack', description: 'Updated description.' };

      const result = await engine.upsertDecision(updated, false);

      expect(result).toEqual({ success: true });
      expect(engine.getDecisionsSnapshot().find((d) => d.decision === 'Bot Attack')?.description).toBe('Updated description.');
    });

    it('rejects updating a decision that does not exist', async () => {
      const result = await engine.upsertDecision(newDecision, false);

      expect(result).toEqual({ success: false, reason: 'not_found' });
    });
  });

  describe('deleteDecision', () => {
    it('deletes an unused decision and removes it from GameLoop', async () => {
      const result = await engine.deleteDecision('Fox Release');

      expect(result).toEqual({ success: true });
      expect(engine.getDecisionsSnapshot().find((d) => d.decision === 'Fox Release')).toBeUndefined();
    });

    it('returns not_found for an unknown decision', async () => {
      const result = await engine.deleteDecision('Nonexistent Decision');

      expect(result).toEqual({ success: false, reason: 'not_found' });
    });

    it('rejects deletion while a non-bankrupt player currently has it deployed', async () => {
      const player = await mockPrisma.player.create({
        data: { name: 'Alice', roomId: 'room-1', isHost: true, bankrupt: false, socketId: 'socket-1' },
      } as any) as any;
      player.company.engineState = {
        activeDecisions: [{ id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true }],
      };

      const result = await engine.deleteDecision('Bot Attack');

      expect(result).toEqual({ success: false, reason: 'in_use' });
      expect(engine.getDecisionsSnapshot().find((d) => d.decision === 'Bot Attack')).toBeDefined();
    });

    it('allows deletion once the only player with it deployed is bankrupt', async () => {
      const player = await mockPrisma.player.create({
        data: { name: 'Alice', roomId: 'room-1', isHost: true, bankrupt: true, socketId: 'socket-1' },
      } as any) as any;
      player.company.engineState = {
        activeDecisions: [{ id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true }],
      };

      const result = await engine.deleteDecision('Bot Attack');

      expect(result).toEqual({ success: true });
    });
  });

  describe('updateGameConfigData', () => {
    it('persists the new config and live-reloads it into GameLoop', async () => {
      const newConfig = engine.getGameConfigSnapshot();
      const updated = { ...newConfig, gameSettings: { ...newConfig.gameSettings, digDeeperCost: 55555 } };

      await engine.updateGameConfigData(updated);

      expect(engine.getGameConfigSnapshot().gameSettings.digDeeperCost).toBe(55555);
      expect(mockPrisma.gameConfigRow.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          gameSettings: updated.gameSettings,
          playerStartingValues: updated.playerStartingValues,
          adminVariables: updated.adminVariables,
        },
      });
    });
  });

  describe('updateFormula', () => {
    it('returns not_found for an unknown formula key', async () => {
      const result = await engine.updateFormula('notARealFormula', '1 + 1', 'bogus');

      expect(result).toEqual({ success: false, reason: 'not_found' });
    });

    it('persists the new expression/description and reflects it in getFormulasSnapshot', async () => {
      const result = await engine.updateFormula('revenue', 'volume * price * 2 + revenueDelta', 'doubled for testing');

      expect(result).toEqual({ success: true });
      const snapshot = engine.getFormulasSnapshot().find((f) => f.key === 'revenue');
      expect(snapshot).toEqual({ key: 'revenue', expression: 'volume * price * 2 + revenueDelta', description: 'doubled for testing' });
      expect(mockPrisma.formula.update).toHaveBeenCalledWith({
        where: { key: 'revenue' },
        data: { expression: 'volume * price * 2 + revenueDelta', description: 'doubled for testing' },
      });
    });

    it('live-reloads GameLoop — a changed formula affects the very next computation, no restart', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);

      await engine.broadcastInitialSnapshot(roomState.room.id, 1);
      const before = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED)
        .pop()![1] as any;
      const revenueBefore = before.players[0].derived.revenue;

      await engine.updateFormula('revenue', 'volume * price * 2 + revenueDelta', 'doubled for testing');

      await engine.broadcastInitialSnapshot(roomState.room.id, 1);
      const after = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED)
        .pop()![1] as any;
      const revenueAfter = after.players[0].derived.revenue;

      // Doubling the formula should double revenue (volume*price term dominates; revenueDelta is 0 pre-decisions)
      expect(revenueAfter).toBeCloseTo(revenueBefore * 2, 4);
    });
  });
});
