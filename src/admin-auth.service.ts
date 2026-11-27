import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

const SESSION_COOKIE = 'raquet_admin_session'
const SESSION_DURATION_SECONDS = 8 * 60 * 60

const safeEqual = (first: string, second: string) => {
  const firstHash = createHash('sha256').update(first).digest()
  const secondHash = createHash('sha256').update(second).digest()
  return timingSafeEqual(firstHash, secondHash)
}

@Injectable()
export class AdminAuthService {
  private getConfiguration() {
    const username = process.env.DASHBOARD_ADMIN_USERNAME
    const password = process.env.DASHBOARD_ADMIN_PASSWORD
    const secret = process.env.DASHBOARD_SESSION_SECRET

    if (!username || !password || !secret || secret.length < 32) {
      throw new ServiceUnavailableException(
        'El acceso administrativo no está configurado correctamente en el servidor.',
      )
    }

    return { username, password, secret }
  }

  validateCredentials(username: string, password: string) {
    const configuration = this.getConfiguration()
    return safeEqual(username, configuration.username)
      && safeEqual(password, configuration.password)
      ? configuration.username
      : null
  }

  createSession(username: string) {
    const { secret } = this.getConfiguration()
    const payload = Buffer.from(JSON.stringify({
      sub: username,
      exp: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS,
    })).toString('base64url')
    const signature = createHmac('sha256', secret).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }

  getSessionUsername(request: Request) {
    const token = request.headers.cookie
      ?.split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1)
    if (!token) return null

    try {
      const { username, secret } = this.getConfiguration()
      const [payload, signature] = token.split('.')
      if (!payload || !signature) return null
      const expectedSignature = createHmac('sha256', secret).update(payload).digest()
      const providedSignature = Buffer.from(signature, 'base64url')
      if (
        providedSignature.length !== expectedSignature.length
        || !timingSafeEqual(providedSignature, expectedSignature)
      ) {
        return null
      }

      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      if (session.sub !== username || !Number.isInteger(session.exp) || session.exp <= Date.now() / 1000) {
        return null
      }
      return username
    } catch {
      return null
    }
  }

  get cookieName() {
    return SESSION_COOKIE
  }

  get sessionDurationSeconds() {
    return SESSION_DURATION_SECONDS
  }
}
