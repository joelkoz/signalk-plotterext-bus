# Agent Instructions

Before changing or debugging this repository, read:

1. `README.md` — the **wire format documentation**. This is the protocol
   contract. The package is only the reference implementation; any conforming
   implementation must be able to interoperate using nothing but the README.
2. `REQUIREMENTS.md` — the authoritative implementation spec: protocol rules,
   API surface, invariants, and test plan.

## What this package is

`signalk-plotterext-bus` implements the message bus between a Signal K
chartplotter host application (for example Freeboard-SK) and extension
iframes (panels, widgets, background runtimes) contributed by Signal K
server plugins through the `plotterExtensions` resource type. The broader
extension mechanism (manifests, widgets, capability negotiation) is defined
by the Signal K plotter extension specification, proposed to the
`SignalK/signalk-server` project under `docs/develop/rest-api/proposed/`.

Two consumer groups use this package, through separate entry points:

- Host applications import `signalk-plotterext-bus/host`.
- Extensions import `signalk-plotterext-bus/extension`.

## Repository layout

```
src/        TypeScript source. protocol.ts (wire types/constants),
            codec.ts (envelope), wildcard.ts (pattern matching),
            port.ts (transports), endpoint.ts (symmetric RPC/event core),
            host.ts (HostConnection), extension.ts (connectExtension).
test/       vitest suites. integration.test.ts drives a real HostConnection
            against a real connectExtension() over a MessageChannel pair and
            doubles as the protocol conformance harness.
dist/       Build output (tsup; ESM + CJS + .d.ts). Generated — do not
            hand-edit, not committed.
```

## Build / test

```sh
npm install
npm run build     # tsup -> dist/
npm test          # vitest run
```

## Engineering rules

- **The wire format is frozen per bus version.** Changing the shape of
  anything that crosses `postMessage` is a breaking protocol change and
  requires bumping the `bus` identifier (`plotterExt/1` -> `plotterExt/2`),
  not just the npm version. Additive fields are allowed; consumers must
  ignore unknown fields.
- **Zero runtime dependencies.** The package must remain trivially auditable
  and bundleable into extension iframes. Dev dependencies only.
- **Plain JSON on the wire.** No class instances, no functions, nothing that
  fails structured clone or JSON round-trips. Errors cross the wire as
  JSON-RPC error objects, never as serialized exceptions.
- **Correlate responses by per-call nonce, never by method name** —
  concurrent calls to the same method must not collide.
- **Every pending call must be timeout-guarded** and removed from the
  pending table on timeout, response, or endpoint close. No leaks.
- **Framework neutrality.** No DOM framework, no reactive library, no
  TypeScript requirement for consumers. The API must stay usable from plain
  JavaScript.
- Keep `README.md` (wire format) and `REQUIREMENTS.md` in sync with any
  behavior change; the docs are part of the deliverable.

## Testing rules

- The MessageChannel integration suite must keep passing unchanged when the
  internals are refactored — it encodes the observable protocol behavior.
- New protocol behavior needs both a unit test and an integration test
  exercising it across a real endpoint pair.
- Tests run in Node (no DOM). `windowPort` is exercised by API shape only;
  browser behavior is validated in host applications.
