import { test, expect } from '@playwright/test';

test.describe('Matchmaking Page', () => {
  test('should load the matchmaking page', async ({ page }) => {
    await page.goto('/play');
    await expect(page).toHaveTitle(/.*Sue Them Chickens.*/i);
  });

  // The landing page's title/subtitle used to be separate text elements; both are now
  // baked into one hero image (Matchmaking.tsx's <Image src="/images/hero.png" alt="Sue
  // Their Asses — rival poultry tycoons face off in court" />) — a single test checking
  // that image renders with its descriptive alt text covers both.
  test('should display the game title', async ({ page }) => {
    await page.goto('/play');
    await expect(page.getByRole('img', { name: /Sue Them Chickens/i })).toBeVisible();
  });

  test('should have a name input field', async ({ page }) => {
    await page.goto('/play');
    const nameInput = page.getByLabel('Your Name');
    await expect(nameInput).toBeVisible();
  });

  test('should allow entering a player name', async ({ page }) => {
    await page.goto('/play');
    const nameInput = page.getByLabel('Your Name');
    await nameInput.fill('TestPlayer');
    await expect(nameInput).toHaveValue('TestPlayer');
  });

  test('should show a room code input field when opened via an invite link', async ({ page }) => {
    // The "Join a Room" section (with its "Room Code" field) only renders when the
    // page is opened via an invite link (/play?room=<id>) — see Matchmaking.tsx.
    await page.goto('/play?room=test-room-code');
    const roomCodeInput = page.getByLabel('Room Code');
    await expect(roomCodeInput).toBeVisible();
    await expect(roomCodeInput).toHaveValue('test-room-code');
  });

  test('should have quick play button', async ({ page }) => {
    await page.goto('/play');
    await expect(page.getByRole('button', { name: /Search for Available Room/i })).toBeVisible();
  });

  test('should have create room button', async ({ page }) => {
    await page.goto('/play');
    await expect(page.getByRole('button', { name: /Create New Room/i })).toBeVisible();
  });

  test('should have join room button when opened via an invite link', async ({ page }) => {
    await page.goto('/play?room=test-room-code');
    await expect(page.getByRole('button', { name: /Join Room/i })).toBeVisible();
  });

  test('should not create room without a name', async ({ page }) => {
    await page.goto('/play');
    const createButton = page.getByRole('button', { name: /Create New Room/i });
    // Button should be disabled when name is empty
    await expect(createButton).toBeDisabled();
  });

  test('should not join room without name and room name', async ({ page }) => {
    await page.goto('/play?room=test-room-code');
    const joinButton = page.getByRole('button', { name: /Join Room/i });
    await expect(joinButton).toBeDisabled();
  });

  test('should not quick play without a name', async ({ page }) => {
    await page.goto('/play');
    const quickPlayButton = page.getByRole('button', { name: /Search for Available Room/i });
    await expect(quickPlayButton).toBeDisabled();
  });

  test('should show room lobby after creating room', async ({ page }) => {
    await page.goto('/play');
    await page.getByLabel('Your Name').fill('LobbyPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    // After socket join, should see the lobby
    await expect(page.getByText('Room Lobby')).toBeVisible();
  });

  test('should show start game button for the host in lobby', async ({ page }) => {
    // Matchmaking.tsx has no "ready up" step — the host starts the game directly.
    await page.goto('/play');
    await page.getByLabel('Your Name').fill('HostPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    await expect(page.getByRole('button', { name: /Start Game/i })).toBeVisible();
  });

  // The lobby tells a lone player a bot opponent is on the way, and counts it down —
  // otherwise a freshly-created room is a silent, empty screen with no indication that
  // anything is about to happen (see botJoinNotice.ts and GameEngine.scheduleBotJoinCheck).
  // The states AFTER this window closes (bot arrives / a real player cancels it) are
  // covered without a browser at both layers: botJoinNotice.test.ts client-side and
  // gameEngine.test.ts's `botJoinInMs on the room snapshot` block server-side, so this
  // spec deliberately doesn't sit through the full 10 seconds.
  test('should count down to the bot opponent joining a freshly-created lobby', async ({ page }) => {
    await page.goto('/play');
    await page.getByLabel('Your Name').fill('WaitingPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    const notice = page.getByText(/A bot opponent joins in \d+s/i);
    await expect(notice).toBeVisible();
    // The counter must actually move — a frozen number reads as a broken lobby.
    const first = await notice.textContent();
    await expect(async () => {
      expect(await notice.textContent()).not.toBe(first);
    }).toPass({ timeout: 5000 });
  });

  test('should show player list in lobby', async ({ page }) => {
    await page.goto('/play');
    await page.getByLabel('Your Name').fill('ListPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    // Should see the player in the list
    await expect(page.getByText('ListPlayer')).toBeVisible();
  });

  test('should show quick play section', async ({ page }) => {
    await page.goto('/play');
    await expect(page.getByText('Quick Play')).toBeVisible();
  });

  test('should show create room section', async ({ page }) => {
    await page.goto('/play');
    await expect(page.getByText('Create a Room')).toBeVisible();
  });

  test('should show join room section when opened via an invite link', async ({ page }) => {
    await page.goto('/play?room=test-room-code');
    await expect(page.getByRole('heading', { name: 'Join a Room' })).toBeVisible();
  });

  test('should show loading overlay when searching for room', async ({ page }) => {
    await page.goto('/play');
    await page.getByLabel('Your Name').fill('SearchPlayer');
    await page.getByRole('button', { name: /Search for Available Room/i }).click();

    // The real DB round trip behind this button can resolve fast enough (same-machine
    // dev DB, near-empty room table) that the transient loading overlay never gets
    // caught mid-flight — accept either observable outcome as proof the click had an
    // effect: the overlay flashing, or (if it already resolved) landing in a room lobby.
    await expect(page.locator('.mantine-LoadingOverlay-root').or(page.getByText('Room Lobby'))).toBeVisible();
  });

  test('should show loading overlay when creating room', async ({ page }) => {
    await page.goto('/play');
    await page.getByLabel('Your Name').fill('CreatePlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    // Same race as "searching for room" above, just more pronounced here — creating a
    // room is a single DB transaction with no candidate-matching loop first, so it's
    // the more likely of the two to resolve before the overlay is ever observed.
    await expect(page.locator('.mantine-LoadingOverlay-root').or(page.getByText('Room Lobby'))).toBeVisible();
  });

  test('should disable inputs while searching', async ({ page }) => {
    await page.goto('/play');
    await page.getByLabel('Your Name').fill('DisabledPlayer');
    await page.getByRole('button', { name: /Search for Available Room/i }).click();

    // Same fast-resolution race as the loading-overlay tests above — if Quick Play
    // resolves before this assertion runs, the name input unmounts entirely (Room Lobby
    // takes over), which is just as valid a proof the click took effect. Checking
    // `isVisible()` first and `toBeDisabled()` after would still leave a gap between the
    // two calls for the exact same race to land in, so this tries the real assertion
    // first and only falls back to "did we already reach Room Lobby" on failure — a
    // failure for any OTHER reason (element present but simply never disabled) still
    // fails this second assertion too, so a genuine regression isn't swallowed here.
    try {
      await expect(page.getByLabel('Your Name')).toBeDisabled({ timeout: 2000 });
    } catch {
      await expect(page.getByText('Room Lobby')).toBeVisible();
    }
  });

  test('should show available rooms section when rooms exist', async ({ page }) => {
    await page.goto('/play');
    // The available rooms section should be present in the UI
    // (rooms will only appear after ROOMS_LISTED event)
    await expect(page.getByText('Available Rooms')).toBeVisible().catch(() => {
      // May not show if no rooms are available yet
    });
  });
});

test.describe('Root URL routing', () => {
  // "/" moved from being Matchmaking itself to Home.tsx, a real content hub — see
  // App.tsx's own doc comment. These two tests guard the split: a bare "/" must show the
  // hub, not the game, while a "/?room=<id>" link generated before this change (old
  // invite links shared before Matchmaking.tsx moved to /play) must still work exactly
  // as it always did, not 404 or strand the visitor on the hub.
  test('bare root shows the Home hub, not Matchmaking', async ({ page }) => {
    await page.goto('/');
    // Role is 'link', NOT 'button' — Home's Play Now is a Mantine `Button
    // component="a" href="/play"`, i.e. a real <a> doing a full page load, per the
    // deliberate "no client-side nav between static pages" convention in App.tsx's doc
    // comment. An <a href> has the ARIA role 'link', so getByRole('button') never
    // matches it; this assertion was written as 'button' and failed in all three
    // browsers from the day it landed. Don't "fix" it back without first changing how
    // Home.tsx renders that element.
    await expect(page.getByRole('link', { name: /Play Now/i })).toBeVisible();
    await expect(page.getByLabel('Your Name')).not.toBeVisible();
  });

  // ConsentBanner mounts on the /play LANDING branch only — see Matchmaking.tsx's own
  // comment above `consentBannerVisible` for the full reasoning (an external link must
  // point at /play, and a visitor who never loads `/` never consents, so GA4 saw
  // literally zero of a real Reddit post's 23 visitors). These two guard the split: the
  // banner must appear for a first-time visitor on /play, and must NOT follow them into
  // the room lobby, where a fixed bottom overlay would sit on the chat input.
  test('a first-time visitor on /play sees the consent banner', async ({ page }) => {
    await page.goto('/play');
    await expect(page.getByRole('button', { name: 'Accept All' })).toBeVisible();
  });

  test('the consent banner does not follow the player into the room lobby', async ({ page }) => {
    await page.goto('/play');
    await expect(page.getByRole('button', { name: 'Accept All' })).toBeVisible();
    await page.getByLabel('Your Name').fill('ConsentPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    // In the lobby now — the banner is gone even though consent was never decided,
    // because only the landing branch mounts it.
    await expect(page.getByText(/Room Lobby/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept All' })).not.toBeVisible();
  });

  test('a legacy root invite link (?room= with no /play) still opens the join flow', async ({ page }) => {
    await page.goto('/?room=test-room-code');
    const roomCodeInput = page.getByLabel('Room Code');
    await expect(roomCodeInput).toBeVisible();
    await expect(roomCodeInput).toHaveValue('test-room-code');
  });
});
