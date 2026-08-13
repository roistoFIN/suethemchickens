import type { DecisionDefinition, GameSettings, IncomingAttackInfo, AnnualReportEntry, LegalCaseData } from './gameTypes.js';

// ============================================================
// Room & Phase Types
// ============================================================

export enum RoomStatus {
  WAITING = 'WAITING',
  /** Single interactive phase that loops until only one player remains */
  GAME_PHASE = 'GAME_PHASE',
  /** Final standings and winner announcement before game over */
  AFTERMATH = 'AFTERMATH',
}

export const PHASE_ORDER: RoomStatus[] = [
  RoomStatus.WAITING,
  RoomStatus.GAME_PHASE,
  RoomStatus.AFTERMATH,
];

export const PHASE_TIMERS: Record<RoomStatus, number> = {
  [RoomStatus.WAITING]: 0,
  [RoomStatus.GAME_PHASE]: 120,
  [RoomStatus.AFTERMATH]: 30,
};

export interface Room {
  id: string;
  status: RoomStatus;
  maxPlayers: number;
  currentPhaseRound: number;
  players: Player[];
  createdAt: Date;
  timer?: number;
  /** Host-toggled — excludes the room from Quick Play matching and the Available Rooms list; a direct room-code/invite-link join still works. */
  inviteOnly: boolean;
  /**
   * Milliseconds remaining until a server-injected bot opponent joins this room, as of
   * the instant this snapshot was built — drives the lobby's "a bot joins in Ns" counter
   * (see `GameEngine.scheduleBotJoinCheck` and `botJoinNotice.ts`).
   *
   * `undefined` whenever no bot join is pending — no timer armed, the deadline already
   * passed, or the room no longer qualifies (started, invite-only, bots disabled, or more
   * than one player present). Deliberately a RELATIVE duration rather than an absolute
   * timestamp so the client never has to trust its own clock agreeing with the server's;
   * the client re-anchors it against its own `Date.now()` on arrival.
   */
  botJoinInMs?: number;
}

// ============================================================
// Player Types
// ============================================================

export interface Player {
  id: string;
  name: string;
  roomId: string;
  isHost: boolean;
  bankrupt: boolean;
  /** Round this player was eliminated in (bankruptcy, merger/takeover, or forfeit) — undefined while still active. */
  eliminatedRound?: number;
  companyId?: string | null;
  socketId?: string | null;
  /** True for a server-injected AI opponent — see GameEngine.addBotPlayer. Always false/
   * undefined for a real player. Drives the client's "🤖 Bot" roster badge. */
  isBot?: boolean;
}

// ============================================================
// Company & Asset Types
// ============================================================

export interface Company {
  id: string;
  playerId: string;
  cash: number;
  debt: number;
  assets: Asset[];
}

export interface Asset {
  id: string;
  companyId: string;
  type: string;
  value: number;
}

// ===========================================================
// Game State (full snapshot)
// ============================================================

export interface GameState {
  room: Room;
  companies: Company[];
  currentPlayerId?: string;
}

// ============================================================
// Socket Event Types
// ============================================================

