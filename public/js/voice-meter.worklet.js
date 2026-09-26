/*
 * Уровень микрофона и шумовой порог считаются в звуковом потоке браузера, а не по таймеру
 * страницы: таймеры фоновой вкладки браузер замедляет до раза в секунду, и порог открывался бы
 * рывками — у слушателей вместо речи были бы обрывки. Здесь каждые 128 отсчётов (≈3 мс).
 */
const WINDOW_BLOCKS = 4; // уровень — по последним ≈10 мс, как у прежнего индикатора
const REPORT_EVERY = 0.05; // секунд между сообщениями для шкалы уровня

class VoiceMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = 0.1;
    this.hold = 0.6;
    this.sums = new Float64Array(WINDOW_BLOCKS);
    this.counts = new Uint32Array(WINDOW_BLOCKS);
    this.slot = 0;
    this.lastLoud = -Infinity;
    this.open = false;
    this.peak = 0;
    this.nextReport = 0;
    this.port.onmessage = ({ data }) => {
      if (Number.isFinite(data?.threshold)) this.threshold = data.threshold;
      if (Number.isFinite(data?.hold)) this.hold = data.hold;
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    let sum = 0;
    if (channel) for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    this.sums[this.slot] = sum;
    this.counts[this.slot] = channel?.length ?? 0;
    this.slot = (this.slot + 1) % WINDOW_BLOCKS;

    let total = 0;
    let count = 0;
    for (let i = 0; i < WINDOW_BLOCKS; i++) {
      total += this.sums[i];
      count += this.counts[i];
    }
    const level = count ? Math.min(1, Math.sqrt(total / count) * 4) : 0;
    this.peak = Math.max(this.peak, level);

    // currentTime — время звукового потока, оно не замедляется в фоне
    if (level >= this.threshold) this.lastLoud = currentTime;
    const open = currentTime - this.lastLoud < this.hold;
    // Открытие порога сообщаем сразу, чтобы не срезать начало слова; уровень для шкалы — пореже
    if (open !== this.open || currentTime >= this.nextReport) {
      this.open = open;
      this.port.postMessage({ level: this.peak, open });
      this.peak = 0;
      this.nextReport = currentTime + REPORT_EVERY;
    }
    return true;
  }
}

registerProcessor('voice-meter', VoiceMeter);
