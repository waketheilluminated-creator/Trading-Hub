import assert from "node:assert/strict";
import test from "node:test";
import { MOBILE_ALERT_VIBRATE, alarmWavDataUri, createMobileAlertSound } from "../lib/mobile-alert-sound.ts";

function fakeHost() {
  const osc = [];
  const audios = [];
  const vibrates = [];
  const host = {
    vibrate(pattern) {
      vibrates.push(pattern);
      return true;
    },
    createAudio() {
      const audio = { src: "", currentTime: 0, played: 0, play: async () => { audio.played += 1; } };
      audios.push(audio);
      return audio;
    },
    AudioContext: class {
      constructor() { this.state = "suspended"; this.currentTime = 0; }
      resume() { this.state = "running"; return Promise.resolve(); }
      createOscillator() {
        const node = {
          frequency: { setValueAtTime() {} },
          connect() {},
          start() { osc.push(node); },
          stop() {},
        };
        return node;
      }
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
      }
      get destination() { return {}; }
    },
  };
  return { host, osc, audios, vibrates };
}

test("alarm wav is a real RIFF payload and vibrate pattern is the mobile cadence", () => {
  assert.deepEqual(MOBILE_ALERT_VIBRATE, [200, 100, 200]);
  const uri = alarmWavDataUri();
  assert.match(uri, /^data:audio\/wav;base64,/);
  const bytes = Buffer.from(uri.slice("data:audio/wav;base64,".length), "base64");
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
  assert.ok(bytes.length > 100);
});

test("chime stays silent until a user gesture unlocks iOS audio, then plays web audio, wav, and vibrate", async () => {
  const { host, osc, audios, vibrates } = fakeHost();
  const sound = createMobileAlertSound(host);
  assert.equal(sound.unlocked, false);
  assert.equal(await sound.play(), false);
  assert.equal(osc.length, 0);
  assert.equal(audios.length, 0);
  assert.equal(await sound.unlock(), true);
  assert.equal(sound.unlocked, true);
  assert.equal(await sound.play(), true);
  assert.ok(osc.length >= 2);
  assert.equal(audios.length, 1);
  assert.match(audios[0].src, /^data:audio\/wav;base64,/);
  assert.equal(audios[0].played, 1);
  assert.deepEqual(vibrates[0], [200, 100, 200]);
});
