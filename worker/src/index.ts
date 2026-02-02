/**
 * Cloudflare Worker: маршрутизация запросов к Durable Object (API + WebSocket).
 * Фронтенд раздаётся отдельно (Cloudflare Pages).
 */

import { AliasState } from './state-do'

const DO_ID = 'alias-state'

export { AliasState }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'OPTIONS') {
      return corsPreflight(request)
    }

    if (path.startsWith('/api/') || path === '/ws') {
      const id = env.ALIAS_STATE.idFromName(DO_ID)
      const stub = env.ALIAS_STATE.get(id)
      const res = await stub.fetch(request)
      // Ответ 101 с WebSocket нельзя оборачивать — иначе теряется соединение.
      if (res.status === 101) return res
      return addCorsHeaders(res, request)
    }

    return new Response('Not Found', { status: 404 })
  },
}

function corsPreflight(request: Request): Response {
  const origin = request.headers.get('Origin') ?? '*'
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}

function addCorsHeaders(response: Response, request: Request): Response {
  const origin = request.headers.get('Origin') ?? '*'
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', origin)
  return new Response(response.body, { status: response.status, headers })
}

export interface Env {
  ALIAS_STATE: DurableObjectNamespace
}
