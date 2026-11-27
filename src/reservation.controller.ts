import { BadRequestException, Controller, Get, Param, Post, Body, Query } from '@nestjs/common'
import { ReservationService } from './reservation.service.js'
import { ManagementService } from './management.service.js'
import type { CreateReservationInput } from './reservation.types.js'

@Controller('api')
export class ReservationController {
  constructor(
    private readonly reservations: ReservationService,
    private readonly management: ManagementService,
  ) {}

  @Get('public/config')
  getPublicConfig() {
    return this.management.getPublicConfig()
  }

  @Get('courts')
  getCourts() {
    return this.reservations.getCourts()
  }

  @Get('availability')
  async getAvailability(
    @Query('date') date: string,
    @Query('courtId') courtId: string,
  ) {
    try {
      return await this.reservations.getOccupied(date, Number(courtId))
    } catch (error) {
      throw new BadRequestException((error as Error).message)
    }

  }

  @Get('availability/slots')
  async getAvailabilitySlots(@Query('date') date: string) {
    try {
      return { date, openHours: await this.reservations.getAvailabilitySlots(date) }
    } catch (error) {
      throw new BadRequestException((error as Error).message)
    }
  }

  @Get('availability/search')
  async searchAvailability(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('courtId') courtId = 'all',
    @Query('timeFrom') timeFrom = '00:00',
    @Query('timeTo') timeTo = '23:59',
    @Query('duration') duration = '1',
  ) {
    try {
      return await this.reservations.searchAvailability({
        startDate,
        endDate,
        courtId,
        timeFrom,
        timeTo,
        duration: Number(duration),
      })
    } catch (error) {
      throw new BadRequestException((error as Error).message)
    }
  }

  @Post('reservations')
  createReservation(@Body() body: CreateReservationInput) {
    return this.reservations.createReservation(body)
  }

  @Get('reservations/:id')
  async getReservation(@Param('id') id: string) {
    const reservation = await this.reservations.getReservation(id)
    if (!reservation) throw new BadRequestException('No encontramos una reserva con ese ID.')
    return reservation
  }

}
