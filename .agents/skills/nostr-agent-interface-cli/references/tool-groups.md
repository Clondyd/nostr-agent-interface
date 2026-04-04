# Tool Groups

Use live discovery for exact schemas:

```bash
nostr-agent-interface cli list-tools --json
nostr-agent-interface cli <toolName> --help
```

Prefer reads before writes. Use NIP-19 normalization before key-dependent mutations.

## Reading and Querying

- `getProfile`
- `getKind1Notes`
- `getLongFormNotes`
- `getReceivedZaps`
- `getSentZaps`
- `getAllZaps`
- `queryEvents`
- `getContactList`
- `getFollowing`
- `getRelayList`

## Identity and Profile

- `createKeypair`
- `createProfile`
- `updateProfile`

## Notes and Events

- `createNote`
- `signNote`
- `publishNote`
- `postNote`
- `createNostrEvent`
- `signNostrEvent`
- `publishNostrEvent`

## Social and Relay Management

- `setRelayList`
- `follow`
- `unfollow`
- `reactToEvent`
- `repostEvent`
- `deleteEvent`
- `replyToEvent`

## Messaging

- `encryptNip04`
- `decryptNip04`
- `sendDmNip04`
- `getDmConversationNip04`
- `encryptNip44`
- `decryptNip44`
- `sendDmNip44`
- `decryptDmNip44`
- `getDmInboxNip44`

## Anonymous Actions

- `sendAnonymousZap`
- `postAnonymousNote`

## NIP-19 Utilities

- `convertNip19`
- `analyzeNip19`

## Blossom Storage

- `getBlossomServers`
- `setBlossomServers`
- `getBlossomUrl`
- `uploadBlob`
- `downloadBlob`
- `listBlobs`
- `deleteBlob`
- `mirrorBlob`
