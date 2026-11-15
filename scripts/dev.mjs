import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const executable = require('electron')
const appRoot = fileURLToPath(new URL('../', import.meta.url))
const vite = await createServer({
  root: appRoot,
  server: { host: '127.0.0.1' },
})
await vite.listen()
const devUrl = vite.resolvedUrls.local[0]
const env = { ...process.env, STACKMATE_DEV_URL: devUrl, STACKMATE_DEV_PARENT: '1' }
delete env.ELECTRON_RUN_AS_NODE
const electron = spawn(executable, [appRoot], {
  env,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})

let closing = false
async function close(code) {
  if (closing) return
  closing = true
  await vite.close()
  process.exitCode = code
}

electron.once('error', error => {
  console.error(error)
  void close(1)
})
electron.once('exit', (code, signal) => void close(code ?? (signal ? 1 : 0)))
const requestQuit = () => {
  if (electron.connected) electron.send('quit', error => {
    if (error && error.code !== 'ERR_IPC_CHANNEL_CLOSED') console.error(error)
  })
}
process.on('SIGINT', requestQuit)
process.on('SIGTERM', requestQuit)
