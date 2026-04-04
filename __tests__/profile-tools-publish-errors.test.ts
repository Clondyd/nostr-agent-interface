import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

type ProfileToolsModule = typeof import('../profile/profile-tools.js');

type MockPool = {
  close: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
};

async function loadProfileToolsWithMock(): Promise<{
  tools: ProfileToolsModule;
  mockPool: MockPool;
  getFreshPoolMock: ReturnType<typeof mock>;
}> {
  const mockPool: MockPool = {
    close: mock(async () => {}),
    publish: mock(() => [] as { success: boolean }[]),
  };
  const getFreshPoolMock = mock(() => mockPool);

  mock.restore();
  const importPath = `../profile/profile-tools.js?mock=${Date.now()}-${Math.random()}`;
  const tools = (await import(importPath)) as ProfileToolsModule;
  tools.__setProfileToolsPoolFactoryForTests(getFreshPoolMock as typeof tools.__setProfileToolsPoolFactoryForTests extends (factory?: infer T) => void ? T : never);

  return { tools, mockPool, getFreshPoolMock };
}

describe('profile-tools publish error paths', () => {
  const VALID_PRIVATE_KEY = '0'.repeat(63) + '1';

  let tools!: ProfileToolsModule;
  let mockPool!: MockPool;
  let getFreshPoolMock!: ReturnType<typeof mock>;

  beforeEach(async () => {
    ({ tools, mockPool, getFreshPoolMock } = await loadProfileToolsWithMock());
    mockPool.close.mockClear();
    mockPool.publish.mockClear();
    getFreshPoolMock.mockClear();
    getFreshPoolMock.mockImplementation(() => mockPool);
    mockPool.publish.mockImplementation(() => [
      Promise.resolve({ success: true }),
      Promise.resolve({ success: true }),
    ]);
  });

  afterEach(() => {
    tools.__setProfileToolsPoolFactoryForTests();
    mock.restore();
  });

  afterAll(() => {
    tools.__setProfileToolsPoolFactoryForTests();
    mock.restore();
  });

  it('createProfile returns failure when no relay accepts the profile event', async () => {
    mockPool.publish.mockReturnValue([
      Promise.resolve({ success: false }),
      Promise.reject(new Error('relay timeout')),
    ]);

    const result = await tools.createProfile(
      VALID_PRIVATE_KEY,
      { name: 'test-user' },
      ['wss://relay.one', 'wss://relay.two'],
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Failed to publish profile to any relay');
    expect(mockPool.close).toHaveBeenCalledTimes(1);
  });

  it('createProfile returns structured error when publish throws', async () => {
    mockPool.publish.mockImplementation(() => {
      throw new Error('profile publish exploded');
    });

    const result = await tools.createProfile(
      VALID_PRIVATE_KEY,
      { name: 'test-user' },
      ['wss://relay.one'],
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Error creating profile: profile publish exploded');
    expect(mockPool.close).toHaveBeenCalledTimes(1);
  });

  it('createProfile returns success when at least one relay accepts publish', async () => {
    mockPool.publish.mockReturnValue([
      Promise.resolve({ success: true }),
      Promise.resolve({ success: false }),
      Promise.reject(new Error('relay down')),
    ]);

    const result = await tools.createProfile(
      VALID_PRIVATE_KEY,
      { name: 'test-user' },
      ['wss://relay.one', 'wss://relay.two', 'wss://relay.three'],
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('Profile published to 1/3 relays');
    expect(result.eventId).toBeDefined();
    expect(result.publicKey).toBeDefined();
    expect(mockPool.close).toHaveBeenCalledTimes(1);
  });

  it('createProfile returns fatal error when pool creation fails', async () => {
    getFreshPoolMock.mockImplementation(() => {
      throw new Error('pool constructor failed');
    });

    const result = await tools.createProfile(
      VALID_PRIVATE_KEY,
      { name: 'test-user' },
      ['wss://relay.one'],
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Fatal error: pool constructor failed');
    expect(mockPool.close).not.toHaveBeenCalled();
  });

  it('postNote returns failure when no relay accepts the signed note', async () => {
    mockPool.publish.mockReturnValue([
      Promise.resolve({ success: false }),
      Promise.reject(new Error('relay timeout')),
    ]);

    const result = await tools.postNote(
      VALID_PRIVATE_KEY,
      'hello',
      [['t', 'nostr']],
      ['wss://relay.one', 'wss://relay.two'],
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Failed to publish note to any relay');
    expect(mockPool.close).toHaveBeenCalledTimes(1);
  });

  it('postNote returns structured error when publish throws', async () => {
    mockPool.publish.mockImplementation(() => {
      throw new Error('post publish exploded');
    });

    const result = await tools.postNote(
      VALID_PRIVATE_KEY,
      'hello',
      [['t', 'nostr']],
      ['wss://relay.one'],
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Error posting note: post publish exploded');
    expect(mockPool.close).toHaveBeenCalledTimes(1);
  });

  it('postNote returns success when one relay accepts publish', async () => {
    mockPool.publish.mockReturnValue([
      Promise.resolve({ success: false }),
      Promise.resolve({ success: true }),
    ]);

    const result = await tools.postNote(
      VALID_PRIVATE_KEY,
      'hello',
      [['t', 'nostr']],
      ['wss://relay.one', 'wss://relay.two'],
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('Note published to 1/2 relays');
    expect(result.noteId).toBeDefined();
    expect(result.publicKey).toBeDefined();
    expect(mockPool.close).toHaveBeenCalledTimes(1);
  });
});
