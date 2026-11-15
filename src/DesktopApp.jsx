import { useEffect, useRef, useState } from 'react'
import App from './App.jsx'
import { setBackendConnection } from './utils/backend'
import { apiOpenProject } from './utils/fileApi'

export default function DesktopApp() {
  const [connection, setConnection] = useState(null)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState('')
  const activeProject = useRef(null)
  const updateConnectionRef = useRef(null)
  const bridge = window.stackmate

  useEffect(() => {
    if (!bridge) {
      setError('StackMate masaüstü uygulamasını açın.')
      return
    }

    let version = 0
    let latest = null
    let disposed = false
    const updateConnection = async (next) => {
      if (disposed) return
      if (next && latest?.baseUrl === next.baseUrl && latest?.token === next.token) return
      latest = next
      const update = ++version
      setBackendConnection(null)
      setConnection(null)
      if (!next) {
        setError('StackMate yerel servisine ulaşılamadı.')
        return
      }
      setError('')
      try {
        if (activeProject.current) await apiOpenProject(activeProject.current, next)
        if (update !== version) return
        setBackendConnection(next)
        setConnection(next)
        setStarted(true)
      } catch (err) {
        if (update === version) {
          setBackendConnection(next)
          setConnection(next)
          setError(`Proje yeniden açılamadı. ${err.message}`)
        }
      }
    }

    updateConnectionRef.current = updateConnection
    const unsubscribe = bridge.onConnectionChanged(updateConnection)
    const initialVersion = version
    bridge.getConnection().then(next => {
      if (version === initialVersion) updateConnection(next)
    }).catch(() => {
      if (version === initialVersion) updateConnection(null)
    })
    return () => {
      disposed = true
      version++
      unsubscribe()
      updateConnectionRef.current = null
      setBackendConnection(null)
    }
  }, [bridge])

  const retry = async () => {
    setError('')
    try {
      const next = await bridge.retryBackend()
      if (next) await updateConnectionRef.current?.(next)
      else setError('StackMate yerel servisi başlatılamadı.')
    } catch {
      setError('StackMate yerel servisi başlatılamadı.')
    }
  }

  return (
    <>
      {started && (
        <div className="desktop-workbench" inert={!connection || Boolean(error)}>
          <App connection={connection} activeProjectPathRef={activeProject} />
        </div>
      )}
      {(!connection || error) && (
        <section className="desktop-connection" aria-live="polite">
          <h1>StackMate</h1>
          <p>{error || 'Yerel servis başlatılıyor…'}</p>
          {error && connection && (
            <button type="button" onClick={() => setError('')}>Çalışma alanına dön</button>
          )}
          {error && !connection && bridge && <button type="button" onClick={retry}>Yeniden dene</button>}
        </section>
      )}
    </>
  )
}
