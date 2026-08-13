import { describe, it, expect } from 'vitest';
import { botJoinNotice } from './botJoinNotice';

const NOW = 1_700_000_000_000;
const human = { isBot: false };
const bot = { isBot: true };

describe('botJoinNotice', () => {
  it('counts down for a lone human with a pending bot join', () => {
    expect(botJoinNotice([human], NOW + 7_400, NOW)).toEqual({ kind: 'countdown', secondsLeft: 8 });
  });

  it('rounds the remaining time UP, so the counter never shows 0 while time remains', () => {
    // A bare Math.floor would render "0s" for a full second before the bot actually
    // arrives, reading as a stalled lobby.
    expect(botJoinNotice([human], NOW + 1, NOW)).toEqual({ kind: 'countdown', secondsLeft: 1 });
    expect(botJoinNotice([human], NOW + 10_000, NOW)).toEqual({ kind: 'countdown', secondsLeft: 10 });
  });

  it('switches to "imminent" once the deadline passes but the bot has not landed yet', () => {
    expect(botJoinNotice([human], NOW, NOW)).toEqual({ kind: 'imminent' });
    expect(botJoinNotice([human], NOW - 500, NOW)).toEqual({ kind: 'imminent' });
  });

  it('reports the bot as present once it is actually in the roster', () => {
    expect(botJoinNotice([human, bot], null, NOW)).toEqual({ kind: 'bot-present' });
  });

  it('prefers "bot present" over a stale deadline still sitting in the future', () => {
    // The arriving ROOM_UPDATED carries both the new roster and (absent) countdown, but
    // the client's own re-anchored deadline can still be mid-flight for a tick.
    expect(botJoinNotice([human, bot], NOW + 5_000, NOW)).toEqual({ kind: 'bot-present' });
  });

  it('reports humans-present the moment a second human joins, even with a stale deadline', () => {
    // The already-waiting player learns of the new arrival via ROOM_PLAYER_JOINED, which
    // carries no fresh room snapshot — so their deadline is still the pre-cancellation
    // one. The roster is what has to win here, or their counter keeps ticking toward a
    // bot the server has already cancelled.
    expect(botJoinNotice([human, human], NOW + 5_000, NOW)).toEqual({ kind: 'humans-present' });
  });

  it('reports humans-present for a full room too', () => {
    expect(botJoinNotice([human, human, human, human], null, NOW)).toEqual({ kind: 'humans-present' });
  });

  it('says nothing for a lone human with no bot join pending (invite-only, bots disabled)', () => {
    expect(botJoinNotice([human], null, NOW)).toBeNull();
  });

  it('treats a missing isBot flag as human', () => {
    expect(botJoinNotice([{}, {}], null, NOW)).toEqual({ kind: 'humans-present' });
    expect(botJoinNotice([{}], NOW + 3_000, NOW)).toEqual({ kind: 'countdown', secondsLeft: 3 });
  });
});
