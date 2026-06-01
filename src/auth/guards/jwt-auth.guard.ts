import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { ALLOW_RECOVERY_SCOPE_KEY } from '../decorators/allow-recovery-scope.decorator';
import { RECOVERY_SCOPE } from '../../common/types/authenticated-request';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  /**
   * Recovery-scoped JWTs (ADR-0010 OQ-1) are confined to a single downstream
   * route. Anywhere else they MUST be refused — including any future REST
   * endpoint that forgets to think about the scope. Allow-listing via
   * `@AllowRecoveryScope()` keeps the default safe.
   */
  handleRequest<TUser = { userId: number; deviceId: number; scope?: string }>(
    err: unknown,
    user: TUser | false,
    info: unknown,
    context: ExecutionContext,
  ): TUser {
    const resolved = super.handleRequest(err, user, info, context);

    if (resolved.scope === RECOVERY_SCOPE) {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        ALLOW_RECOVERY_SCOPE_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (!allowed) {
        throw new UnauthorizedException(
          'Recovery token not allowed for this endpoint',
          'RECOVERY_TOKEN_DENIED',
        );
      }
    }

    return resolved;
  }
}
