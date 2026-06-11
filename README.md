# signalk-plotterext-bus

Reference implementation of the **Signal K plotter extension bus** — the
message protocol between a chartplotter host application (e.g. Freeboard-SK)
and extension iframes (panels, widgets, background runtimes) provided by
Signal K server plugins via the `plotterExtensions` resource type.

The **documented wire format below is the contract**; this package is a
convenience. Any conforming implementation interoperates.

## Install

```sh
npm install signalk-plotterext-bus
```

- Extensions import `signalk-plotterext-bus/extension`.
- Hosts import `signalk-plotterext-bus/host`.

## Wire Format

Every message is a JSON-RPC 2.0 object inside a routing envelope, sent with
`postMessage` (window-to-iframe or `MessageChannel`):

```json
{ "bus": "plotterExt/1", "msg": { "jsonrpc": "2.0", "...": "..." } }
```

The `bus` field identifies protocol and major version so frames can ignore
unrelated `postMessage` traffic.

### Calls

A call is a JSON-RPC request with a fresh per-call correlation `id` (never
correlate by method name — concurrent calls to the same method must not
collide):

```json
{ "jsonrpc": "2.0", "id": "ab12-1", "method": "state.get", "params": { "keys": ["path"] } }
```

Exactly one response per request, `result` and `error` mutually exclusive:

```json
{ "jsonrpc": "2.0", "id": "ab12-1", "result": { "values": { "path": "navigation.speedOverGround" } } }
{ "jsonrpc": "2.0", "id": "ab12-1", "error": { "code": -32602, "message": "…", "data": { "reason": "INVALID_PARAMS" } } }
```

Protocol errors use the JSON-RPC reserved codes (`-32601` method not found,
`-32602` invalid params, `-32603` internal). Host API errors use
implementation-defined codes (this package defaults to `-32000`) and put a
stable string identifier in `error.data.reason`. Callers apply timeouts and
discard the pending-call entry when one fires.

### Events

An event is a JSON-RPC *notification* (no `id`); its `method` is a
hierarchical dot-separated event name:

```json
{ "jsonrpc": "2.0", "method": "sk.navigation.speedOverGround", "params": { "path": "navigation.speedOverGround", "value": 3.6 } }
```

`postMessage` is point-to-point, so hosts only forward events a context has
subscribed to via `events.subscribe` / `events.unsubscribe`. Subscription
patterns use eventemitter2-style wildcards: `*` matches exactly one segment,
`**` matches zero or more segments (`map.*`, `sk.navigation.**`).

### Connection establishment

1. The extension sends the notification `bus.ready` (repeating every ~250 ms
   until answered, in case the host attaches late).
2. The host replies with the notification `bus.handshake`:

```json
{
  "jsonrpc": "2.0",
  "method": "bus.handshake",
  "params": {
    "host": "freeboard-sk",
    "hostVersion": "2.14.0",
    "apiVersion": "1",
    "capabilities": ["widgets", "panels.iframe", "signalk.stream"],
    "context": { "kind": "widget", "id": "gauge", "instanceId": "…", "targetInstance": null }
  }
}
```

### Built-in methods

Implemented by `HostConnection` automatically:

| Method | Params | Result |
| --- | --- | --- |
| `events.subscribe` | `{ patterns: string[] }` | `{ subscriptionId }` |
| `events.unsubscribe` | `{ subscriptionId }` | `{}` |

Host API methods (`state.*`, `signalk.*`, `map.*`, …) are supplied by the
embedding host application; see the plotter extension specification for the
vocabulary.

## Usage — extension side

```js
import { connectExtension } from 'signalk-plotterext-bus/extension'

const client = await connectExtension()
console.log(client.context)           // { kind: 'widget', id: 'gauge', instanceId: '…' }

// Per-instance configuration
const { path } = await client.state.get(['path'])

// Live Signal K data, relayed by the host
const stop = await client.signalk.subscribe([path], (ev) => {
  render(ev.value)
})

// React to configuration changes made by the config panel
await client.subscribe(['state.changed'], async () => {
  const values = await client.state.get()
  reconfigure(values)
})
```

## Usage — host side

```js
import { HostConnection, windowPort } from 'signalk-plotterext-bus/host'

const conn = new HostConnection({
  port: windowPort(iframe.contentWindow),
  hostInfo: {
    host: 'my-plotter',
    hostVersion: '1.0.0',
    apiVersion: '1',
    capabilities: ['widgets', 'panels.iframe', 'signalk.stream']
  },
  context: { kind: 'widget', id: 'gauge', instanceId, targetInstance: null },
  methods: {
    'state.get': async ({ keys }) => ({ values: await loadState(instanceId, keys) }),
    'state.set': async ({ values }) => { await saveState(instanceId, values) },
    'signalk.subscribe': ({ paths }) => startRelay(conn, paths),
    'signalk.unsubscribe': ({ subscriptionId }) => stopRelay(subscriptionId)
  },
  onSubscriptionsChanged: (patterns) => updateUpstream(patterns)
})

// Later, from the host's data stream:
conn.publish('sk.navigation.speedOverGround', { path, value, timestamp })
```

Throw `RpcError` from method handlers to return structured errors:

```js
import { RpcError, RPC_ERRORS } from 'signalk-plotterext-bus/host'
throw new RpcError('unknown path', { code: RPC_ERRORS.INVALID_PARAMS, reason: 'UNKNOWN_PATH' })
```

## Conformance testing

The test suite drives a real `HostConnection` against a real
`connectExtension()` over a `MessageChannel` pair with no DOM. A host
implementing its own endpoint can reuse the same harness shape to verify
conformance.

```sh
npm test
```

## License

MIT
