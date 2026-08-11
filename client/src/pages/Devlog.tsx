import React from 'react';
import { Container, Paper, Title, Text, Stack, Group, Button, Divider, Badge, Box } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import AdSlot from '../components/AdSlot';
import { usePageMeta } from '../lib/usePageMeta';

// "Courtroom Ink" tokens — see CLAUDE.md's *Client-side duplicated pure logic* section
// for why every page defines its own local copy instead of importing a shared one.
const devlogStyles = {
  paper: {
    background: 'var(--ink-parchment)',
    backgroundImage: 'var(--paper-texture)',
    border: '1px solid #cbb888',
    borderRadius: 4,
    boxShadow: '6px 8px 0 rgba(0,0,0,0.45)',
  } as React.CSSProperties,
  title: {
    fontFamily: "'Rye', Georgia, serif",
    fontWeight: 400,
    color: 'var(--ink-text)',
  } as React.CSSProperties,
};

export interface DevlogEntry {
  date: string;
  title: string;
  tag: string;
  paragraphs: string[];
}

/**
 * Real engineering postmortems, newest first, adapted from actual commit history into
 * plain-language stories — distinct from `/whats-new` (short, player-facing patch notes)
 * in both length and audience: this is "here's a bug we found and how we found it,"
 * written for anyone curious how the game actually works under the hood. Every story here
 * corresponds to a real fix documented in more technical detail in this repo's own
 * CLAUDE.md, cross-referenced against the actual commit that shipped it for accurate dates.
 */
