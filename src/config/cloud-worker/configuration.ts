import { registerAs } from '@nestjs/config';

export default registerAs('cloudWorker', () => ({
  workerUrl: process.env.CLOUD_WORKER_URL,
  cloudId: process.env.CLOUD_ID,
  cloudToken: process.env.CLOUD_TOKEN,
  ddnsEnabled: process.env.DDNS_ENABLED,
  ddnsUpdateInterval: process.env.DDNS_UPDATE_INTERVAL,
  pushIncludeData: process.env.PUSH_INCLUDE_DATA,
}));
