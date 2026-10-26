import { ConfigurationError } from '@publish-calendar/shared';
import { loadApiConfig } from './config/env.js';
import { buildServer } from './server.js';

export async function startFromEnv(
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  // Rule 3.2: Validate all configuration before serving requests or processing jobs
  const config = loadApiConfig(env);
  const { app } = await buildServer({ config });

  const closeGracefully = async () => {
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void closeGracefully();
  });
  process.on('SIGTERM', () => {
    void closeGracefully();
  });

  await app.listen({
    host: config.apiHost,
    port: config.apiPort,
  });
}

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('/index.js') ||
    process.argv[1].endsWith('/index.ts'));

if (isMainModule) {
  startFromEnv(process.env).catch((err: unknown) => {
    if (err instanceof ConfigurationError) {
      console.error(err.message);
    } else if (err instanceof Error) {
      console.error(`Startup failure: ${err.message}`);
    } else {
      console.error('Unknown startup failure', err);
    }
    process.exit(1);
  });
}