// Client → Server events
export enum ClientEvents {
  ROOM_JOIN = 'room:join',
  /** Voluntarily leave the room lobby — WAITING phase only. Distinct from `game:leave`'s GAME_PHASE forfeit. */
  ROOM_LEAVE = 'room:leave',
  ROOM_KICK = 'room:kick',
  ROOM_START_GAME = 'room:startGame',
  ROOM_LIST = 'room:list',
  /** Host toggles whether the room can be found via Quick Play / the Available Rooms list — WAITING phase only. A direct room-code/invite-link join is never blocked by this. */
  ROOM_SET_INVITE_ONLY = 'room:setInviteOnly',
  CHAT_MESSAGE = 'chat:message',
  GAME_SUBMIT_DECISIONS = 'game:submitDecisions',
  /** Pay to reveal the next tier of intel on an incoming attack — instant, outside turn resolution. */
  GAME_DIG_DEEPER = 'game:digDeeper',
  /** Re-associate an existing player (by id) with a new socket after a disconnect, within the server's grace period. */
  ROOM_REJOIN = 'room:rejoin',
  /** Request AI-narrated "annual report" text for one rival's active decisions — on demand, outside turn resolution. */
  GAME_GET_ANNUAL_REPORT = 'game:getAnnualReport',
  /** Voluntary forfeit — "Leave Game" during GAME_PHASE. Instant bankruptcy for the requesting player; the game continues for everyone else. */
  GAME_LEAVE = 'game:leave',
  /** Toggle ready status for the in-flight turn — once every active (non-bankrupt) player is ready, the turn resolves immediately instead of waiting out the timer. */
  GAME_READY = 'game:ready',
  /** Charge `gameSettings.lawsuitFilingCost` the instant a player files a lawsuit (SueModal's "File" button) — instant, outside turn resolution, same pattern as `game:digDeeper`. The case itself is still only created/validated at the next turn resolution via `game:submitDecisions`. */
  GAME_FILE_LAWSUIT = 'game:fileLawsuit',
  /** Request KPI history (persisted `KpiSnapshot` rows) — on demand, opened by clicking any KPI card or breakdown line item. `GetKpiHistoryPayload.targetPlayerId` omitted or equal to the caller's own id returns "my own data" plus a 3-turn-ahead prediction; any other id in the same room returns that rival's history only, no prediction. */
  GAME_GET_KPI_HISTORY = 'game:getKpiHistory',
  /** Make a settlement offer on a `'negotiating'` case — either the defendant's opening offer, or either side's counter-offer. Instant, outside turn resolution, same pattern as `game:digDeeper`. Only the party who did *not* make the most recent offer (the defendant, if none has been made yet) may call this. */
  GAME_MAKE_OFFER = 'game:makeOffer',
  /** Accept the other party's most recent offer, settling the case immediately for that amount — instant, outside turn resolution. Only the party who did not make that offer may call this. */
  GAME_ACCEPT_OFFER = 'game:acceptOffer',
  /** End negotiation and send a case to trial — instant, outside turn resolution. Either party may call this at any time while the case is `'negotiating'`. Only marks the case `'awaiting_trial'`; the verdict itself is still drawn the next time the room's turn resolves (same trial-resolution step every `awaiting_trial` case already goes through), not immediately. */
  GAME_GO_TO_COURT = 'game:goToCourt',
  /** Pay `gameSettings.digDeeperCost` to reveal the probability of success on a case you're the defendant on — instant, outside turn resolution. Defendant-only; a plaintiff never knows a defendant's odds this way. Unlike `game:digDeeper`'s 3-tier ladder, this is a single one-shot reveal scoped to one case. */
  GAME_DIG_DEEPER_CASE = 'game:digDeeperCase',
  /** Request the whole room's game-timeline replay data (every player's KPI history, every decision deployed, every lawsuit filed/resolved) — no payload, unlike every other on-demand request. Valid in both GAME_PHASE (a live-spectating eliminated player) and AFTERMATH (the finished-game replay), not just GAME_PHASE. */
  GAME_GET_GAME_TIMELINE = 'game:getGameTimeline',
}

// Server → Client events
export enum ServerEvents {
  ROOM_JOINED = 'room:joined',
  /** Sent only to the requesting socket, confirming a successful `room:leave` — the client's cue to reset to the landing page. */
  ROOM_LEFT = 'room:left',
  ROOM_PLAYER_KICKED = 'room:playerKicked',
  ROOM_PLAYER_JOINED = 'room:playerJoined',
  ROOM_PLAYER_LEFT = 'room:playerLeft',
  ROOMS_LISTED = 'rooms:list',
  /** Broadcast to the whole room whenever the roster or room-level settings change outside a fresh join (kick, leave, host reassignment, invite-only toggle) — always a freshly-rebuilt `Room` snapshot, never a stale cached one. Deliberately does *not* carry a `player` field like `room:joined` does, so it can never overwrite a recipient's own identity with someone else's. */
  ROOM_UPDATED = 'room:updated',
  PHASE_CHANGED = 'phase:changed',
  TIMER_UPDATE = 'timer:update',
  BOARD_UPDATE = 'board:update',
  GAME_DECK = 'game:deck',
  TURN_RESOLVED = 'turn:resolved',
  PLAYER_BANKRUPT = 'player:bankrupt',
  GAME_OVER = 'game:over',
  ERROR = 'error',
  CHAT_MESSAGE = 'chat:message',
  /** Sent only to the requesting socket — never broadcast — with the newly-unlocked intel tier. */
  GAME_DIG_DEEPER_RESULT = 'game:digDeeperResult',
  /** Sent only to the requesting socket, in response to `game:getAnnualReport`. */
  GAME_ANNUAL_REPORT_RESULT = 'game:annualReportResult',
  /** Sent only to the requesting socket, confirming a successful `game:leave` forfeit — the client's cue to reset to the landing page. */
  GAME_LEFT = 'game:left',
  /** Broadcast to the whole room on every `game:ready` toggle, and reset to an empty `readyPlayerIds` at the start of each new round. */
  GAME_READY_UPDATE = 'game:readyUpdate',
  /** Sent only to the requesting socket, in response to `game:fileLawsuit` — either the fee was charged (with the new cash) or it wasn't (with a reason). */
  GAME_FILE_LAWSUIT_RESULT = 'game:fileLawsuitResult',
  /** Sent only to the requesting socket, in response to `game:getKpiHistory` — this player's own KPI history + 3-turn prediction. */
  GAME_KPI_HISTORY_RESULT = 'game:kpiHistoryResult',
  /** Sent to BOTH parties on a case (not broadcast to the room) whenever `game:makeOffer`/`game:acceptOffer`/`game:goToCourt` succeeds — each recipient gets the same updated `LegalCaseData`, plus their own `newCash` if this update just settled the case (undefined for an offer or a court decision, which never move cash). A validation failure (not your turn, case not found, etc.) goes only to the requesting socket via `error`, same as `game:getKpiHistory`. */
  GAME_LEGAL_CASE_UPDATE = 'game:legalCaseUpdate',
  /** Sent only to the requesting socket, in response to `game:getGameTimeline` — the whole room's `GameTimelineResponse`. */
  GAME_TIMELINE_RESULT = 'game:gameTimelineResult',
}

