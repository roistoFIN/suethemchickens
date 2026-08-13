# ⚖️ Sue Them Chickens

A multiplayer web-based business strategy game where players manage companies and eliminate opponents through bankruptcy.

## 🎮 Game Overview

### Game Flow

The game progresses through a continuous loop until only one player remains:

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                     │
│  Matchmaking ──▶ Game Loop round (120s) ──▶ resolveGameTurn        │
│   (Lobby)         submit decisions          bankruptcy check runs  │
│       ▲            (all players at once)    every round, inline    │
│       │                                              │             │
│       │                              ┌───────────────┴──────┐      │
│       │                        >1 player still active  1 player   │
│       │                              │                left        │
│       │                              ▼                   │        │
│       └───────────── loop back into another Game Loop round        │
│                                                           ▼        │
│                                                     GAME OVER       │
│                                                    (Aftermath)      │
│                                                                     │
└───────────────────────────────────────────────────────────────────┘
```

### Phase Details

| Phase | Name | Description | Timer |
|-------|------|-------------|-------|
| 1 | **Matchmaking** | Players join/create rooms, or use Quick Play | No timer |
| 2 | **Game Loop** | Repeats every round: players submit decisions, server resolves outcomes (P&L, market share, legal risk, bankruptcy check) and broadcasts `turn:resolved` | 120s per round |
| 3 | **Aftermath** | Terminal state — reached the instant only one player remains. Shows the winner and final standings; the game does not return to the Game Loop from here. | 30s |

Bankruptcy is checked as part of every single Game Loop round, not in a separate pass: a
player is eliminated the instant their cash goes below $0 on any turn. The
loop continues — incrementing the round and resolving again every 120s — until only one
player remains, at which point the room moves to Aftermath and the game ends.

### Invite Link Feature

Hosts can share direct web links to invite other players to their room:

1. **Copy Link**: Host clicks the copy icon next to "Room Invite Link" in the lobby → copies URL like `http://localhost:5173/?room=<roomId>` to clipboard
2. **Invite Flow**: When a player opens an invite link, the matchmaking page shows only the "Join a Room" section with the room code pre-filled — "Create a Room" and "Quick Play" are hidden
3. **Normal Flow**: Players who navigate directly to `/matchmaking` see all options (Quick Play, Create Room, Join Room, Available Rooms)
4. **Server Validation**: The room code from the URL is passed as `roomName` in the `room:join` payload; UUID v4 codes (36 chars) and CUID-style IDs (~25 chars) are both supported

### Quick Play Feature

Players can join existing rooms without knowing the room ID through the Quick Play system:

1. **Search**: Player clicks "Search for Available Room" → sends `room:list` event
2. **Room Discovery**: Server merges in-memory active rooms with database rooms for consistency
3. **Auto-Join**: Server finds the room with the fewest players (< 4) and joins the player — invite-only rooms (see *Lobby Features* below) are never a candidate
4. **Fallback**: If no rooms available, a new room is created automatically
5. **Live Updates**: Other players receive `room:playerJoined` events when someone joins

The room list is dynamically updated via the `rooms:list` server event, showing:
- Room ID (truncated)
- Current player count (e.g., 2/4)
- Room status and phase round

### Lobby Features

- **Remembered name** — `Matchmaking.tsx` saves the player's name to `localStorage`
  (`stita_player_name`) the moment it's non-empty, and pre-fills + locks the name field on
  return visits so it never needs re-typing. A **Change Name** button sits next to the
  field, enabled only once a name exists (freshly typed or remembered) — clicking it
  unlocks the field for editing again.
- **`Matchmaking.tsx` lives at `/play`, not `/`** — the site's actual homepage is
  `Home.tsx`, a content hub with a "Play Now" button plus links to every static page
  below. See `App.tsx`'s doc comment for the routing split and the AdSense "low-value
  content" rejection that prompted it, and *Static Content Pages* further down for what
  each page covers.
- **Room Lobby chat** — a simple text chat, shown here as an always-visible inline box
  (`chat:message`, client → server payload `{ message }`, broadcast back to the room as
  `{ playerId, playerName, message, timestamp }`). No longer WAITING-only — the same
  conversation continues into GAME_PHASE and AFTERMATH via a floating chat button on those
  screens; see *In-Game & Game-Over Chat* further down. Ephemeral — nothing is persisted
  server-side, and a newly-joined/rejoined player gets no history replay, only messages
  sent while they're actually in the room (the client's own `chatStore` keeps a continuous
  history across phases for the life of the browser tab — see that section for details).
- **Kicked player redirect** — `room:playerKicked` for *your own* id now fully resets
  `gameStore` (room/player/turn state, not just your roster entry) and clears the saved
  session, landing you back on the plain landing page with a dismissible "You've been
  removed from the room by the host." notification (`App.tsx`'s `NotificationBanner`,
  fixed to the top of the screen, auto-dismisses after 6s).
