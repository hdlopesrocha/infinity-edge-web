// Game-channel transport: the framed binary protocol rides on either a
// WebSocket (the C++ server) or an RTCDataChannel (the browser host), so
// NetGame only ever sees send/onmessage/onclose.

export interface GameTransport {
  /** Queue a frame; silently dropped when the link is not open. */
  send(frame: Uint8Array): void;
  close(): void;
  readonly open: boolean;
  onopen: (() => void) | null;
  onmessage: ((data: ArrayBuffer | Uint8Array) => void) | null;
  onclose: (() => void) | null;
}

/** Wraps a WebSocket (arraybuffer mode). */
export function webSocketTransport(ws: WebSocket): GameTransport {
  const t: GameTransport = {
    send: (frame) => {
      if (ws.readyState !== 1) return;
      try { ws.send(frame); } catch { /* closing */ }
    },
    close: () => {
      try { ws.close(); } catch { /* already closed */ }
    },
    get open() { return ws.readyState === 1; },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.binaryType = 'arraybuffer';
  if (ws.readyState === 1) queueMicrotask(() => t.onopen?.());
  ws.onopen = () => t.onopen?.();
  ws.onmessage = (ev) => t.onmessage?.(ev.data as ArrayBuffer);
  ws.onclose = () => t.onclose?.();
  return t;
}

/**
 * Wraps an RTCDataChannel. `negotiated` channels start open; both cases are
 * handled. Binary data arrives as ArrayBuffer (binaryType is set here).
 */
export function rtcTransport(channel: RTCDataChannel): GameTransport {
  channel.binaryType = 'arraybuffer';
  const t: GameTransport = {
    send: (frame) => {
      if (channel.readyState !== 'open') return;
      try { channel.send(frame as unknown as ArrayBuffer); } catch { /* closing */ }
    },
    close: () => {
      try { channel.close(); } catch { /* already closed */ }
    },
    get open() { return channel.readyState === 'open'; },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  if (channel.readyState === 'open') queueMicrotask(() => t.onopen?.());
  channel.onopen = () => t.onopen?.();
  channel.onmessage = (ev: MessageEvent) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) t.onmessage?.(data as ArrayBuffer);
  };
  channel.onclose = () => t.onclose?.();
  channel.onerror = () => t.onclose?.();
  return t;
}