// ============================================================
// Action Payload Types
// ============================================================

export interface RoomJoinPayload {
  playerName: string;
  roomName?: string;
}

/** Payload for `room:rejoin` — resume an existing session (id-only, no auth in this app: the pair itself is the bearer credential, same trust model as every other player id already in use). */
export interface RoomRejoinPayload {
  roomId: string;
  playerId: string;
}

/** Payload for `room:setInviteOnly` — host toggles Quick Play / Available Rooms discoverability. */
export interface RoomSetInviteOnlyPayload {
  inviteOnly: boolean;
}

/** Payload for `game:digDeeper` — spend `gameSettings.digDeeperCost` to reveal the next tier of intel on one attack. */
export interface DigDeeperPayload {
  attackId: string;
}

/** Payload for `game:getAnnualReport` — request narrated flavor text for one rival's active decisions. */
export interface AnnualReportRequestPayload {
  rivalPlayerId: string;
}

/** Payload for `chat:message` (client → server) — in-room chat, usable in every room phase (WAITING lobby, GAME_PHASE, AFTERMATH). */
export interface ChatMessagePayload {
  message: string;
}

/** Payload for `game:ready` — toggle this player's ready status for the in-flight turn. */
export interface GameReadyPayload {
  ready: boolean;
}

/** Payload for `game:fileLawsuit` — pay `gameSettings.lawsuitFilingCost` to file a specific lawsuit right now. Same `{ targetId, decisionName, groundName }` shape as one entry of `SubmittedDecisions.lawsuits` — the client still separately queues that entry via `game:submitDecisions` for the case itself to be created at the next turn resolution; this only charges the fee. */
export interface FileLawsuitPayload {
  targetId: string;
  decisionName: string;
  groundName: string;
}

/** Payload for `game:makeOffer` — propose (or counter) a settlement amount on a case still `'negotiating'`. */
export interface MakeOfferPayload {
  caseId: string;
  amount: number;
}

/** Payload for `game:acceptOffer` — accept the other party's most recent offer on this case. */
export interface AcceptOfferPayload {
  caseId: string;
}

/** Payload for `game:goToCourt` — end negotiation on this case and send it to trial. */
export interface GoToCourtPayload {
  caseId: string;
}

/** Payload for `game:digDeeperCase` — spend `gameSettings.digDeeperCost` to reveal the
 * probability of success on a case you're the defendant on. Defendant-only, one-shot per
 * case (unlike `game:digDeeper`'s 3-tier ladder). */
export interface DigDeeperCasePayload {
  caseId: string;
}

// ===========================================================
// Response Types
// ============================================================

export interface RoomJoinedResponse {
  room: Room;
  player: Player;
  companies: Company[];
}

/** Broadcast for `room:updated` — see the enum entry for why this never carries a `player` field. */
export interface RoomUpdatedResponse {
  room: Room;
}

export interface PhaseChangedResponse {
  phase: RoomStatus;
  round: number;
  timeLimit: number;
}

