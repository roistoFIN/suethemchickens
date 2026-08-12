import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Container,
  Paper,
  Title,
  Text,
  TextInput,
  Button,
  Stack,
  Divider,
  Flex,
  Alert,
  Badge,
  Group,
  CopyButton,
  ActionIcon,
  LoadingOverlay,
  ScrollArea,
  Image,
  Modal,
  Box,
} from '@mantine/core';
import { IconCopy, IconCheck, IconShieldLock, IconMessageStar, IconHome } from '@tabler/icons-react';
import { useSocketStore } from '../stores/socketStore';
import { useGameStore } from '../stores/gameStore';
import { useChatStore } from '../stores/chatStore';
import FeedbackForm from '../components/FeedbackForm';
import ShareButton from '../components/ShareButton';
import PrivacyPolicyModal from '../components/PrivacyPolicyModal';
import ConsentBanner from '../components/ConsentBanner';
import { useConsentStore } from '../stores/consentStore';
import { usePageMeta } from '../lib/usePageMeta';
import { ClientEvents, ServerEvents, type RoomInfo } from '@suethemchickens/shared';

/** localStorage key for remembering the player's name across visits — see `Matchmaking`'s name-entry section. */
const NAME_STORAGE_KEY = 'stita_player_name';

// "Courtroom Ink" tokens — same tokens as GamePhase.tsx's gpStyles, defined locally
// since this is a separate file; the underlying CSS custom properties live once in
// theme.css. Kept small (this page has far less surface than the in-game dashboard).
const mmStyles = {
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
  label: {
    fontFamily: "'Courier Prime', 'Courier New', monospace",
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: 'var(--ink-text)',
  } as React.CSSProperties,
  listedRoom: {
    background: '#f6efd9',
    backgroundImage: 'var(--paper-texture)',
    border: '1px solid #cbb888',
    borderRadius: 3,
  } as React.CSSProperties,
  primaryBtn: {
    fontFamily: "'Rye', Georgia, serif",
    letterSpacing: '0.02em',
    background: 'var(--ink-text)',
    color: 'var(--ink-parchment)',
    border: '2px solid var(--ink-gold)',
  } as React.CSSProperties,
};

function loadSavedName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // localStorage unavailable (private browsing, etc.) — the name just won't be remembered.
  }
}

/**
 * Matchmaking page — Phase 1 of the game flow. Lives at `/play` (App.tsx renders it there,
 * and — for back-compat with any invite link generated before this page moved — at `/`
 * whenever a `?room=` param is present; see App.tsx's own doc comment). `/` itself is now
 * `Home.tsx`, a real content hub linking here via a "Play Now" button — see CLAUDE.md's
 * *AdSense "low-value content" rejection* section for why the site has a hub page at all.
 *
 * Handles three entry paths:
 * - **Normal**: Player sees Quick Play, Create Room, Join Room, and Available Rooms sections.
 * - **Invite Link**: When accessed via `?room=<roomId>` query param, only "Join a Room" is shown
 *   with the room code auto-filled. "Create a Room" and "Quick Play" are hidden. New invite
 *   links point at `/play?room=<roomId>`; an older `/?room=<roomId>` link still works too.
 * - **Lobby**: After joining, displays the room lobby with player list, host controls,
 *   and an invite-link copy button for hosts.
 *
 * @remarks State is managed via Zustand stores (`gameStore`, `socketStore`).
 *          Socket.IO events: `rooms:list` → populates available rooms.
 */
