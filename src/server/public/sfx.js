/**
 * 金手指风格音效 —— 纯 Web Audio 合成（零依赖，无音频文件）。
 * 电子哔声：发送 / 工具调用 / 完成 / 错误 / 审批提示。
 * 开关状态存 localStorage（xuanji.sfx），默认开启。
 */
(() => {
  let ctx = null;
  let enabled = localStorage.getItem('xuanji.sfx') !== 'off';

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  function tone(freq, delay, dur, type = 'square', vol = 0.03) {
    if (!enabled) return;
    const c = ac();
    if (!c) return;
    try {
      const t0 = c.currentTime + delay;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(c.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    } catch {
      /* 音频不可用则静默 */
    }
  }

  window.sfx = {
    get enabled() {
      return enabled;
    },
    setEnabled(v) {
      enabled = v;
      localStorage.setItem('xuanji.sfx', v ? 'on' : 'off');
    },
    /** 发送消息：双短升音 */
    send() {
      tone(660, 0, 0.06, 'square', 0.03);
      tone(990, 0.07, 0.09, 'square', 0.03);
    },
    /** 工具调用：单哔 */
    tool() {
      tone(520, 0, 0.07, 'square', 0.03);
    },
    /** 工具成功：轻嘀 */
    toolOk() {
      tone(780, 0, 0.06, 'square', 0.022);
    },
    /** 运行完成：三连升音 */
    done() {
      tone(523, 0, 0.09, 'square', 0.03);
      tone(784, 0.1, 0.09, 'square', 0.03);
      tone(1046, 0.2, 0.16, 'square', 0.03);
    },
    /** 出错：低鸣 */
    error() {
      tone(220, 0, 0.18, 'sawtooth', 0.035);
      tone(150, 0.18, 0.24, 'sawtooth', 0.035);
    },
    /** 审批弹窗：双正弦提示 */
    approval() {
      tone(880, 0, 0.08, 'sine', 0.04);
      tone(880, 0.13, 0.08, 'sine', 0.04);
    },
  };
})();