export const DEVLOG_ENTRIES: DevlogEntry[] = [
  {
    date: 'August 11, 2026',
    title: 'A stranger told us our best feature was invisible',
    tag: 'Design',
    paragraphs: [
      "We posted the game to a game-sharing community and got exactly one substantive reply. It asked for a feature: a small evidence log during a lawsuit negotiation showing what the rival actually did, your chance of winning, and the damages at stake — so that, as they put it, losing a trial would feel like a risk you chose rather than random chance punching you in the face.",
      "The awkward part is that all three of those things already existed. That is precisely what the Dig Deeper button uncovers: first who did what to you, then the exact decision they deployed, then every legal ground you could sue them on with an estimated chance of success and the money at stake on each. It's the single most important mechanic in the game, and it had been shipped, tested and documented for months. We replied pointing this out, and got the reply that actually mattered: \"I didn't catch that from the clip. If it's already there, I'd make the button a little more obvious, because that's exactly the info I wanted before risking a trial.\"",
      "That is a much more useful bug report than a feature request. Nothing was missing — the path to the information simply wasn't labelled. The button announced its price ($10,000) and said nothing whatsoever about what you got for the money. Worse, the one place that did explain it, on a lawsuit you're defending, was a hover tooltip, which means it did not exist at all for anyone playing on a phone.",
      "So the fix is small and entirely cosmetic: the button now states its payoff before its price, and changes what it promises depending on how far you've already dug — \"Reveals what they actually did\" while your attacker is still anonymous, then \"Reveals your grounds to sue — and your odds of winning\" once you know what they deployed. It's a filled button now rather than a faint outline, because on an un-investigated attack it is the primary thing you should be doing. Not one line of game logic changed.",
      "The lesson we're taking from it is uncomfortable and probably generalisable: a mechanic that is fully implemented, correct, and undiscovered is worth approximately zero. We had no way of knowing this from our own play-testing, because we already knew where everything was.",
    ],
  },
  {
    date: 'August 6, 2026',
    title: 'Rebuilding the site around real content: a homepage, four new guides, and a quieter cookie banner',
    tag: 'Site & Growth',
    paragraphs: [
      "Until recently, this whole site was effectively one screen: a hero image, a name field, and a couple of buttons. Fine for a returning player who already knows what they're doing, not so fine for anyone landing here cold, or for the ad slot that used to sit right next to all that empty space. We rebuilt the front of the site around a real homepage — a proper pitch, a Play Now button, and a directory to everything else — and split the game itself off onto its own page rather than living at the root URL.",
      "That \"everything else\" is four brand-new pages: a precise Rules reference (the real numbers, not vibes), a Strategy Guide, a Glossary for the legal and business jargon the game's own UI throws at you, and this Devlog — alongside the illustrated How to Play walkthrough and changelog that already existed. Each one is a real, independently-loadable page, not a modal or a scroll-down section, which mattered for reasons beyond just tidiness (a thin, mostly-empty page next to an ad slot is exactly the kind of thing an ad reviewer flags as low-value).",
      "Two smaller fixes rounded it out. The cookie-consent banner used to be mounted sitewide, which meant it could pop up over the bottom of the screen mid-round if a player hadn't made a choice yet — a bad moment for a real-time game to ask about advertising cookies. It now lives only on the homepage, asked once, up front, before anyone reaches the game itself. And every one of the new guide pages now carries its own ad placement, each with its own distinct ad unit — the same one-slot-per-placement rule the homepage and Game Over screen already followed, just finally applied everywhere there's real content to sit next to.",
    ],
  },
  {
    date: 'July 30, 2026',
    title: 'Market share used to be purely decorative',
    tag: 'Engine',
    paragraphs: [
      "A player asked a simple, slightly embarrassing question: \"does market share actually do anything? Does revenue drop when share drops?\" We went and checked the actual formula, and the honest answer was: almost never. Market share fed into how much you could theoretically sell, but the ceiling on how much you could actually produce was so much lower than the theoretical market size that you'd have to fall to single-digit market share before it ever became the real bottleneck. In practice, a whole cluster of decisions that only moved price or market share were quietly doing nothing to your bottom line.",
      "We fixed two things. First, the total market now scales with how many players are actually in your game, so a 2-player and a 4-player match both start on fair footing instead of one side getting an artificially generous pie. Second, prices now behave like a real market: if everyone raises prices at once, total demand actually shrinks a little, and if everyone cuts prices, it grows — not just a zero-sum tug-of-war between players. We verified the fix with the same randomized-simulation approach we use for every balance change: run a hundred-plus games before and after, and check that the decisions in question actually started winning games instead of sitting inert.",
    ],
  },
  {
    date: 'July 30, 2026',
    title: 'The AI opponent had been throwing punches that never landed',
    tag: 'Bot AI',
    paragraphs: [
      "This one stung a little. Our server-controlled bot opponent had access to roughly 53 different attacking decisions — sabotage, smear campaigns, supply-chain attacks, all the good dirty stuff. It had been picking them, paying for them, and deploying them in every game since the bot first shipped. And for months, none of them were actually hurting anyone.",
      "The bug was a one-line mix-up: the code that decided who an attack should target was checking the wrong flag. It looked at a field that's only ever set on the two Buy/Sell Shares decisions, instead of the field that actually marks a decision as having a real effect on a rival. Every other attacking decision the bot deployed had no target attached at all, so the game engine — correctly, by its own rules — just silently dropped the harmful part of the effect. The bot spent real money cosplaying as a villain without ever actually landing a blow.",
      'Fixing it was a single function-call swap. Verifying it mattered more: once bot attacks started actually working, we immediately found a second, much scarier bug hiding behind the first one — which is the next story.',
    ],
  },
  {
    date: 'July 30, 2026',
    title: 'One decision, six turns, and a bankrupt idle player',
    tag: 'Engine',
    paragraphs: [
      "Right after fixing the bot-targeting bug above, a live test game produced an alarming result: a player who never submitted a single decision the entire game went bankrupt by round 12, entirely because of one attack the bot deployed back in round 5 and never touched again. One decision. Seven rounds of silence. Total collapse.",
      "The cause was a compounding bug in how we applied percentage-based effects. When an attack reduces a target's capacity utilization by, say, 30%, our code was re-applying that same 30% cut every single turn — against the value from the turn before, not the original value. That's not a one-time 30% hit, that's exponential decay: 100% turn one, 70% turn two, 49% turn three, and so on, forever, for as long as the attack stayed on the books (up to ten years of in-game time). A single successful attack was a death sentence with no way to recover from it short of suing your way out.",
      "The fix mirrors how we already handled a similar bug on the decision's own side (not the target's): apply the effect through its own defined schedule, then hold — stop compounding it every subsequent turn. We added a dedicated regression test that replays this exact scenario turn by turn, specifically so this class of bug can never quietly come back.",
    ],
  },
  {
    date: 'July 29, 2026',
    title: 'Our own AI kept bankrupting itself against a player who did nothing',
    tag: 'Bot AI',
    paragraphs: [
      "A separate, equally embarrassing discovery: our bot could reliably go bankrupt in a game where its only opponent submitted zero decisions the entire match. No attacks, no lawsuits, nothing adversarial at all — the bot was doing this entirely to itself.",
      "We found five separate, compounding gaps. The bot's cost estimates only ever looked at a decision's first-year cash effect, missing costs that landed in later years. It had no sense of its own cash trend — it could be losing money every single turn and never notice. Worst of all, it never checked whether a decision was actually legal to deploy (cooldowns, exclusions, still-maturing prior decisions), so it kept mentally crediting itself windfalls from picks that got silently rejected, then overspending elsewhere based on money it never actually had.",
      'The biggest single fix, once we found it: the bot\'s profitability check never accounted for the cost of raw materials and logistics scaling with production volume — often the single largest line item in this game\'s numbers. A bot chasing bigger capacity was making its own largest hidden cost grow right along with it, invisibly. Across a hundred-game test harness, fixing all of this dropped the bot\'s self-inflicted bankruptcy rate from roughly 39% down to about 3%.',
    ],
  },
  {
    date: 'July 29, 2026',
    title: '"Settled" didn\'t mean what we thought it meant',
    tag: 'Legal System',
    paragraphs: [
      "A sharp-eyed player reported something that shouldn't have been possible: a case they'd deliberately sent to trial — explicitly declining to negotiate, forcing a real verdict — showed up afterward labeled \"Settled.\" No offer had ever been made or accepted. We went digging and found a real, if subtle, inconsistency baked into the game from early on.",
      "When a defendant goes bankrupt or gets acquired mid-game, any lawsuits still open against them get paid out from whatever's left in a final settlement pool — a completely different mechanism from an actual negotiated agreement. Our code was stamping every one of those payouts with the exact same \"settled\" label a real negotiated deal gets, even though nothing had actually been negotiated.",
      'The fix was to give that payout its own distinct outcome label, so a "Settled" case now always means exactly one thing: someone made a real offer, and the other side genuinely agreed to it. A bankruptcy-triggered payout gets its own honest label and its own distinct on-screen notice instead.',
    ],
  },
];

