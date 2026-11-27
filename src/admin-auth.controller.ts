import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import type { Request } from 'express'
import { AdminAuthGuard } from './admin-auth.guard.js'
import { AdminAuthService } from './admin-auth.service.js'

type LoginBody = {
  username?: string
  password?: string
}

@Controller('api/admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  login(
    @Body() body: LoginBody,
    @Res({ passthrough: true }) response: Response,
  ) {
    const username = this.auth.validateCredentials(body?.username ?? '', body?.password ?? '')
    if (!username) throw new UnauthorizedException('Usuario o contraseña incorrectos.')

    const token = this.auth.createSession(username)
    response.cookie(this.auth.cookieName, token, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/api/admin',
      maxAge: this.auth.sessionDurationSeconds * 1000,
    })
    return { username }
  }

  @UseGuards(AdminAuthGuard)
  @Get('session')
  getSession(@Req() request: Request) {
    return {
      authenticated: true,
      username: this.auth.getSessionUsername(request),
    }
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(this.auth.cookieName, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/api/admin',
    })
    return { loggedOut: true }
  }
}
