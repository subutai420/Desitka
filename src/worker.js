import { DurableObject } from "cloudflare:workers";
import { CARDS } from "./cards.js";

const ROOM_TTL_MS = 48 * 60 * 60 * 1000; // místnost se smaže 48 h po poslední aktivitě

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([A-Z]{4})$/);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get("s")) || null;
    });
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "join") return this.join(ws, msg);

    const att = ws.deserializeAttachment();
    const pid = att && att.pid;
    if (!pid || !this.s) return;
    const s = this.s;
    const host = this.isHost(pid);

    switch (msg.type) {
      case "config":
        if (!host || s.phase !== "lobby") return;
        if ([10, 15, 20].includes(msg.target)) s.target = msg.target;
        if (typeof msg.drinks === "boolean") s.drinks = msg.drinks;
        break;
      case "start":
        if (!host || !s.players.length) return;
        if (s.phase === "playing" || s.phase === "roundEnd") return;
        this.startGame();
        break;
      case "answer": this.answer(pid, msg.i, msg.choice); break;
      case "pass": this.pass(pid, pid); break;
      case "skip":
        if (!host || s.phase !== "playing") return;
        this.pass(s.round.turn, pid);
        break;
      case "next":
        if (!host || s.phase !== "roundEnd") return;
        this.newRound((s.round.starter + 1) % s.order.length);
        break;
      case "lobby":
        if (!host || s.phase !== "over") return;
        s.phase = "lobby"; s.round = null; s.order = null; s.scores = null; s.roundNo = 0;
        break;
      case "leave":
        if (s.phase === "lobby") s.players = s.players.filter((p) => p.id !== pid);
        if (s.hostId === pid && s.players.length) s.hostId = s.players[0].id;
        ws.serializeAttachment(null);
        break;
      default: return;
    }
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws) { this.broadcast(ws); }
  async webSocketError(ws) { this.broadcast(ws); }

  async alarm() {
    await this.ctx.storage.deleteAll();
    this.s = null;
  }

  /* ---------- helpers ---------- */
  online(exclude) {
    const set = new Set();
    for (const w of this.ctx.getWebSockets()) {
      if (w === exclude || w.readyState !== WebSocket.OPEN) continue;
      const a = w.deserializeAttachment();
      if (a && a.pid) set.add(a.pid);
    }
    return set;
  }

  // Hostitel může akce dělat vždy; když je offline, převezme je kdokoli z hráčů.
  isHost(pid) {
    return this.s.hostId === pid || !this.online().has(this.s.hostId);
  }

  async save() {
    await this.ctx.storage.put("s", this.s);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  async join(ws, msg) {
    const pid = String(msg.pid || "").slice(0, 24);
    const name = String(msg.name || "").trim().slice(0, 20);
    if (!/^[a-z0-9]{4,24}$/i.test(pid) || !name) return this.send(ws, { type: "error", code: "bad", msg: "Chybí jméno." });
    if (!this.s) {
      if (!msg.create) return this.send(ws, { type: "error", code: "noroom", msg: "Místnost s tímto kódem neexistuje." });
      this.s = { hostId: pid, phase: "lobby", target: 15, drinks: false, players: [], roundNo: 0, used: [], order: null, scores: null, round: null };
    }
    const s = this.s;
    const p = s.players.find((x) => x.id === pid);
    if (p) p.name = name;
    else {
      if (s.players.length >= 12) return this.send(ws, { type: "error", code: "full", msg: "Místnost je plná (max. 12 hráčů)." });
      s.players.push({ id: pid, name, joinedAt: Date.now() });
    }
    if (s.names && s.names[pid]) s.names[pid] = name;
    ws.serializeAttachment({ pid });
    await this.save();
    this.broadcast();
  }

  startGame() {
    const s = this.s;
    s.order = s.players.map((p) => p.id);
    s.names = Object.fromEntries(s.players.map((p) => [p.id, p.name]));
    s.scores = Object.fromEntries(s.order.map((p) => [p, 0]));
    s.roundNo = 0;
    this.newRound(0);
  }

  newRound(starter) {
    const s = this.s;
    let used = s.used || [];
    if (used.length >= CARDS.length) used = [];
    const free = CARDS.map((_, i) => i).filter((i) => !used.includes(i));
    const card = free[Math.floor(Math.random() * free.length)];
    s.used = [...used, card];
    const status = {}, pot = {};
    s.order.forEach((p) => { status[p] = "in"; pot[p] = 0; });
    s.round = { card, taken: Array(10).fill(null), status, pot, turn: s.order[starter], starter, last: null };
    s.roundNo += 1;
    s.phase = "playing";
  }

  answer(pid, i, choice) {
    const s = this.s, r = s.round;
    if (s.phase !== "playing" || r.turn !== pid) return;
    if (!Number.isInteger(i) || i < 0 || i > 9 || r.taken[i]) return;
    const card = CARDS[r.card];
    if (!card.o.includes(choice)) return;
    const ok = card.i[i][1] === choice;
    r.taken[i] = { by: pid, ok, choice };
    if (ok) r.pot[pid] += 1;
    else { r.pot[pid] = 0; r.status[pid] = "out"; }
    r.last = { kind: "answer", pid, i, choice, ok, t: Date.now() };
    this.advance();
  }

  pass(pid, actor) {
    const s = this.s, r = s.round;
    if (s.phase !== "playing" || r.turn !== pid || r.status[pid] !== "in") return;
    r.status[pid] = "passed";
    r.last = { kind: pid === actor ? "pass" : "skip", pid, pot: r.pot[pid], t: Date.now() };
    this.advance();
  }

  advance() {
    const s = this.s, r = s.round;
    const allTaken = r.taken.every(Boolean);
    const active = s.order.filter((p) => r.status[p] === "in");
    if (allTaken || !active.length) {
      s.order.forEach((p) => { s.scores[p] += r.pot[p] || 0; });
      const max = Math.max(...s.order.map((p) => s.scores[p]));
      s.phase = max >= s.target ? "over" : "roundEnd";
      r.turn = null;
      return;
    }
    const idx = s.order.indexOf(r.turn);
    for (let k = 1; k <= s.order.length; k++) {
      const p = s.order[(idx + k) % s.order.length];
      if (r.status[p] === "in") { r.turn = p; break; }
    }
  }

  // Veřejný pohled: správné odpovědi jen u odehraných položek nebo po konci kola.
  view(online) {
    const s = this.s;
    const v = {
      phase: s.phase, hostId: s.hostId, target: s.target, drinks: s.drinks, roundNo: s.roundNo,
      players: s.players.map((p) => ({ id: p.id, name: p.name, online: online.has(p.id) })),
      order: s.order, names: s.names || {}, scores: s.scores, round: null,
    };
    if (s.round && s.phase !== "lobby") {
      const r = s.round, card = CARDS[r.card], reveal = s.phase !== "playing";
      v.round = {
        turn: r.turn, status: r.status, pot: r.pot, starter: r.starter,
        card: { q: card.q, o: card.o, items: card.i.map((x) => x[0]) },
        taken: r.taken.map((t, i) => (t ? { ...t, ans: card.i[i][1] } : null)),
        answers: reveal ? card.i.map((x) => x[1]) : null,
        last: r.last ? { ...r.last, ...(r.last.kind === "answer" ? { ans: card.i[r.last.i][1], item: card.i[r.last.i][0] } : {}) } : null,
      };
    }
    return v;
  }

  broadcast(exclude) {
    if (!this.s) return;
    const online = this.online(exclude);
    const data = JSON.stringify({ type: "state", state: this.view(online) });
    for (const w of this.ctx.getWebSockets()) {
      if (w === exclude) continue;
      const a = w.deserializeAttachment();
      if (!a || !a.pid) continue;
      try { w.send(data); } catch {}
    }
  }
}
