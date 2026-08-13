/**
 * Decides what the room lobby should say about the server-injected bot opponent — the
 * "a bot joins in 7s" counter, and the messages that replace it once that window closes.
 *
 * Pure and DOM-free on purpose (this workspace runs Vitest without jsdom, see
 * CLAUDE.md's *Test layers*), so `botJoinNotice.test.ts` can exercise every state
 * directly instead of driving the lobby through a browser.
 *
 * The server's own rule (`GameEngine.scheduleBotJoinCheck`) is that a bot joins a public,
 * still-WAITING room `BOT_JOIN_DELAY_MS` after it's left with exactly one human in it,
 * and that a real human joining first cancels that (`joinRoom`'s `clearBotJoinCheck`).
 * This mirrors it for display only — never authoritative, same convention as every other
 * client-side mirror of server math in this codebase.
 */

/** Minimal shape this needs off `Room['players']` — deliberately not the full `Player`. */
export interface BotJoinNoticePlayer {
  isBot?: boolean;
}

export type BotJoinNotice =
  /** A bot is on the clock — show the live counter. */
  | { kind: 'countdown'; secondsLeft: number }
  /** The counter hit zero; the bot's join is in flight and a ROOM_UPDATED is imminent. */
  | { kind: 'imminent' }
  /** A bot is already here. It still yields its seat to any human who joins (see
   *  `GameEngine.joinRoom`'s `removeBotPlayers`), which is the whole point of saying so. */
  | { kind: 'bot-present' }
  /** Two or more humans — the bot was cancelled and none is coming. */
  | { kind: 'humans-present' };

/**
 * @param players - The room's current roster.
 * @param botJoinDeadline - Epoch ms the bot is expected at, or `null` when nothing is
 *   pending. Derived client-side by anchoring `Room.botJoinInMs` against the client's own
 *   `Date.now()` at arrival, so a client clock offset from the server's can't skew it.
 * @param now - Current epoch ms; injected rather than read internally to keep this pure.
 * @returns The notice to render, or `null` when the lobby should say nothing at all — a
 *   lone player in a room no bot is scheduled for (invite-only, or bots disabled).
 */
export function botJoinNotice(
  players: BotJoinNoticePlayer[],
  botJoinDeadline: number | null,
  now: number,
): BotJoinNotice | null {
  // A bot in the room outranks any stale pending-join state: whatever the countdown said,
  // the outcome has already happened.
  if (players.some((p) => p.isBot)) return { kind: 'bot-present' };

  // Derived from the roster rather than from `botJoinInMs` going away, deliberately: the
  // player who was already waiting learns about a new arrival via ROOM_PLAYER_JOINED,
  // which carries no fresh room snapshot (see socketStore.ts), so their `botJoinInMs`
  // is still the pre-cancellation value at this point and would otherwise keep ticking.
  if (players.filter((p) => !p.isBot).length > 1) return { kind: 'humans-present' };

  if (botJoinDeadline === null) return null;

  const secondsLeft = Math.ceil((botJoinDeadline - now) / 1000);
  return secondsLeft > 0 ? { kind: 'countdown', secondsLeft } : { kind: 'imminent' };
}