- **Minimum 2 players to start** — `room:startGame`'s **Start Game** button is disabled
  client-side below 2 players (covers "just created the room" and "kicked back down to
  alone"), and the server independently rejects a `room:startGame` attempt with
  `NOT_ENOUGH_PLAYERS` below 2 regardless of what the client sends.
- **Name-taken message** — trying to join with a name already in use in that room (or a
  name that was just kicked from it, see below) surfaces as a dismissible red alert on the
  landing page instead of failing silently; the same fix also resets the stuck loading
  spinner that any failed join used to leave behind (nothing previously reset it on error).
- **Invite Only** — the host can toggle a room between 🔓 **Public** and 🔒 **Invite Only**
  (`room:setInviteOnly`, host-only, WAITING phase only). An invite-only room is excluded
  from Quick Play matching and the Available Rooms list, but a direct room-code or
  invite-link join is never blocked by it — "invite only" means "not auto-discoverable,"
  not "unjoinable."
- **Leave Room** — a button in the lobby (`room:leave`/`room:left`, WAITING phase only)
  that actually removes the player from the room (DB row deleted, same cleanup as a kick)
  and returns them to a fully-reset landing page: the loading spinner and lobby chat
  history are both explicitly cleared (see CLAUDE.md — neither used to be, since
  `Matchmaking` never unmounts across a room ↔ landing transition, so leftover component
  state from the room you just left would otherwise carry into whatever's next). Distinct
  from GAME_PHASE's **Leave Game**, which forfeits (marks bankrupt) rather than removing
  the player, since there's a game in progress to lose.
- **Bot-opponent countdown** — a lone player in a public room is told, in the lobby, that
  a bot opponent joins in *N* seconds, counting down live (`Room.botJoinInMs`, recomputed
  on every room snapshot; `GameEngine.scheduleBotJoinCheck`'s 10s window). The message is
  always *replaced* rather than just disappearing when that window closes, so the lobby
  never goes silent on the player: **a real player joining first cancels the bot outright**
  ("Real players are in the room — no bot will join"), and if the bot does arrive, the
  notice becomes "real players can still join at any time — the next one to arrive takes
  the bot's seat" (accurate: `joinRoom` removes any bot the instant a human joins).
  Cancelling is scoped to that pending join, not the room forever — if the room drops back
  to one lone human, the countdown re-arms exactly as it already did.
- **Host reassignment** — if the host disconnects past the grace period, gets kicked (host
  can't kick themselves, so this only ever happens via the other two paths), or leaves
  voluntarily, the longest-tenured remaining player (`GameEngine.promoteNewHostIfNeeded`)
  is promoted automatically, both in-memory and in the DB.
- **Kicked players can't rejoin** — each room tracks kicked *names* (`RoomState.kickedNames`
  — see CLAUDE.md for why this is name-based rather than a real ban) and rejects a fresh
  `room:join` reusing one, whether via invite link or Quick Play, for the lifetime of the
  room. Quick Play treats that rejection like any other unusable candidate room (full,
  gone, whatever) — it skips to the next one, or creates a fresh room if none work, rather
  than surfacing a hard error and stranding the player on the landing page.

### Static Content Pages

Real, crawlable, independently-loadable URLs — each checked in `App.tsx` ahead of the
game-phase switch (see CLAUDE.md for the full routing story and the AdSense rejection
that prompted building most of these):

| Path | Component | What it is |
| --- | --- | --- |
| `/` | `Home.tsx` | The actual homepage — pitch, "Play Now" button, links to everything below. |
| `/play` | `Matchmaking.tsx` | The game itself: create/join/quick-play, invite links, lobby. |
| `/how-to-play` | `HowToPlay.tsx` | A screenshot-illustrated walkthrough of a full game, lobby to Game Over. |
| `/rules` | `Rules.tsx` | The precise reference — decision-category caps, elimination conditions, real default numbers. |
| `/strategy` | `StrategyGuide.tsx` | Deeper strategic advice grounded in documented engine behavior. |
| `/glossary` | `Glossary.tsx` | Plain-language definitions for the game's legal and business jargon. |
| `/devlog` | `Devlog.tsx` | Real engineering postmortems, written as plain-language stories. |
| `/whats-new` | `WhatsNew.tsx` | A blog-style changelog of player-facing patch notes, by version. |
| `/admin` | `AdminPortal.tsx` | Token-gated room monitoring + config/decisions/formulas/feedback/analytics. |

An invite link generated before `/play` existed still works — a `/?room=<id>` URL falls
through to the game exactly like `/play?room=<id>` does, rather than stranding an
already-shared link on the new homepage.

`/`, `/rules`, `/strategy`, `/glossary`, `/devlog`, `/how-to-play`, and `/whats-new` each
carry their own manual Google AdSense `AdSlot`, one distinct ad unit per page (see
CLAUDE.md). The cookie-consent banner (`ConsentBanner.tsx`) mounts only on `/` — it used
to be sitewide, which could pop it up over a live game round; now the choice is made once,
up front, before a player ever reaches `/play`.

**SEO/crawler files**: `client/public/robots.txt` (disallows `/admin`, points at
`sitemap.xml`) and `client/public/sitemap.xml` (lists all 8 real pages — update by hand
when adding a new one) both exist now, alongside a real favicon and Open Graph/Twitter
Card image (`client/public/images/og-image.png`), all cropped from the existing
`hero.png` key art. Each routable page except `Home.tsx` sets its own `<title>`/meta
description via `client/src/lib/usePageMeta.ts` — see CLAUDE.md's own section for why
`og:*`/canonical tags can't be varied per page the same way (no SSR).

---

## 🏗️ Architecture

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BROWSERS (Clients)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Player 1   │  │   Player 2   │  │   Player N   │              │
│  │  React + UI  │  │  React + UI  │  │  React + UI  │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                  │                       │
│         └──────────────────┼──────────────────┘                       │
│                        WebSocket                                      │
└────────────────────────┬─────────────────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   SOCKET.IO SERVER  │
              │                     │
              │  • Room Manager     │
              │  • Phase Engine     │
              │  • Action Validator │
              │  • Broadcast Hub    │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐     ┌──────────────────┐
              │   PRISMA ORM        │────▶│   PostgreSQL     │
              │                     │     │   (Game State,   │
              │  • Game State       │     │    Players,       │
              │  • Player Data      │     │    Companies,     │
              │  • Asset Records    │     │    Actions,       │
              └──────────┬──────────┘     └──────────────────┘
                         │
```

### Design Principles

1. **Server-Authoritative**: The server is the single source of truth. Clients send intentions; the server validates and resolves.
2. **Phase-Based State Machine**: Each game phase is an isolated handler, making the system testable and extensible.
3. **Action Logging**: Every action is persisted, enabling replay, debugging, and dispute resolution.
4. **Optimistic UI**: Clients show immediate feedback; the server reconciles authoritative state.
5. **Room Garbage Collection**: Empty rooms are automatically cleaned up from both in-memory state and the database to prevent ghost rooms from appearing in Quick Play queries.
6. **Dual-Source Room Consistency**: Room listings merge in-memory active rooms with database records to ensure accuracy across server restarts and Quick Play scenarios.

---

## 🛠️ Tech Stack

Tech stack is defined in tech-stack.md 

---

## 📁 Project Structure

```
suethemchickens/
├── client/                          # React frontend application
│   ├── public/
│   │   └── images/                  # Static assets served as-is (Vite public/ convention)
│   │       ├── hero.png             # Landing page hero art
│   │       ├── sued.png             # "sued" post-turn info window art
│   │       ├── lawsuit-won.png      # "lawsuit verdict: won as plaintiff" (collected a payout) News art
│   │       ├── lawsuit-lost.png     # "lawsuit verdict: lost" post-turn info window art
│   │       ├── defender-won.png     # "lawsuit verdict: won as defendant" (case dismissed) News art
│   │       ├── settlement-proposal.png # "case settled" post-turn info window art
│   │       ├── shares-bought.png    # "shares bought" post-turn info window art
│   │       ├── turn-change.png      # "turn change" post-turn info window art
│   │       └── lost.png             # "lost" takeover art (bankrupt/forfeit)
│   ├── src/
│   │   ├── components/              # Reusable UI components
│   │   │   ├── Timer.tsx            # Phase countdown timer
│   │   │   ├── ChatWidget.tsx       # Floating in-game/game-over chat button + popup
│   │   │   ├── FeedbackForm.tsx     # Shared 1-5 mood-face rating + text feedback form
│   │   │   ├── FeedbackWidget.tsx   # Floating game-over feedback button + popup (wraps FeedbackForm)
│   │   │   ├── PrivacyPolicyModal.tsx # Shared GDPR privacy policy modal (Home.tsx + Matchmaking.tsx)
│   │   │   └── ...
│   │   ├── pages/                   # Page components
│   │   │   ├── Home.tsx             # / — the real homepage: pitch, Play Now, links to everything
│   │   │   ├── Matchmaking.tsx      # /play — create/join/quick-play, invite links, inline chat
│   │   │   ├── GamePhase.tsx        # The GAME_PHASE loop UI (KPIs, decisions, lawsuits)
│   │   │   ├── GameOver.tsx         # AFTERMATH: winner + final standings
│   │   │   ├── GameTimelineView.tsx # Civilization-style replay/live spectator view
│   │   │   ├── AdminPortal.tsx      # /admin — token-gated room monitoring + config/decisions/
│   │   │   │                        # formulas/feedback/analytics view
│   │   │   ├── HowToPlay.tsx        # /how-to-play — screenshot-illustrated rules walkthrough
│   │   │   ├── Rules.tsx            # /rules — precise reference: caps, elimination, real numbers
│   │   │   ├── StrategyGuide.tsx    # /strategy — deeper strategic advice
│   │   │   ├── Glossary.tsx         # /glossary — legal + business jargon definitions
│   │   │   ├── Devlog.tsx           # /devlog — engineering postmortems as plain-language stories
│   │   │   └── WhatsNew.tsx         # /whats-new — blog-style changelog, player-facing patch notes
│   │   ├── stores/                  # Zustand state stores
│   │   │   ├── gameStore.ts         # Game state (room, phase, timer, turn results)
│   │   │   ├── socketStore.ts       # Socket.IO connection & events
│   │   │   └── chatStore.ts         # Room chat history, continuous across phases
│   │   ├── App.tsx                  # Root component — renders phase/`/admin`/the static
│   │   │                            # content pages directly, no path-based routing for
│   │   │                            # game phases (see CLAUDE.md);
│   │   │                            # also owns the global NotificationBanner and the
│   │   │                            # "lost" takeover (bankrupt/forfeit)
│   │   └── main.tsx                 # Entry point
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── Dockerfile
│   ├── nginx-entrypoint.sh
│   ├── .env.example
│   └── package.json
│
├── server/                          # Node.js backend application
│   ├── src/
│   │   ├── socket/                  # Socket.IO handlers
│   │   │   └── gameEngine.ts        # Room/phase lifecycle + GameLoop orchestration
│   │   ├── engine/                  # Turn-resolution engine (see below)
│   │   │   ├── gameLoop.ts          # Orchestrates one full turn, per-room
│   │   │   ├── calcEngine.ts        # P&L, balance sheet, market share, risk gauge
│   │   │   ├── decisionEngine.ts    # Decision deployment, maturity, exclusions
│   │   │   ├── legalEngine.ts       # Deliberate lawsuit filing (see Lawsuits below)
│   │   │   ├── formulaEngine.ts     # Safe expression parser/evaluator for DB-backed
│   │   │   │                        # formulas (see Formulas below) — no eval/Function/vm
│   │   │   └── defaultFormulas.ts   # The 24 seed formula expressions — shared by
│   │   │                            # prisma/seed.ts and the engine test fixtures
│   │   ├── data/                    # Seed-only now — see Decisions & Game Config below
│   │   │   ├── game_engine.json     # Decision library: impacts, legal risks, exclusions
│   │   │   └── game_config.json     # Starting values + admin-tunable variables
│   │   ├── validation/              # Zod schemas
│   │   │   └── schemas.ts           # All input validation
│   │   ├── services/                # External service clients + persistence helpers
│   │   │   ├── llmService.ts        # Local llama.cpp client — AI-narrated annual report text
│   │   │   ├── eventLogService.ts   # Best-effort EventLog writer (see EventLog below)
│   │   │   └── analyticsService.ts  # Pure aggregation behind the Analytics tab's dashboards
│   │   ├── middleware/
│   │   │   └── adminAuth.ts         # ADMIN_TOKEN gate for /api/admin/* (see Admin Portal below)
│   │   └── index.ts                 # Server entry point + REST endpoints (/health, /api/room,
│   │                                 # /api/admin/*)
│   ├── prisma/
│   │   ├── schema.prisma            # Database schema (incl. Decision, GameConfigRow,
│   │   │                            # Formula — the decision library, game config, and
│   │   │                            # pure-math formulas, all DB-backed)
│   │   ├── seed.ts                  # npm run db:seed — seeds Decision/GameConfigRow
│   │   │                            # from server/src/data/*.json and Formula from
│   │   │                            # defaultFormulas.ts (idempotent)
│   │   └── migrations/              # Database migrations
│   ├── .env.example                 # Environment variables template
│   ├── .env                         # Environment variables (gitignored)
│   ├── Dockerfile
│   ├── tsconfig.json
│   └── package.json
│
├── shared/                          # Shared types between client/server
│   ├── src/
│   │   ├── index.ts                 # Room/player/socket-event types, enums, payloads
│   │   └── gameTypes.ts             # Engine types: DecisionDefinition, PlayerVariables,
│   │                                 # LegalCaseData, TurnResolutionResult, GameConfig
│   ├── tsconfig.json
│   └── package.json
│
├── tests/                           # Integration & E2E Tests
│   ├── api/                         # Vitest interface tests (DB via testcontainers)
│   │   ├── health.test.ts
│   │   ├── room.test.ts             # Room/Player/Company CRUD, incl. engineState/variables
│   │   ├── socket.test.ts           # Socket.IO event contracts (incl. game:submitDecisions,
│   │   │                            # turn:resolved, game:over)
│   │   └── validation.test.ts       # Zod schema contracts
│   ├── e2e/                         # Playwright E2E tests
│   │   ├── matchmaking.spec.ts      # Lobby: create/join/quick-play/invite-link flows
│   │   └── gamePhase.spec.ts        # Starting a game reaches GAME_PHASE cleanly
│   ├── playwright.config.ts
│   ├── vitest.config.ts
│   └── test-setup.ts
│
├── models/                          # Local LLM weights (gitignored — see "Local LLM" below)
├── .github/                         # GitHub Actions CI/CD
├── .dockerignore
├── Dockerfile                       # Full-stack multi-stage build
├── docker-compose.yml               # Docker orchestration (PostgreSQL, server, client, llm)
├── package.json                     # Monorepo root (workspaces)
├── .gitignore
└── README.md                        # This file
```

---

## 🗄️ Data Model

### Entity Relationship Diagram

```
┌──────────┐       ┌──────────┐       ┌──────────┐
│  Room    │1    *│  Player  │1    1│ Company  │
├──────────┤       ├──────────┤       ├──────────┤
│ id       │──────▶│ id       │──────▶│ id       │
│ status   │       │ name     │       │ playerId │
│ maxPlayers│      │ roomId   │       │ cash     │
│ round    │       │ isHost   │       │ debt     │
│ createdAt│       │ socketId │       └────┬─────┘
└──────────┘       │ bankrupt │            │
                   │ createdAt│            │
                   │          │ 1    *  ┌──▼────┐
                   │          │       │  │ Asset │
                   │          │       │  └───────┘
```

### Database Schema (Prisma)

```prisma
model Room {
  id                String       @id @default(cuid())
  status            RoomStatus   @default(WAITING)
  maxPlayers        Int          @default(4)
  currentPhaseRound Int          @default(1)
  createdAt         DateTime     @default(now())
  inviteOnly        Boolean      @default(false) // host-toggled — see "Invite Only" above
  players           Player[]

  @@index([status])
  @@index([createdAt])
}

model Player {
  id              String     @id @default(cuid())
  name            String
  roomId          String
  room            Room       @relation(fields: [roomId], references: [id], onDelete: Cascade)
  isHost          Boolean    @default(false)
  bankrupt        Boolean    @default(false)
  // Round eliminated in (bankruptcy, merger/takeover, or forfeit) — null while active.
  // See "Game Timeline" below for why this is needed.
  eliminatedRound Int?
  socketId        String?
  createdAt       DateTime   @default(now())
  companyId       String?    @unique
  company         Company?

  @@index([roomId])
  @@index([roomId, bankrupt])
}

// All per-player game-engine state lives in JSONB columns so GameLoop can read/write
// it atomically each turn without a schema migration per new field. `cash`/`debt` stay
// as typed columns too, for quick queries (e.g. bankruptcy checks, standings).
model Company {
  id                String  @id @default(cuid())
  playerId          String  @unique
  player            Player  @relation(fields: [playerId], references: [id], onDelete: Cascade)
  cash              Decimal @default(100000) @db.Decimal(15, 2)
  debt              Decimal @default(0)      @db.Decimal(15, 2)
  // Full PlayerVariables (cash, assets, price, outrage, scrutiny, ...) — the turn-resolution math
  variables         Json    @default("{}")
  // Snapshot of last turn's computed results, for UI display/history
  lastTurnSnapshot  Json?   @default("{}")
  // activeDecisions, depreciationLedger, legalCases, investigations (GameLoop's CompanyEngineState)
  engineState       Json    @default("{}")
  assets            Asset[]

  @@index([playerId])
}

model Asset {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  type      String
  value     Decimal  @db.Decimal(15, 2)

  @@index([companyId])
}

// One row per player per round — the source of the KPI history graphs (every KPI card
// and breakdown line item is clickable, see "KPI History & Prediction" above). Stores
// the same variables/derived/riskGauge shape turn:resolved already carries per player,
// verbatim, so any current or future clickable field can be graphed without a further
// migration. Written by GameEngine, never read/written by GameLoop itself.
model KpiSnapshot {
  id        String   @id @default(cuid())
  playerId  String
  player    Player   @relation(fields: [playerId], references: [id], onDelete: Cascade)
  round     Int
  variables Json
  derived   Json
  riskGauge Float
  createdAt DateTime @default(now())

  @@unique([playerId, round])
  @@index([playerId])
}

// Durable lawsuit lifecycle log — the live LegalCaseData inside Company.engineState.
// legalCases only survives one extra turn past its own resolution, so a separate table
// is needed to answer "every lawsuit filed/resolved" across a whole game (see "Game
// Timeline" below). One row per case (id == LegalCaseData.id), created at filing,
// updated once at resolution. Deliberately no FK to Player — only to Room — since a
// Player row can be deleted independently; names are denormalized at write time.
model LegalCaseHistory {
  id            String   @id
  roomId        String
  room          Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  plaintiffId   String
  plaintiffName String
  defendantId   String
  defendantName String
  decisionName  String
  groundName    String
  description   String
  stakes        Decimal  @db.Decimal(15, 2)
  filedRound    Int
  resolvedRound Int?
  verdict       String?  // 'won' | 'lost' | 'settled' | 'cancelled'
  createdAt     DateTime @default(now())

  @@index([roomId])
  @@index([roomId, filedRound])
}

// Player-submitted feedback (see "Player Feedback" above) — a 1-5 Likert rating plus
// optional free text. Deliberately no FK to Player/Room at all: fully anonymous by
// design, submitted via a plain public REST endpoint (POST /api/feedback), read back
// only via GET /api/admin/feedback (admin-token gated, read-only).
model Feedback {
  id        String   @id @default(cuid())
  rating    Int
  message   String?
  source    String   // 'landing' | 'gameover'
  createdAt DateTime @default(now())

  @@index([createdAt])
}
```

---

## 🔌 Real-Time Communication

### Socket.IO Events

#### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `room:join` | `{ playerName, roomName?, searchForRoom? }` | Join a specific room by ID (`roomName`), create one (no params), or search for an available room (`searchForRoom: true`). When joining via invite link, `roomName` contains the UUID v4 room code from the URL query param. |
| `room:rejoin` | `{ roomId, playerId }` | Resume an existing session on a new socket — after a page refresh, an accidental back button, or a brief network drop — as long as it's within the server's reconnect grace period. See *Reconnection & Session Resume* below. |
| `room:list` | — | Request list of available rooms |
| `room:kick` | `{ playerId }` | Host removes a player from the room |
| `room:leave` | — | Voluntarily leave the room lobby — WAITING phase only. Distinct from `game:leave`'s GAME_PHASE forfeit; this actually removes the player rather than marking them bankrupt. See *Lobby Features* above. |
| `room:setInviteOnly` | `{ inviteOnly }` | Host toggles whether the room can be found via Quick Play / the Available Rooms list — WAITING phase only. Never blocks a direct room-code/invite-link join. |
| `room:startGame` | — | Host starts the game (WAITING → GAME_PHASE, round 1) |
| `game:submitDecisions` | `{ strategic: DecisionEntry[], operational: DecisionEntry[], financial: DecisionEntry[], lawsuits: LawsuitEntry[] }` | Full replacement of this turn's pending decisions (`{ name, targetId?, amount? }` each) *and* deliberate lawsuit filings (`{ targetId, decisionName, groundName }` each — see *Lawsuits* below). `financial` is Buy Shares/Sell Shares' own decision-type category, capped independently of strategic/operational. Structural validation only — per-turn limits (max 1 strategic / 2 operational / 2 financial / 3 lawsuits) come from `game_config.json` and are enforced by `GameLoop.processNewDecisions` / `GameLoop`'s lawsuit-filing step. |
| `game:digDeeper` | `{ attackId }` | Pay `gameSettings.digDeeperCost` ($10,000 by default) plus a wealth-scaled surcharge (`wealthScaledFeeRate`, 3% of the payer's own current cash by default) to reveal the next tier of intel on one incoming attack — instant, outside the turn-resolution cycle. See *Attack Awareness & Dig Deeper* below. |
| `game:fileLawsuit` | `{ targetId, decisionName, groundName }` | Pay `gameSettings.lawsuitFilingCost` ($15,000 by default) plus the same wealth-scaled surcharge the instant a lawsuit is actually filed — instant, outside the turn-resolution cycle, same pattern as `game:digDeeper`. The client still separately queues the same entry via `game:submitDecisions` for the case itself to be created at the next turn resolution. See *Lawsuits* below. |
| `game:getAnnualReport` | `{ rivalPlayerId }` | Request AI-narrated "annual report" text for one rival's active decisions — on demand, outside the turn-resolution cycle. See *AI-Narrated Annual Reports* below. |
| `game:getKpiHistory` | `{ targetPlayerId? }` | Request KPI history (persisted `KpiSnapshot` rows) — on demand, opened by clicking any KPI card or breakdown line item. Omitted (or equal to the caller's own id) returns "my own data" plus a 3-turn-ahead prediction; any other id in the same room returns that rival's history only, no prediction. See *KPI History & Prediction* below. |
| `game:makeOffer` | `{ caseId, amount }` | Make (or counter) a settlement offer on a case still `'negotiating'` — instant, outside the turn-resolution cycle. Only the party who did *not* make the most recent offer may call this (the defendant, if none has been made yet). See *Lawsuits* below. |
| `game:acceptOffer` | `{ caseId }` | Accept the other party's most recent offer, settling the case immediately for that amount — instant. Only the party who did not make that offer may call this. |
| `game:goToCourt` | `{ caseId }` | End negotiation and send a case to trial — instant. Either party may call this at any time while the case is `'negotiating'`; only marks it `awaiting_trial`, the verdict itself is still drawn at the next turn resolution. |
| `game:getGameTimeline` | — | Request the whole room's game-timeline replay/spectator data (every player's KPI history, every decision deployed, every lawsuit filed/resolved) — no payload, unlike every other on-demand request here. Valid in both GAME_PHASE (a live-spectating eliminated player) and AFTERMATH (the finished-game replay). See *Game Timeline* below. |
| `game:leave` | — | Voluntary forfeit — GAME_PHASE only. Instant bankruptcy for the requesting player; the game continues for everyone else. See *Leave Game* below. |
| `game:ready` | `{ ready }` | Toggle ready status for the in-flight turn — GAME_PHASE only. Once every active player is ready, the turn resolves immediately. See *Ready-Up* below. |
| `chat:message` | `{ message }` | Send a chat message to the room — any room phase (WAITING, GAME_PHASE, AFTERMATH). See *Lobby Features* / *In-Game & Game-Over Chat* below. |

#### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room:joined` | `{ room, player, companies }` | Successfully joined a room — also the response to a successful `room:rejoin` |
| `room:left` | — | Sent only to the requesting socket, confirming a successful `room:leave` — the client's cue to reset to the landing page |
| `room:playerJoined` | `{ playerId, playerName, isHost, roomId }` | New player joined the room |
| `room:playerKicked` | `{ kickedPlayerId, kickedPlayerName }` | Player was kicked from room |
| `room:playerLeft` | `{ playerId, playerName, roomId }` | A disconnected player's reconnect grace period expired without them coming back — they're now actually removed. Never fires for a disconnect that reconnects in time; the rest of the room isn't told about those at all. |
| `room:updated` | `{ room }` | Broadcast to the whole room whenever the roster or room-level settings change outside a fresh join (kick, `room:leave`, host reassignment, `room:setInviteOnly`) — always a freshly-rebuilt `Room` snapshot (`GameEngine.buildRoomSnapshot`), never a stale cached one. Deliberately carries no `player` field, unlike `room:joined` — see *Game Engine Architecture* below for why that matters. |
| `rooms:list` | `{ rooms: RoomInfo[] }` | List of available rooms (Quick Play) — never includes invite-only rooms |
| `phase:changed` | `{ phase, round, timeLimit }` | Room advanced phase, or looped into another GAME_PHASE round |
| `timer:update` | `{ timeLeft }` | Countdown tick |
| `game:deck` | `{ decisions: DecisionDefinition[], gameSettings: GameSettings }` | Sent once, right when GAME_PHASE starts — this game's own fixed, randomly-drawn 50-decision set (see *Business Decisions* below) and per-turn limits, static for the whole game. Also re-sent on a successful `room:rejoin` during GAME_PHASE, with the identical set the game started with. |
| `turn:resolved` | `TurnResolutionResult` (`{ round, players: PlayerTurnResult[], gameOver, winnerId? }`) | Sent twice per round-1: once immediately when the game starts (starting-position preview, `GameLoop.getInitialSnapshot`), and again whenever a GAME_PHASE turn actually finishes resolving (`GameLoop.resolveTurn`) — full per-player state either way. `GameEngine` caches the most recent one per room and re-sends it on a successful `room:rejoin` during GAME_PHASE, so a reconnecting player doesn't wait for the next turn to see where things stand. |
| `player:bankrupt` | `{ playerId, playerName }` | Player eliminated — either their cash went below $0 this turn, or they voluntarily forfeited via `game:leave` |
| `game:over` | `{ winner, finalStandings }` | Only one player remains; room moved to AFTERMATH. Also re-sent on a successful `room:rejoin` during AFTERMATH. |
| `game:digDeeperResult` | `{ attackId, cost, newCash, attack: IncomingAttackInfo }` | Sent only to the requesting socket, never broadcast — the newly-unlocked intel tier for one attack |
| `game:fileLawsuitResult` | `{ cost, newCash }` | Sent only to the requesting socket, on a successful `game:fileLawsuit` charge — a failed charge (insufficient funds, per-turn limit reached) is reported via the generic `error` event instead, same convention as `game:digDeeper` |
| `game:annualReportResult` | `{ rivalPlayerId, entries: AnnualReportEntry[] }` | Sent only to the requesting socket, never broadcast — AI-narrated (or static-fallback) flavor text for the rival's active decisions |
| `game:kpiHistoryResult` | `{ playerId, history: KpiSnapshotPoint[], predicted: KpiSnapshotPoint[], bankruptAtRound? }` | Sent only to the requesting socket — persisted KPI history (oldest round first) for whichever player was requested (`playerId`). Self requests get up to 3 predicted future turns too; rival requests always come back with `predicted: []`. |
| `game:legalCaseUpdate` | `{ case: LegalCaseData, newCash? }` | Sent to BOTH parties on a case (never broadcast to the room) whenever `game:makeOffer`/`game:acceptOffer`/`game:goToCourt` succeeds. `newCash` is per-recipient — present only for whichever party's cash actually just moved (a settlement), undefined for an offer or a court decision. A validation failure (not your turn, case not found, etc.) goes only to the requesting socket via `error` instead. |
| `game:gameTimelineResult` | `{ roomId, currentRound, gameOver, winnerId?, players: TimelinePlayerInfo[], kpiHistory: Record<string, KpiSnapshotPoint[]>, decisions: TimelineDecisionEvent[], lawsuits: TimelineLawsuitEvent[] }` | Sent only to the requesting socket, in response to `game:getGameTimeline` — the whole room's history at once, not per-target like `game:kpiHistoryResult`. See *Game Timeline* below. |
| `game:left` | — | Sent only to the requesting socket, confirming a successful `game:leave` forfeit — the client's cue to show the "lost" takeover with the forfeit-specific message |
| `game:readyUpdate` | `{ readyPlayerIds: string[], activePlayerCount: number }` | Broadcast on every `game:ready` toggle, and reset to an empty `readyPlayerIds` at the start of every new round |
| `chat:message` | `{ playerId, playerName, message, timestamp }` | Broadcast to the room in response to a `chat:message` from any player in it |
| `error` | `{ code, message }` | Error occurred (e.g. `NOT_HOST`, `INVALID_DECISIONS`, `REJOIN_FAILED`, `ANNUAL_REPORT_FAILED`, `NOT_ENOUGH_PLAYERS`, `LEAVE_GAME_FAILED`, `INVALID_READY`, `INVALID_CHAT_MESSAGE`, `NAME_TAKEN`, `ROOM_FULL`, `ROOM_NOT_FOUND`, `KICKED_FROM_ROOM`, `LEAVE_ROOM_FAILED`, `INVALID_INVITE_ONLY`, `MAKE_OFFER_FAILED`, `ACCEPT_OFFER_FAILED`, `GO_TO_COURT_FAILED`) — the three negotiation failure codes carry a `message` matching `LegalCaseActionOutcome`'s `reason` (`case_not_found`, `not_negotiating`, `not_a_party`, `not_your_turn`, `no_offer_to_accept`, `invalid_amount`) |

### API Type Definitions

```typescript
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

export interface RoomJoinPayload {
  playerName: string;
  roomName?: string;
  searchForRoom?: boolean;
}

export interface RoomRejoinPayload {
  roomId: string;
  playerId: string;
}

export interface RoomSetInviteOnlyPayload {
  inviteOnly: boolean;
}

/** Broadcast for `room:updated` — see the enum entry for why this never carries a `player` field. */
export interface RoomUpdatedResponse {
  room: Room;
}

/** One rival's active decision, narrated for their "annual report" — see `game:getAnnualReport`. */
export interface AnnualReportEntry {
  decisionName: string;
  text: string;   // AI-generated (or static-fallback) flavor text — never the real numbers
  year: number;   // deployedYear + 1
}

export interface ChatMessagePayload {
  message: string;
}

export interface ChatMessageBroadcast {
  playerId: string;
  playerName: string;
  message: string;
  timestamp: string;
}

export interface GameReadyPayload {
  ready: boolean;
}

export interface GameReadyUpdateResponse {
  readyPlayerIds: string[];
  activePlayerCount: number;
}
```

### Zustand State Stores

The client uses Zustand for lightweight, TypeScript-safe state management:

#### `gameStore.ts`

Manages all game-related state including room state, player data, phase tracking, and timer.

| Method | Description |
|--------|-------------|
| `updateRoom(room)` | Replace the current room state |
| `updatePlayer(player)` | Replace the current player object with updated DB-generated ID |
| `kickPlayer(playerId)` | Remove a player from the room — despite the name, just "remove from roster"; also reused for the `room:playerLeft` (grace-period-expired) case |
| `addPlayer(player)` | Add a new player to the room when they join dynamically |
| `markPlayerBankrupt(playerId)` | Mark a player as bankrupt and remove them from active play |
| `updatePhase(data)` | Update the current game phase, round, and timer |
| `updateTimer(timeLeft)` | Update the countdown timer value |
| `handleTurnResolved(data)` | Replace `turnResults` with the latest `turn:resolved` payload |
| `clearTurnResults()` | Clear `turnResults` |
| `applyDigDeeperResult(playerId, data)` | Immutably patches just the requesting player's cash + the matching `incomingAttacks` entry inside `turnResults` — the instant, out-of-band response to `game:digDeeper`, applied without waiting for the next turn |
| `applyFileLawsuitResult(playerId, newCash)` | Immutably patches just the requesting player's cash inside `turnResults` — the instant, out-of-band response to `game:fileLawsuit`, same "don't wait for the next turn" reasoning as `applyDigDeeperResult` |
| `setAnnualReportLoading(rivalPlayerId)` | Marks one rival's AI annual report as in-flight, so `RivalFullReportView` doesn't fire a duplicate `game:getAnnualReport` while waiting |
| `applyAnnualReportResult(rivalPlayerId, entries)` | Caches the AI-narrated entries for one rival, keyed by id — the response to `game:getAnnualReport` |
| `setGameDeck(data)` | Store the decision library + per-turn limits |
| `setGameOver(data)` | Set game over state with winner and standings |
| `clearGameOver()` | Clear game over state |
| `setError(error)` | Set error state |
| `setNotification(message)` | Set UI notification message |
| `setCompanies(companies)` | Update company data for all players |
| `setIsRejoining(isRejoining)` | Toggle the "attempting to resume a saved session" flag — gates `App.tsx`'s first paint so Matchmaking doesn't flash before a `room:rejoin` attempt resolves |
| `resetSession()` | Wipes room/player/in-game state back to a fresh landing-page state — used when a player is kicked, or acknowledges the "lost" takeover via **Return to Start** |
| `setSelfEliminationReason(reason)` | Sets `selfElimination` (`'bankrupt' \| 'forfeit' \| 'merged'`) — checked by `App.tsx` ahead of the normal phase switch to show the full-screen "lost" takeover regardless of what phase the room is actually in. Set from `player:bankrupt` for the current player's own id (`'bankrupt'` or `'merged'`), then upgraded to `'forfeit'` if a `game:left` ack follows. Also resets `hasAcknowledgedElimination` to `false`, defensively. |
| `acknowledgeElimination()` | Sets `hasAcknowledgedElimination: true` — the "Watch the rest of the game" button's action, swapping the one-time "lost" takeover for the live `GameTimelineView` spectator view. Deliberately not persisted to `localStorage`; resets each session. See *Game Timeline* above. |

#### `socketStore.ts`

Manages the Socket.IO connection and event routing, plus session persistence for
reconnection (see *Reconnection & Session Resume* below):

| Method | Description |
|--------|-------------|
| `send(event, payload)` | Emit a socket event to the server |
| `on(event, handler)` | Subscribe to a server event, returns unsubscribe function |
| `disconnect()` | Close the socket connection |
| `returnToLanding()` | Clears the saved session and calls `gameStore.resetSession()` — the shared "acknowledge and go back to the landing page" step behind both a kick and the "lost" takeover's **Return to Start** button |

**Key event handlers:**
- `connect` → If a session (`{ roomId, playerId }`) is saved in `localStorage`, sets
  `isRejoining` and emits `room:rejoin`. Fires on the first connect *and* on every
  Socket.IO-driven auto-reconnect after a transient drop — so a brief network blip with
  the tab still open self-heals here too, not just a full page reload.
- `room:joined` → Calls `gameStore.updateRoom()`/`updatePlayer()`, and saves the session
  to `localStorage` — covers both a fresh join and a successful rejoin, since the server
  reuses this same event for both
- `room:playerJoined` → Calls `gameStore.addPlayer()` with deduplication guard
- `room:playerKicked` → For *my own* id: clears the saved session and calls
  `gameStore.resetSession()` plus `setNotification(...)`, landing back on the plain
  landing page — not just a roster removal. For anyone else, calls `gameStore.kickPlayer()`
  (roster removal only).
- `room:playerLeft` → Calls `gameStore.kickPlayer()` (same roster-removal logic) plus a
  distinguishing notification ("…connection timed out")
- `room:updated` → Calls `gameStore.updateRoom()`, then re-derives *my own* player object
  by matching my own id inside the fresh roster and calling `updatePlayer()` with that
  entry — not a shared `player` field from the payload (there isn't one). This is the fix
  for a real bug: broadcasting one shared player object to the whole room after a kick
  used to silently overwrite every other client's own identity with the kicking host's.
  Also how a newly-promoted host's own `isHost` flag reaches their own client, not just
  how others see them.
- `room:left` → Clears the saved session and calls `gameStore.resetSession()` plus
  `setNotification('You left the room.')` — the ack for my own voluntary `room:leave`
- `phase:changed` → Calls `gameStore.updatePhase()`
- `timer:update` → Calls `gameStore.updateTimer()`
- `player:bankrupt` → Calls `gameStore.markPlayerBankrupt()`; for *my own* id, also calls
  `setSelfEliminationReason('bankrupt')` — see *Leave Game* above; for anyone else's,
  calls `enqueueBankruptcyEvent()` instead — see *Bankruptcy & Game Over* below
- `game:over` → Calls `gameStore.setGameOver()`; clears the saved session (nothing left
  to reconnect to)
- `game:digDeeperResult` → Calls `gameStore.applyDigDeeperResult()`
- `game:fileLawsuitResult` → Calls `gameStore.applyFileLawsuitResult()`
- `game:annualReportResult` → Calls `gameStore.applyAnnualReportResult()`
- `game:left` → Calls `setSelfEliminationReason('forfeit')` — upgrades the reason set by
  the `player:bankrupt` handler moments earlier; does **not** itself reset the session,
  that's deferred to the takeover screen's **Return to Start** button
- `error` → Calls `gameStore.setError()`; a `REJOIN_FAILED` code additionally clears the
  saved session and `isRejoining`, so a stale/expired session self-heals into the normal
  landing page
- `chat:message` → Calls `chatStore.addMessage()` — registered globally here rather than
  inside whichever page currently renders a chat surface, since `chatStore`'s whole point
  is surviving the unmount/remount every phase transition causes (see below)

Also calls `chatStore.resetForRoom(data.room.id)` from its own `room:joined` handler, right
alongside the session-persistence bookkeeping above — see `chatStore.ts` below for why.

#### `chatStore.ts`

Room chat history — a continuous conversation across the WAITING lobby, GAME_PHASE, and
AFTERMATH, independent of which page component currently renders a chat surface (`gameStore`
also swaps `room`/`currentPhase` across a phase change, but the chat message list living in
its *own* store, not `gameStore`, is what lets it survive `App.tsx` unmounting one page
component and mounting another off that same `currentPhase` switch — see *In-Game &
Game-Over Chat* above). Both the lobby's inline chat box (`Matchmaking.tsx`) and every
floating `ChatWidget` instance (`GamePhase.tsx`, `GameTimelineView.tsx`) read and write this
one store.

| Field / Method | Description |
|--------|-------------|
| `messages` | The room's chat history, in order — a plain `ChatMessageBroadcast[]` |
| `isVisible` | True while a chat surface is currently on-screen and presumed being read (the lobby's inline box while mounted, or a popup while open) — gates whether `addMessage` counts an incoming message as unread |
| `unreadCount` | How many messages have arrived since `isVisible` was last true — the number shown on `ChatWidget`'s floating button badge |
| `addMessage(message)` | Appends to `messages`; increments `unreadCount` only if `isVisible` is false |
| `show()` | Marks the chat surface visible and clears `unreadCount` — called when a `ChatWidget` popup opens, or while the lobby's inline box is mounted |
| `hide()` | Marks the chat surface no longer visible — called when a popup closes/unmounts, or the lobby is left |
| `resetForRoom(roomId)` | Clears `messages`/`unreadCount`/`isVisible` only if `roomId` is actually different from the room this store currently holds history for — a no-op for a same-room rejoin or an ordinary phase change, so history survives exactly the transitions it's meant to |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20+ and npm 9+
- **Docker** and **Docker Compose** (for containerized deployment)

### Option 1: Local Development (Recommended for Development)

```bash
# 1. Clone and enter the project
cd suethemchickens

# 2. Start PostgreSQL via Docker
docker-compose up -d postgres

# 3. Install all dependencies (monorepo workspaces)
npm install

# 4. Set up the database
cp server/.env.example server/.env
npm run db:generate
npm run db:migrate
npm run db:seed   # required — the server loads the decision library + game config
                  # from the database at startup, not from JSON directly (see
                  # "Decisions & Game Config" below); it won't start without this

# 5. Start development servers (client + server with hot reload)
npm run dev
```

The application will be available at:
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001

### Option 2: Full Docker Deployment

```bash
# 1. Clone and enter the project
cd suethemchickens

# 2. Build and start all services (PostgreSQL, server, client)
docker-compose up -d --build

# 3. Apply migrations + seed the decision library/game config against the
# containerized Postgres — required once (the server container doesn't run
# migrations/seed automatically on boot): from server/, pointed at the exposed
# Postgres port, e.g.
#   DATABASE_URL=postgresql://stita:stita_password@localhost:5432/stita_db \
#     npx prisma migrate deploy && npm run db:seed
#
# The application will be available at:
# - Frontend: http://localhost:80
# - Backend API: http://localhost:3001
```

### Local LLM (optional — AI-narrated annual report text)

The rival "Full Filing" annual report uses a local LLM (see *AI-Narrated Annual
Reports* below) instead of the old fixed flavor text. This is fully optional — the
game works identically without it, falling back to the original static text.

```bash
# 1. Download the model (not committed to the repo — ~1.1GB)
mkdir -p models
# Place Qwen3-1.7B-Q4_K_M.gguf in ./models/ — e.g. from https://huggingface.co/Qwen/Qwen3-1.7B-GGUF

# 2. Start the llama.cpp server
docker-compose up -d llm

# The server (LLM_URL) checks http://localhost:8080 by default in local dev;
# in the full Docker stack it resolves to the `llm` service automatically.
```

### Admin Portal (optional — room monitoring)

`/admin` (see *Admin Portal* below) is disabled by default — set `ADMIN_TOKEN` in
`server/.env` (local dev) or in your shell/root `.env` before `docker-compose up`
(it's read via `${ADMIN_TOKEN}` in `docker-compose.yml`). Unset = the admin API
returns 503 for every request; this never affects the game itself.

### Rebuilding and Restarting

```bash
# Rebuild Docker containers (after code changes)
docker-compose up -d --build

# Rebuild only a specific service
docker-compose up -d --build server
docker-compose up -d --build client

# Restart all services (without rebuilding)
docker-compose restart

# Stop all Docker services
docker-compose down

# Stop and remove volumes (wipes database!)
docker-compose down -v
```

### Database Management

```bash
# Generate Prisma client (after schema changes)
npm run db:generate

# Run pending migrations
npm run db:migrate

# Reset database (drops and recreates all tables)
npx prisma migrate reset

# Open Prisma Studio (database GUI)
npm run db:studio

# Seed the decision library + game config from server/src/data/*.json — required
# after a fresh migrate/reset, since GameEngine now loads both from the database,
# not from the JSON files directly (see "Decisions & Game Config" below). Idempotent.
npm run db:seed
```

### Individual Service Commands

```bash
# Start only the backend server
npm run dev:server

# Start only the frontend client
npm run dev:client

# Build for production
npm run build

# Build only client or server
npm run build:client
npm run build:server
```

### Environment Variables

**Server** (`server/.env` — copy from `server/.env.example`):

```env
DATABASE_URL="postgresql://stita:stita_password@localhost:5432/stita_db"
PORT=3001
NODE_ENV=development
CLIENT_URL=http://localhost:5173
LLM_URL=http://localhost:8080   # optional — see "Local LLM" below; falls back to static text if unset/unreachable
ADMIN_TOKEN=                    # optional — enables /admin (see "Admin Portal"); unset disables the admin API
```

**Client** (`client/.env` — copy from `client/.env.example`):

```env
VITE_SERVER_URL=http://localhost:3001
```

> **Note**: When running via Docker Compose, environment variables are injected automatically. The client uses `http://server:3001` internally, and the server uses the PostgreSQL service name `postgres`.

---

## 🎯 Game Mechanics

Full detail lives in the turn-resolution engine itself — `gameLoop.ts`'s `resolveTurn`
(its numbered `// ── Step N ──` comments are the current, accurate execution order) and
`calcEngine.ts`/`decisionEngine.ts`/`legalEngine.ts`'s own doc comments — plus the
`Decision` table's data (seeded from, and originally mirrored by,
`server/src/data/game_engine.json` — see *Decisions & Game Config* below).
This section is a summary of what the server's `engine/` actually does.

### Business Decisions (Game Loop)

The instant the host starts the game, every player lands straight in the game room
showing their real starting position (cash, equity, revenue, stock value) — `GameLoop`
computes this via `getInitialSnapshot`, the same formula pipeline as a real turn but with
zero decisions applied and nothing persisted, so there's no blank "waiting" screen for
the first round's timer.

The client renders the actual Decision Deck from `game:deck` — filterable by level
(Strategic/Operational/Financial) and nature (Traditional/Grey Area/Dirty), each its own row of
filter chips (two independent filters, not one combined chip group), one card per decision
with its description, an **EFFECTS** panel, and a DEPLOY button. The effects panel
answers "what does this do, when does it start, how long does it last": a maturity
badge (`INSTANT` or `MATURES IN Nt`, from the max explicit year key across the
decision's impact schedules) plus a per-field timeline, built client-side from the raw
`impacts` schedules (no server round-trip). The timeline's trailing schedule value is
labeled differently depending on which kind of field it's attached to — a decision's own
field only ever applies that value ONCE, at the turn it matures, and is never re-applied
after (see CLAUDE.md's *"Root historical bug"* section), so it's labeled `Permanent`
(e.g. `Yr 1: -$100,000 → Yr 2: -$100,000 → Permanent: +40%`); a `target.*` field genuinely
re-applies that value to the chosen opponent every turn until the statute of limitations
(or a successful lawsuit voids the instance first), so it's labeled `Every turn until Yr N`
instead. Effects are further split into two visually separate groups, **EFFECTS ON YOU**
and **EFFECTS ON TARGET** (the latter only rendered for a decision that actually has a
`target.*` field — most of the library doesn't), rather than one flat list where a
`Target's …`-prefixed row could be missed among the deploying player's own KPIs. Clicking DEPLOY
(target picker first, for `requiresTarget` decisions like Buy Shares) queues it locally
and re-sends the player's full pending selection via `game:submitDecisions` on every
change — the server treats each submission as a full replacement, not an increment. The
deck mirrors `DecisionEngine.canDeploy`'s exclusion rules client-side (same decision
maturing, forward/reverse `excludes`) so a card is visibly greyed out with a reason
rather than letting a player queue a move the server would reject.

The deck itself opens from a **MAKE IMPORTANT DECISIONS** button inside the **Active
Decisions** box, rather than sitting inline as its own panel — the same "button opens a
modal" shape the **SUE THEM CHICKENS** button already uses for the Sue modal. Whatever's
queued this turn shows up in the **Active Decisions** box directly too, not just inside
that modal — a red `QUEUED` badge alongside the already-active decisions, with its own
**Cancel** link right there (no need to reopen the deck just to back out of a pick). The
box's header count (`"X strategic, Y operational, and Z financial"`) includes both active and queued
decisions together. The same goes for a filed-but-not-yet-created lawsuit in the **Open
Lawsuits** box: it appears as a `QUEUED` entry with a **Remove** link there — the
`SUE THEM CHICKENS` modal itself shows only a queued-count line (not its own duplicate
list of what's queued) and closes itself automatically the instant a lawsuit is
successfully filed, since the Open Lawsuits box is where a player actually confirms/
cancels a queued filing from that point on. All of this reads and writes the exact same
`pending` client state the deck/Sue modal already use — cancelling re-sends the same
full-replacement `game:submitDecisions` payload with that one entry filtered out.

The **Active Decisions** box itself (`ActiveDecisionsBox` in `GamePhase.tsx`) can filter
its list by status (`All`/`Queued`/`Maturing`/`Matured`/`Voided — Sued`/`Expired`) and
sort it — ascending or descending — by turn deployed, attacked player (for a decision
like Bot Attack that targeted a chosen opponent, both queued and already-active), or
decision name. The list itself is capped to roughly 3 collapsed cards' worth of height,
scrolling for the rest, so a long game's accumulated decisions don't push the rest of the
page down. See CLAUDE.md's *"`ActiveDecisionsBox`..."* section for the implementation.

Alongside the level/nature filter chips, the deck also has a **SEARCH DECISIONS** text
field (matching by decision name or description, the same shape as SUE THEM CHICKENS'
"SEARCH GROUNDS" field) and a **SORT BY KPI** control: a dropdown of every KPI field some
decision in the library actually affects (derived from the live, admin-editable decision
data, not a hardcoded list — an unaffected field never shows up as a useless option), plus
two direction chips ("Highest → Lowest" / "Lowest → Highest") that appear once a KPI is
picked. Ranking is by each decision's own effect on the chosen field at the moment it's
deployed (its year-1 schedule value, or the ongoing `'default'` if it has no year-1 entry)
— a decision that doesn't touch the chosen field at all sorts as 0, alongside whichever end
of the list that lands it on. All three controls (level/nature filters, search, sort)
compose freely — sort applies to whatever the filters and search already narrowed down to.

Each card in the box — active or still-queued — also shows the decision's own
description and a collapsible **SHOW DETAILS** toggle, the same **EFFECTS** timeline +
legal-risk line the deck's own cards render, so confirming what a still-maturing or
queued pick actually does never requires reopening the deck.

Each 120s GAME_PHASE round, every player submits up to 1 strategic + 2 operational +
2 financial decision from that game's own fixed decision set — spanning `Traditional`,
`Grey Area`, and `Dirty` in nature. Every new game randomly draws its own 50-decision set
from the full admin-editable library (48 random decisions plus every share-transaction
decision — Buy Shares/Sell Shares — always included, regardless of the draw) the moment
the game starts; that set never changes for the rest of the game, survives reconnects,
and is different from game to game. `Financial` is a decision-type category of its own
(Buy Shares/Sell Shares plus a handful of financial-engineering content decisions — bond
issuances, futures plays, and worse), capped independently of strategic/operational
by `gameSettings.maxFinancialDecisionsPerTurn` — see *Share Ownership & Takeover* below.
When the timer expires, `GameLoop` resolves the turn for all players simultaneously:

1. Apply active decisions' impacts (additive relative stacking across matured instances) —
   a decision's own negative `cash` cost also picks up a company-size-scaled surcharge
   (`gameSettings.decisionCostWealthScaleRate`, 1% of the deploying player's own current
   cash by default, costs-only — a positive/windfall value is never scaled down), the
   same "bigger company pays more for the same move" idea `wealthScaledFeeRate` already
   applies to litigation fees
1b. Buy/Sell Shares trades execute — see *Share Ownership & Takeover* below
2. Depreciation ledger (genuine asset purchases only)
3. Competitiveness & market share (zero-sum across all players)
4. Volume, capped by installed capacity — against a pie sized per-player and scaled by the
   room's active player count (`marketVolumePerPlayerTonnesPerYear`), further adjusted by
   real-world demand elasticity (the average price across every active player shrinks or
   grows the whole market, not just each player's own share of it) unless
   `gameSettings.marketFixed` is set
5. P&L (revenue, COGS, EBITDA, tax, net profit)
6. Lawsuits filed this turn resolve (or await trial) — see *Lawsuits* below
7. Balance sheet & cash flow (one unified formula)
8. Bankruptcy check, and a majority-ownership takeover check — see *Share Ownership & Takeover* below
9. Global Risk Gauge (a.k.a. Threat Level — see below for its 4th and 5th terms)

Results broadcast via `turn:resolved`. `legalExposure` from open cases lowers a player's
own stock value and increases how likely every case against them is to succeed — a
deliberate snowball effect that punishes concentrated risk-taking.

> **Deviation from the original design spec by explicit product decision:** the Risk
> Gauge was originally specified as a fixed 3-term blend (legal exposure ratio, scrutiny,
> outrage). It's been
> extended with two further weighted terms:
> - **Ownership/takeover risk** (w4) — the single largest outside stake in your company
>   relative to the 50% takeover threshold above, since majority-ownership takeover is a
>   fully independent way to lose the game the original gauge never reflected.
> - **Legal-solvency risk** (w5) — the same probability-weighted open-lawsuit exposure the
>   w1 term already computes, but compared against a projected *next-turn* cash (a naive
>   linear extrapolation of this turn's own cash trend, not the real prediction engine —
>   see CLAUDE.md for why) instead of today's cash. Distinct from w1: that term feeds
>   `adjustedProbability`'s snowball effect off *current* cash; this one asks the narrower,
>   forward-looking question "could these open cases actually bankrupt me next turn."
>
> Seeded weights moved `w1=0.5, w2=0.25, w3=0.25` → (adding w4) `w1=0.4, w2=0.2, w3=0.2,
> w4=0.2` → (adding w5) `w1=0.32, w2=0.16, w3=0.16, w4=0.16, w5=0.2`, all still
> admin-editable from `/admin`. See CLAUDE.md's *"Risk Gauge takeover term"* and *"Risk
> Gauge solvency term"* sections for the full rationale and implementation, including why
> the "predicted cash" and "open lawsuits" inputs mean specifically what they do — both
> were genuinely ambiguous requests clarified before implementing, not obvious defaults.

### Share Ownership & Takeover — a second way to lose the game

Every company has a cap table (`PlayerVariables.shareOwnership: Record<string, number>`,
fractions summing to 1.0) alongside `totalSharesOutstanding` (an absolute share count used
only for per-share pricing, `stockValue = marketEquity / totalSharesOutstanding`). Two
reserved keys, never a real player id: `"self"` (the company's own founding player's
retained stake — every company starts here at 100%) and `"EXTERNAL_MARKET"` (floating
shares nobody currently holds). Any other key is a real player id holding a bought-in
cross-stake.

**Share Issuance** raises capital by increasing `totalSharesOutstanding` and diluting every
existing holder proportionally — the new shares land 100% in `EXTERNAL_MARKET` until
someone buys them.

**Buy Shares** (`level: 'Financial'`, `requiresTarget: true`, `variableAmount: true`) is a
real trade, not a fixed schedule: pick a target company (any player, **including your
own** — a self-buyback lets you reclaim stake previously diluted out to
`EXTERNAL_MARKET`) and a dollar investment amount at deploy time. The client labels this
picker "COMPANY," not "TARGET" — it's choosing whose cap table the trade acts on, not a
counterparty; a purchase never requires the other side's consent and a sale (below) never
goes to another player directly. Priced off the target's **stockValue as of the start of the turn**
(last turn's close — trades don't wait for this turn's not-yet-computed balance sheet).
Every existing holder of the target — including `EXTERNAL_MARKET` — is diluted pro-rata by
the fraction bought; the buyer's own stake grows by that same fraction. The buyer's cash
decreases by the full amount spent; every diluted *player* holder (never `EXTERNAL_MARKET`,
which absorbs its own dilution with no counterparty, and never the buyer's own existing
stake, which nets to zero — a self-buyback never pays itself) receives their pro-rata share
of that amount in cash. Carries real legal risk (Breach of Fiduciary Duty, Williams Act
Disclosure) — but only above a configurable minimum single-transaction size
(`legalRiskConditions.minPercentAcquiredInSingleTransaction`, 5% by default): a token
purchase is never suable.

**Sell Shares** (`level: 'Financial'`) converts a held stake back to cash at the current
price, always returning the shares to `EXTERNAL_MARKET` specifically — never pro-rata to
other players, and capped by whatever you actually hold. Its own "COMPANY" picker chooses
*which* company's shares you're liquidating (your own, or any rival's you've bought into)
— not a buyer, since a sale always goes to the external market regardless.

**Simultaneous purchases against the same target** (two players buying into the same
company the same turn) resolve in strict server-arrival order (FIFO) — the first purchase's
dilution is already reflected in the cap table before the second is computed, so the two
can never double-count or silently overwrite each other.

**Majority-ownership takeover** is a second elimination path, entirely independent of
bankruptcy: the instant any player crosses 50% ownership of another company, that
company's own player is eliminated — exactly like bankruptcy, including the same case-
waterfall payout to plaintiffs holding open cases against them. The acquirer additionally
inherits the eliminated company's assets and intangible assets in full, and most of its
cash — `gameSettings.mergerIntegrationCostRate` (25% by default) of a positive final cash
balance is lost to "integration costs" rather than transferred, a deliberate cash sink so
hostile takeover isn't a second, unlimited wealth-concentration mechanism on top of
whatever a company earned on its own (not debt, not active decisions, not legal cases,
either way). Stock can fall to exactly $0 with no floor if a company's legal exposure meets
or exceeds its equity — a deliberately allowed "buy a distressed rival for free" scenario.
That $0 pricing is reserved for a company whose stock has genuinely, computedly crashed —
round 1 prices normally off a starting book value (`(cash + assets + intangibleAssets +
reserves - debt) / totalSharesOutstanding`, since `stockValue` hasn't been computed for
anyone yet at that point) rather than being mistaken for the same "distressed, free" case
(see CLAUDE.md's *Share ownership & majority-ownership takeover* section for the bug this
fixes).

**The cap table itself is visible in the client, not just its consequences.** Both the
STOCK VALUE drill-down (your own dashboard) and a rival's Full Filing report show an
OWNERSHIP (CAP TABLE) panel — a stacked ownership bar plus a row per current shareholder
(name, % owned, share count, $ value), largest stake first — so the majority-ownership
threshold above isn't something you only find out about after it's already happened. See
CLAUDE.md's *"OWNERSHIP (CAP TABLE)"* section for how a `shareOwnership` key resolves to a
display name (self-key vs. a real playerId vs. `EXTERNAL_MARKET`) and how that differs
between viewing your own company and a rival's.

**Takeover risk also feeds the Threat Level gauge itself**, not just the cap table panel —
see the Global Risk Gauge deviation note above and CLAUDE.md's *"Risk Gauge takeover
term"* section.

### Lawsuits — deliberate filing, not automatic

> **Deviation from the original design spec by explicit product decision:** the spec's
> literal design has *every* decision with `legalRisks` automatically generate a case against
> the decision-maker from *every other player* the instant it's deployed. That's been
> replaced with deliberate filing — a case only exists if a player actively chooses to
> sue over it. If you want to restore the spec-literal automatic behavior, see
> `GameLoop`'s Step 8 and `LegalEngine.fileLawsuit`.

There is no fixed catalog of lawsuit grounds — but there's also no restriction to what a
specific target has actually done. `SueModal` derives every ground you can select from
`game:deck`'s `legalRisks`, across the **entire decision library**, regardless of whether
the target you're picking has ever deployed the decision it comes from. You can knowingly
gamble on a ground you merely suspect is true, not just one you've confirmed. Filing queues
`{ targetId, decisionName, groundName }` into the same pending state as deployed decisions
(up to `gameSettings.maxLawsuitsPerPlayerPerTurn`, 3 by default) and submits it via
`game:submitDecisions`. At turn resolution, `LegalEngine.fileLawsuit` checks whether the
target actually has that decision active: if so, it prices the case using
`getScheduleValue` against the legal risk's `probability` schedule at the target
decision's `elapsedYears` — the longer a risky decision has been live, the higher the
probability tier, exactly like a normal impact schedule. If not — a wrong
guess — the case is still created (never silently dropped), just with `baseProbability`
forced to `0`: a real, visible, but hopeless case. `fileLawsuit` still rejects a filing
outright (no case, fee already spent) only if the decision or ground name doesn't exist in
the library at all, which the real client never sends.

Filing also costs `gameSettings.lawsuitFilingCost` ($15,000 by default) plus a wealth-scaled
surcharge (`wealthScaledFeeRate`, 3% of the payer's own current cash by default — a
deliberate cash sink: the surcharge portion isn't credited to anyone, it just leaves the
game, so litigation stays a meaningful cost for a wealthy player instead of the same flat
fee a round-1 player pays), shown right on the **SUE THEM CHICKENS** button and deducted
**instantly** the moment the "File" button is clicked in `SueModal` — a `game:fileLawsuit`
round trip, same "instant, outside turn resolution" pattern as Dig Deeper, not something
that waits for the round timer. The case
itself is still only created at the next turn resolution, exactly as described above — the
fee purely gates the *act of filing*. It is **not refunded** either way: a wrong guess
still creates a real (if hopeless) case, so the fee was never wasted on nothing, but it's
just as non-refundable as a correct guess that later loses at trial. Filing is capped at
`gameSettings.maxLawsuitsPerPlayerPerTurn` same as the filings themselves, so a player can't
rack up fee charges past what a turn will actually process.

Neither side sees a case's win probability for free — both start at a gray, unclickable
"Unknown" chip and have to earn the real number, via two different routes. The
**plaintiff** earns it *before* filing, by fully "Dig Deeper"-investigating the underlying
attack (investigation level 3) and suing over its exact suggested ground. The
**defendant** earns it *after* the fact, by paying `gameSettings.digDeeperCost` on the case
itself (`game:digDeeperCase`) — a single one-shot reveal, unlike the plaintiff's 3-tier
route. Once earned, either side's card shows the same colored chip (dot color still
green/yellow/red via `semaphoreLevel`, using `adjustedProbability` if the case has one,
else `baseProbability`) — but labeled with a 5-band verbal likelihood
(`likelihoodLabel`: Highly Unlikely/Unlikely/Moderate/Likely/Highly Likely) rather than
an exact percentage, since the underlying number is a snapshot that snowballs (every
open case against the same defendant makes every other one somewhat more likely to
succeed too — see *Legal Risk & Lawsuits* below), so a precise-looking `%` overstates
how exact a read it really is. The chip is still clickable to `RiskBreakdownView` for the
full weighted-factor breakdown, which keeps its exact percentages (base probability +
scrutiny term + legal-exposure term = total) — that view is recomputed live from current
data every time it's opened, not a stale snapshot, so the same false-precision concern
doesn't apply there. The plaintiff's flag is decided once, permanently, at the moment the case is
filed (not recomputed from the player's live attack list on every render), so it can't
flicker back to "Unknown" later just because the underlying attacking decision matures out
or its deployer goes bankrupt; the defendant's flag is likewise permanent once paid for.

A wrong guess (see above) is the clearest illustration of why the plaintiff's route
matters: a plaintiff who merely gambled on a hunch has no attack to have investigated, so
they can never earn the real number that way — they stay "Unknown" until (if ever) they
pay to dig into the case directly, same as any defendant would. The defendant, meanwhile,
always *can* pay to see the true `0%` on a hopeless case filed against them, since they
genuinely did (or didn't) do the thing being alleged and there's no attack-investigation
prerequisite standing in their way.

**Statute of limitations:** `gameSettings.statuteOfLimitationsYears` (10 by default,
admin-editable) caps how long after deployment a decision instance can still be
meaningfully sued over. Once a target's cited instance has been active at least that many
years (`elapsedYears >= statuteOfLimitationsYears`), suing over it — even correctly, over
a ground the target genuinely triggered — is time-barred: the case is still created (the
same "real but hopeless" shape a wrong guess gets), just with `baseProbability` forced to
`0`. The same cutoff applies to every "suggested ground" estimate `pickAllGrounds` computes
for Dig Deeper's tier-3 reveal and the "SUE NOW" shortcut, so a suggestion never quotes
winnable-looking odds for a decision a real filing would immediately zero out for being too
old. This is independent of the decision's own maturity (maturity is about
when an impact schedule locks in, not legal liability): a long-matured decision can still
be well within the limitations window, and a still-maturing one could in principle be past
it, if `statuteOfLimitationsYears` were ever set below a decision's own maturity time.

`target.*` impact fields (the 9 fields like `target.cash`, `target.outrage`
that route a decision's effect to the chosen target rather than the decision-maker, used
by Buy Shares/Sell Shares and the offensive-sabotage decisions) route to the chosen
opponent every turn the decision stays active, applied in `resolveTurn`'s Step 2 right
alongside the decision's own self-effects (`calcEngine.extractTargetImpacts`/
`applyTargetImpacts`, `DecisionEngine.getTargetImpacts`, `GameLoop.buildIncomingAttacks`)
— see *Attack Awareness & Dig Deeper* below for how a targeted player finds out.

A filed case starts at `status: 'negotiating'` — a richer addition than the original
design spec, which never modeled a negotiation phase at all (a case just resolves via a
probability draw "this turn"). Getting a case out of `'negotiating'` works one of three ways:

- **Settle it live.** The **defendant always moves first** — they either make an opening
  offer or go straight to court. Once an offer's on the table, only the side who *didn't*
  make it can respond: counter with a new offer, **accept** it (settles immediately —
  defendant pays plaintiff that exact amount, case resolved), or **go to court** (ends
  negotiation for a trial verdict instead — see below). This is all instant, independent
  of the turn timer, the same "fires over the socket right away" pattern as Dig Deeper —
  `NegotiationPanel` in `GamePhase.tsx` is the UI, `game:makeOffer`/`game:acceptOffer`/
  `game:goToCourt` the events. Going to court doesn't draw a verdict on the spot; it just
  marks the case `awaiting_trial` — the actual probability draw happens the next time this
  room's turn resolves, same trial logic every other `awaiting_trial` case goes through.

  Each new offer has to fall within a range that **narrows with every move** rather than
  staying fixed for the whole negotiation: the defendant's opening offer can be anywhere
  from $0 up to the full stakes; the plaintiff's first counter must be at least the
  defendant's offer, up to the full stakes; the defendant's next offer must be at least
  their *own* previous offer, up to the plaintiff's latest ask; and so on, alternating —
  each side can only ever move their own end of the range inward, bracketing the two
  sides closer together turn by turn rather than letting either one drift away from
  what's already been offered. The slider in `NegotiationPanel` shows this live as a
  "Range: $X – $Y" caption, and the server independently re-validates every offer against
  the same range (`GameLoop.computeOfferBracket`) — the client's copy is just a UI guide.
- **Leave an offer hanging.** If a turn boundary arrives with an offer still unanswered
  (nobody accepted, countered, or went to court in time), it's treated as accepted right
  there — the case settles for that offer's amount. In practice this means any negotiation
  with real back-and-forth resolves within about one round of being left unattended; it
  never drags on turn after turn.
- **Never engage at all.** If neither side ever makes a single offer, the original
  **negotiation timeout** still applies, unchanged: each case tracks `turnsNegotiating`,
  incremented once per turn it's still negotiating (a case filed this turn doesn't get
  incremented in the same turn it's created); once that hits
  `gameSettings.negotiationPeriodTurns` (2 by default), the case is forced to
  `awaiting_trial` and resolves via the existing trial logic in that same turn's
  resolution — the client never observes an intermediate `awaiting_trial` snapshot for a
  case that timed out this way, it just jumps from its last negotiating turn straight to a
  verdict.

The lawsuit card shows a live hint for whichever of these applies — a countdown ("Goes to
trial automatically in N more turn(s)") when nothing's been offered yet, or a warning that
a pending offer will be treated as accepted once one has.

**Winning a case voids the sued decision — a further addition beyond spec.** A "win" here
means the defendant ends up paying: a trial verdict of `'won'` for the plaintiff, or any
settlement where the defendant pays out (an accepted offer, or an unanswered offer
auto-settling at a turn boundary). A trial verdict of `'lost'` (the defendant wins) never
triggers this. The moment either of those happens, `GameLoop.voidSuedDecisionInstance`:

- Cancels the sued decision instance's **forthcoming** effects — nothing it did in earlier
  turns is reverted (that cash/KPI movement already happened and stays), but from this turn
  forward its impact schedule is never applied again, even a permanent `'default'` one that
  would otherwise keep re-applying forever.
- Forces it `isMatured: true` immediately, which is what actually frees the decision back up
  for redeployment — `DecisionEngine.canDeploy`'s existing "the previous instance must have
  matured" rule already allows a new deploy once that's true, no separate "un-suspend" step
  needed.
- Flags it `voidedByLawsuit: true` (`ActiveDecisionInstance`/`LegalCaseData.
  defendantDecisionInstanceId`), shown client-side in "Active Decisions" as a gray
  **VOIDED — SUED** badge in place of the normal ✓ MATURED one.

This only ever targets the *specific* decision instance the case was actually filed against
— recorded once, at filing time, as `LegalCaseData.defendantDecisionInstanceId` (undefined
for a wrong guess or a time-barred ground, the same cases where `baseProbability` is forced
to 0 — there's no genuine instance to point at). Matching by id rather than by decision name
matters once a decision can be redeployed after being voided: a defendant could have both a
long-dead voided instance and a live new one active at once, and a fresh lawsuit must always
be priced and later voided against whichever instance is actually still live, never a stale
one sitting earlier in the array. `voidSuedDecisionInstance` is called from every place a
verdict/settlement is actually decided — the trial-resolution loop (Step 8b/9), the stale-
offer auto-settle branch (Step 8b), and the out-of-band `acceptOffer` action — never from
`makeOffer`/`goToCourt`, which don't resolve anything themselves.

**A decision with a permanent effect blocks redeploying itself only for
`gameSettings.permanentEffectCooldownYears` turns after it matures — a separate, normally
much shorter clock from the statute of limitations.** `DecisionEngine.hasPermanentEffect(def)`
flags a decision whenever any of its own (non-`target.*`, non-`competitor*`) impact fields
carries a non-zero `'default'` schedule value — meaning that field's effect would otherwise
re-apply every turn forever once the schedule's explicit years run out, not just a one-time
bump. `canDeploy` blocks redeploying such a decision while a matured, non-voided instance is
younger than `permanentEffectCooldownYears` (3 by default, admin-editable) — deliberately
**not** the same value as `statuteOfLimitationsYears` (10 by default, which still governs
only how long a decision stays suable and how long a `target.*` effect keeps re-applying,
completely unchanged). Redeployability lifts as soon as the cooldown passes, independent of
whether the effect has "naturally expired" per the statute below.

This used to reuse `statuteOfLimitationsYears` itself for the redeploy lock too — given
typical games run ~12-15 rounds, a 10-turn lock made every permanent-effect decision (New
Factory, Vertical Integration, Raw Material Monopoly, Venture Capital Shadow Money, Patent
Portfolio, Bot Attack, ...) an effective one-time-per-game pick unless an opponent happened
to sue it into `voidedByLawsuit` first — even though the game's own documented stacking math
(`installedCapacity = base * (1 + 0.4 + 0.4)` for two matured New Factorys) assumes
redeploying the same permanent-effect decision more than once in a game is normal, intended
play. `permanentEffectCooldownYears` fixes that: matured decisions genuinely come back into
rotation during a normal game, on a cooldown tuned for "how often can I reinvest in this,"
not "how long am I legally exposed."

Separately, a permanent effect (and a permanent `target.*` effect, e.g. Bot Attack's ongoing
`target.outrage`) still **naturally expires** once the instance has been active
`gameSettings.statuteOfLimitationsYears` turns — `advanceAndApply`/`collectTargetImpacts`
stop re-applying its schedule from that turn on, forcing `isMatured: true` if it wasn't
already. This is unchanged by the above and exists for a different reason: without it, the
ability to redeploy after a voided lawsuit would double as a way to keep re-rolling a
decision that grants an indefinitely-repeating KPI boost until one attempt slips through
unsued — tying the expiry to the statute closes that loophole while still letting the effect
run its natural course. In practice `permanentEffectCooldownYears` (short) will almost always
free a decision for redeployment well before `statuteOfLimitationsYears` (long) would ever
naturally expire it — the two mechanisms just happen to share the same underlying "how old is
this instance" clock, for two independent purposes. A decision voided by a lost lawsuit is
unaffected by either — it's already free to redeploy immediately (see above). Decisions
without a permanent effect are unaffected by both: they can still be redeployed as soon as
they mature, exactly as before this feature.

**Only one lawsuit can ever be filed against a specific decision instance — first come,
first served.** The moment a genuine (non-wrong-guess, non-time-barred) case is filed
against a decision instance, that instance is permanently claimed: no further lawsuit —
from anyone, on any ground, in this turn or any future one — can ever target it again,
regardless of how the first case eventually resolves (settled, won, or lost). If two
players try to sue the same instance in the same turn, whichever plaintiff's filing is
processed first wins the claim; the other gets the same "real but hopeless" 0%-probability
shape a wrong guess or a time-barred ground already gets, rather than being silently
dropped. This is scoped to the specific *instance*, not the decision name — once that
instance is later voided (see above) or expires and the player redeploys the same decision,
the fresh instance is a clean slate and can be sued once, independently. The claim is
recorded directly on the decision instance itself (`everSued`), not derived from scanning
past cases — a resolved case is only kept in a player's persisted `legalCases` for one
extra turn past its own resolution (long enough for the client to show the verdict once),
then drops out entirely, so a flag stamped on the instance itself is what makes the
"can't be sued again" rule outlive the case's own visibility. When a target has two live,
un-sued instances of the same decision at once (normal — stacking a permanent-effect
decision is allowed), filing from a "SUE NOW" hint attaches to the exact instance that hint
was for, not just whichever instance happens to share its name — see CLAUDE.md's *"Only
one lawsuit per decision instance, ever"* section for the mechanism.

### Attack Awareness & Dig Deeper

Offensive decisions (Bot Attack, Social Astroturf, and the rest of the `target.*`-bearing
library) used to land invisibly — the target's stats moved with no signal pointing at the
cause. Every player who currently has an active `target.*` decision aimed at them gets an
`incomingAttacks` entry on their own `PlayerTurnResult`, computed fresh by
`GameLoop.buildIncomingAttacks` each turn — this is server-gated, not just UI-hidden: the
attacker's identity is never sent to the client below whatever tier that player has
personally unlocked, so there's nothing to read via devtools before paying for it.

The client shows a hint next to the SUE THEM CHICKENS button — *"Somebody did something to
you"* — with a **🔍 Dig Deeper** button. Each click emits `game:digDeeper` and costs
`gameSettings.digDeeperCost` ($10,000 by default), deducted **instantly** via
`GameEngine.digDeeper`/`GameLoop.digDeeper` — a genuinely out-of-band mutation, not routed
through the normal turn-resolution cycle (see CLAUDE.md's *"Four exceptions to
'everything happens in resolveTurn'"*). Investigation unlocks progressively, tracked per
attack instance in `Company.engineState.investigations`:

1. **Who** — the attacker's id and name, plus a one-sentence AI-narrated "annual report"
   flavor blurb about the attacking decision (the same generation `game:getAnnualReport`
   uses for a rival's Full Filing, with the same `competitorsView` fallback) — deliberately
   vague corporate PR-speak, so it doesn't leak anything tier 2 doesn't already reveal more
   precisely. See CLAUDE.md's *"An incoming attack's tier-1 hint reuses the same AI-narrated
   annual-report blurb"* for why this has to be computed in `GameEngine`, not `GameLoop`.
2. **What** — the decision name, description, and a human-readable effect summary (e.g.
   *"-20% Capacity Utilization"*), via `decisionEngine.summarizeTargetImpacts`
3. **Suggested lawsuits + estimated odds + estimated stakes** — EVERY viable `legalRisks`
   ground against that decision (not just the strongest one — a decision can carry
   several), picked by `decisionEngine.pickAllGrounds` using the *same* adjusted-
   probability formula as real trial resolution evaluated against the attacker's current
   scrutiny/legal exposure, sorted strongest-first. Each is an estimate, shown as a 5-band
   verbal likelihood (Highly Unlikely/Unlikely/Moderate/Likely/Highly Likely) rather than
   an exact percentage, since it's a pre-filing snapshot that typically only grows from
   here (every case later opened against the same target raises everyone's odds against
   them, this one included, once it exists) — the real probability is still recomputed
   fresh at trial time. Shown alongside each: an estimated dollar **stakes** figure, priced
   the exact same way a real filed case's `LegalCaseData.stakes` is (`LegalEngine.
   fileLawsuit`'s own calc — absolute-type grounds use the schedule value directly,
   relative-type grounds scale it against the attacker's own current field value), so the
   number shown here before filing matches what the real case will actually carry once
   filed — not an expected value, not discounted by the probability next to it. Every
   suggested ground gets its own **SUE NOW** button, which files that exact ground
   directly — no modal, no further confirmation step (see `AttackHintCard`'s own doc
   comment for why: by full investigation, everything `SueModal` would otherwise ask the
   player to pick is already known and already shown on the card).

Once fully investigated (tier 3), the button disables — no further charge. The button is
also disabled client-side whenever cash is below `digDeeperCost`; the server enforces the
same rule independently, so it's never possible to Dig Deeper into bankruptcy.

Each hint card has its own small **✕** to dismiss it — a purely local "I'm not interested
in this one" preference, not something the server tracks. A dismissed hint stays hidden for
as long as that same attacking decision instance keeps showing up (it reappears if you
reload the page, and stops mattering entirely once the instance itself matures out/expires/
gets voided by a lawsuit, or if a fresh instance of the same decision is redeployed later —
that's a new hint you haven't dismissed).

**Indirect effects get the same hint, broadcast to everyone instead of one target.** Most
of the decision library has no `target.*` impacts at all — no single player it's aimed
at — but roughly two-thirds of those still carry `legalRisks` (New Factory's nuisance
suit, Water Pumping's environmental suit, Night Dumping, Maintenance Neglect, Artificial
Greenwashing, and so on). Deploying one of these used to be completely invisible to
everyone but the deployer, even though any player could already sue over it "blind" via
SUE THEM CHICKENS' whole-library ground list (see below). `GameLoop.isIndirectEffect`
flags a decision instance as indirect whenever it has zero `target.*` impacts AND at
least one `legalRisks` entry; `buildIncomingAttacks` then surfaces it to **every other
active player**, not just one victim, since there's no target to route it to. A decision
with neither trait (no `target.*` impacts and no `legalRisks`, e.g. Sell Shares) gets no
hint at all — nothing to reveal or sue over.

Everything else about the mechanic is identical to a direct attack — same 3-tier
investigation ladder (including the heads-up shortcut below), same `Company.
engineState.investigations` tracking keyed by decision instance id, same **SUE NOW**
flow once tier 3 is reached, same `digDeeper` cost/charge path — with two differences:
tier 2's effect summary describes the decision's own effect on its deployer (via
`decisionEngine.summarizeOwnImpacts`) rather than a `target.*` effect (there isn't one),
and the client headline reads *"Somebody did something that indirectly affects you"*
(a calmer blue card, not the alarmed orange one) instead of *"...did something to you."*
`digDeeper` also drops its "must actually target me" check for an indirect attack — any
other active player may dig into one, matching the fact that it was broadcast to all of
them in the first place.

**Heads-up (2-active-player) games skip tier 1 for free.** With only one other player
still standing, "who attacked me" was never actually ambiguous — paying to learn it is a
wasted dig, not real investigation. `GameLoop.effectiveInvestigationLevel` bumps the
persisted investigation level up by one tier whenever exactly 2 players are active, so the
attacker's identity is visible immediately with zero digs, the first paid dig jumps
straight to tier 2 (what the decision does), and the second paid dig reaches tier 3
(suggested ground + odds) — only 2 paid digs total instead of 3. The persisted level
itself still just counts up by 1 per dig; only what a given level reveals shifts. If the
game later has more than 2 active players again, the normal 3-tier ladder applies as
usual — this is re-evaluated from the current active-player count on every call, not
locked in once a game goes heads-up. This applies identically to indirect effects — with
only one other player in the game, an indirect decision's deployer isn't ambiguous either.

Once you've acted on the hint — suing the attacker over exactly the suggested ground,
with a "correct" case (win probability above 0%) — the hint card disappears, instead of
continuing to nag about an attack you've already addressed. This checks both a lawsuit
still queued this turn and a real case already on the books from an earlier turn.
Suing over a *different* ground for the same attacking decision (picked manually, not via
SUE NOW) doesn't make the hint disappear — only the specific suggested ground counts,
since that's the only one whose win probability the client actually has.

### Ready-Up (Instant Turn Resolution)

The 120s per-round timer doesn't have to run out — a separate **Turn** box in the header
(distinct from the Threat Level bar, which used to carry the countdown itself) shows the
round number, the countdown, and a **Ready** toggle (`READY (x/y)` → `✓ READY (x/y)`,
`x`/`y` = ready count / active-player count). The instant every active (non-bankrupt)
player is ready, `GameEngine` clears the timer and calls `resolveGameTurn` immediately
instead of waiting out the rest of it — `GameEngine.toggleReady` tracks ready state as a
`Set<playerId>` per room (`RoomState.readyPlayerIds`), reset to empty at the start of
every new round (`game:readyUpdate` broadcasts `{ readyPlayerIds: [], activePlayerCount }`
right alongside the round's `phase:changed`) and when the game first starts. Readiness is
purely a timing trigger, not a turn-resolution mutation — it never changes what a turn
computes, only when it fires. A player forfeiting (see *Leave Game* below) also drops
their own ready flag and re-checks the condition, since their departure can be the thing
that makes everyone *remaining* ready.

### Reconnection & Session Resume

A raw socket disconnect — a network hiccup, an accidental browser back button, a page
refresh — never deletes a player anymore. `GameEngine.markPlayerDisconnected` clears their
live socket association but leaves them in the room; their still-open decisions/lawsuits
keep resolving normally on schedule, exactly like an AFK player who simply didn't submit
that turn. They have `RECONNECT_GRACE_PERIOD_MS` (120s by default — widened from the
original 60s to give mobile players, whose connections drop more readily on backgrounding
or a network handoff, a realistic window to come back) to reconnect before the
same heartbeat interval that sweeps stale empty rooms (`STALE_ROOM_THRESHOLD`) also calls
`finalizePlayerRemoval` — the original immediate-delete behavior, just deferred. Because
the player is never removed from the room during the grace window, **the rest of the room
is never told they left** — no broadcast fires unless the grace period actually expires
(at which point `room:playerLeft` fires, distinct from a real kick).

On the client, `socketStore.ts` persists `{ roomId, playerId }` to `localStorage` on every
successful join, and attempts `room:rejoin` on every socket `connect` event — which fires
on first load *and* on every Socket.IO-driven auto-reconnect, so a brief network blip with
the tab still open self-heals without a page reload too. `App.tsx` shows a "Reconnecting…"
state while that attempt is in flight, and `GamePhase.tsx` redirects to matchmaking if it
ever lands with a genuinely empty store and no rejoin attempt underway (closing off what
was previously an infinite "Waiting for game data…" spinner on a raw refresh with no saved
session). A failed rejoin (`REJOIN_FAILED` — expired grace period, ended game, bogus
session) self-heals into the normal matchmaking flow by clearing the stale saved session.

**A grace-period expiry landing mid-turn-resolution used to be able to freeze the whole
room, needing every client to refresh to recover** — a real, reported bug. The heartbeat
sweep that finalizes an expired grace period runs on its own fixed 10s interval, completely
independent of the round timer that drives `resolveGameTurn` — so nothing stopped the two
from landing within moments of each other whenever a disconnect happened to occur with
somewhere around a round's worth of time left before its natural end. When they did,
`finalizePlayerRemoval` could delete a disconnected player's `Company`/`Player` rows from
under an *already in-flight* `resolveGameTurn` for that same room, which would then throw
trying to persist that now-gone player's turn results, abort its entire persistence loop,
and get silently swallowed by resolution's outer error handler — `turn:resolved` and the
next round's timer never fire, and the room is stuck for good (the round timer that would
have retried was already cleared before resolution started). Fixed two ways: the heartbeat
sweep now skips finalizing a removal while `resolveGameTurn`/`forfeitGame`'s shared
concurrency lock (`advancingRooms`) is already held for that room, retrying on its next 10s
tick instead; and `resolveGameTurn` now isolates every player's persistence in its own
try/catch, so one player's row unexpectedly vanishing can never abort the turn for everyone
else in the room — the resolution, and the notification that the other player's connection
timed out, both still land normally, no refresh required.

### Leave Game (Voluntary Forfeit)

A red **Leave Game** button, fixed floating in the GAME_PHASE screen's bottom-left corner
(confirmation modal first — it's irreversible) — paired with the floating **Chat** button
in the opposite (bottom-right) corner, see *In-Game & Game-Over Chat* below — emits
`game:leave`. `GameEngine.forfeitGame` marks the requesting player
bankrupt immediately — same DB write shape as a natural cash<0 elimination — and, if that
leaves at most one active player, ends the game exactly like a normal turn's post-resolution
win check would. The game continues uninterrupted for everyone else.

The forfeiting player doesn't just get redirected — `App.tsx` shows a full-screen "lost"
takeover (`lost.png`, "YOU FORFEITED") ahead of whatever phase the room is actually in, so
even if their own forfeit just ended the game, they see this instead of the winner's
GameOver screen. A **Return to Start** button on that screen is what actually resets the
session and sends them back to the landing page — the takeover itself is just an
acknowledgement step, not an auto-redirect. The identical takeover (`lost.png`, "YOU'VE
GONE BANKRUPT") also covers natural cash<0 elimination, which previously had no client-side
handling at all — both paths set the same `gameStore.selfElimination` flag from
`player:bankrupt`/`game:left`, just with a different `reason`.

**Everyone else in the room gets their own distinct notice — "X CHICKENED OUT"
(`chickened-out.png`), not the generic "gone bankrupt" one a natural elimination gets.**
`forfeitGame`'s `player:bankrupt` broadcast carries `reason: 'forfeit'` specifically for
this — every OTHER still-in-the-game player's `BankruptcyModal` (the same info-window
overlay a natural bankruptcy or a majority-ownership merger already shows, see *Game Over
Screen* elsewhere in this doc) branches on that reason the same way it already branches on
`'merger'`, so a forfeit reads as a voluntary quit rather than a financial collapse. This
was previously indistinguishable — `forfeitGame`'s broadcast carried no `reason` field at
all, so it fell through to the same "gone bankrupt" copy/art a real elimination gets. The
forfeiting player's own screen was never affected by this gap — their own `game:left` event
already correctly showed "YOU FORFEITED" — the gap was specifically in what everyone
*else* saw about them.

**A forfeited player's socket stays fully connected — including still subscribed to that
room's Socket.IO broadcast channel, on purpose (see the game-timeline "keep spectating"
feature) — so leaving this room for a second one on the same connection, without a page
reload, used to leak the first room's future broadcasts into whatever the second room's
screen was showing.** A real, reported, and reproduced bug: play a game to completion,
start a second one against a different opponent on the same tab (no reload), and once the
*first* room's game happened to conclude on its own, its `game:over`/`player:bankrupt`
broadcasts landed on this same socket too — silently overwriting the second game's own,
still-in-progress Game Over/GamePhase screen with the first game's stale winner/eliminated-
player data. Fixed by `GameEngine.leaveStaleSocketRoom`, called from every place a socket
gets (re)pointed at a room (`createRoom`/`joinRoom`/`rejoinRoom`): it leaves whatever room
that socket was previously mapped to before attaching it to the new one. See CLAUDE.md's
*"A socket that starts a second game without reloading kept receiving its first game's
broadcasts"* for the full root-cause writeup.

### In-Game & Game-Over Chat

Room chat (`chat:message`, see *Lobby Features* above for the wire payload shape) is no
longer scoped to the WAITING lobby — the server-side phase gate that used to reject a
`chat:message` outside `WAITING` is gone, so the same in-room chat now works throughout
GAME_PHASE and AFTERMATH too, not just while waiting for the game to start.

The lobby keeps its existing always-visible inline **Lobby Chat** box, unchanged. GAME_PHASE
and AFTERMATH (both live spectating and the finished-game replay — see *Game Timeline*
below) instead get a floating **Chat** button, fixed in the screen's bottom-right corner —
paired with the floating **Leave Game** button in the bottom-left (see *Leave Game* above),
the two are a deliberate pair of fixed-position controls, one per corner. Clicking it opens
a small popup window, styled to match the app's "Courtroom Ink" parchment/gold theme, with
the same message list + input box shape as the lobby's inline chat.

**One continuous conversation, not three separate ones.** The client's `chatStore` (a
dedicated Zustand store, `client/src/stores/chatStore.ts`) holds chat history independently
of which page component is currently mounted, so a message sent in the lobby is still
visible once the game starts and after it ends — the lobby's inline box and every
in-game/game-over `ChatWidget` instance all read from and write to this same store. History
resets only when the client actually joins a *different* room (`chatStore.resetForRoom`,
called from `socketStore`'s `room:joined` handler) — a phase change within the same room
never clears it. Chat itself stays ephemeral server-side exactly as before (broadcast-only,
nothing persisted, no history replay on rejoin — a page reload starts empty).

**The chat button's icon shows an unread badge** (a small numeric count) whenever a message
arrives while the popup is closed — `chatStore.isVisible` tracks whether a chat surface
(the lobby's inline box while mounted, or the popup while open) is currently on-screen and
presumed being read; opening the popup clears the count. The lobby's inline box marks
itself visible for as long as it's mounted (so messages read there don't later show up as
unread once the game starts), matching how the popup marks itself visible only while open.

See `client/src/components/ChatWidget.tsx` and CLAUDE.md for the full implementation notes,
including why the unread-badge positioning needed the fixed-position styling to live on a
wrapper `Box` rather than directly on the button (Mantine's `Indicator` badge positions
relative to its child's normal-flow box, which collapses to nothing if that child is itself
taken out of flow via `position: fixed`).

### Player Feedback

A themed popup form — a 1-5 Likert scale rendered as mood-face icons (😢🙁😐🙂😄, via
`@tabler/icons-react`'s `IconMoodCry`/`IconMoodSad`/`IconMoodNeutral`/`IconMoodSmile`/
`IconMoodHappy`) plus an optional free-text box — reachable from three places: an inline
**Feedback** button on both `Home.tsx` (`/`, next to Privacy Policy/Cookie Settings) and
`Matchmaking.tsx` (`/play`, next to Privacy Policy only — Cookie Settings lives on `Home.tsx`
alone now, see *Static Content Pages* above), each opening a Modal, and a floating button
in the bottom-left corner of the game-over/replay screen
(`GameTimelineView` in `mode="finished"` — the mirror image of the floating **Chat**
button's bottom-right corner; see *In-Game & Game-Over Chat* above). Both embed the same
`client/src/components/FeedbackForm.tsx`; only the surrounding shell (Modal vs. floating
popup) differs, matching whichever button convention the host page already uses.

**Deliberately, fully anonymous.** Submitting posts `{ rating, message?, source }` to a
plain public REST endpoint (`POST /api/feedback`, no socket involvement, no auth) —
nothing identifying the player, their room, or their game is ever collected or sent, even
from the game-over form where that context would technically be available. This matches
the rest of the app's no-auth trust model (see *Reconnection & Session Resume* above) and
keeps the two forms behaving identically regardless of where they're opened from;
`source` (`'landing' | 'gameover'`) is the only context a submission carries, purely for
admin-side triage. A rating is required to submit; the message is optional.

Feedback is read-only from the outside — the only way to see submissions is
`GET /api/admin/feedback` (admin-token gated, see *Admin Portal* below); there's no
socket event, no player-facing "see what others said" view, and nothing here is ever
edited, only reviewed.

### AI-Narrated Annual Reports

A rival's "Full Filing" report used to show one of 3-4 fixed, hand-written
`competitorsView` flavor sentences per decision (cycled by `elapsedYears % length`),
sourced straight from `game_engine.json`. That text is now generated by a local LLM —
a `llama.cpp` server (the `llm` service in `docker-compose.yml`, running Qwen3-1.7B,
model weights mounted read-only from `./models/`, not committed to the repo) — so the
narration varies year to year instead of repeating the same handful of lines forever.

Opening a rival's Full Filing modal emits `game:getAnnualReport` with just their player
id; `GameEngine.getAnnualReport` re-derives what to narrate server-side from that
player's own `Company.engineState` (`GameLoop.getActiveDecisionSummaries` — a pure,
read-only lookup, never trusting anything about the rival the requesting client sent),
then asks `services/llmService.ts` to narrate each active decision via the local
model's OpenAI-compatible `/v1/chat/completions` endpoint. Responses are cached
in-process per `decisionName#elapsedYears` (not per-player — the same decision at the
same age gets the same blurb for every viewer), so opening the same rival's report
twice, or a second player opening it, doesn't re-hit the model.

This is entirely best-effort: the client renders the static `competitorsView` text
immediately and unconditionally (so the modal is never blank or stuck loading), then
swaps in the AI-generated version — tagged **✨ AI-generated** — if and when
`game:annualReportResult` arrives. `llmService` itself catches every failure mode
(unreachable host, non-2xx, request timeout, empty/unparseable response) and falls
back to that same static text before it ever reaches the socket layer, so the whole
feature is fully optional — the game plays identically whether or not the `llm`
container is running. See CLAUDE.md's *"Local LLM for narrated annual report text"*
for the architectural rationale.

### KPI History & Prediction

Every KPI card (CASH, EQUITY, REVENUE, STOCK VALUE, THREAT LEVEL) and every individual
tracked-field row inside their breakdown views (e.g. Operating expenses/Staff costs/Tax
inside the Cash Waterfall, Volume/Price inside Revenue, each balance-sheet line inside
Equity, each factor inside Shares) is clickable — it opens a graph combining this
player's own actual history with a 3-turn-ahead prediction, via `game:getKpiHistory`
(`{ targetPlayerId? }`, omitted means "my own data") → `game:kpiHistoryResult`. History
is one `KpiSnapshot` DB row per player per round, written alongside every turn
resolution. Purely computed intermediate figures in the breakdown views (COGS, gross
profit, EBITDA, EBIT, profit before tax, net profit, market equity, net demand) aren't
clickable — they're derived-of-derived inside the view itself, not a single tracked
field anywhere.

The 3-turn prediction is computed by the real game engine, not an approximation — it
literally re-runs `GameLoop.resolveTurn` forward, using the exact same competitiveness/
market-share/P&L/balance-sheet/depreciation math a real turn does. By explicit product
decision, it **assumes only this player's own decisions and their causes continue
applying — it does not take other players' decisions into account**: every rival is
held frozen at their current snapshot for the whole predicted window (no new rival
decisions, attacks, or lawsuits, and never counting anything a rival has currently
queued-but-not-yet-submitted in their own UI), while the player's own already-active
decisions keep maturing and scheduling normally. The very first predicted turn also folds
in whatever the player has *currently queued but not yet submitted for real* (whichever
decisions/lawsuits are sitting in their in-progress selection right now) — the preview
reflects what would actually happen if they went ahead with their current picks, not just
their already-locked-in state. The graph shows this as a dashed continuation of the
solid actual-history line, with a caption spelling out the assumption. If the
projection shows the player going bankrupt within the window, the dashed line simply
stops at that round instead of showing further (meaningless) points. See CLAUDE.md's
*"KPI history + prediction graphs"* section for how the prediction is implemented
(reusing `resolveTurn` itself, sandboxed) without forking or approximating the engine.

**Rivals get the same graph, history only.** Every mini-stat in a rival's dossier
(CASH/REVENUE/EQUITY/STOCK VALUE/DEBT) and every row in their Full Filing report is
clickable too, opening the identical `KpiHistoryGraph` with that rival's real
`KpiSnapshot` history — but never a prediction, since projecting a rival's future from
decisions you can't see wasn't offered. Pass `targetPlayerId: <rival's id>` in the
`game:getKpiHistory` payload to request it. See CLAUDE.md's *"KPI history + prediction
graphs"* section for how a rival lookup is scoped to the requester's own room.

**Every KPI value also shows an up/down/no-change arrow** for its move since the previous
turn — the 4 top cards, Threat Level, all 5 rival mini-stats, every breakdown row for both
your own KPIs and a rival's Full Filing report, and every player's slice of the market
share bar in SHARES. This is a separate, lighter-weight mechanism from the history graph
above — it only ever compares the current turn to the one immediately before it (already
in the client's memory), not the full persisted history, so it needs no extra server
round trip. A green/red arrow means up/down is favorable/unfavorable for that particular
field (costs and Threat Level read backwards — a red up-arrow on Operating expenses is
bad, same as it looks); a gray dash means the value is holding steady, and no icon at all
means there's nothing yet to compare against (round 1, or a rival you're seeing for the
first time). See CLAUDE.md's *"Trend arrows"* section for exactly how each field's
direction is decided.

### Admin Portal

`/admin` is a real, independent URL — the only one in this app that isn't rendered off
`currentPhase` state (see CLAUDE.md's *"Client: no path-based routing for game phases"*).
It has two parts:

- **Room monitoring** — every in-memory room in every phase (not just WAITING/joinable
  ones, unlike Quick Play's `room:list`), each with its players' host/bankrupt/connected
  status. Polled every 5 seconds while open.
- **Decision library + game config editing** — the full decision list and the
  `GameConfig` (`gameSettings`/`playerStartingValues`/`adminVariables`) are edited as raw
  JSON in a textarea (client-validated for parseable JSON, then server-validated against
  a Zod schema before being written) rather than a structured form per field — the
  decision library's `impacts` shape is an open-ended nested record, so a bespoke form
  builder isn't worth it over textarea + real validation. Unlike the rooms table, these
  are fetched once on login (and again right after a successful save), not polled — so
  an in-progress edit can never be silently overwritten by a background refresh.
- **Formulas editing** — the 24 pure-math formulas (see
  *Formulas* below), each shown as its description plus a single-line text input for
  the expression (not a JSON textarea — these are one-line math expressions, not nested
  objects). A parse or unknown-variable error from the server is surfaced inline on the
  row that failed. Same fetch-once-on-auth-plus-after-save pattern as the other two tabs.
- **Feedback (read-only)** — every submission from the two player-facing feedback forms
  (see *Player Feedback* below): rating, optional message, source, and timestamp, newest
  first. Nothing here is editable — feedback is collected anonymously via a public
  endpoint and only ever read back here. Polled every 5 seconds alongside the rooms
  table, since new rows can arrive at any time.
- **Analytics (read-only)** — durable, cross-game telemetry for balance analysis and bug
  tracing (see CLAUDE.md's *"EventLog + the admin Analytics tab"* for the full design).
  Four sub-views: a filterable/paginated raw **Event Feed** (turn resolutions, decision
  deployments/rejections with their real reason, player eliminations/disconnects/
  reconnects/kicks, room cleanups, completed games, local-LLM calls, and previously
  console.error-only failures now also logged with `severity: 'error'`) — the only
  sub-view that polls, since it's genuinely live data; a **Decision Balance** dashboard
  cross-referencing real deployments against real game outcomes for a live win/loss
  correlation per decision (the productionized version of this project's earlier
  randomized-simulation balance work); a **Lawsuit Win Rates** dashboard grouped by
  decision + ground; and a **Performance & Errors** view (turn-resolution duration, local
  LLM call latency/success rate, and an error-context breakdown). The three dashboards
  are fetched once when opened plus a manual Refresh button, not polled — each is a real
  multi-thousand-row server-side scan, admin-portal scale rather than hot-path.

The decision library, game config, and formulas are all **stored in Postgres, not static
JSON** (see *Decisions & Game Config* and *Formulas* below) — every save here takes
effect on the very next turn resolved anywhere in the game, no restart required. Deleting
a decision that's currently deployed in a live game is rejected (409) rather than allowed
to crash the next turn resolution for whoever has it active; formulas can't be deleted at
all (see below), only retuned.

Access is gated by a single shared-secret token — set `ADMIN_TOKEN` in `server/.env` (no
default; unset disables the admin API entirely, returning 503 rather than accepting any
request). `AdminPortal.tsx` prompts for the token at runtime and keeps it in
`sessionStorage`, sending it as the `x-admin-token` header on every request — it is
**never** embedded in the client bundle as a `VITE_*` env var, since those are public in
the built JS. There's no broader auth system in this app (see *Reconnection & Session
Resume* above for the same unauthenticated-id-pair trust model elsewhere), so this is
deliberately the simplest thing that works: one token, no users, no expiry.

### Decisions & Game Config (database-backed)

The decision library and `GameConfig` used to be static JSON files
(`server/src/data/game_engine.json`/`game_config.json`) loaded once at server startup.
They're now rows in Postgres (`Decision`, `GameConfigRow`) — authoritative at runtime,
editable live from `/admin` above, with changes taking effect on the next turn resolved
(no restart). The JSON files still exist on disk, repurposed as the **versioned seed
source** for `npm run db:seed` (see `prisma/seed.ts`) — useful for `git diff`-able review
of balance changes and as the disaster-recovery reset path
(`npx prisma migrate reset && npm run db:seed` restores the default library exactly), but
editing them directly has no effect on a running server.

`GameEngine.loadGameData()` reads both tables once at startup (awaited before the server
starts accepting connections); every admin write calls the same
`GameLoop.loadDecisions()`/`updateConfig()` used there to live-reload the in-memory copy
`GameLoop` actually resolves turns against. Deleting a decision is blocked while it's
currently deployed by any non-bankrupt player, anywhere — several places in
`GameLoop.resolveTurn` assume an active decision's definition always exists, so removing
one still in use would otherwise crash the next turn resolution for whoever has it
deployed.

### Formulas (database-backed)

The 24 pure, scalar, named-input formulas that drive competitiveness and market share,
volume, P&L, balance sheet, legal-risk probability, and the risk gauge (`competitiveness`,
`revenue`, `netProfit`, `riskGauge`, etc.) are rows in Postgres (`Formula`:
`key`/`expression`/`description`), seeded from `server/src/engine/defaultFormulas.ts` and
editable live from `/admin`'s Formulas tab, the same live-reload-no-restart story as
decisions/config above. Everything else in the turn-resolution math — the per-turn
execution order, the depreciation ledger, decision maturity/exclusion locking, the
bankruptcy/merger waterfall, simultaneous-purchase FIFO tie-breaking — is control flow and
multi-player ordering, not tunable math, and stays as TypeScript permanently (see
`gameLoop.ts`'s `resolveTurn`, whose numbered `// ── Step N ──` comments are the current,
accurate execution order); it was never a candidate for this.

Expressions are parsed and evaluated by `formulaEngine.ts`, a small hand-rolled
recursive-descent parser/evaluator — **deliberately not `eval`/`new Function`/`vm`**,
since an admin-editable string reaching any of those would be arbitrary code execution
behind a single shared token, a categorically worse risk than a math typo. The grammar is
fixed and tiny: number literals, identifiers, `+ - * /`, unary `-`, parentheses, and
exactly two whitelisted calls, `MIN`/`MAX` — no member access, no assignment, no string
literals, no arbitrary function calls, so there's no path from a formula string to
anything beyond that AST. `calcEngine.ts`'s 7 exported functions each take a `FormulaSet`
(`Map<string, CompiledFormula>`) and call `evalNamed(formulas, 'key', context)` instead of
inline arithmetic — a mechanical refactor, not a rebalancing; the seeded expressions
(`defaultFormulas.ts`, shared by `prisma/seed.ts` and the engine test fixtures) match the
old hardcoded behavior exactly.

**The formula key set is fixed — no create/delete via `/admin`, only `PUT`.** Each of the
23 keys is referenced by name at a specific `calcEngine.ts` call site `GameLoop`
hard-depends on; unlike decision deletion, there's no way to make removing one safe, so
the option doesn't exist. Every write is validated twice before it reaches `GameLoop`: a
real syntax parse (`parseFormula`) and a fixed per-key variable whitelist
(`FORMULA_VARIABLES` in `validation/schemas.ts`) — an expression that parses fine but
references a variable the call site never supplies would otherwise throw mid-turn, for
every active game, the next time it's evaluated.

### Bankruptcy & Game Over (Aftermath)

A player is eliminated the instant their cash goes below $0 on any turn — strictly
`cash < 0`, no debt-based rule. When a player falls, their still-unresolved lawsuits
(as both plaintiff and defendant) lapse; cases against them are paid out from a pool of
that turn's positive income-side cash flow, oldest filing first, until the pool runs out
(oldest-filing-first, same rule for both elimination reasons). The game continues, looping GAME_PHASE rounds, until only one player
remains — there is no fixed round limit and no score-based win condition. The eliminated
player themselves sees the "lost" takeover described in *Leave Game* above, regardless of
whether they left voluntarily or actually ran out of cash. Everyone else still in the game
gets an "X HAS GONE BANKRUPT" **info-window modal** (same `lost.png` art), queued in
`gameStore.bankruptcyEvents` and rendered by `App.tsx`'s `BankruptcyModal` as an overlay on
top of whatever's currently on screen — the game itself keeps running and stays fully
visible underneath (the round timer, KPIs, News feed, everyone's turn — nothing pauses or
disappears), and dismissing the modal ("Got it" or the close button) just returns to it.
This used to be a full-page takeover that replaced the entire screen, including a
still-in-progress game for every survivor — a real, reported bug, since the game only
*looked* like it had stopped. The modal still has to render independently of the
`currentPhase` switch (not folded into GamePhase's own News feed) so it's shown even when
this same elimination ends the game — the `player:bankrupt` and `game:over`/`phase:changed`
broadcasts arrive back-to-back from the same turn resolution, and the modal keeps showing
layered on top of the Game Over screen that swaps in underneath it in that case.

A bankrupted player's Company row must have its real (negative) `cash` persisted, not just
their `Player.bankrupt` flag — `GameLoop.resolveTurn` excludes bankrupted players from
`companyUpdates` (their engine state is done being touched), so `BankruptedPlayer.finalCash`
carries their actual balance at elimination for `GameEngine` to write to the DB alongside
the `bankrupt: true` flag. Skipping this left a bankrupted player's `cash` column frozen at
whatever positive value it had from their last still-active turn — including on the Game
Over / Final Standings screen, which read the DB straight through `buildGameOverPayload`.

### News (sued / lawsuit verdict / settlement / shares bought / turn change)

Five things generate a News item after a turn resolves: getting sued, one of your own
lawsuits reaching a trial verdict, one of your own cases settling by negotiation instead,
another player buying a stake in your own company via Buy Shares, and the round simply
advancing. Unlike earlier versions of this feature, **none of these interrupt play** —
each one just appends a row to the **News** box (right under the KPI cards), and the
player clicks a row whenever they like to see the same info window this used to pop up
automatically. Rows show a short topic ("You have been sued", "Case won", "Case settled",
"Your shares were bought", "Next turn") and which turn they're from; a brand-new row
flashes red a
few times so it doesn't go unnoticed, without demanding an immediate response the way an
auto-popping modal did. The list appends newest-at-the-bottom and auto-scrolls to follow,
but only while you're already scrolled near the bottom — scroll up to reread older news
and a new arrival won't yank you back down.

- **Sued** (`sued.png`) — `detectNewlySuedCases` diffs this turn's legal cases against
  last turn's to find cases newly filed against the current player (by id, so an
  existing case is never re-reported). Shows the plaintiff, decision, ground, and
  stakes for every newly-filed case that turn.
- **Lawsuit verdict** (`lawsuit-won.png` / `defender-won.png` / `lawsuit-lost.png`) —
  `detectNewlyResolvedCases` finds cases *I'm a party to* (plaintiff or defendant) that
  just reached a trial verdict (`status: 'resolved'`, `verdict: 'won' | 'lost'`). The
  `won`/`lost` label is from **my own perspective**, not the raw `verdict` field — a
  defendant's case resolving `'lost'` (the plaintiff lost) is a *win* for that defendant,
  so the outcome is flipped for whichever role I actually have in the case, with
  role-aware copy for all four win/lose × plaintiff/defendant combinations ("You received
  $X from…", "You paid $X to…", etc.). The art goes one step further than the text: a win
  as **plaintiff** (a real payout) shows `lawsuit-won.png`, while a win as **defendant**
  (the case was dismissed, no money changes hands) shows the distinct `defender-won.png` —
  picked by checking whether every case in this turn's won-bundle has me as defendant.
- **Case settled** (`settlement-proposal.png`) — `detectNewlySettledCases` finds cases
  *I'm a party to* that resolved via `verdict: 'settled'` instead of a trial (negotiation
  — see *Lawsuits* above; not `'cancelled'`, the bankruptcy-waterfall outcome, which isn't
  a settlement either side negotiated). Shows who paid whom the settled amount, same
  role-aware framing as the verdict item.
- **Shares bought** (`shares-bought.png`) — `GameLoop` itself already knows, at the exact
  moment each Buy Shares trade executes, who bought and what fraction of the whole company
  changed hands (`PlayerTurnResult.sharesBoughtThisTurn`), so this one needs no client-side
  diffing against last turn — only the *target* of a purchase gets the item, and only for a
  genuine other-player purchase (a self-buyback, reclaiming your own previously-diluted
  stake, is your own action and isn't news to yourself). Shows who bought and what
  percentage of the total shares was sold, e.g. "Bob bought 20% of your company's shares."
  Two different buyers purchasing a stake in the same turn produce two separate items, same
  "one thing per event, never a batch" rule every other News item follows.
- **Next turn** (`turn-change.png`) — every round after the first (round 1 is the
  initial game start, not a change from anything) gets one of these the moment the
  round number advances.

All three legal-case detection functions are pure and unit-tested independently of any
live turn cycle (`GamePhase.utils.test.ts`); Shares Bought's own coverage lives
server-side, in `gameLoop.test.ts`'s Buy/Sell Shares suite, since the server already
computes exactly what happened that turn (see CLAUDE.md). The effect that drives all of
this is guarded against
React 18 StrictMode's dev-only double-invocation via a `useRef` — see CLAUDE.md for why
that guard exists and what broke before it did.

### Game Timeline — a Civilization-style game-over replay, and a live spectator view for eliminated players

`GameTimelineView` (`client/src/pages/GameTimelineView.tsx`) is one shared screen used two
ways: a **live-updating spectator view** for a player who's been eliminated (bankrupt,
forfeited, or acquired) but chooses to keep watching, and the **Game Over screen itself**
(`GameOver.tsx`, now just a thin wrapper) for everyone — winner and spectators alike — once
the game actually ends. It shows a switchable KPI race chart (Cash/Equity/Revenue/Stock
Value/Threat Level, one line per player), play/pause/speed/scrub controls, a cumulative
"happenings" log (every decision deployed and every lawsuit filed/resolved, for every
player, clickable to jump the scrub position to that round), and a ranked standings list
for whichever metric is currently selected — scrubbing to the final round *is* the
final-standings view, there's no separate table.

**A "deployed X" happening's decision name is itself clickable** (separately from the
round-jump click on the rest of the row), opening a themed popup with that decision's full
details — description, level/nature, effects timeline, legal risks — the same information
`ActiveDecisionCard` shows during the live game, looked up from the room's decision deck
already held client-side. **A lawsuit happening (filed or resolved) shows its dollar
stakes and the plaintiff's own known odds** at the moment they sued, as the same 5-band
verbal likelihood (Highly Unlikely…Highly Likely) the live SUE THEM CHICKENS flow uses —
"Unknown" if the plaintiff sued on a hunch rather than a fully-investigated hint, matching
how odds are gated everywhere else in the game. **A Buy Shares happening shows the acquired
stake percentage** — "acquired N% stake" alongside the target's name, the same figure a
live incoming-attack hint's "Acquired N% ownership stake" summary already shows.

After acknowledging an elimination (`LostOverlay`'s new **"Watch the rest of the game"**
button, alongside the original **"Leave"**), a player lands on the live view instead of a
dead end — their socket was never disconnected on elimination in the first place, so it's
been receiving every turn's broadcast the whole time regardless. The live view auto-follows
the newest round as further turns resolve, unless the viewer has manually scrubbed
backward. The instant the game actually ends, every socket still in the room — survivors
and spectators together — gets the same phase-change broadcast and lands on the identical
finished-game replay.

Two small backend additions make this possible: a durable `LegalCaseHistory` table
(a resolved lawsuit only survives one extra turn in a player's live engine state, so a
separate log is needed to show "every lawsuit filed/resolved" across a whole game, plus
`baseProbability`/`plaintiffFullyInvestigated` columns stamped once at filing time so the
happenings log can show the plaintiff's own known odds) and a `Player.eliminatedRound`
column (so "when was X eliminated" is reconstructable from persisted data, not just a live
broadcast a spectator happened to see). Eliminated players
are also now exempt from the disconnect grace-period cleanup that would otherwise delete
their data if they simply closed their tab — see CLAUDE.md's *"Game Timeline"* section for
the full architecture, including the stale-room-cleanup fix that had to come with it.

---

## 🔍 Validation & Game Engine

### Input Validation (Zod Schemas)

All client inputs are validated server-side using Zod schemas before processing:

| Schema | Field | Constraints |
|--------|-------|-------------|
| `roomJoinSchema` | `playerName` | Required, 1-30 characters |
| | `roomName` | Optional, max 40 characters (covers UUID v4 invite-link codes, 36 chars) |
| | `searchForRoom` | Optional boolean — triggers Quick Play search |
| `chatMessageSchema` | `message` | Required, 1-500 characters |
| `submitDecisionsSchema` | `strategic`, `operational`, `financial` | Arrays of `{ name, targetId?, amount? }`, max 20 entries each — structural sanity only; the real per-turn limits come from `game_config.json` and are enforced by `GameLoop.processNewDecisions` |
| | `lawsuits` | Array of `{ targetId, decisionName, groundName, attackId? }`, max 10 entries — structural cap only; the real limit (`maxLawsuitsPerPlayerPerTurn`, 3) and the "target actually deployed this" check happen in `LegalEngine.fileLawsuit`. `attackId`, when present, pins the filing to that exact attacking instance rather than a name-only match — see CLAUDE.md's *"Only one lawsuit per decision instance, ever"* section |
| `digDeeperSchema` | `attackId` | Required, 1-100 characters |
| `gameReadySchema` | `ready` | Required boolean |
| `roomSetInviteOnlySchema` | `inviteOnly` | Required boolean |
| `roomRejoinSchema` | `roomId`, `playerId` | Both required, 1-50 characters — no separate auth token; the id pair itself is the bearer credential, same trust model as every other player id already used throughout the app (no passwords anywhere) |
| `annualReportRequestSchema` | `rivalPlayerId` | Required, 1-100 characters |
| `decisionDefinitionSchema` | `decision`, `level`, `description`, `nature`, `offensiveAction`, `excludes`, `impacts` | Structural — mirrors `DecisionDefinition`; doesn't re-verify formula semantics, same philosophy as `submitDecisionsSchema` |
| | `legalRisks`, `competitorsView`, `variableAmount`, `requiresTarget`, `legalRiskConditions`, `cashFlowCategory` | All optional |
| `gameConfigSchema` | `gameSettings`, `playerStartingValues`, `adminVariables` | Strict, field-by-field (not a loose record) — every field is a fixed, known number/boolean driving a real formula, so a typo'd key is rejected, not silently ignored |
| `formulaUpdateSchema` | `expression`, `description` | `expression` is further checked by `parseFormula` (real syntax, not a regex) and against `FORMULA_VARIABLES`'s per-key whitelist — an expression that parses fine but references a variable the target `calcEngine.ts` call site never supplies is rejected here, not at evaluation time mid-turn |

### Game Engine Architecture

Two layers split room/lobby/persistence/broadcast concerns from turn-resolution math:

**`GameEngine`** (`server/src/socket/gameEngine.ts`) — room and phase lifecycle, and the
only place that touches Prisma or Socket.IO for turn resolution:

| Method | Description |
|--------|-------------|
| `createRoom(player)` | Creates a new room with the player as founder (max 4 players) |
| `joinRoom(roomId, player)` | Joins an existing room; throws if full, the name is already taken, or the name is in `RoomState.kickedNames` for this room |
| `markPlayerDisconnected(socketId)` | A socket disconnected — clears the player's live socket association but keeps them in the room and makes no DB write, starting their reconnect grace-period clock |
| `finalizePlayerRemoval(roomId, playerId)` *(private)* | Actually removes a player whose grace period expired without a `room:rejoin` — the DB cleanup `markPlayerDisconnected`'s predecessor (`removePlayer`) used to do immediately; broadcasts `room:playerLeft`; cleans up the room if it's now empty, otherwise promotes a new host if needed and broadcasts `room:updated` |
| `leaveRoom(roomId, playerId)` | Voluntary lobby departure — WAITING phase only. Same DB cleanup as a kick (player actually removed, not just marked bankrupt — there's no game in progress to forfeit), then either deletes the room (last player) or promotes a new host if needed and broadcasts `room:updated` |
| `promoteNewHostIfNeeded(roomState)` | No-ops if the room already has a host or is empty; otherwise promotes the longest-tenured remaining player (`roomState.players` is a `Map`, so the first entry is genuinely the earliest joiner still present) and persists it. Called after every removal path — kick, `leaveRoom`, `finalizePlayerRemoval` — since any of them could have removed the host. |
| `buildRoomSnapshot(roomState)` | Rebuilds a `Room` object fresh from `roomState.players` every time. The one thing to never do instead: broadcast `roomState.room` directly — its embedded `players` array is populated once at creation and nothing keeps it in sync afterward, which was the root cause of a real bug (a kick's "sync the roster" broadcast silently overwriting other players' own identity — see the `room:updated` handler above for the fix). |
| `rejoinRoom(roomId, playerId, socketId)` | Re-associates an existing (still-within-grace-period) player with a new socket; returns data for the caller to emit (`room:joined` always, plus `game:deck`/cached `turn:resolved` or `game:over` depending on room phase) rather than doing the emitting itself, mirroring `digDeeper`'s pattern |
| `buildRoomJoinedPayload(roomState, player)` | Builds the `room:joined` payload shape (via `buildRoomSnapshot` plus the recipient's own `player`) — shared by the fresh-join and rejoin paths |
| `digDeeper(roomId, playerId, attackId)` | "Dig Deeper" — pay to reveal the next tier of intel on one incoming attack, instantly, outside the turn-resolution cycle. Loads active players, calls `GameLoop.digDeeper` (pure), and on success does the one Prisma write (`cash` *and* `variables`, since `GameLoop` reads cash from the `variables` JSONB, not the column) |
| `getAnnualReport(roomId, rivalPlayerId)` | AI-narrated "annual report" text for one rival, on demand — loads active players, calls `GameLoop.getActiveDecisionSummaries` (pure, re-derives from the rival's own `Company.engineState`), then asks `services/llmService.ts` to narrate each active decision (network I/O, cached, falls back to static `competitorsView` text on any failure). Read-only — no Prisma write |
| `advancePhase(roomId)` | Linear phase advance (WAITING → GAME_PHASE); race-condition guarded |
| `resolveGameTurn(roomId)` | Loads active players from the DB, calls `GameLoop.resolveTurn` (pure), then persists the returned `companyUpdates`/`bankruptedPlayers` and broadcasts `player:bankrupt`/`turn:resolved` — then either loops into another GAME_PHASE round (clearing `readyPlayerIds` and broadcasting `game:readyUpdate` for it) or, once one player remains, transitions to AFTERMATH and emits `game:over`. Also caches the broadcast result (`lastTurnResults`) for `rejoinRoom` to re-send. Called either by the round timer, or early — by the `game:ready`/`game:leave` socket handlers, once `toggleReady`/`forfeitGame` report every active player is ready — never from inside `toggleReady`/`forfeitGame` themselves; see *Ready-up triggers `resolveGameTurn` early* in CLAUDE.md for why. |
| `forfeitGame(roomId, playerId)` | Voluntary forfeit — GAME_PHASE only. Marks the player bankrupt (same DB write + `player:bankrupt` broadcast shape as a natural elimination) and, if that leaves at most one active player, ends the game exactly like `resolveGameTurn`'s post-turn win check. Otherwise drops the forfeiting player's ready flag and returns `triggerImmediateResolution: true` if that alone now satisfies "every remaining active player is ready" — the caller, not this method, calls `resolveGameTurn` for that, since this method still holds the `advancingRooms` lock (see below) until it returns. |
| `toggleReady(roomId, playerId, ready)` | Adds/removes one player from `RoomState.readyPlayerIds` (GAME_PHASE only, `null` for an unknown/bankrupt player or a non-GAME_PHASE room) and returns the updated `{ readyPlayerIds, activePlayerCount }` for the caller to broadcast and, if everyone active is now ready, immediately call `resolveGameTurn` with. |
| `submitDecisions(roomId, playerId, decisions)` | Forwards a validated `game:submitDecisions` payload to `GameLoop` |
| `broadcastInitialSnapshot(roomId, round)` | Called once, right when `room:startGame` fires — loads active players, calls `GameLoop.getInitialSnapshot` (pure), and broadcasts the result immediately so the game room renders without delay. Also caches it for `rejoinRoom`. |
| `broadcastRoomState(roomId, event, data)` | Broadcasts state to all players in a room |
| `getAdminRoomsSnapshot()` | Synchronous, in-memory-only monitoring snapshot of every room in every phase (unlike `room:list`'s WAITING-only, non-full-only Quick Play view), with every player's host/bankrupt/connected status. Backs `GET /api/admin/rooms`. |
| `loadGameData()` | Reads the `Decision`/`GameConfigRow` tables, constructs `GameLoop`, and loads the decision library — called once at startup (awaited before the server accepts connections) and never again; every later change goes through `upsertDecision`/`deleteDecision`/`updateGameConfigData` below instead |
| `getDecisionsSnapshot()` / `getGameConfigSnapshot()` | In-memory reads backing `GET /api/admin/decisions` / `GET /api/admin/config` |
| `upsertDecision(def, isNew)` | Create or update one decision — writes the DB row, then calls `GameLoop.loadDecisions()` again so the change is live for the next turn resolved anywhere. `isNew` picks create-must-not-exist vs. update-must-exist. |
| `deleteDecision(name)` | Deletes a decision — but only after `isDecisionInUse` confirms no non-bankrupt player anywhere currently has it deployed (`{ reason: 'in_use' }` otherwise); `GameLoop.resolveTurn` assumes an active decision's definition always exists, so this guard is load-bearing, not a nicety |
| `updateGameConfigData(config)` | Writes the new `GameConfig` to the DB, then calls `GameLoop.updateConfig()` to live-reload it |
| `getFormulasSnapshot()` | In-memory read backing `GET /api/admin/formulas` |
| `updateFormula(key, expression, description)` | Writes one formula row (404 if the key is unknown — no create), then calls `GameLoop.loadFormulas()` again so the change is live for the next turn resolved anywhere. Validation (syntax + variable whitelist) happens in `validateFormulaUpdate` before this is ever called. |
| `loadActiveCompanyPlayers(roomId)` *(private)* | Shared DB fetch (`player.findMany` with `company` included, `bankrupt: false`) feeding `resolveGameTurn`, `broadcastInitialSnapshot`, and `digDeeper` |
| `startHeartbeatCleanup()` *(private)* | One 10s `setInterval` sweeping two things: rooms empty for over `STALE_ROOM_THRESHOLD` (60s), and disconnected players past `RECONNECT_GRACE_PERIOD_MS` (120s) → `finalizePlayerRemoval`, skipped for a room whose turn is currently resolving (`advancingRooms`) and retried on the next tick instead — see *Reconnection & Session Resume* above. Extend this interval for new periodic sweeps rather than adding a second one. |

**`GameLoop`** (`server/src/engine/gameLoop.ts`) — the authoritative turn-resolution
engine, loaded via `GameEngine.loadGameData()` (decisions/config now come from the
database, not JSON — see *Decisions & Game Config* above) and live-reloaded on every
admin edit. It is a **pure computation engine**: no Prisma, no Socket.IO, no I/O of any
kind — it takes plain player data in and returns plain result data out, so it can be
unit-tested and reasoned about without mocking a database or a socket server:

| Method | Description |
|--------|-------------|
| `loadDecisions(definitions)` | Loads the decision library into `DecisionEngine`/`LegalEngine` — safe to call again any time, replacing the in-memory maps outright, which is how admin decision edits take effect on the next turn with no restart |
| `updateConfig(config)` | Replaces `gameSettings`/`playerStartingValues`/`adminVariables` in place — same mechanism as `loadDecisions`, used both for the initial DB load and every later admin config edit |
| `loadFormulas(rows)` | Compiles each row's expression into a `FormulaSet` and replaces the in-memory set outright — same live-reload mechanism as `loadDecisions`/`updateConfig`, used for the initial DB load and every later admin formula edit. Every calc-engine call in `resolveTurn`/`getInitialSnapshot` reads from this set; it defaults to an empty `Map`, so this must be called before any turn resolves. |
| `submitDecisions(roomId, playerId, decisions)` | Buffers one player's choices for the in-flight turn |
| `resolveTurn(roomId, round, players: EngineDataInput[])` | Runs the full per-turn calculation (see *Business Decisions* above) and returns a `TurnResolutionOutcome`: the `turn:resolved` broadcast payload (`result`), the `Company` rows still-active players need persisted (`companyUpdates`), and the players eliminated this turn (`bankruptedPlayers`) — it does not write to the DB or emit anything itself |
| `getInitialSnapshot(roomId, round, players: EngineDataInput[])` | Same formula pipeline as `resolveTurn`, but with zero decisions and nothing persisted — returns the `TurnResolutionResult` preview directly; the caller broadcasts it |
| `digDeeper(playerId, attackId, players: EngineDataInput[])` | A lighter-weight sibling to `resolveTurn` — no market/P&L pipeline, just cash + engine state. Validates funds and investigation level, bumps the target attack's tier, and returns a `DigDeeperOutcome` (new cash, the revealed `IncomingAttackInfo`, and the engine state to persist) for the caller to write and emit; never runs on the turn timer |
| `getActiveDecisionSummaries(playerId, players: EngineDataInput[])` | Read-only lookup of one player's active decisions (name, description, deployed/elapsed years) for `GameEngine.getAnnualReport` to narrate — mutates nothing, returns `null` if the player isn't found |

`GameEngine` owns the full read → compute → persist → broadcast cycle: it loads each
active player's `Company.variables`/`engineState` from the DB into `EngineDataInput[]`,
calls the relevant `GameLoop` method, then writes back `companyUpdates` (`Company.update`)
and `bankruptedPlayers` (`Player.update({ bankrupt: true })`) and emits `player:bankrupt`
and `turn:resolved` in that order — mirroring exactly the order `GameLoop` used to persist
and broadcast internally, just performed by the caller instead.

**Room Lifecycle:**
1. Room created in database with `WAITING` status
2. Players join via socket; room loaded into in-memory `Map`
3. Host starts the game: `WAITING` → `GAME_PHASE`, round 1, 120s timer starts, the
   decision library broadcasts once (`game:deck`), and `broadcastInitialSnapshot`
   immediately sends everyone their starting position — players land straight in the
   game room with a real, deployable Decision Deck, not a blank loading screen
4. Every time the GAME_PHASE timer expires, `resolveGameTurn` resolves the round and
   either loops (`currentPhaseRound` + 1, new 120s timer) or ends the game (`AFTERMATH`)
5. A socket disconnecting doesn't remove its player — see *Reconnection & Session Resume*
   above — so "room empties" now means every player's reconnect grace period has expired,
   not just every socket being momentarily gone; once that's true, both in-memory state
   and the database record are cleaned up

**Concurrency Safety:**
- Phase advancement and turn resolution share a `Set<string>` lock (`advancingRooms`) to
  prevent two concurrent resolutions of the same room
- Room joins handle the "TOCTOU" (time-of-check-time-of-use) gap by catching `Room is full` errors and falling back to room creation

---

## 🧪 Testing

```bash
# Type-check all packages
npm run type-check

# Lint all packages
npm run lint

# Run backend unit tests (Vitest) — engine, calcEngine, decisionEngine, legalEngine,
# formulaEngine (parser/evaluator correctness + rejection of dangerous-looking input
# like __proto__/constructor/arbitrary calls), gameLoop (incl. a regression test that
# a lawsuit persisted into both the plaintiff's and defendant's own engineState
# doesn't get double-counted when reconstructed on a later turn, and a regression test
# that a case forced to trial by the negotiation timeout resolves in the same turn it
# crosses the threshold, plus the makeOffer/acceptOffer/goToCourt turn-taking rules,
# the offer-bracket-narrows-with-each-move regression suite, Step 8b's
# stale-offer-auto-settle/no-offer-cap fallbacks, the plaintiffFullyInvestigated
# describe block covering all branches of the stamped-at-filing-time flag that reveals
# a plaintiff's own case odds, and legalEngine's fileLawsuit tests confirming a wrong
# guess against a target's undeployed decision still creates a real, 0%-probability
# case rather than silently dropping the filing), gameEngine (incl.
# toggleReady, forfeitGame's ready-interaction, promoteNewHostIfNeeded, leaveRoom,
# buildRoomSnapshot, joinRoom's kickedNames rejection, and makeOffer/acceptOffer's
# two-party Company-row persistence + two-socket game:legalCaseUpdate emit), validation
# schemas, llmService, adminAuth middleware. No DB or live LLM required (mocked Prisma,
# incl. mocked `formula` model; llmService's own network calls are mocked via
# global.fetch). Also covers predictFutureKpis (KPI history/prediction graphs) — incl.
# regression tests that a real room's queued decision still applies after a prediction
# runs (the sandboxed room id reads, but never clears/consumes, real in-flight
# submissions), that the player's OWN currently-queued decision is folded into the very
# first predicted turn, and that a rival's queued decision in the same room is not.
npm test --workspace=server

# Run frontend unit tests (Vitest) — Zustand stores, GamePhase utilities (incl.
# detectNewlySuedCases, detectNewlyResolvedCases, and detectNewlySettledCases, the pure
# diffs behind the sued/verdict/settlement News items; isAttackAlreadySuedOver, which
# hides an incoming-attack hint once sued over with a correct/non-zero-probability case;
# and getGroundsAgainst, confirming the SUE THEM CHICKENS ground list is the whole decision
# library's legal-risk catalog, not scoped to any one target's actual deployed decisions)
npm --workspace=client exec vitest run

# Run API interface tests (Vitest + real PostgreSQL via testcontainers)
npm run test:api

# Run API tests in watch mode
npm run test:api:watch

# Run Playwright E2E tests (needs the client dev server + a running backend)
npm run test:e2e

# Run Playwright E2E tests in UI mode
npm run test:e2e:ui

# Run Playwright E2E tests headed (visible browser)
npm run test:e2e:headed

# Run all tests (API + E2E)
npm run test:all
```

> **Note**: `npm run test:api` (`tests/api/`) spins up a real, disposable PostgreSQL
> database via testcontainers and runs `prisma migrate deploy` against it — it needs
> Docker. It's the layer that verifies the actual Socket.IO event contracts (including
> `game:submitDecisions`, `turn:resolved`, `game:over`) and Prisma schema, as opposed to
> the mocked-Prisma unit tests in `server/src/**/*.test.ts`.

---

## 📦 Deployment

### Production Build (Local)

```bash
# Build both packages
npm run build

# The client will be in client/dist/
# The server will be in server/dist/
```

### Docker Deployment

The project includes a multi-stage Docker build (`Dockerfile`) that builds the entire stack in one image:

```dockerfile
# Build and run with the full-stack image
docker build -t suethemchickens:latest .
docker run -p 80:80 -p 3001:3001 suethemchickens:latest
```

Or use the provided `docker-compose.yml` for orchestrated deployment with PostgreSQL:

```bash
docker-compose up -d --build
```

### Recommended Hosting

| Service | Best For |
|---------|----------|
| **Railway** | Full-stack deployment with managed PostgreSQL |
| **Fly.io** | Socket.IO apps with sticky sessions |
| **Render** | Simple deployment with free tier |
| **AWS ECS** | Production-scale with auto-scaling |

---

## 🔒 Security

- **Server-authoritative validation**: All game actions validated with Zod schemas
- **CORS protection**: Configured per environment
- **Input sanitization**: All user inputs validated before processing
- **Rate limiting**: Recommended for production (add `express-rate-limit`)
- **Authentication**: Recommended for production (add JWT or session-based auth)

---

## 📝 API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/room/:roomId` | Get room details |
| POST | `/api/feedback` | Submit player feedback — `{ rating: 1-5, message?, source: 'landing' \| 'gameover' }`. Body validated by `feedbackSubmitSchema`. Public, no auth — deliberately anonymous, no player/room id accepted. See *Player Feedback* above. |
| GET | `/api/admin/rooms` | Every in-memory room (any phase), with per-player status. Requires `x-admin-token`. See *Admin Portal* below. |
| GET | `/api/admin/decisions` | The full decision library, from the DB. Requires `x-admin-token`. |
| POST | `/api/admin/decisions` | Create a new decision. Body validated by `decisionDefinitionSchema`; 409 if the name already exists. Requires `x-admin-token`. |
| PUT | `/api/admin/decisions/:name` | Update an existing decision's fields (not a rename — `body.decision` must equal `:name`); 404 if unknown. Requires `x-admin-token`. |
| DELETE | `/api/admin/decisions/:name` | Delete a decision; 409 (`reason: 'in_use'`) if it's currently deployed by an active player anywhere, 404 if unknown. Requires `x-admin-token`. |
| GET | `/api/admin/config` | The `GameConfig` (`gameSettings`/`playerStartingValues`/`adminVariables`), from the DB. Requires `x-admin-token`. |
| PUT | `/api/admin/config` | Replace the game config. Body validated by `gameConfigSchema`. Requires `x-admin-token`. |
| GET | `/api/admin/formulas` | All 24 pure-math formulas, from the DB. Requires `x-admin-token`. See *Formulas* above. |
| PUT | `/api/admin/formulas/:key` | Update one formula's expression/description. Body validated by `formulaUpdateSchema` — real syntax parse plus a per-key variable whitelist; 400 on either failure, 404 if the key is unknown. No create/delete — the key set is fixed. Requires `x-admin-token`. |
| GET | `/api/admin/feedback` | Every submitted feedback row, newest first. Read-only — nothing here is ever written from the admin side. Requires `x-admin-token`. See *Player Feedback* above. |
| GET | `/api/admin/events` | Filterable/paginated raw `EventLog` feed. Query params: `eventType`, `severity`, `roomId`, `playerId`, `before` (ISO timestamp cursor), `limit` (default 100, capped at 500). Requires `x-admin-token`. See *Admin Portal → Analytics* above and CLAUDE.md's *"EventLog + the admin Analytics tab"*. |
| GET | `/api/admin/analytics/decisions` | Per-decision deploy/reject counts, top rejection reasons, and a real win/loss correlation cross-referenced against completed games. Requires `x-admin-token`. |
| GET | `/api/admin/analytics/lawsuits` | Per (decision, ground) filed/resolved/won counts, win rate, and average stakes — read from `LegalCaseHistory`. Requires `x-admin-token`. |
| GET | `/api/admin/analytics/performance` | Turn-resolution duration stats, local-LLM call latency/success rate by kind, and an error-context breakdown. Requires `x-admin-token`. |

### WebSocket API

All real-time communication uses Socket.IO events (see [Real-Time Communication](#real-time-communication) section above).

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License.

---

## 🙏 Acknowledgments

- Built with [Socket.IO](https://socket.io/) for real-time communication
- Database powered by [PostgreSQL](https://www.postgresql.org/)
- ORM by [Prisma](https://prisma.io/)
- UI components from [Mantine](https://mantine.dev/)
