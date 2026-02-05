/**
 * Генерация карточки результата для шеринга в Telegram/Discord.
 * Горизонтальная карточка: слева QR на jarusdev.com, справа — текст и оформление (победа/поражение), конфетти для победителей.
 */

import QRCode from 'qrcode'

const CARD_WIDTH = 1000
const CARD_HEIGHT = 500
const QR_SIZE = 200
const QR_LEFT_PADDING = 48
const QR_TOP_PADDING = (CARD_HEIGHT - QR_SIZE) / 2
const RIGHT_PANEL_LEFT = 280
const SITE_URL = 'https://jarusdev.com'

const CONFETTI_COLORS = [
  [52, 211, 153],   // emerald-400
  [251, 191, 36],   // amber-400
  [248, 113, 113], // rose-400
  [56, 189, 248],  // sky-400
  [167, 139, 250], // violet-400
]

export type ShareCardParams = {
  isWinner: boolean
  teamName: string
  scoreLabel: string // e.g. "15 очков"
  titleWon: string   // e.g. "Мы победили!"
  titleLost: string  // e.g. "Мы проиграли"
  brandText: string  // e.g. "Alias Web"
}

function drawConfetti(ctx: CanvasRenderingContext2D, width: number, height: number, count: number) {
  const left = RIGHT_PANEL_LEFT
  for (let i = 0; i < count; i++) {
    const [r, g, b] = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
    ctx.fillStyle = `rgb(${r},${g},${b})`
    const x = left + Math.random() * (width - left - 40)
    const y = 20 + Math.random() * (height - 80)
    const w = 4 + Math.random() * 8
    const h = 2 + Math.random() * 6
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate((Math.random() - 0.5) * 1.2)
    ctx.fillRect(-w / 2, -h / 2, w, h)
    ctx.restore()
  }
}

export async function drawShareCard(params: ShareCardParams): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = CARD_WIDTH
  canvas.height = CARD_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2d not available')

  const { isWinner, teamName, scoreLabel, titleWon, titleLost, brandText } = params

  // Левая часть — нейтральный тёмный фон под QR
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, 0, RIGHT_PANEL_LEFT, CARD_HEIGHT)
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, RIGHT_PANEL_LEFT - 1, CARD_HEIGHT - 1)

  // QR-код на сайт
  const qrDataUrl = await QRCode.toDataURL(SITE_URL, {
    width: QR_SIZE,
    margin: 0,
    color: { dark: '#0f172a', light: '#ffffff' },
  })
  const qrImg = new Image()
  await new Promise<void>((resolve, reject) => {
    qrImg.onload = () => resolve()
    qrImg.onerror = reject
    qrImg.src = qrDataUrl
  })
  ctx.drawImage(qrImg, QR_LEFT_PADDING, QR_TOP_PADDING, QR_SIZE, QR_SIZE)

  // Подпись под QR
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = '14px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('jarusdev.com', RIGHT_PANEL_LEFT / 2, QR_TOP_PADDING + QR_SIZE + 28)

  // Правая часть — градиент и текст
  const rightGradient = ctx.createLinearGradient(RIGHT_PANEL_LEFT, 0, CARD_WIDTH, CARD_HEIGHT)
  if (isWinner) {
    rightGradient.addColorStop(0, '#064e3b')
    rightGradient.addColorStop(0.4, '#065f46')
    rightGradient.addColorStop(0.7, '#047857')
    rightGradient.addColorStop(1, '#059669')
  } else {
    rightGradient.addColorStop(0, '#1e1b4b')
    rightGradient.addColorStop(0.4, '#312e81')
    rightGradient.addColorStop(0.7, '#3730a3')
    rightGradient.addColorStop(1, '#4338ca')
  }
  ctx.fillStyle = rightGradient
  ctx.fillRect(RIGHT_PANEL_LEFT, 0, CARD_WIDTH - RIGHT_PANEL_LEFT, CARD_HEIGHT)
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.strokeRect(RIGHT_PANEL_LEFT + 0.5, 0.5, CARD_WIDTH - RIGHT_PANEL_LEFT - 1, CARD_HEIGHT - 1)

  // Конфетти только для победителей
  if (isWinner) {
    drawConfetti(ctx, CARD_WIDTH, CARD_HEIGHT, 55)
  }

  // Бренд
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = 'bold 32px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(brandText, RIGHT_PANEL_LEFT + 48, 100)

  // Заголовок победа/поражение
  ctx.fillStyle = isWinner ? '#a7f3d0' : '#c7d2fe'
  ctx.font = 'bold 42px system-ui, sans-serif'
  ctx.fillText(isWinner ? titleWon : titleLost, RIGHT_PANEL_LEFT + 48, 185)

  // Название команды
  ctx.fillStyle = '#ffffff'
  ctx.font = '28px system-ui, sans-serif'
  const teamText = teamName.length > 24 ? teamName.slice(0, 21) + '…' : teamName
  ctx.fillText(teamText, RIGHT_PANEL_LEFT + 48, 260)

  // Счёт
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  ctx.font = '24px system-ui, sans-serif'
  ctx.fillText(scoreLabel, RIGHT_PANEL_LEFT + 48, 310)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/png',
      0.95
    )
  })
}

export function shareCardBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
