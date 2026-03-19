import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { BanService } from '../modules/ban/ban.service';

export class AuthenticatedSocketAdapter extends IoAdapter {
  private authService: AuthService;
  private banService: BanService;
  private readonly logger = new Logger(AuthenticatedSocketAdapter.name);

  constructor(private app: INestApplicationContext) {
    super(app);
    this.authService = this.app.get(AuthService);
    this.banService = this.app.get(BanService);
  }

  createIOServer(port: number, options?: any) {
    // Max payload: 12MB (10MB volatile media + JSON/base64 overhead)
    // Aligned with MAX_VOLATILE_PAYLOAD_BYTES application-level limit
    const serverOptions = {
      ...options,
      maxHttpBufferSize: 12 * 1024 * 1024, // 12MB
      pingTimeout: 60000, // 60 seconds
      pingInterval: 25000, // 25 seconds
    };

    const server: Server = super.createIOServer(port, serverOptions);

    const authMiddleware = async (socket: any, next: (err?: Error) => void) => {
      const tokenPayload: string =
        socket.handshake?.auth?.token ||
        socket.handshake?.headers?.authorization;

      if (!tokenPayload) {
        return next(new Error('Token not provided'));
      }

      const [method, token] = tokenPayload.split(' ');

      if (method !== 'Bearer') {
        return next(
          new Error('Invalid authentication method. Only Bearer is supported.'),
        );
      }

      try {
        // Validate JWT token
        const payload = await this.authService.validateJWT(token);

        // Check if user is banned
        if (await this.banService.isUserBanned(payload.sub)) {
          return next(new Error('BANNED'));
        }

        // Attach user info to socket
        socket.user = {
          userId: payload.sub,
        };

        return next();
      } catch (error: any) {
        this.logger.warn(`WebSocket authentication error: ${error.message}`);
        return next(new Error('Authentication failed'));
      }
    };

    const middleware = (socket: any, next: (err?: Error) => void) => {
      void authMiddleware(socket, next);
    };
    server.use(middleware);
    server.of('/chat').use(middleware);

    return server;
  }
}
