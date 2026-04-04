import { mock, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { generateKeypair } from 'snstr';
import { NostrEvent } from '../utils/index.js';

type NoteToolsModule = typeof import('../note/note-tools.js');

type MockPool = {
  close: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
};

async function loadNoteToolsWithMock(): Promise<{
  tools: NoteToolsModule;
  mockPool: MockPool;
  getFreshPoolMock: ReturnType<typeof mock>;
}> {
  const mockPool: MockPool = {
    close: mock(async () => {}),
    publish: mock(() => [
      Promise.resolve({ success: true }),
      Promise.resolve({ success: true }),
    ]),
  };

  const getFreshPoolMock = mock(() => mockPool);

  mock.restore();
  const importPath = `../note/note-tools.js?mock=${Date.now()}-${Math.random()}`;
  const tools = (await import(importPath)) as NoteToolsModule;
  tools.__setNoteToolsPoolFactoryForTests(getFreshPoolMock as typeof tools.__setNoteToolsPoolFactoryForTests extends (factory?: infer T) => void ? T : never);

  return {
    tools,
    mockPool,
    getFreshPoolMock,
  };
}

describe('Note Tools Functions', () => {
  let testKeys: { publicKey: string; privateKey: string };
  let tools!: NoteToolsModule;
  let mockPool!: MockPool;
  let getFreshPoolMock!: ReturnType<typeof mock>;

  beforeAll(async () => {
    testKeys = await generateKeypair();
  });

  beforeEach(async () => {
    ({ tools, mockPool, getFreshPoolMock } = await loadNoteToolsWithMock());
    mockPool.close.mockClear();
    mockPool.publish.mockClear();
    getFreshPoolMock.mockClear();
  });

  afterEach(() => {
    tools.__setNoteToolsPoolFactoryForTests();
    mock.restore();
  });

  afterAll(() => {
    tools.__setNoteToolsPoolFactoryForTests();
    mock.restore();
  });

  describe('formatProfile', () => {
    it('should format a complete profile', () => {
      const profileEvent: NostrEvent = {
        id: 'profile-id',
        pubkey: testKeys.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 0,
        tags: [],
        content: JSON.stringify({
          name: 'Test User',
          display_name: 'Tester',
          about: 'A test profile',
          picture: 'https://example.com/pic.jpg',
          nip05: 'test@example.com',
          lud16: 'test@getalby.com',
          lud06: 'LNURL123',
          website: 'https://example.com',
        }),
        sig: 'test-sig',
      };

      const formatted = tools.formatProfile(profileEvent);

      expect(formatted).toContain('Name: Test User');
      expect(formatted).toContain('Display Name: Tester');
      expect(formatted).toContain('About: A test profile');
      expect(formatted).toContain('NIP-05: test@example.com');
      expect(formatted).toContain('Lightning Address (LUD-16): test@getalby.com');
      expect(formatted).toContain('LNURL (LUD-06): LNURL123');
      expect(formatted).toContain('Picture: https://example.com/pic.jpg');
      expect(formatted).toContain('Website: https://example.com');
    });

    it('should handle missing profile data', () => {
      const profileEvent: NostrEvent = {
        id: 'profile-id',
        pubkey: testKeys.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 0,
        tags: [],
        content: JSON.stringify({
          name: 'Minimal User',
        }),
        sig: 'test-sig',
      };

      const formatted = tools.formatProfile(profileEvent);

      expect(formatted).toContain('Name: Minimal User');
      expect(formatted).toContain('Display Name: Minimal User');
      expect(formatted).toContain('About: No about information');
      expect(formatted).toContain('NIP-05: Not set');
    });

    it('should handle malformed content', () => {
      const profileEvent: NostrEvent = {
        id: 'profile-id',
        pubkey: testKeys.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 0,
        tags: [],
        content: 'invalid json',
        sig: 'test-sig',
      };

      const formatted = tools.formatProfile(profileEvent);

      expect(formatted).toContain('Name: Unknown');
      expect(formatted).toContain('Display Name: Unknown');
    });

    it('should handle null profile', () => {
      const formatted = tools.formatProfile(null as unknown as NostrEvent);
      expect(formatted).toBe('No profile found');
    });
  });

  describe('formatNote', () => {
    it('should format a note correctly', () => {
      const noteEvent: NostrEvent = {
        id: 'note123',
        pubkey: testKeys.publicKey,
        created_at: Math.floor(Date.now() / 1000) - 3600,
        kind: 1,
        tags: [],
        content: 'This is a test note #nostr',
        sig: 'test-sig',
      };

      const formatted = tools.formatNote(noteEvent);

      expect(formatted).toContain('ID: note123');
      expect(formatted).toContain('Content: This is a test note #nostr');
      expect(formatted).toContain('Created:');
      expect(formatted).toContain('---');
    });

    it('should handle null note', () => {
      const formatted = tools.formatNote(null as unknown as NostrEvent);
      expect(formatted).toBe('');
    });
  });

  describe('createNote', () => {
    it('should create a valid unsigned note', async () => {
      const result = await tools.createNote(testKeys.privateKey, 'Hello Nostr!', [['t', 'greeting']]);

      expect(result.success).toBe(true);
      expect(result.noteEvent).toBeDefined();
      expect(result.publicKey).toBe(testKeys.publicKey);

      const note = result.noteEvent;
      expect(note.kind).toBe(1);
      expect(note.content).toBe('Hello Nostr!');
      expect(note.tags).toEqual([['t', 'greeting']]);
      expect(note.pubkey).toBe(testKeys.publicKey);
      expect(note.created_at).toBeDefined();
      expect(note.id).toBeUndefined();
      expect(note.sig).toBeUndefined();
    });

    it('should handle nsec format', async () => {
      const nsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
      const result = await tools.createNote(nsec, 'Note with nsec');

      expect(result.success).toBe(true);
      expect(result.noteEvent).toBeDefined();
    });

    it('should handle invalid private key', async () => {
      const result = await tools.createNote('invalid_key', 'This should fail');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Error creating note');
    });
  });

  describe('signNote', () => {
    it('should sign a note correctly', async () => {
      const createResult = await tools.createNote(testKeys.privateKey, 'Note to sign', [['t', 'test']]);
      expect(createResult.success).toBe(true);

      const signResult = await tools.signNote(testKeys.privateKey, createResult.noteEvent);
      expect(signResult.success).toBe(true);
      expect(signResult.signedNote).toBeDefined();

      const signed = signResult.signedNote;
      expect(signed.id).toBeDefined();
      expect(signed.sig).toBeDefined();
      expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
      expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    });

    it('should reject mismatched keys', async () => {
      const otherKeys = await generateKeypair();
      const createResult = await tools.createNote(testKeys.privateKey, 'Note with key 1');
      const signResult = await tools.signNote(otherKeys.privateKey, createResult.noteEvent);

      expect(signResult.success).toBe(false);
      expect(signResult.message).toContain('does not match');
    });
  });

  describe('publishNote', () => {
    it('should handle no relays', async () => {
      const createResult = await tools.createNote(testKeys.privateKey, 'Test');
      const signResult = await tools.signNote(testKeys.privateKey, createResult.noteEvent);
      const publishResult = await tools.publishNote(signResult.signedNote, []);

      expect(publishResult.success).toBe(true);
      expect(publishResult.message).toContain('no relays specified');
    });
  });
});
