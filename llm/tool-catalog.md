# Tool Catalog (Current)

This catalog represents the canonical Nostr tool contract used by Nostr Agent Interface.

Lineage note: this contract originates from the original Nostr MCP Server JARC toolset and is extended here for broader CLI/API workflows, with MCP preserved as a supported compatibility transport.

## Reading and Querying

1. `getProfile`
2. `getKind1Notes`
3. `getLongFormNotes`
4. `getReceivedZaps`
5. `getSentZaps`
6. `getAllZaps`
7. `queryEvents`
8. `getContactList`
9. `getFollowing`
10. `getRelayList`

## Identity and Profile

11. `createKeypair`
12. `createProfile`
13. `updateProfile`

## Notes

14. `createNote`
15. `signNote`
16. `publishNote`
17. `postNote`

## Generic Event Lifecycle

18. `createNostrEvent`
19. `signNostrEvent`
20. `publishNostrEvent`

## Social

21. `setRelayList`
22. `follow`
23. `unfollow`
24. `reactToEvent`
25. `repostEvent`
26. `deleteEvent`
27. `replyToEvent`

## Messaging

28. `encryptNip04`
29. `decryptNip04`
30. `sendDmNip04`
31. `getDmConversationNip04`
32. `encryptNip44`
33. `decryptNip44`
34. `sendDmNip44`
35. `decryptDmNip44`
36. `getDmInboxNip44`

## Anonymous Actions

37. `sendAnonymousZap`
38. `postAnonymousNote`

## NIP-19 Entity Utilities

39. `convertNip19`
40. `analyzeNip19`

## Blossom Storage

41. `getBlossomServers`
42. `setBlossomServers`
43. `getBlossomUrl`
44. `uploadBlob`
45. `downloadBlob`
46. `listBlobs`
47. `deleteBlob`
48. `mirrorBlob`

## Input Normalization Notes

1. Public keys generally accept hex and `npub`.
2. Private keys generally accept hex and `nsec`.
3. Many tools accept optional relay lists and use defaults when omitted.

## Agent Usage Heuristics

1. Prefer reads before writes.
2. Verify key material before mutations.
3. Surface relay + event IDs in write summaries.
4. Retry publish/query failures with explicit relay lists.
