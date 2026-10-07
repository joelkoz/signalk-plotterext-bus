import { PublishParams, PublishScope, RPC_ERRORS, RpcError } from './protocol'

const SCOPES: readonly PublishScope[] = ['all', 'extension']

function badRequest(message: string): RpcError {
  return new RpcError(message, {
    code: RPC_ERRORS.INVALID_PARAMS,
    reason: 'events.badRequest'
  })
}

/**
 * Validate `events.publish` params (or a `publish` button action's fields) and
 * apply the default scope. Throws an `events.badRequest` RpcError for a missing
 * or empty topic, a topic containing `*` or in the `bus.*` namespace, or an
 * unknown scope. Routing the event to contexts is the host's job; this only
 * enforces the wire rules so every host rejects the same inputs.
 */
export function parsePublishParams(
  params: unknown
): Required<Pick<PublishParams, 'topic' | 'scope'>> & { params?: unknown } {
  const p = (params ?? {}) as Partial<PublishParams>
  const { topic, scope = 'all' } = p
  if (typeof topic !== 'string' || topic.length === 0) {
    throw badRequest('events.publish requires a non-empty topic')
  }
  if (topic.includes('*')) {
    throw badRequest('events.publish topic must not contain "*"')
  }
  if (topic === 'bus' || topic.startsWith('bus.')) {
    throw badRequest('events.publish topic must not be in the bus.* namespace')
  }
  if (!SCOPES.includes(scope)) {
    throw badRequest(`events.publish scope must be one of: ${SCOPES.join(', ')}`)
  }
  return 'params' in p ? { topic, scope, params: p.params } : { topic, scope }
}