/** The shared decision library + per-turn limits, sent once when GAME_PHASE starts. */
export interface GameDeckResponse {
  decisions: DecisionDefinition[];
  gameSettings: GameSettings;
}

export interface RoomInfo {
  id: string;
  status: RoomStatus;
  maxPlayers: number;
  currentPhaseRound: number;
  playerCount: number;
}

export interface RoomsListedResponse {
  rooms: RoomInfo[];
}

// ============================================================
// Admin Portal Types — REST-only (not socket events), gated by ADMIN_TOKEN
// ============================================================

export interface AdminRoomPlayerSnapshot {
  id: string;
  name: string;
  isHost: boolean;
  bankrupt: boolean;
  /** Whether this player currently has a live socket, or is mid reconnect-grace-period. */
  connected: boolean;
}

/** One in-memory room's full monitoring snapshot — every player, not just the requesting one. */
export interface AdminRoomSnapshot {
  id: string;
  status: RoomStatus;
  round: number;
  maxPlayers: number;
  createdAt: string;
  players: AdminRoomPlayerSnapshot[];
}

export interface AdminRoomsResponse {
  rooms: AdminRoomSnapshot[];
}

/** One named formula (the 23 pure, scalar, named-input ones — competitiveness, P&L,
 * risk gauge, etc.) — DB-backed (`Formula` table), editable
 * via `PUT /api/admin/formulas/:key`. The key set is fixed; only `expression`/
 * `description` are ever written. */
export interface FormulaInfo {
  key: string;
  expression: string;
  description: string;
}

export interface FormulasResponse {
  formulas: FormulaInfo[];
}

/** Which of the two feedback forms a `Feedback` row came from — purely for admin
 * triage, since the row itself carries no player/room identity at all (see
 * `FeedbackEntry`'s doc comment). */
export type FeedbackSource = 'landing' | 'gameover';

/** Body for `POST /api/feedback` — a plain public REST endpoint (no auth, no socket
 * involvement), since the landing-page form has no room/socket to piggyback on and
 * the game-over form shouldn't behave differently just because one exists. `rating`
 * is a 1-5 Likert score (mapped to mood-icon faces client-side); `message` is
 * optional free text. */
export interface FeedbackSubmitPayload {
  rating: number;
  message?: string;
  source: FeedbackSource;
}

/** One submitted feedback row, as read back by `GET /api/admin/feedback`. Deliberately
 * carries no player/room identity — feedback is fully anonymous by design (see the
 * `Feedback` Prisma model's own doc comment) — `source` is the only context an admin
 * gets beyond the rating/message/timestamp themselves. */
export interface FeedbackEntry {
  id: string;
  rating: number;
  message: string | null;
  source: FeedbackSource;
  createdAt: string;
}

export interface FeedbackListResponse {
  feedback: FeedbackEntry[];
}

// ============================================================
// EventLog / admin Analytics tab — see server's EventLog Prisma model and
// eventLogService.ts for the fixed EVENT_TYPES vocabulary these read from.
// Read-only from the client's point of view (AdminPortal.tsx); nothing here is ever
// written by the client — every write happens server-side, from GameEngine.
// ============================================================

export type EventSeverity = 'info' | 'warning' | 'error';

