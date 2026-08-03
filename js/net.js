// Online play — a thin wrapper around the vendored PeerJS global (`Peer`).
// One game = one host peer whose ID is derived from a short room code, and a
// single reliable WebRTC data connection carrying JSON messages. The PeerJS
// cloud only brokers the handshake; moves and chat travel peer-to-peer.

const PREFIX = 'kronspiel-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L look-alikes

export function makeCode(len = 4) {
  const rand = new Uint32Array(len);
  crypto.getRandomValues(rand);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[rand[i] % ALPHABET.length];
  return s;
}

export const normalizeCode = (text) => String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class Net {
  // handlers: { onHostReady(code), onConnect(), onMessage(msg), onClose(), onError(kind) }
  constructor(handlers) {
    this.h = handlers;
    this.peer = null;
    this.conn = null;
    this.role = null;
    this.code = null;
    this.closed = false;
  }

  host(code) {
    this.role = 'host';
    this.code = code;
    this.peer = new Peer(PREFIX + code);
    this.peer.on('open', () => { if (!this.closed) this.h.onHostReady(code); });
    this.peer.on('connection', (conn) => {
      if (this.closed) { conn.close(); return; }
      if (this.conn && this.conn.open) { conn.close(); return; } // the table is full
      this._wire(conn);
    });
    this.peer.on('error', (e) => this._error(e));
  }

  join(code) {
    this.role = 'guest';
    this.code = code;
    this.peer = new Peer();
    this.peer.on('open', () => {
      if (!this.closed) this._wire(this.peer.connect(PREFIX + code, { reliable: true }));
    });
    this.peer.on('error', (e) => this._error(e));
  }

  _wire(conn) {
    this.conn = conn;
    conn.on('open', () => { if (!this.closed) this.h.onConnect(); });
    conn.on('data', (d) => { if (!this.closed && d && typeof d === 'object') this.h.onMessage(d); });
    conn.on('close', () => { if (!this.closed) this.h.onClose(); });
    conn.on('error', () => { if (!this.closed) this.h.onClose(); });
  }

  _error(e) {
    if (!this.closed) this.h.onError(e && e.type ? e.type : 'unknown');
  }

  get connected() { return !!(this.conn && this.conn.open); }

  send(msg) {
    if (this.connected) {
      try { this.conn.send(msg); } catch { /* connection died mid-send; close event follows */ }
    }
  }

  destroy() {
    this.closed = true;
    try { this.peer?.destroy(); } catch { /* already gone */ }
    this.peer = null;
    this.conn = null;
  }
}
