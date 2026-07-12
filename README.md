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

1. The **caller** sends the notification `bus.ready` (repeating every ~250 ms
   until answered, in case the host attaches late). The caller is normally an
   extension iframe; in a **reverse-embedding** setup it is the application
   embedding the plotter (see *Embedding hosts* below). A caller may include an
   optional `id` in the `bus.ready` payload — the host adopts it as `context.id`
   when configured to (`adoptCallerId`), otherwise ignores it.
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

`context.kind` is `panel`, `widget`, `background` or `embedding-host`.

### Embedding hosts (reverse embedding)

The roles above are symmetric in the transport: the **host** owns the API
methods/events and the **caller** invokes them. Normally the plotter is the host
and the top-level page, embedding each extension in a child iframe. The bus also
supports the reverse — the plotter runs inside an iframe embedded by another
application (an "embedding host") that drives it as a caller. The plotter stays
the API host but now directs its port at `window.parent`; the embedding host is
the caller and initiates the handshake, and identifies itself with an `id` in
its `bus.ready` payload. Construct the host side with `adoptCallerId: true` so it
uses that id as `context.id` (`kind: 'embedding-host'`); connect the caller with
`connectExtension({ port, id })`. The wire format is otherwise identical.

### Built-in methods

Implemented by `HostConnection` automatically:

| Method | Params | Result |
| --- | --- | --- |
| `events.subscribe` | `{ patterns: string[] }` | `{ subscriptionId }` |
| `events.unsubscribe` | `{ subscriptionId }` | `{}` |

Host API methods (`state.*`, `signalk.*`, `map.*`, `route.*`, `chart.*`, …) are
supplied by the embedding host application; see the plotter extension
specification for the vocabulary. The client exposes typed convenience wrappers
for some of them (`client.state`, `client.signalk`, `client.route`,
`client.chart`); all are equally reachable through the generic
`client.call(method, params)`.

### Route error reasons

A failing `route.*` host method rejects with a JSON-RPC error whose
`error.data.reason` is one of the stable `RouteErrorReason` strings (exported
from the package). Treat `reason` as the contract; the human-readable `message`
may change.

| `reason` | Meaning |
| --- | --- |
| `routes.unknownId` | No visible route has the supplied `routeId`. |
| `routes.badRef` | `route.show(ref)` was given a ref that resolves to no stored route. |
| `routes.badRequest` | Malformed params — e.g. fewer than two points, a non-numeric `position`, or non-string name/description metadata. |
| `routes.saveFailed` | The host attempted to persist the route but the server rejected the write. Distinct from `saveCancelled`. |
| `routes.deleteFailed` | The host attempted to delete the stored route but the server rejected the request. |
| `routes.saveCancelled` | The user dismissed the host's save dialog without saving. |
| `routes.notSupported` | The host does not implement this route operation. |

### Chart error reasons

A failing `chart.*` host method rejects with a JSON-RPC error whose
`error.data.reason` is one of the stable `ChartErrorReason` strings (exported
from the package).

| `reason` | Meaning |
| --- | --- |
| `charts.unknownId` | No managed chart has one of the supplied ids. |
| `charts.badRequest` | Malformed params — e.g. a missing `ids` array, a non-boolean `visible`, or an out-of-range `opacity`. |
| `charts.notSupported` | The host does not implement this chart operation. |

### Night-mode error reasons

A failing `nightMode.*` host method rejects with a JSON-RPC error whose
`error.data.reason` is one of the stable `NightModeErrorReason` strings.

| `reason` | Meaning |
| --- | --- |
| `nightMode.badRequest` | Malformed params — e.g. a non-boolean `enabled`/`auto`, or neither field present. |
| `nightMode.notSupported` | The host does not implement night mode. |

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

// Visible routes (capability `routes`)
if (client.hasCapability('routes')) {
  // A route needs at least two points (one segment).
  const { routeId } = await client.route.create({
    name: 'Plan A',
    points: [{ position: [-80.1, 25.7] }, { position: [-80.2, 25.8] }]
  })
  await client.subscribe(['route.**'], async (name) => {
    if (name === 'route.dirty') reseed(await client.route.get(routeId))
  })
  console.log(await client.route.list())
}

// Chart layers (capability `charts`) — a lightweight facade over the charts
// the host already manages. No creating or deleting; only show/hide, opacity
// and stacking order.
if (client.hasCapability('charts')) {
  const charts = await client.chart.list() // in display order, topmost first
  // Turn one or more charts on/off in a single batch call.
  await client.chart.setVisibility([charts[0].id], true)
  // Follow changes from any origin (including the host's own chart controls).
  await client.subscribe(['chart.**'], async () => {
    render(await client.chart.list())
  })
}

// Night mode (capability `nightMode`) — match the host's night-vision display.
if (client.hasCapability('nightMode')) {
  const { enabled } = await client.nightMode.get()
  applyTheme(enabled ? 'night' : 'day')
  // Follow changes from any origin (an extension's set, the host's own toggle,
  // or the server's environment.mode flipping while `auto` is on).
  await client.subscribe(['nightMode.changed'], (_name, { enabled }) => {
    applyTheme(enabled ? 'night' : 'day')
  })
  // Force on / force off / follow the server:
  // await client.nightMode.set({ enabled: true })   // force on (auto -> false)
  // await client.nightMode.set({ auto: true })       // follow environment.mode
}
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