/** One row from the `EventLog` table, as read back by `GET /api/admin/events`. */
export interface EventLogEntry {
  id: string;
  eventType: string;
  severity: EventSeverity;
  roomId: string | null;
  playerId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EventLogListResponse {
  events: EventLogEntry[];
}

/** One decision's aggregate stats across every logged `decision.deployed`/
 * `decision.rejected` event, cross-referenced against `game.completed` events to
 * compute a real win/loss correlation from actually-played games — the productionized
 * version of the one-off randomized-simulation balance analysis described in
 * CLAUDE.md's decision-balance sections. `winRate` is `null` until at least one
 * deployment of this decision happened in a room whose game has since completed. */
export interface DecisionAnalyticsEntry {
  decisionName: string;
  deployCount: number;
  rejectCount: number;
  topRejectReasons: Array<{ reason: string; count: number }>;
  winCount: number;
  lossCount: number;
  winRate: number | null;
}

export interface DecisionAnalyticsResponse {
  decisions: DecisionAnalyticsEntry[];
  /** How many completed games (`game.completed` events) the win/loss correlation is drawn from. */
  gamesConsidered: number;
}

/** One (decision, ground) pair's aggregate stats, from the durable `LegalCaseHistory`
 * table — not EventLog, since lawsuit lifecycle is already fully captured there (see
 * CLAUDE.md's LegalCaseHistory section). */
export interface LawsuitAnalyticsEntry {
  groundName: string;
  decisionName: string;
  filedCount: number;
  resolvedCount: number;
  wonCount: number;
  winRate: number | null;
  avgStakes: number | null;
}

export interface LawsuitAnalyticsResponse {
  grounds: LawsuitAnalyticsEntry[];
}

export interface PerformanceLlmStat {
  kind: string;
  count: number;
  avgLatencyMs: number;
  successRate: number;
}

export interface PerformanceAnalyticsResponse {
  turns: { count: number; avgComputeMs: number; avgTotalMs: number; maxTotalMs: number };
  llm: PerformanceLlmStat[];
  errorCounts: Array<{ context: string; count: number }>;
}

/** Response for `game:digDeeperResult` — sent only to the socket that paid for the dig. */
export interface DigDeeperResultPayload {
  attackId: string;
  cost: number;
  newCash: number;
  attack: IncomingAttackInfo;
}

/** Response for `game:fileLawsuitResult` — sent only to the socket that filed, on success.
 * A failed charge (insufficient funds, per-turn limit reached, etc.) is reported via the
 * generic `error` event instead, same convention as `game:digDeeper`. */
export interface FileLawsuitResultPayload {
  cost: number;
  newCash: number;
}

/** Response for `game:annualReportResult` — sent only to the requesting socket. */
export interface AnnualReportResultPayload {
  rivalPlayerId: string;
  entries: AnnualReportEntry[];
}

/** Response for `game:legalCaseUpdate` — sent to both parties on the case (never broadcast
 * to the whole room). `newCash` is per-recipient: present only for the party whose cash
 * actually just moved (a settlement via `game:acceptOffer`), undefined for an offer or a
 * court decision. */
export interface LegalCaseUpdatePayload {
  case: LegalCaseData;
  newCash?: number;
}

/** Broadcast for `chat:message` (server → client) — one chat message, sent to every player in the room. */
export interface ChatMessageBroadcast {
  playerId: string;
  playerName: string;
  message: string;
  timestamp: string;
}

/** Broadcast for `game:readyUpdate` — current ready state for the in-flight turn. `activePlayerCount` excludes bankrupt players, matching the "all active players ready" trigger for early turn resolution. */
export interface GameReadyUpdateResponse {
  readyPlayerIds: string[];
  activePlayerCount: number;
}



export interface GameOverResponse {
  winner: Player;
  finalStandings: PlayerStanding[];
}

export interface PlayerStanding {
  player: Player;
  company: Company | null;
  rank: number;
}

// ============================================================
// Error Response
// ============================================================

export interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown;
}

// ============================================================
// Constants
// ============================================================

/** Maximum number of players per room. This is the single source of truth — both the Prisma schema default and game engine logic reference this value. */
export const MAX_PLAYERS = 4;

// ============================================================
// Utility Types
// ============================================================

export type SocketId = string;

// ============================================================
// Game Engine Types (calculation engine, decision system, etc.)
// ============================================================

export * from './gameTypes.js';

// ============================================================
// Turn Result Types — re-exported for convenience
// ============================================================

export type { PlayerTurnResult, TurnResolutionResult } from './gameTypes.js';

// ============================================================
// Room State (in-memory, for game engine)
// ============================================================

export interface RoomState {
  room: Room;
  players: Map<string, Player>;
  timer: ReturnType<typeof setInterval> | null;
  timerValue: number;
  /** Player ids ready for the in-flight turn — cleared at the start of every new GAME_PHASE round. See `GameEngine.toggleReady`. */
  readyPlayerIds: Set<string>;
  /** Names kicked from this room — blocks a fresh `room:join` (invite-link or Quick Play) reusing that name, for the lifetime of the room. Not a real ban system (no auth in this app — see README's trust model); a determined player could still rejoin under a different name. */
  kickedNames: Set<string>;
  /** This room's fixed, randomly-drawn decision set for the game about to start (or in
   * progress) — decision names only, resolved back to full definitions via
   * `GameEngine.getRoomDeck`. Empty until `GameEngine.startGame` picks it (see
   * `pickRandomDecisionSubset`); never recomputed after that for the life of the game,
   * so every player sees the same set for the whole game, survives reconnects, and
   * SUE THEM CHICKENS' ground catalog is implicitly scoped to it too, since the client
   * only ever knows about decisions it received via `game:deck`. */
  decisionSubset: string[];
}


export type Nullable<T> = T | null;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
}
