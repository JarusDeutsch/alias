/**
 * Тихие приятные звуковые эффекты через Web Audio API (без внешних файлов).
 * Громкость ~12–15%, короткие тоны.
 */

const MASTER_GAIN = 0.22

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  return new Ctx()
}

let audioCtxRef: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (!audioCtxRef) audioCtxRef = getAudioContext()
  return audioCtxRef
}

function playTone(
  frequency: number,
  durationMs: number,
  opts?: { gain?: number; type?: OscillatorType; startOffset?: number }
) {
  const audioCtx = getCtx()
  if (!audioCtx) return

  const run = () => {
    const gain = (opts?.gain ?? 1) * MASTER_GAIN
    const type = opts?.type ?? 'sine'
    const startOffset = opts?.startOffset ?? 0
    const osc = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    osc.connect(g)
    g.connect(audioCtx.destination)
    osc.type = type
    osc.frequency.setValueAtTime(frequency, audioCtx.currentTime + startOffset)
    g.gain.setValueAtTime(0, audioCtx.currentTime + startOffset)
    g.gain.linearRampToValueAtTime(gain, audioCtx.currentTime + startOffset + 0.02)
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + startOffset + durationMs / 1000)
    osc.start(audioCtx.currentTime + startOffset)
    osc.stop(audioCtx.currentTime + startOffset + durationMs / 1000 + 0.05)
  }

  if (audioCtx.state === 'suspended') {
    void audioCtx.resume().then(run)
  } else {
    run()
  }
}

/** Угадал (+1) — короткий приятный восходящий тон */
export function playCorrect() {
  playTone(523.25, 80)
  playTone(659.25, 100, { startOffset: 0.06 })
  playTone(783.99, 120, { startOffset: 0.14 })
}

/** Не знаю (0) — нейтральный мягкий тон */
export function playDontKnow() {
  playTone(440, 100)
  playTone(392, 90, { startOffset: 0.08 })
}

/** Пропуск (-1) — мягкий «шаг вниз» */
export function playSkip() {
  playTone(494, 70)
  playTone(392, 100, { startOffset: 0.05 })
}

/** Победа — короткая радостная фраза */
export function playWin() {
  const f = [523.25, 659.25, 783.99, 1046.5]
  f.forEach((hz, i) => playTone(hz, 130, { startOffset: i * 0.1 }))
}

/** Поражение — тихий спокойный нисходящий тон */
export function playLose() {
  playTone(392, 120)
  playTone(349.23, 140, { startOffset: 0.1 })
  playTone(293.66, 160, { startOffset: 0.22 })
}
