/**
 * iOS Safari / PWA alert chime.
 * Audio stays locked until unlock() runs inside a user gesture. play() then starts a
 * multi-tone Web Audio alarm, an embedded WAV <audio> fallback, and vibrate(200, 100, 200).
 */

export const MOBILE_ALERT_VIBRATE = [200, 100, 200] as const;

type GainNodeLike = {
  gain: { setValueAtTime(value: number, time: number): void; exponentialRampToValueAtTime(value: number, time: number): void };
  connect(dest: unknown): void;
};
type OscillatorLike = {
  frequency: { setValueAtTime(value: number, time: number): void };
  connect(dest: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
};
type AudioContextLike = {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainNodeLike;
};
type AudioElementLike = { src: string; currentTime: number; play(): Promise<void> };

export type MobileAlertSoundHost = {
  vibrate?: (pattern: number[]) => boolean;
  createAudio?: () => AudioElementLike;
  AudioContext?: new () => AudioContextLike;
};

const TONES = [880, 1174, 1568];

let wavUri: string | null = null;

function buildWavBytes(): Uint8Array {
  const sampleRate = 8000;
  const count = Math.floor(sampleRate * 0.45);
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, count * 2, true);
  for (let index = 0; index < count; index += 1) {
    const time = index / sampleRate;
    const envelope = Math.min(1, index / 80) * (1 - index / count);
    const sample = Math.sin(2 * Math.PI * 880 * time) * 0.55 + Math.sin(2 * Math.PI * 1320 * time) * 0.35;
    const clamped = Math.max(-1, Math.min(1, sample * envelope));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

export function alarmWavDataUri(): string {
  if (wavUri) return wavUri;
  const bytes = buildWavBytes();
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  wavUri = `data:audio/wav;base64,${base64}`;
  return wavUri;
}

function browserHost(): MobileAlertSoundHost {
  if (typeof window === "undefined") return {};
  const audioWindow = window as Window & { webkitAudioContext?: new () => AudioContextLike };
  const Context = window.AudioContext ?? audioWindow.webkitAudioContext;
  return {
    vibrate: typeof navigator !== "undefined" && typeof navigator.vibrate === "function"
      ? (pattern) => navigator.vibrate(pattern)
      : undefined,
    createAudio: typeof Audio === "undefined" ? undefined : () => new Audio(),
    AudioContext: Context,
  };
}

export function createMobileAlertSound(host: MobileAlertSoundHost = browserHost()) {
  let unlocked = false;
  let context: AudioContextLike | null = null;
  let audio: AudioElementLike | null = null;

  async function unlock(): Promise<boolean> {
    if (host.AudioContext) {
      context = context ?? new host.AudioContext();
      if (context.state === "suspended") await context.resume();
    }
    unlocked = true;
    return true;
  }

  function chime(): void {
    if (!context) return;
    const start = context.currentTime;
    TONES.forEach((frequency, index) => {
      const osc = context!.createOscillator();
      const gain = context!.createGain();
      const at = start + index * 0.16;
      osc.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(gain);
      gain.connect(context!.destination);
      osc.start(at);
      osc.stop(at + 0.2);
    });
  }

  async function play(): Promise<boolean> {
    if (!unlocked) return false;
    chime();
    if (!audio && host.createAudio) audio = host.createAudio();
    if (audio) {
      audio.src = alarmWavDataUri();
      audio.currentTime = 0;
      await audio.play();
    }
    host.vibrate?.([...MOBILE_ALERT_VIBRATE]);
    return true;
  }

  return {
    get unlocked() { return unlocked; },
    unlock,
    play,
  };
}

export type MobileAlertSound = ReturnType<typeof createMobileAlertSound>;
