const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function code(len: number): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length]
  return s
}
