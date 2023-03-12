import { promisify } from 'util'
import { app as createApp } from './src/app'
import { numberFromEnv, requiredEnv } from './src/env'
import { inMemoryPreviewEnvStore } from './src/preview-env'
import { sshServer as createSshServer } from './src/ssh-server'
import { getSSHKeys } from './src/ssh-keys'
import url from 'url'
import path from 'path'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const {sshPrivateKey, sshPublicKey} = await getSSHKeys({
  defaultKeyLocation: path.join(__dirname, "./ssh/ssh_host_key")
})

const PORT = numberFromEnv('PORT') || 3000
const SSH_PORT = numberFromEnv('SSH_PORT') || 2222
const LISTEN_HOST = '0.0.0.0'
const BASE_URL = (() => {
  const result = new URL(requiredEnv('BASE_URL'))
  if (result.pathname !== '/' || result.search || result.username || result.password || result.hash) {
    throw new Error(`Invalid URL: ${result} - cannot specify path, search, username, password, or hash`)
  }
  return { hostname: result.hostname, port: result.port, protocol: result.protocol }
})()

type BaseUrl = typeof BASE_URL

const envStore = inMemoryPreviewEnvStore({
  test: {
    target: 'http://3.73.126.120',
  },
})

const app = createApp({ envStore, sshPublicKey })
const sshLogger = app.log.child({ name: 'ssh_server' })

const tunnelName = (clientId: string, remotePath: string) => {
  const serviceName = remotePath.replace(/^\//, '')
  return `${serviceName}-${clientId}`
}

const tunnelUrl = ({ hostname, protocol, port }: BaseUrl, clientId: string, tunnel: string) => new URL(
  `${protocol}//${tunnelName(clientId, tunnel)}.${hostname}:${port}`
).toString()

const sshServer = createSshServer({
  log: sshLogger,
  sshPrivateKey,
  socketDir: '/tmp', // TODO
  onPipeCreated: async (clientId, remotePath, localSocket) => {
    const key = tunnelName(clientId, remotePath);
    sshLogger.debug('creating tunnel %s for localSocket %s', key, localSocket)
    await envStore.set(key, { target: localSocket })
  },
  onPipeDestroyed: async (clientId, remotePath) => {
    const key = tunnelName(clientId, remotePath);
    sshLogger.debug('deleting tunnel %s', key)
    await envStore.delete(key)
  },
  onHello: (clientId, tunnels) => JSON.stringify({ 
    clientId,
    tunnels: Object.fromEntries(tunnels.map(tunnel => [
      tunnel, 
      tunnelUrl(BASE_URL, clientId, tunnel),
    ])),
  }) + '\r\n',
})
  .listen(SSH_PORT, LISTEN_HOST, () => {
    app.log.debug('ssh server listening on port %j', SSH_PORT)
  })
  .on('error', (err: unknown) => {
    app.log.error('ssh server error: %j', err)
  })

app.listen({ host: LISTEN_HOST, port: PORT }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})

;['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.once(signal, () => {
    app.log.info(`shutting down on ${signal}`)
    Promise.all([promisify(sshServer.close).call(sshServer), app.close()])
      .catch((err) => {
        app.log.error(err)
        process.exit(1)
      })
      .finally(() => {
        process.exit(0)
      })
  })
})