const Matchmaking: React.FC = () => {
  usePageMeta(
    'Play | Sue Them Chickens',
    'Join or create a room and start playing Sue Them Chickens — a free real-time multiplayer business sim where you sue your rivals into bankruptcy.',
  );
  const [searchParams] = useSearchParams();
  const [playerName, setPlayerName] = useState(loadSavedName);
  const [isNameLocked, setIsNameLocked] = useState(() => !!loadSavedName());
  const [roomName, setRoomName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [availableRooms, setAvailableRooms] = useState<RoomInfo[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const { send, on } = useSocketStore();
  const { room, player, error, setError } = useGameStore();
  const { messages: chatMessages, show: showChat, hide: hideChat } = useChatStore();

  /** ConsentBanner mounts on the LANDING branch of this component only (see the final
   * return) — never in the room-lobby branch above it, and never in GamePhase/GameOver,
   * which App.tsx renders instead of this component entirely.
   *
   * Why it's here at all, having been deliberately removed from `/play` once before: a
   * visitor who arrives straight on `/play` from an external link never loads `/`, so
   * they never saw the banner, so `analytics_storage` stayed at its ALL_DENIED default
   * for the whole visit — and a denied visitor only produces cookieless "modeled" pings
   * that Google won't surface below a large aggregate volume this site doesn't have.
   * Measured for real: a Reddit post driving 23 unique visitors and 7 played matches
   * (confirmed in Caddy's own access log) registered as literally zero in GA4, because
   * every one of them landed on /play. Since an external link must point at /play — `/`
   * is a hub page, and r/WebGames' P4.iii bans linking a "collection or directory" —
   * that blind spot applies to essentially all inbound marketing traffic.
   *
   * The original objection stands and is respected: a fixed bottom overlay has no good
   * place to sit over a live 120-second round, and the room lobby's chat input has the
   * same problem. Hence the landing-only mount — that screen is as passive as the hub
   * page, with nothing time-sensitive to cover, and it's strictly BEFORE a player has
   * entered a room. Same `pb={140}` reservation Home.tsx uses, so the banner can't cover
   * the Privacy/Feedback row beneath it. */
  const hasDecidedConsent = useConsentStore((s) => s.hasDecided);
  const consentSettingsOpen = useConsentStore((s) => s.settingsOpen);
  const consentBannerVisible = !hasDecidedConsent || consentSettingsOpen;

  /** A failed join/create attempt (name taken, room full, kicked, etc.) shouldn't leave
   * the loading overlay stuck forever — there's nothing else that resets these on error. */
  useEffect(() => {
    if (!error) return;
    setIsCreating(false);
    setIsSearching(false);
  }, [error]);

  /** Neither flag was ever reset on a *successful* join either (only the room-lobby view
   * rendering instead of this landing view masked it) — reset on every transition across
   * the room/no-room boundary, so landing back here (Leave Room, being kicked) never shows
   * a stuck LoadingOverlay left over from however we originally got into a room. */
  useEffect(() => {
    setIsCreating(false);
    setIsSearching(false);
  }, [room]);

  /** Remember the player's name as soon as it's non-empty, so it doesn't need to be re-typed next visit. */
  useEffect(() => {
    const trimmed = playerName.trim();
    if (trimmed) {
      saveName(trimmed);
    }
  }, [playerName]);

  /** Chat messages/history now live in chatStore (shared with GamePhase/GameTimelineView's
   * floating ChatWidget, so the same conversation carries through from the lobby into the
   * game and game-over screens — see chatStore.ts's own doc comment) rather than local
   * state here. This lobby view still renders it as an always-visible inline box, unlike
   * the floating popup those other screens use — so it marks the chat "visible" for as
   * long as the lobby itself is showing, meaning a message that arrives while a player is
   * sitting in the lobby is treated as already read, not queued up as unread for when they
   * later land on the in-game floating widget. */
  useEffect(() => {
    if (!room) return;
    showChat();
    return () => hideChat();
  }, [room, showChat, hideChat]);

  useEffect(() => {
    chatViewportRef.current?.scrollTo({ top: chatViewportRef.current.scrollHeight });
  }, [chatMessages]);

  const handleSendChatMessage = () => {
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    send(ClientEvents.CHAT_MESSAGE, { message: trimmed });
    setChatInput('');
  };

  /** Auto-detect invite link from URL query params and pre-fill the room name field. */
  useEffect(() => {
    const invitedRoom = searchParams.get('room');
    if (invitedRoom) {
      setRoomName(invitedRoom.trim());
    }
  }, [searchParams]);

  useEffect(() => {
    const unsubscribe = on(ServerEvents.ROOMS_LISTED, (data: unknown) => {
      const typedData = data as { rooms: RoomInfo[] };
      setAvailableRooms(typedData.rooms);
      setIsSearching(false);
    });
    return unsubscribe;
  }, [on]);

  /**
   * Create a new room for this player.
   *
   * Emits `room:join` with only `playerName` — server creates a fresh room
   * and assigns the player as host.
   */
  const handleCreateRoom = () => {
    if (!playerName.trim()) return;
    setError(null);
    setIsCreating(true);
    send(ClientEvents.ROOM_JOIN, { playerName: playerName.trim() });
  };

  /**
   * Join an existing room by its ID (room name/code).
   *
   * Used both when manually entering a room code and when joining via invite link
   * (`?room=<roomId>`). The room code is passed as `roomName` in the payload.
   *
   * @param roomId - Optional override; uses local state's `roomName` by default.
   */
  const handleJoinRoom = () => {
    if (!playerName.trim() || !roomName.trim()) return;
    setError(null);
    send(ClientEvents.ROOM_JOIN, {
      playerName: playerName.trim(),
      roomName: roomName.trim(),
    });
  };

  /**
   * Quick Play — find any available room with fewer than max players.
   *
   * Emits `room:join` with `searchForRoom: true`. Server selects the room
   * with the fewest players (or creates a new one if none are available).
   */
  const handleSearchForRoom = () => {
    if (!playerName.trim()) return;
    setError(null);
    setIsSearching(true);
    send(ClientEvents.ROOM_JOIN, { playerName: playerName.trim(), searchForRoom: true });
  };

  /**
   * Join a specific room from the "Available Rooms" list.
   *
   * @param roomId - The unique ID of the target room.
   */
  const handleJoinListedRoom = (roomId: string) => {
    if (!playerName.trim()) return;
    setError(null);
    send(ClientEvents.ROOM_JOIN, {
      playerName: playerName.trim(),
      roomName: roomId,
    });
  };

  if (room && player) {
    const isHost = player.isHost;

    return (
      <Container size="sm" py="xl">
        <Paper p="xl" style={mmStyles.paper}>
          <Flex justify="space-between" align="center" mb="md">
            <Title order={2} style={mmStyles.title}>🏢 Room Lobby</Title>
            <Badge color={room.inviteOnly ? 'orange' : 'gray'} size="sm">
              {room.inviteOnly ? '🔒 Invite Only' : '🔓 Public'}
            </Badge>
          </Flex>
          <Stack>
            <Text fw={700} style={{ color: 'var(--ink-text)' }}>Players ({room.players.length}/{room.maxPlayers}):</Text>
            {room.players.map((p) => (
              <Flex key={p.id} justify="space-between" align="center">
                <Text style={{ color: 'var(--ink-text)' }}>
                  {p.name} {p.id === player.id && '(You)'}
                </Text>
                <Flex gap="xs" align="center">
                  {/* A bot's badge always shows, host or not — kicking it (below) is still
                      available to the host the same as for any other player. */}
                  {p.isBot && (
                    <Badge color="teal" size="sm">🤖 Bot</Badge>
                  )}
                  {isHost && p.id !== player.id ? (
                    <Button
                      size="compact-xs"
                      color="red"
                      variant="outline"
                      onClick={() => send(ClientEvents.ROOM_KICK, { playerId: p.id })}
                    >
                      Kick
                    </Button>
                  ) : (
                    !p.isBot && (
                      <Badge color={p.isHost ? 'orange' : 'gray'} size="sm">
                        {p.isHost ? 'Host' : 'Player'}
                      </Badge>
                    )
                  )}
                </Flex>
              </Flex>
            ))}
          </Stack>
          <Divider my="md" color="#cbb888" />
          <Stack gap="xs" mb="md">
            <Text fw={700} style={{ color: 'var(--ink-text)' }}>Lobby Chat:</Text>
            <ScrollArea h={160} viewportRef={chatViewportRef} type="auto" style={{ background: '#f6efd9', border: '1px solid #cbb888', borderRadius: 3 }}>
              <Stack gap={4} p={4}>
                {chatMessages.length === 0 && (
                  <Text size="sm" style={{ color: 'var(--ink-text-soft)' }}>
                    No messages yet — say hi.
                  </Text>
                )}
                {chatMessages.map((m, i) => (
                  <Text key={i} size="sm" style={{ color: 'var(--ink-text)' }}>
                    <Text span fw={600}>
                      {m.playerId === player.id ? 'You' : m.playerName}:
                    </Text>{' '}
                    {m.message}
                  </Text>
                ))}
              </Stack>
            </ScrollArea>
            <Group gap="xs">
              <TextInput
                placeholder="Type a message..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSendChatMessage();
                }}
                maxLength={500}
                style={{ flex: 1 }}
              />
              <Button onClick={handleSendChatMessage} disabled={!chatInput.trim()}>
                Send
              </Button>
            </Group>
          </Stack>
          <Divider my="md" color="#cbb888" />
          {/* Visible to every player in the lobby, not just the host — anyone waiting for
              the room to fill has a reason to invite a friend, and gating this to the
              host alone would cut the invite loop down to one player per room instead of
              up to four. Web Share API opens the OS-native share sheet on mobile
              (WhatsApp/SMS/Discord/etc. in one tap); desktop falls back to a plain
              clipboard copy — see ShareButton.tsx. */}
          <Stack gap="xs" mb="md">
            <Text fw={700} style={{ color: 'var(--ink-text)' }}>Invite Friends:</Text>
            <ShareButton
              fullWidth
              size="md"
              label="🔗 Invite Friends to Join"
              title="Sue Them Chickens"
              text="Come run a chicken empire with me in Sue Them Chickens — a free multiplayer business sim where you sue your rivals into bankruptcy 🐔⚖️"
              url={window.location.origin + `/play?room=${room.id}`}
              style={mmStyles.primaryBtn}
            />
            <Group justify="space-between" gap="xs">
              <Text size="xs" style={{ color: 'var(--ink-text-soft)' }}>Or copy the raw link:</Text>
              <CopyButton value={window.location.origin + `/play?room=${room.id}`}>
                {({ copied, copy }) => (
                  <ActionIcon
                    color={copied ? 'teal' : 'blue'}
                    variant="filled"
                    size="md"
                    onClick={copy}
                    title={copied ? 'Link copied!' : 'Copy invite link'}
                  >
                    {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  </ActionIcon>
                )}
              </CopyButton>
            </Group>
          </Stack>
          <Divider my="md" color="#cbb888" />
          {isHost && (
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={700} style={{ color: 'var(--ink-text)' }}>Room Visibility:</Text>
                <Button
                  size="xs"
                  variant={room.inviteOnly ? 'filled' : 'outline'}
                  color={room.inviteOnly ? 'orange' : 'gray'}
                  onClick={() => send(ClientEvents.ROOM_SET_INVITE_ONLY, { inviteOnly: !room.inviteOnly })}
                  title={room.inviteOnly ? 'Invisible to Quick Play and Available Rooms — code/link still works' : 'Discoverable via Quick Play and Available Rooms'}
                >
                  {room.inviteOnly ? '🔒 Invite Only' : '🔓 Public'}
                </Button>
              </Group>
              <Group justify="center">
                <Button
                  size="lg"
                  style={{ ...mmStyles.primaryBtn, background: 'var(--ink-forest)', borderColor: 'var(--ink-forest)' }}
                  onClick={() => send(ClientEvents.ROOM_START_GAME, null)}
                  disabled={room.players.length < 2}
                  title={room.players.length < 2 ? 'Waiting for at least one more player to join' : undefined}
                >
                  Start Game
                </Button>
              </Group>
            </Stack>
          )}
          {!isHost && (
            <Alert
              variant="filled"
              color="dark"
              styles={{ root: { background: 'var(--ink-text)', border: '2px solid var(--ink-gold)' } }}
            >
              Waiting for the host to start the game...
            </Alert>
          )}
          <Divider my="md" color="#cbb888" />
          <Button
            fullWidth
            variant="outline"
            color="red"
            onClick={() => send(ClientEvents.ROOM_LEAVE, null)}
          >
            Leave Room
          </Button>
        </Paper>
      </Container>
    );
  }

  // Landing (name entry + Join/Create) — the ONLY branch of this component that mounts
  // ConsentBanner. See the `consentBannerVisible` note above the return for why.
  return (
    <Box pb={consentBannerVisible ? 140 : 0}>
    <Container size="sm" py="xl">
      <Paper p="xl" pos="relative" style={mmStyles.paper}>
        <LoadingOverlay visible={isCreating || isSearching} />
        <Text
          size="xs"
          style={{ position: 'absolute', top: 6, right: 10, color: 'var(--ink-text-soft)', opacity: 0.6 }}
        >
          v0.95
        </Text>
        <Image
          src="/images/hero.png"
          alt="Sue Them Chickens — rival poultry tycoons face off in court"
          radius="md"
          mb="md"
        />
        <Group justify="center" mb="xl">
          {/* Every other guide (How to Play, Rules, Strategy, Glossary, Devlog, What's
              New) is reachable from the hub at "/" now — see Home.tsx — so this page
              only needs a single way back there rather than re-listing all of them. */}
          <Button
            component="a"
            href="/"
            variant="subtle"
            color="dark"
            leftSection={<IconHome size={16} />}
          >
            Home &amp; Guides
          </Button>
          <Button
            variant="subtle"
            color="dark"
            leftSection={<IconShieldLock size={16} />}
            onClick={() => setPrivacyOpen(true)}
          >
            Privacy Policy
          </Button>
          <Button
            variant="subtle"
            color="dark"
            leftSection={<IconMessageStar size={16} />}
            onClick={() => setFeedbackOpen(true)}
          >
            Feedback
          </Button>
        </Group>

        <Stack>
          <Group align="flex-end" gap="xs">
            <TextInput
              label={<span style={mmStyles.label}>Your Name</span>}
              placeholder="Enter your name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              required
              disabled={isCreating || isSearching || isNameLocked}
              style={{ flex: 1 }}
            />
            <Button
              variant="outline"
              color="dark"
              disabled={isCreating || isSearching || !isNameLocked}
              onClick={() => setIsNameLocked(false)}
            >
              Change Name
            </Button>
          </Group>

          {error && (
            <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
              {error.message}
            </Alert>
          )}

          <Divider my="sm" color="#cbb888" />

          {/* Show Quick Play + Create Room when NOT invited via link */}
          {!searchParams.has('room') && (
            <>
              <Title order={3} style={mmStyles.title}>Quick Play</Title>
              <Button
                fullWidth
                onClick={handleSearchForRoom}
                disabled={!playerName.trim() || isSearching}
                style={mmStyles.primaryBtn}
              >
                {isSearching ? 'Searching for a room...' : 'Search for Available Room'}
              </Button>

              <Divider my="sm" color="#cbb888" />

              <Title order={3} style={mmStyles.title}>Create a Room</Title>
              <Button
                fullWidth
                onClick={handleCreateRoom}
                disabled={!playerName.trim() || isCreating}
                style={{ ...mmStyles.primaryBtn, background: 'var(--ink-blood)', borderColor: 'var(--ink-blood)', color: '#f4e9d0' }}
              >
                {isCreating ? 'Creating...' : 'Create New Room'}
              </Button>
            </>
          )}

          {/* Show Join a Room ONLY when invited via direct link */}
          {searchParams.has('room') && (
            <>
              <Alert
                variant="filled"
                color="dark"
                mb="sm"
                styles={{ root: { background: 'var(--ink-text)', border: '2px solid var(--ink-gold)' } }}
              >
                You were invited to join a room. Enter your name below and click Join.
              </Alert>

              <Title order={3} style={mmStyles.title}>Join a Room</Title>
              <TextInput
                label={<span style={mmStyles.label}>Room Code</span>}
                placeholder="Enter room code"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                disabled={isCreating || isSearching}
              />
              <Button
                fullWidth
                variant="outline"
                color="dark"
                onClick={handleJoinRoom}
                disabled={!playerName.trim() || !roomName.trim() || isCreating || isSearching}
              >
                Join Room
              </Button>
            </>
          )}

          {/* Always show available rooms for quick play discovery */}
          {!searchParams.has('room') && availableRooms.length > 0 && (
            <>
              <Divider my="sm" color="#cbb888" />
              <Title order={3} style={mmStyles.title}>Available Rooms</Title>
              <Stack>
                {availableRooms.map((roomInfo) => (
                  <Paper key={roomInfo.id} p="sm" style={mmStyles.listedRoom}>
                    <Flex justify="space-between" align="center">
                      <Text style={{ color: 'var(--ink-text)' }}>
                        Room {roomInfo.id.slice(0, 8)}... ({roomInfo.playerCount}/4 players)
                      </Text>
                      <Button
                        size="sm"
                        color="dark"
                        onClick={() => handleJoinListedRoom(roomInfo.id)}
                        disabled={!playerName.trim()}
                      >
                        Join
                      </Button>
                    </Flex>
                  </Paper>
                ))}
              </Stack>
            </>
          )}
        </Stack>
      </Paper>

      {/* This used to carry a full inline "How to Play" section plus the landing AdSlot
          directly — both moved to Home.tsx once "/" became a real content hub rather
          than this page (see Home.tsx's own doc comment and CLAUDE.md's *AdSense
          "low-value content" rejection* section for the full history). Keeping this page
          itself lean/conversion-focused again now that the informational job lives
          elsewhere; a visitor who lands here directly via an old bookmark or invite link
          still gets one clear way back to everything else. */}
      {/* This sits directly on the page's dark `--ink-bg`, not inside the parchment
          Paper above — a real, reported bug: it originally used `--ink-text`/
          `--ink-text-soft` (the dark, near-black tokens meant for text ON parchment),
          which read as almost invisible dark-on-dark against the page background.
          `--ink-text-on-dark-soft` is this theme's actual token for exactly this case —
          see GamePhase.tsx's `loadingOverlay` style for the same pairing — and the links
          use `--ink-gold` (the site's accent/CTA color) plus an underline so they read as
          clickable, not just differently-colored body text. */}
      <Text size="sm" ta="center" mt="xl" style={{ color: 'var(--ink-text-on-dark-soft)' }}>
        New here? <a href="/how-to-play" style={{ color: 'var(--ink-gold)', textDecoration: 'underline' }}>Learn how to play</a>,
        or see <a href="/" style={{ color: 'var(--ink-gold)', textDecoration: 'underline' }}>everything else the site has</a>.
      </Text>

      <PrivacyPolicyModal
        opened={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
        titleStyle={mmStyles.title}
        primaryBtnStyle={mmStyles.primaryBtn}
      />

      <Modal
        opened={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        title={<Text component="span" style={{ ...mmStyles.title, fontSize: '1.3rem' }}>💬 Feedback</Text>}
        centered
        size="sm"
      >
        <FeedbackForm source="landing" onClose={() => setFeedbackOpen(false)} />
      </Modal>
    </Container>
    <ConsentBanner />
    </Box>
  );
};

export default Matchmaking;
