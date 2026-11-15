let currentConnection = null;

export function setBackendConnection(connection) {
  currentConnection = connection;
}

function getConnection() {
  if (!currentConnection) throw new Error('Yerel servise ulaşılamadı.');
  return currentConnection;
}

function backendUrl(path, baseUrl) {
  const base = new URL(baseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.username || url.password) {
    throw new Error('Geçersiz yerel servis adresi.');
  }
  return url;
}

export async function apiFetch(path, options, connection = getConnection()) {
  const { baseUrl, token } = connection;
  const headers = new Headers(options?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(backendUrl(path, baseUrl), { ...options, headers });
}

export function streamUrl(path, params, websocket = false) {
  const { baseUrl, token } = getConnection();
  const url = backendUrl(path, baseUrl);
  if (websocket) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [name, value] of Object.entries(params ?? {})) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set('token', token);
  return url;
}
