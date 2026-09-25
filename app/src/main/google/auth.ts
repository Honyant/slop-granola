// Google Cloud credentials for Speech-to-Text and Vertex AI: a service-account
// key file if one is configured, otherwise gcloud's application-default
// credentials (`gcloud auth application-default login`).
import { GoogleAuth } from 'google-auth-library'
import type { Settings } from '@shared/settings'

export type GoogleConfig = Settings['google']

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform']
const clients = new Map<string, GoogleAuth>()

export function googleAuth(config: GoogleConfig): GoogleAuth {
  const key = config.credentialsPath
  let auth = clients.get(key)
  if (!auth) {
    auth = new GoogleAuth({ scopes: SCOPES, ...(key ? { keyFilename: key } : {}) })
    clients.set(key, auth)
  }
  return auth
}

/** Short-lived OAuth token; google-auth-library caches and refreshes it. */
export async function googleAccessToken(config: GoogleConfig): Promise<string> {
  const token = await googleAuth(config).getAccessToken()
  if (!token) throw new Error('Google credentials produced no access token')
  return token
}

export async function googleProjectId(config: GoogleConfig): Promise<string> {
  if (config.projectId.trim()) return config.projectId.trim()
  const project = await googleAuth(config).getProjectId()
  if (!project) throw new Error('Set a Google Cloud project ID in Settings → Connectors')
  return project
}
