import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common'
import { AdminAuthGuard } from './admin-auth.guard.js'
import { ManagementService } from './management.service.js'
import { ReservationService } from './reservation.service.js'
import type { ManagementSettings, VenuePromotionInput } from './management.types.js'
import type { CreateAdminReservationInput } from './reservation.types.js'

@UseGuards(AdminAuthGuard)
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly reservations: ReservationService,
    private readonly management: ManagementService,
  ) {}

  @Get('overview')
  getOverview() {
    return this.reservations.getAdminOverview()
  }

  @Get('availability')
  getAvailability(
    @Query('date') date: string,
    @Query('courtId') courtId: string,
  ) {
    return this.reservations.getAdminAvailability(date, Number(courtId))
  }

  @Get('reservations')
  getReservations(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('date') date?: string,
  ) {
    return this.reservations.getAdminReservations({ status, search, date })
  }

  @Post('reservations')
  createReservation(@Body() body: CreateAdminReservationInput) {
    return this.reservations.createAdminReservation(body)
  }

  @Get('reservations/:id/availability')
  async getReservationAvailability(
    @Param('id') id: string,
    @Query('date') date: string,
    @Query('courtId') courtId: string,
  ) {
    const availability = await this.reservations.getAdminReservationAvailability(
      id,
      date,
      Number(courtId),
    )
    if (!availability) throw new NotFoundException('No encontramos una reserva con ese ID.')
    return availability
  }

  @Patch('reservations/:id')
  async updateReservation(
    @Param('id') id: string,
    @Body() body: CreateAdminReservationInput,
  ) {
    const reservation = await this.reservations.updateAdminReservation(id, body)
    if (!reservation) throw new NotFoundException('No encontramos una reserva con ese ID.')
    return reservation
  }

  @Patch('reservations/:id/status')
  async updateReservationStatus(
    @Param('id') id: string,
    @Body() body: { status?: string },
  ) {
    const reservation = await this.reservations.updateReservationStatus(id, body?.status ?? '')
    if (!reservation) throw new NotFoundException('No encontramos una reserva con ese ID.')
    return reservation
  }

  @Get('settings')
  getSettings() {
    return this.management.getSettings()
  }

  @Put('settings')
  updateSettings(@Body() body: ManagementSettings) {
    return this.management.updateSettings(body)
  }

  @Post('announcements')
  async createAnnouncement(
    @Body() body: { title: string; message: string; active: boolean },
  ) {
    return this.management.createAnnouncement(body)
  }

  @Patch('announcements/:id')
  async updateAnnouncement(
    @Param('id') id: string,
    @Body() body: { title: string; message: string; active: boolean },
  ) {
    const announcement = await this.management.updateAnnouncement(id, body)
    if (!announcement) throw new NotFoundException('No encontramos ese anuncio.')
    return announcement
  }

  @Delete('announcements/:id')
  async deleteAnnouncement(@Param('id') id: string) {
    const announcement = await this.management.deleteAnnouncement(id)
    if (!announcement) throw new NotFoundException('No encontramos ese anuncio.')
    return announcement
  }

  @Post('promotions')
  createPromotion(@Body() body: VenuePromotionInput) {
    return this.management.createPromotion(body)
  }

  @Patch('promotions/:id')
  async updatePromotion(
    @Param('id') id: string,
    @Body() body: VenuePromotionInput,
  ) {
    const promotion = await this.management.updatePromotion(id, body)
    if (!promotion) throw new NotFoundException('No encontramos esa promoción.')
    return promotion
  }

  @Delete('promotions/:id')
  async deletePromotion(@Param('id') id: string) {
    const promotion = await this.management.deletePromotion(id)
    if (!promotion) throw new NotFoundException('No encontramos esa promoción.')
    return promotion
  }
}
