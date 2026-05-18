export enum ChatEvents {
  // Client -> Server
  SendMessage = 'sendMessage',
  SendPacket = 'sendPacket',
  JoinRoom = 'joinRoom',
  LeaveRoom = 'leaveRoom',

  // Server -> Client
  NewMessage = 'newMessage',
  NewPacket = 'newPacket',
  UserJoined = 'userJoined',
  UserLeft = 'userLeft',
  UserOnline = 'userOnline',
  RoomDeleted = 'roomDeleted',
  UserLeftRoom = 'userLeftRoom',
}

export interface MessageEnvelope {
  id: string;
  roomId: number;
  senderId: number;
  /**
   * Sender's device id. Optional so legacy pending envelopes (queued
   * before the H-04 fix) decode unchanged; the client falls back to
   * deviceId=1 when absent.
   */
  senderDeviceId?: number;
  message: any;
  timestamp: string;
  category?: string;
  type?: string;
  version: string;
}

export interface ControlPacket {
  id: string;
  roomId: number;
  senderId: number;
  senderDeviceId?: number;
  packet: any;
  recipientIds?: number[];
  timestamp: string;
}

export interface UserOnlineEvent {
  userId: number;
  roomId: number;
  timestamp: number;
}
