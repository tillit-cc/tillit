import { Socket as ClientSocket } from 'socket.io-client';
import { IsNull, Not } from 'typeorm';
import { createTestApp, TestApp } from './helpers/test-app.factory';
import { PendingMessage } from '../src/entities/pending-message.entity';

describe('Chat WebSocket (E2E)', () => {
  let testApp: TestApp;
  const clients: ClientSocket[] = [];

  /**
   * Helper: connect a client and wait for the 'connect' event.
   */
  function connectClient(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const client = testApp.createAuthenticatedClient(token);
      clients.push(client);
      client.on('connect', () => resolve(client));
      client.on('connect_error', (err) => reject(err));
    });
  }

  /**
   * Helper: wait for a specific event on a client with timeout.
   */
  function waitForEvent(
    client: ClientSocket,
    event: string,
    timeoutMs = 5000,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for event: ${event}`)),
        timeoutMs,
      );
      client.once(event, (data: any, ack?: Function) => {
        clearTimeout(timer);
        if (ack) ack(); // Send ack back to server
        resolve(data);
      });
    });
  }

  beforeAll(async () => {
    testApp = await createTestApp();
  }, 30000);

  afterEach(() => {
    // Disconnect all clients created during the test
    for (const client of clients) {
      if (client.connected) client.disconnect();
    }
    clients.length = 0;
  });

  afterAll(async () => {
    if (testApp) await testApp.close();
  }, 10000);

  describe('WebSocket Authentication', () => {
    it('should reject connection without token', async () => {
      const client = testApp.createAuthenticatedClient('');
      clients.push(client);

      await expect(
        new Promise((resolve, reject) => {
          client.on('connect', () => resolve(true));
          client.on('connect_error', (err) => reject(err));
        }),
      ).rejects.toThrow();
    });

    it('should reject invalid token', async () => {
      const client = testApp.createAuthenticatedClient('Bearer invalid-jwt');
      clients.push(client);

      await expect(
        new Promise((resolve, reject) => {
          client.on('connect', () => resolve(true));
          client.on('connect_error', (err) => reject(err));
        }),
      ).rejects.toThrow();
    });

    it('should accept valid JWT', async () => {
      const user = await testApp.seedUser();
      const token = testApp.getToken(user.id);
      const client = await connectClient(token);

      expect(client.connected).toBe(true);
    });
  });

  describe('Room Flow', () => {
    it('should auto-join rooms on connect', async () => {
      const user = await testApp.seedUser();
      const room = await testApp.seedRoom(user.id);
      await testApp.addUserToRoom(room.id, user.id, 'Alice');

      const token = testApp.getToken(user.id);
      const client = await connectClient(token);

      // Give time for auto-join to complete
      await new Promise((r) => setTimeout(r, 500));

      // Verify by sending a message to the room and checking we can join
      const result = await new Promise<any>((resolve) => {
        client.emit('joinRoom', { roomId: room.id }, (response: any) => {
          resolve(response);
        });
      });

      expect(result.success).toBe(true);
    });

    it('should join and leave room via WebSocket events', async () => {
      const user = await testApp.seedUser();
      const room = await testApp.seedRoom(user.id);
      await testApp.addUserToRoom(room.id, user.id, 'Alice');

      const token = testApp.getToken(user.id);
      const client = await connectClient(token);

      // Join room
      const joinResult = await new Promise<any>((resolve) => {
        client.emit('joinRoom', { roomId: room.id }, (response: any) => {
          resolve(response);
        });
      });
      expect(joinResult.success).toBe(true);

      // Leave room
      const leaveResult = await new Promise<any>((resolve) => {
        client.emit('leaveRoom', { roomId: room.id }, (response: any) => {
          resolve(response);
        });
      });
      expect(leaveResult.success).toBe(true);
    });
  });

  describe('Message Delivery', () => {
    it('should deliver message to other room members', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      const room = await testApp.seedRoom(alice.id);
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      const aliceToken = testApp.getToken(alice.id);
      const bobToken = testApp.getToken(bob.id);

      const bobClient = await connectClient(bobToken);
      // Wait for auto-join to complete
      await new Promise((r) => setTimeout(r, 500));

      const aliceClient = await connectClient(aliceToken);
      await new Promise((r) => setTimeout(r, 500));

      // Bob listens for newMessage
      const msgPromise = waitForEvent(bobClient, 'newMessage');

      // Alice sends message
      const sendResult = await new Promise<any>((resolve) => {
        aliceClient.emit(
          'sendMessage',
          {
            roomId: room.id,
            message: { text: 'Hello Bob!' },
            category: 'user',
            type: 'text',
          },
          (response: any) => resolve(response),
        );
      });

      expect(sendResult.success).toBe(true);

      const receivedMsg = await msgPromise;
      expect(receivedMsg.roomId).toBe(room.id);
      expect(receivedMsg.senderId).toBe(alice.id);
    });

    it('should NOT deliver message back to sender', async () => {
      const alice = await testApp.seedUser();
      const room = await testApp.seedRoom(alice.id);
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');

      const token = testApp.getToken(alice.id);
      const client = await connectClient(token);
      await new Promise((r) => setTimeout(r, 500));

      let receivedOwnMessage = false;
      client.on('newMessage', () => {
        receivedOwnMessage = true;
      });

      // Send message
      await new Promise<any>((resolve) => {
        client.emit(
          'sendMessage',
          {
            roomId: room.id,
            message: { text: 'self message' },
          },
          (response: any) => resolve(response),
        );
      });

      // Wait a bit and verify no self-delivery
      await new Promise((r) => setTimeout(r, 1000));
      expect(receivedOwnMessage).toBe(false);
    });

    it('should return error when sending to non-member room', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      const room = await testApp.seedRoom(bob.id);
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');
      // Alice is NOT a member

      const token = testApp.getToken(alice.id);
      const client = await connectClient(token);
      await new Promise((r) => setTimeout(r, 300));

      const result = await new Promise<any>((resolve) => {
        client.emit(
          'sendMessage',
          {
            roomId: room.id,
            message: { text: 'unauthorized' },
          },
          (response: any) => resolve(response),
        );
      });

      expect(result.error).toBe('You are not a member of this room');
    });

    it('should save pending message when recipient is offline', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      const room = await testApp.seedRoom(alice.id);
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      // Only Alice connects - Bob is offline
      const aliceToken = testApp.getToken(alice.id);
      const aliceClient = await connectClient(aliceToken);
      await new Promise((r) => setTimeout(r, 500));

      // Alice sends message
      await new Promise<any>((resolve) => {
        aliceClient.emit(
          'sendMessage',
          {
            roomId: room.id,
            message: { text: 'offline test' },
          },
          (response: any) => resolve(response),
        );
      });

      // Wait for pending message to be saved
      await new Promise((r) => setTimeout(r, 500));

      // Check pending_messages table
      const pendingRepo = testApp.dataSource.getRepository(PendingMessage);
      const pending = await pendingRepo.find({
        where: { userId: bob.id, roomId: room.id },
      });

      expect(pending.length).toBeGreaterThan(0);
    });
  });

  describe('Multi-device fan-out', () => {
    it('delivers per-device ciphertext via top-level recipients[]', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      const room = await testApp.seedRoom(alice.id);
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      // Alice has two devices, Bob has one.
      const aliceD1Token = testApp.getToken(alice.id, 1);
      const aliceD2Token = testApp.getToken(alice.id, 2);
      const bobToken = testApp.getToken(bob.id, 1);

      const aliceD2Client = await connectClient(aliceD2Token);
      const bobClient = await connectClient(bobToken);
      await new Promise((r) => setTimeout(r, 500));

      const aliceD1Client = await connectClient(aliceD1Token);
      await new Promise((r) => setTimeout(r, 500));

      const aliceD2MsgPromise = waitForEvent(aliceD2Client, 'newMessage');
      const bobMsgPromise = waitForEvent(bobClient, 'newMessage');

      // Alice's primary device must NOT receive its own message back.
      let aliceD1Received = false;
      aliceD1Client.on('newMessage', () => {
        aliceD1Received = true;
      });

      const sendResult = await new Promise<any>((resolve) => {
        aliceD1Client.emit(
          'sendMessage',
          {
            roomId: room.id,
            recipients: [
              {
                userId: alice.id,
                deviceId: 2,
                ciphertext: 'cipher-for-A2',
              },
              {
                userId: bob.id,
                deviceId: 1,
                ciphertext: 'cipher-for-B1',
              },
            ],
            metadata: { id_parent: 'parent-123', version: '0.1.0' },
            category: 'user',
            type: 'text',
          },
          (response: any) => resolve(response),
        );
      });

      expect(sendResult.success).toBe(true);

      const a2Msg = await aliceD2MsgPromise;
      expect(a2Msg.message).toBe('cipher-for-A2');
      expect(a2Msg.senderId).toBe(alice.id);
      expect(a2Msg.senderDeviceId).toBe(1);
      expect(a2Msg.idParent).toBe('parent-123');
      expect(a2Msg.version).toBe('0.1.0');

      const bMsg = await bobMsgPromise;
      expect(bMsg.message).toBe('cipher-for-B1');
      expect(bMsg.senderId).toBe(alice.id);
      expect(bMsg.idParent).toBe('parent-123');

      // Same logical message id across devices (server-assigned baseId).
      expect(a2Msg.id).toBe(bMsg.id);

      // Confirm no self-echo on the sending device.
      await new Promise((r) => setTimeout(r, 300));
      expect(aliceD1Received).toBe(false);
    });

    // Helper: connect with a newMessage listener already attached, so the
    // server-side handleConnection → deliverPending emit cannot race the
    // client-side handler registration.
    function connectAndCollect(
      token: string,
    ): Promise<{ client: ClientSocket; buffer: any[] }> {
      return new Promise((resolve, reject) => {
        const client = testApp.createAuthenticatedClient(token);
        clients.push(client);
        const buffer: any[] = [];
        client.on('newMessage', (data: any, ack?: () => void) => {
          buffer.push(data);
          if (ack) ack();
        });
        client.on('connect', () => resolve({ client, buffer }));
        client.on('connect_error', (err) => reject(err));
      });
    }

    it('queues per-device row scoped to deviceId when target is offline', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      const room = await testApp.seedRoom(alice.id);
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      // Only Alice D1 and Bob connect — Alice D2 is offline.
      const aliceD1Token = testApp.getToken(alice.id, 1);
      const bobToken = testApp.getToken(bob.id, 1);
      const bobClient = await connectClient(bobToken);
      const aliceD1Client = await connectClient(aliceD1Token);
      await new Promise((r) => setTimeout(r, 300));

      const bobMsgPromise = waitForEvent(bobClient, 'newMessage');

      await new Promise<any>((resolve) => {
        aliceD1Client.emit(
          'sendMessage',
          {
            roomId: room.id,
            recipients: [
              {
                userId: alice.id,
                deviceId: 2,
                ciphertext: 'cipher-for-A2-offline',
              },
              {
                userId: bob.id,
                deviceId: 1,
                ciphertext: 'cipher-for-B1',
              },
            ],
            category: 'user',
            type: 'text',
          },
          (response: any) => resolve(response),
        );
      });

      await bobMsgPromise;
      await new Promise((r) => setTimeout(r, 500));

      const pendingRepo = testApp.dataSource.getRepository(PendingMessage);
      const pendingForA2 = await pendingRepo.find({
        where: { userId: alice.id, roomId: room.id, recipientDeviceId: 2 },
      });
      expect(pendingForA2.length).toBe(1);
      const parsedEnvelope = JSON.parse(pendingForA2[0].envelope);
      expect(parsedEnvelope.message).toBe('cipher-for-A2-offline');

      // No legacy NULL-device row for Alice — the fan-out path must use the
      // per-device column so a different device cannot drain A2's queue.
      const legacyNullRows = await pendingRepo.find({
        where: {
          userId: alice.id,
          roomId: room.id,
          recipientDeviceId: IsNull(),
        },
      });
      expect(legacyNullRows.length).toBe(0);

      // Bob's queue is untouched.
      const bobPending = await pendingRepo.find({
        where: { userId: bob.id, roomId: room.id },
      });
      expect(bobPending.length).toBe(0);
    }, 15000);

    it('drains per-device pending on reconnect, leaves rows for other devices', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      const room = await testApp.seedRoom(alice.id);
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      const aliceD1Client = await connectClient(testApp.getToken(alice.id, 1));
      const bobClient = await connectClient(testApp.getToken(bob.id, 1));
      await new Promise((r) => setTimeout(r, 300));

      const bobMsg1 = waitForEvent(bobClient, 'newMessage');
      await new Promise<any>((resolve) => {
        aliceD1Client.emit(
          'sendMessage',
          {
            roomId: room.id,
            recipients: [
              {
                userId: alice.id,
                deviceId: 2,
                ciphertext: 'queued-for-A2',
              },
              {
                userId: bob.id,
                deviceId: 1,
                ciphertext: 'cipher-for-B1',
              },
            ],
            category: 'user',
            type: 'text',
          },
          (response: any) => resolve(response),
        );
      });
      await bobMsg1;
      await new Promise((r) => setTimeout(r, 300));

      // A2 reconnect drains its own pending row.
      const aliceD2 = await connectAndCollect(testApp.getToken(alice.id, 2));
      await new Promise((r) => setTimeout(r, 800));

      const drainedA2 = aliceD2.buffer.filter(
        (m) => m.message === 'queued-for-A2',
      );
      expect(drainedA2.length).toBe(1);

      const pendingRepo = testApp.dataSource.getRepository(PendingMessage);
      const afterDrain = await pendingRepo.find({
        where: { userId: alice.id, roomId: room.id, recipientDeviceId: 2 },
      });
      expect(afterDrain.length).toBe(0);

      // Now send again to A2 while A2 is offline, then bring a sibling
      // device A3 online — it must NOT drain rows scoped to deviceId=2.
      aliceD2.client.disconnect();
      await new Promise((r) => setTimeout(r, 200));

      await new Promise<any>((resolve) => {
        aliceD1Client.emit(
          'sendMessage',
          {
            roomId: room.id,
            recipients: [
              {
                userId: alice.id,
                deviceId: 2,
                ciphertext: 'second-A2-only',
              },
            ],
            category: 'user',
            type: 'text',
          },
          (response: any) => resolve(response),
        );
      });
      await new Promise((r) => setTimeout(r, 300));

      const aliceD3 = await connectAndCollect(testApp.getToken(alice.id, 3));
      await new Promise((r) => setTimeout(r, 800));
      expect(aliceD3.buffer.length).toBe(0);

      const stillPending = await pendingRepo.find({
        where: { userId: alice.id, roomId: room.id, recipientDeviceId: 2 },
      });
      expect(stillPending.length).toBe(1);
    }, 15000);

    it('regression: nested message.payload.recipients does NOT trigger fan-out', async () => {
      // Legacy (buggy) client shape — recipients[] inside the envelope. The
      // server must NOT pick the multi-device path because the DTO requires
      // recipients[] top-level. We pin current behavior: the legacy single
      // broadcast is taken, every non-sending device receives the SAME blob
      // (backend-0011: sender's other devices are legitimate recipients).
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      await testApp.seedDevice(alice.id, 2);
      const room = await testApp.seedRoom(alice.id);
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      const aliceD1Client = await connectClient(testApp.getToken(alice.id, 1));
      const aliceD2Client = await connectClient(testApp.getToken(alice.id, 2));
      const bobClient = await connectClient(testApp.getToken(bob.id, 1));
      await new Promise((r) => setTimeout(r, 500));

      const aliceD2MsgPromise = waitForEvent(aliceD2Client, 'newMessage');
      const bobMsgPromise = waitForEvent(bobClient, 'newMessage');

      await new Promise<any>((resolve) => {
        aliceD1Client.emit(
          'sendMessage',
          {
            roomId: room.id,
            message: {
              payload: {
                recipients: [
                  { userId: bob.id, deviceId: 1, ciphertext: 'x' },
                  { userId: alice.id, deviceId: 2, ciphertext: 'y' },
                ],
              },
            },
            category: 'user',
            type: 'text',
          },
          (response: any) => resolve(response),
        );
      });

      const bMsg = await bobMsgPromise;
      const a2Msg = await aliceD2MsgPromise;

      // Whole blob landed on bob — fan-out did NOT happen.
      expect(bMsg.message?.payload?.recipients).toBeDefined();
      // Sender's other device receives the SAME envelope blob (legacy single
      // broadcast still in effect — the per-device fan-out path requires
      // top-level recipients[]).
      expect(a2Msg.message?.payload?.recipients).toEqual(
        bMsg.message?.payload?.recipients,
      );

      // No pending rows for Alice — A2 was online and acked.
      const pendingRepo = testApp.dataSource.getRepository(PendingMessage);
      const aliceLegacyPending = await pendingRepo.find({
        where: {
          userId: alice.id,
          roomId: room.id,
          recipientDeviceId: Not(IsNull()),
        },
      });
      expect(aliceLegacyPending.length).toBe(0);
    });
  });

  // backend-0011: sender-key broadcast must fan-out to the sender's OTHER
  // devices (online and offline). Reuses the same envelope ciphertext —
  // every active device in the room (minus the sending device) is a target.
  describe('Sender-key self fan-out (backend-0011)', () => {
    function connectAndCollect(
      token: string,
    ): Promise<{ client: ClientSocket; buffer: any[] }> {
      return new Promise((resolve, reject) => {
        const client = testApp.createAuthenticatedClient(token);
        clients.push(client);
        const buffer: any[] = [];
        client.on('newMessage', (data: any, ack?: () => void) => {
          buffer.push(data);
          if (ack) ack();
        });
        client.on('connect', () => resolve({ client, buffer }));
        client.on('connect_error', (err) => reject(err));
      });
    }

    it('online: A2 and B1 receive the sender-key broadcast, A1 does not', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      await testApp.seedDevice(alice.id, 2);
      const room = await testApp.seedRoom(alice.id, 'sk-room', {
        useSenderKeys: true,
      });
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      const aliceD1 = await connectAndCollect(testApp.getToken(alice.id, 1));
      const aliceD2 = await connectAndCollect(testApp.getToken(alice.id, 2));
      const bobD1 = await connectAndCollect(testApp.getToken(bob.id, 1));
      await new Promise((r) => setTimeout(r, 500));

      const sendResult = await new Promise<any>((resolve) => {
        aliceD1.client.emit(
          'sendMessage',
          {
            roomId: room.id,
            message: {
              payload: {
                ciphertext: 'sk-ciphertext-blob',
                distributionId: 'dist-1',
              },
            },
            category: 'senderkey_message',
            type: 'text',
          },
          (response: any) => resolve(response),
        );
      });
      expect(sendResult.success).toBe(true);

      await new Promise((r) => setTimeout(r, 500));

      // A2 received the broadcast — same ciphertext blob as B1.
      const a2Msg = aliceD2.buffer.find(
        (m) => m?.category === 'senderkey_message',
      );
      expect(a2Msg).toBeDefined();
      expect(a2Msg.message.ciphertext).toBe('sk-ciphertext-blob');
      expect(a2Msg.senderId).toBe(alice.id);
      expect(a2Msg.senderDeviceId).toBe(1);

      const bMsg = bobD1.buffer.find(
        (m) => m?.category === 'senderkey_message',
      );
      expect(bMsg).toBeDefined();
      expect(bMsg.message.ciphertext).toBe('sk-ciphertext-blob');

      // A1 (sending device) must NOT see its own broadcast.
      expect(
        aliceD1.buffer.filter((m) => m?.category === 'senderkey_message')
          .length,
      ).toBe(0);
    }, 15000);

    it('offline self-device: A2 gets a per-device pending row, drained on reconnect', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      await testApp.seedDevice(alice.id, 2);
      const room = await testApp.seedRoom(alice.id, 'sk-room', {
        useSenderKeys: true,
      });
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      // Only A1 and B1 are online. A2 is offline.
      const aliceD1 = await connectAndCollect(testApp.getToken(alice.id, 1));
      const bobD1 = await connectAndCollect(testApp.getToken(bob.id, 1));
      await new Promise((r) => setTimeout(r, 500));

      await new Promise<any>((resolve) => {
        aliceD1.client.emit(
          'sendMessage',
          {
            roomId: room.id,
            message: {
              payload: {
                ciphertext: 'sk-offline-blob',
                distributionId: 'dist-2',
              },
            },
            category: 'senderkey_message',
            type: 'text',
          },
          (response: any) => resolve(response),
        );
      });

      // Wait for the background delivery (backend-0015) to land the row.
      await new Promise((r) => setTimeout(r, 800));

      // B1 received online.
      expect(
        bobD1.buffer.filter((m) => m?.category === 'senderkey_message').length,
      ).toBe(1);

      // A2 has exactly one per-device pending row scoped to deviceId=2.
      const pendingRepo = testApp.dataSource.getRepository(PendingMessage);
      const pendingForA2 = await pendingRepo.find({
        where: { userId: alice.id, roomId: room.id, recipientDeviceId: 2 },
      });
      expect(pendingForA2.length).toBe(1);
      const parsed = JSON.parse(pendingForA2[0].envelope);
      expect(parsed.message.ciphertext).toBe('sk-offline-blob');

      // A2 reconnects → its own row drains, B1 stays untouched.
      const aliceD2 = await connectAndCollect(testApp.getToken(alice.id, 2));
      await new Promise((r) => setTimeout(r, 800));

      const a2Drained = aliceD2.buffer.find(
        (m) => m?.message?.ciphertext === 'sk-offline-blob',
      );
      expect(a2Drained).toBeDefined();

      const afterDrain = await pendingRepo.find({
        where: { userId: alice.id, roomId: room.id, recipientDeviceId: 2 },
      });
      expect(afterDrain.length).toBe(0);

      // Bob got no pending row at all.
      const bobPending = await pendingRepo.find({
        where: { userId: bob.id, roomId: room.id },
      });
      expect(bobPending.length).toBe(0);
    }, 15000);

    it('A2 online, B1 offline: only B1 ends up in pending_messages', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      await testApp.seedDevice(alice.id, 2);
      const room = await testApp.seedRoom(alice.id, 'sk-room', {
        useSenderKeys: true,
      });
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      const aliceD1 = await connectAndCollect(testApp.getToken(alice.id, 1));
      const aliceD2 = await connectAndCollect(testApp.getToken(alice.id, 2));
      // Bob is offline.
      await new Promise((r) => setTimeout(r, 500));

      await new Promise<any>((resolve) => {
        aliceD1.client.emit(
          'sendMessage',
          {
            roomId: room.id,
            message: {
              payload: {
                ciphertext: 'sk-mixed',
                distributionId: 'dist-3',
              },
            },
            category: 'senderkey_message',
            type: 'text',
          },
          (response: any) => resolve(response),
        );
      });
      await new Promise((r) => setTimeout(r, 800));

      // A2 (online) got the broadcast.
      expect(
        aliceD2.buffer.filter((m) => m?.message?.ciphertext === 'sk-mixed')
          .length,
      ).toBe(1);

      const pendingRepo = testApp.dataSource.getRepository(PendingMessage);
      // Alice (sender + online sibling A2) has no pending rows.
      const alicePending = await pendingRepo.find({
        where: { userId: alice.id, roomId: room.id },
      });
      expect(alicePending.length).toBe(0);

      // Bob has a per-device row (deviceId=1).
      const bobPending = await pendingRepo.find({
        where: { userId: bob.id, roomId: room.id, recipientDeviceId: 1 },
      });
      expect(bobPending.length).toBe(1);
    }, 15000);
  });

  describe('Control Packets', () => {
    it('should deliver control packet to room members', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      const room = await testApp.seedRoom(alice.id);
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');

      const aliceToken = testApp.getToken(alice.id);
      const bobToken = testApp.getToken(bob.id);

      const bobClient = await connectClient(bobToken);
      await new Promise((r) => setTimeout(r, 500));

      const aliceClient = await connectClient(aliceToken);
      await new Promise((r) => setTimeout(r, 500));

      // Bob listens for newPacket
      const pktPromise = waitForEvent(bobClient, 'newPacket');

      // Alice sends control packet
      const sendResult = await new Promise<any>((resolve) => {
        aliceClient.emit(
          'sendPacket',
          {
            roomId: room.id,
            packet: { type: 'SESSION_ESTABLISHED', data: {} },
          },
          (response: any) => resolve(response),
        );
      });

      expect(sendResult.success).toBe(true);

      const receivedPkt = await pktPromise;
      expect(receivedPkt.roomId).toBe(room.id);
      expect(receivedPkt.senderId).toBe(alice.id);
    });

    it('should deliver control packet only to specific recipientIds', async () => {
      const alice = await testApp.seedUser();
      const bob = await testApp.seedUser();
      const carol = await testApp.seedUser();
      const room = await testApp.seedRoom(alice.id);
      await testApp.addUserToRoom(room.id, alice.id, 'Alice');
      await testApp.addUserToRoom(room.id, bob.id, 'Bob');
      await testApp.addUserToRoom(room.id, carol.id, 'Carol');

      const aliceToken = testApp.getToken(alice.id);
      const bobToken = testApp.getToken(bob.id);
      const carolToken = testApp.getToken(carol.id);

      const bobClient = await connectClient(bobToken);
      const carolClient = await connectClient(carolToken);
      await new Promise((r) => setTimeout(r, 500));

      const aliceClient = await connectClient(aliceToken);
      await new Promise((r) => setTimeout(r, 500));

      // Bob listens for newPacket
      const bobPktPromise = waitForEvent(bobClient, 'newPacket');

      // Carol should NOT receive it
      let carolReceived = false;
      carolClient.on('newPacket', () => {
        carolReceived = true;
      });

      // Alice sends packet to Bob only
      await new Promise<any>((resolve) => {
        aliceClient.emit(
          'sendPacket',
          {
            roomId: room.id,
            packet: { type: 'SESSION_ESTABLISHED' },
            recipientIds: [bob.id],
          },
          (response: any) => resolve(response),
        );
      });

      const bobPkt = await bobPktPromise;
      expect(bobPkt.senderId).toBe(alice.id);

      // Wait and verify Carol didn't get it
      await new Promise((r) => setTimeout(r, 1000));
      expect(carolReceived).toBe(false);
    });
  });
});
