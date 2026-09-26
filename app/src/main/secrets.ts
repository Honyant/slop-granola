// Credentials at rest. Electron's safeStorage encrypts with a key held in the
// macOS Keychain, so a copied or backed-up database does not leak API keys.
import { safeStorage } from 'electron'
import { SEALED_PREFIX as PREFIX, type SecretBox } from './db/repos'

export function keychainBox(log: (message: string) => void): SecretBox {
  const available = safeStorage.isEncryptionAvailable()
  if (!available) log('secrets: Keychain encryption unavailable; credentials are stored unencrypted')
  return {
    seal: (plain) => (available && plain ? PREFIX + safeStorage.encryptString(plain).toString('base64') : plain),
    open: (stored) => {
      if (!stored.startsWith(PREFIX)) return stored // written before encryption, or by a build without it
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'))
      } catch {
        log('secrets: could not decrypt a stored credential (Keychain changed?); it must be re-entered')
        return ''
      }
    },
  }
}
