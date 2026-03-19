import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app/config.service';
import { AuthenticatedSocketAdapter } from './sockets/authenticated-socket.adapter';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    bodyParser: true,
    rawBody: false,
  });

  // Security headers
  app.use(helmet());

  // Increase the payload size limit for Signal Protocol key bundles
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useWebSocketAdapter(new AuthenticatedSocketAdapter(app));

  const corsOrigin = process.env.CORS_ORIGIN || true;
  app.enableCors({
    origin: corsOrigin === 'true' ? true : corsOrigin,
    credentials: true,
  });

  if (!process.env.CORS_ORIGIN) {
    logger.warn('CORS_ORIGIN not set — accepting requests from any origin');
  }

  const appConfig: AppConfigService = app.get(AppConfigService);

  await app.listen(appConfig.port);
}
void bootstrap();
