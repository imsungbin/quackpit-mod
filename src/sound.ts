// The duck's optional quack (off by default): synthesised here as a short
// WAV, since the mod ships text, SVG and PNG files only. A nasal, falling
// buzz through two formant filters, about a quarter of a second. Pure.

import { base64 } from './cells'

const RATE = 16_000

function biquadBandpass(freq: number, q: number) {
  const w = (2 * Math.PI * freq) / RATE
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  const b0 = alpha / a0
  const b2 = -alpha / a0
  const a1 = (-2 * Math.cos(w)) / a0
  const a2 = (1 - alpha) / a0
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  return (x: number) => {
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }
}

/** A deterministic pseudo-random sequence, so the clip is the same every time. */
function noise(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff - 0.5
  }
}

function samples(): Float32Array {
  const duration = 0.26
  const n = Math.floor(RATE * duration)
  const out = new Float32Array(n)
  const f1 = biquadBandpass(1150, 3.2)
  const f2 = biquadBandpass(2500, 4.5)
  const rand = noise(7)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const time = i / RATE
    const k = time / duration
    const f0 = 560 * (1 - 0.38 * k) + 40 * Math.sin(2 * Math.PI * 9 * time)
    phase = (phase + f0 / RATE) % 1
    const buzz = phase < 0.32 ? 1 : -0.47
    const x = buzz + 0.08 * rand()
    const attack = Math.min(1, time / 0.012)
    const release = k < 0.62 ? 1 : Math.exp(-((k - 0.62) / 0.38) * 4)
    out[i] = (0.35 * x + 1.1 * f1(x) + 0.7 * f2(x)) * attack * release
  }
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  const gain = peak > 0 ? 0.8 / peak : 1
  for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) * gain
  return out
}

let cached: string | undefined

/** The quack as a base64 WAV (16 kHz, 16-bit mono). */
export function quackWav(): string {
  if (cached) return cached
  const pcm = samples()
  const data = pcm.length * 2
  const view = new DataView(new ArrayBuffer(44 + data))
  const ascii = (at: number, text: string) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + data, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, data, true)
  pcm.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true))
  cached = base64(new Uint8Array(view.buffer))
  return cached
}
