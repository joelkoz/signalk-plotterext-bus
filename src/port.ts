/**
 * Transport abstraction. The bus runs over anything that can post and
 * receive structured-cloneable data: window.postMessage between a host page
 * and an iframe, a MessageChannel port, or a test double.
 */
export interface BusPort {
  post(data: unknown): void
  /** Register a receive handler; returns an unlisten function. */
  listen(handler: (data: unknown) => void): () => void
}

export interface WindowPortOptions {
  /**
   * targetOrigin for outgoing postMessage and required origin of incoming
   * messages. Defaults to the listening window's own origin (the baseline
   * deployment is same-origin). Pass '*' to disable origin checks.
   */
  origin?: string
  /** Window whose 'message' events are listened to. Defaults to globalThis. */
  listenWindow?: Window
}

/**
 * A port over window.postMessage to a peer window. On the host side the peer
 * is an iframe's contentWindow; on the extension side it is window.parent.
 * Only messages whose source is the peer (and whose origin matches) are
 * delivered.
 */
export function windowPort(peer: Window, opts: WindowPortOptions = {}): BusPort {
  const listenWindow =
    opts.listenWindow ?? (globalThis as unknown as Window)
  const origin = opts.origin ?? listenWindow.location?.origin ?? '*'
  return {
    post(data) {
      peer.postMessage(data, origin)
    },
    listen(handler) {
      const fn = (ev: MessageEvent) => {
        if (ev.source !== peer) return
        if (origin !== '*' && ev.origin !== origin) return
        handler(ev.data)
      }
      listenWindow.addEventListener('message', fn as EventListener)
      return () =>
        listenWindow.removeEventListener('message', fn as EventListener)
    }
  }
}

interface MessagePortLike {
  postMessage(data: unknown): void
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void
  removeEventListener(
    type: 'message',
    fn: (ev: { data: unknown }) => void
  ): void
  start?(): void
}

/** A port over a MessageChannel/MessagePort (browser or Node). */
export function messagePort(port: MessagePortLike): BusPort {
  return {
    post(data) {
      port.postMessage(data)
    },
    listen(handler) {
      const fn = (ev: { data: unknown }) => handler(ev.data)
      port.addEventListener('message', fn)
      port.start?.()
      return () => port.removeEventListener('message', fn)
    }
  }
}
