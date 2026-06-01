import { BadRequestException } from '@nestjs/common';

// libsignal is a native ESM addon — mock it before importing modules that
// transitively pull it in (AuthService → '@signalapp/libsignal-client').
jest.mock('@signalapp/libsignal-client', () => ({
  PublicKey: { deserialize: jest.fn() },
}));

import { KeysController } from './keys.controller';
import { KeysService } from '../services/keys.service';
import { RoomService } from '../../chat/services/room.service';
import { UploadKeysDto } from '../dto/keys.dto';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';

describe('KeysController (recovery scope)', () => {
  let keysService: { uploadKeys: jest.Mock };
  let roomService: { usersShareRoom: jest.Mock };
  let controller: KeysController;

  beforeEach(() => {
    keysService = {
      uploadKeys: jest.fn().mockResolvedValue(undefined),
    };
    roomService = {
      usersShareRoom: jest.fn().mockResolvedValue(true),
    };
    controller = new KeysController(
      keysService as unknown as KeysService,
      roomService as unknown as RoomService,
    );
  });

  const makeReq = (scope?: 'recover'): AuthenticatedRequest =>
    ({
      user: { userId: 1, deviceId: 1, ...(scope ? { scope } : {}) },
    }) as unknown as AuthenticatedRequest;

  const recoveryDto = (
    overrides: Partial<UploadKeysDto> = {},
  ): UploadKeysDto => ({
    deviceId: 1,
    deviceAuthPublicKey: 'new-auth-pub',
    recoverPrimary: true,
    ...overrides,
  });

  it('accepts the canonical recovery shape with a recovery-scoped JWT', async () => {
    await controller.uploadKeys(makeReq('recover'), recoveryDto());

    expect(keysService.uploadKeys).toHaveBeenCalledWith(
      1, // userId
      1, // deviceId
      undefined, // identityPublicKey not provided in this minimal test
      undefined, // registrationId
      undefined, // signedPreKey
      undefined, // preKeys
      undefined, // kyberPreKeys
      'new-auth-pub',
      true,
    );
  });

  it('rejects a recovery-scoped JWT carrying a non-recovery body', async () => {
    // Missing deviceAuthPublicKey — the recovery flow exists precisely to
    // rotate the auth key, so omitting it makes the call meaningless.
    await expect(
      controller.uploadKeys(
        makeReq('recover'),
        recoveryDto({ deviceAuthPublicKey: undefined }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Wrong deviceId for recovery — only deviceId=1 is permitted.
    await expect(
      controller.uploadKeys(makeReq('recover'), recoveryDto({ deviceId: 2 })),
    ).rejects.toMatchObject({
      response: { error: 'RECOVERY_PAYLOAD_REQUIRED' },
    });

    // recoverPrimary flag missing — the body looks like a normal upload but
    // the token only authorizes recovery; reject so a leaked recovery JWT
    // can't perform a regular bundle upload.
    await expect(
      controller.uploadKeys(
        makeReq('recover'),
        recoveryDto({ recoverPrimary: false }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(keysService.uploadKeys).not.toHaveBeenCalled();
  });

  it('passes through a normal JWT without scope check', async () => {
    // No scope → the recovery-shape guard is skipped; the controller calls
    // the service with whatever body it received (including a regular bundle
    // upload that does not satisfy the recovery shape).
    const dto: UploadKeysDto = {
      deviceId: 1,
      identityPublicKey: 'identity',
      registrationId: 12345,
    };

    await controller.uploadKeys(makeReq(), dto);

    expect(keysService.uploadKeys).toHaveBeenCalledWith(
      1,
      1,
      'identity',
      12345,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});
