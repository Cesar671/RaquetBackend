import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { AdminAuthService } from './admin-auth.service.js'

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest()
    if (!this.auth.getSessionUsername(request)) {
      throw new UnauthorizedException('Inicia sesión para acceder al backoffice.')
    }
    return true
  }
}