/**
 * `/devlog` — longer-form engineering postmortems, one page (not per-post routes) per
 * this codebase's existing convention of plain pathname-checked static pages rather than
 * slug-based routing — see App.tsx's own doc comment. `DEVLOG_ENTRIES` is exported and
 * covered by Devlog.test.ts's shape/sort checks. Carries its own manual `AdSlot`
 * (`VITE_ADSENSE_SLOT_DEVLOG`) below the content, same convention as every other static
 * page.
 */
const Devlog: React.FC = () => {
  usePageMeta(
    'Devlog | Sue Them Chickens',
    'Real engineering postmortems from building Sue Them Chickens, told as plain-language stories about bugs found and fixed.',
  );
  return (
    <Container size="sm" py="xl">
      <Paper p="xl" style={devlogStyles.paper}>
        <Title order={1} style={devlogStyles.title} mb="xs">🛠️ Devlog</Title>
        <Text size="sm" mb="xl" style={{ color: 'var(--ink-text-soft)' }}>
          Real bugs we found, how we found them, and what we changed — newest first.
        </Text>

        <Stack gap="xl">
          {DEVLOG_ENTRIES.map((entry, i) => (
            <React.Fragment key={`${entry.date}-${entry.title}`}>
              {i > 0 && <Divider color="#cbb888" />}
              <Stack gap="xs">
                <Group gap="sm" align="center">
                  <Badge color="dark" variant="light" size="sm">{entry.tag}</Badge>
                  <Text size="sm" style={{ color: 'var(--ink-text-soft)' }}>{entry.date}</Text>
                </Group>
                <Title order={3} style={devlogStyles.title}>{entry.title}</Title>
                <Stack gap="sm">
                  {entry.paragraphs.map((p, pi) => (
                    <Text key={pi} size="sm">{p}</Text>
                  ))}
                </Stack>
              </Stack>
            </React.Fragment>
          ))}
        </Stack>

        <Group justify="center" mt="xl">
          <Button
            component="a"
            href="/"
            variant="outline"
            color="dark"
            leftSection={<IconArrowLeft size={16} />}
          >
            Back to the hub
          </Button>
        </Group>
      </Paper>

      <Box mt="xl">
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_DEVLOG} />
      </Box>
    </Container>
  );
};

export default Devlog;
