/**
 * Оценка разницы между часами клиента и сервера (упрощённый NTP).
 * Из нескольких замеров берём тот, у которого минимальная задержка: он точнее всего.
 */
export class Clock {
  constructor(socket) {
    this.socket = socket;
    this.offset = 0;
    this.rtt = 0;
  }

  now() {
    return Date.now() + this.offset;
  }

  async sync(samples = 5) {
    let best = null;
    for (let i = 0; i < samples; i++) {
      const sent = Date.now();
      let serverTime;
      try {
        serverTime = await this.socket.timeout(3000).emitWithAck('time:ping');
      } catch {
        continue;
      }
      const rtt = Date.now() - sent;
      if (!best || rtt < best.rtt) best = { rtt, offset: serverTime - (sent + rtt / 2) };
    }
    if (best) {
      this.offset = best.offset;
      this.rtt = best.rtt;
    }
    return best;
  }
}
