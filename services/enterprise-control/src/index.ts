import { loadControlConfig } from './config'
import { startControlRuntime } from './runtime'

try {
  const config = loadControlConfig(Bun.env)
  const runtime = await startControlRuntime(config)
  console.log(`Enterprise control listening on ${config.host}:${runtime.server.port}`)
  const stop = () => { void runtime.close().finally(() => { process.exitCode = 0 }) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch {
  console.error('Enterprise control failed to start. Verify database migrations, Redis and listener settings.')
  process.exitCode = 1
}
