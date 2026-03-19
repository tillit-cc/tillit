import { Socket as ClientSocket } from 'socket.io-client';
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
