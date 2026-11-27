import { BadRequestException, Injectable } from '@nestjs/common'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CreateAdminReservationInput,
  CreateReservationInput,
  Reservation,
} from './reservation.types.js'
import { ManagementService } from './management.service.js'
import type { ManagementSettings } from './management.types.js'

const getDateKey = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const PUBLIC_BOOKING_DAYS_AHEAD = 10

@Injectable()
export class ReservationService {
  private readonly dataFile = join(process.cwd(), 'data', 'reservations.json')
  private writeQueue: Promise<void> = Promise.resolve()
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly management: ManagementService) {}

  private normalizeRecipient(phone: string) {
    const digits = phone.replace(/\D/g, '')
    if (digits.startsWith('591') && digits.length === 11) return digits
    if (/^[567]\d{7}$/.test(digits)) return `591${digits}`
    return digits
  }

  async sendWhatsAppCode(reservation: Reservation) {
    const token = process.env.WHATSAPP_CLOUD_API_TOKEN
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
    const templateName = process.env.WHATSAPP_TEMPLATE_NAME
    const recipient = this.normalizeRecipient(reservation.phone)
    const missingConfiguration = [
      !token && 'WHATSAPP_CLOUD_API_TOKEN',
      !phoneNumberId && 'WHATSAPP_PHONE_NUMBER_ID',
      !templateName && 'WHATSAPP_TEMPLATE_NAME',
    ].filter((key): key is string => Boolean(key))

    if (!token || !phoneNumberId || !templateName) {
      return {
        status: 'not-configured' as const,
        provider: 'meta-whatsapp-cloud-api' as const,
        recipient,
        missingConfiguration,
      }
    }

    const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v22.0'
    const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`
    const templateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'es_ES'
    const body = {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLanguage },
        components: [{
          type: 'body',
          parameters: [{ type: 'text', text: reservation.id }],
        }],
      },
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)

      if (!response.ok) {
        const detail = payload?.error?.message
          || `WhatsApp respondió con estado HTTP ${response.status}.`
        return {
          status: 'failed' as const,
          provider: 'meta-whatsapp-cloud-api' as const,
          recipient,
          error: detail,
        }
      }

      return {
        status: 'sent' as const,
        provider: 'meta-whatsapp-cloud-api' as const,
        recipient,
      }
    } catch (error) {
      return {
        status: 'failed' as const,
        provider: 'meta-whatsapp-cloud-api' as const,
        recipient,
        error: error instanceof Error
          ? error.name === 'TimeoutError' || error.name === 'AbortError'
            ? 'WhatsApp no respondió dentro del tiempo esperado.'
            : error.message
          : 'No se pudo conectar con WhatsApp.',
      }
    }
  }

  async getCourts() {
    const settings = await this.management.getSettings()
    return settings.courts
      .filter((court) => court.active)
      .map(({ id, name }) => ({ id, name }))
  }

  getOpenHoursForDate(dateKey: string, settings: ManagementSettings) {
    const date = new Date(`${dateKey}T12:00:00`)
    if (Number.isNaN(date.getTime())) return []
    const period = settings.openingHours.courts.find((item) => item.days.includes(date.getDay()))
    if (!period) return []
    const opening = Number(period.opensAt.slice(0, 2)) * 60 + Number(period.opensAt.slice(3, 5))
    const closing = Number(period.closesAt.slice(0, 2)) * 60 + Number(period.closesAt.slice(3, 5))
    if (closing <= opening) return []
    return Array.from({ length: Math.floor((closing - opening) / 60) }, (_, index) =>
      `${String(Math.floor((opening + index * 60) / 60)).padStart(2, '0')}:${String((opening + index * 60) % 60).padStart(2, '0')}`,
    )
  }

  private getAllHourlySlots() {
    return Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)
  }

  private getPublicBookingDateRange() {
    const today = new Date()
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    end.setDate(end.getDate() + PUBLIC_BOOKING_DAYS_AHEAD)
    return { startDate: getDateKey(today), endDate: getDateKey(end) }
  }

  private isValidHourlySlot(hour: string) {
    return /^(?:[01]\d|2[0-3]):00$/.test(hour)
  }

  async getAvailabilitySlots(dateKey: string) {
    if (!this.validateDate(dateKey)) throw new Error('La fecha proporcionada no es válida.')
    const settings = await this.management.getSettings()
    return this.getOpenHoursForDate(dateKey, settings)
  }

  private async readReservations(): Promise<Reservation[]> {
    try {
      const content = await readFile(this.dataFile, 'utf8')
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private persistReservations(reservations: Reservation[]) {
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.dataFile), { recursive: true })
      const temporaryFile = `${this.dataFile}.tmp`
      await writeFile(temporaryFile, JSON.stringify(reservations, null, 2), 'utf8')
      await rename(temporaryFile, this.dataFile)
    })
    this.writeQueue = operation.catch(() => {})
    return operation
  }

  private validateDate(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
    const dateValue = new Date(`${date}T12:00:00`)
    if (Number.isNaN(dateValue.getTime())) return false
    return getDateKey(dateValue) === date
  }

  private validatePhone(phone: string) {
    const normalized = phone.replace(/[\s().-]/g, '')
    return /^(?:\+?591)?[567]\d{7}$/.test(normalized)
  }

  async getOccupied(date: string, courtId: number) {
    const settings = await this.management.getSettings()
    const court = settings.courts.find((item) => item.id === courtId && item.active)
    if (!this.validateDate(date) || !court) {
      throw new Error('Solicitud inválida.')
    }

    const reservations = await this.readReservations()
    const occupied = new Set<string>()

    for (const reservation of reservations) {
      if (reservation.status === 'cancelled') continue
      for (const booking of reservation.bookings) {
        if (booking.date === date && booking.courtId === courtId) {
          for (const hour of booking.hours) occupied.add(hour)
        }
      }
    }

    return {
      date,
      courtId,
      occupiedHours: Array.from(occupied).sort(),
      openHours: this.getOpenHoursForDate(date, settings),
    }
  }

  async getAdminAvailability(date: string, courtId: number) {
    const settings = await this.management.getSettings()
    const court = settings.courts.find((item) => item.id === courtId && item.active)
    if (!this.validateDate(date) || !court) {
      throw new BadRequestException('Solicitud inválida.')
    }

    const reservations = await this.readReservations()
    const occupied = new Set<string>()
    for (const reservation of reservations) {
      if (reservation.status === 'cancelled') continue
      for (const booking of reservation.bookings) {
        if (booking.date === date && booking.courtId === courtId) {
          for (const hour of booking.hours) occupied.add(hour)
        }
      }
    }

    return {
      date,
      courtId,
      occupiedHours: Array.from(occupied).sort(),
      openHours: this.getAllHourlySlots(),
    }
  }

  async searchAvailability(params: {
    startDate: string
    endDate: string
    courtId: string
    timeFrom: string
    timeTo: string
    duration: number
  }) {
    if (!this.validateDate(params.startDate) || !this.validateDate(params.endDate)) {
      throw new Error('Las fechas proporcionadas no son válidas.')
    }
    if (params.startDate > params.endDate) {
      throw new Error('La fecha final debe ser igual o posterior a la fecha inicial.')
    }
    const publicDateRange = this.getPublicBookingDateRange()
    if (
      params.startDate < publicDateRange.startDate
      || params.endDate > publicDateRange.endDate
    ) {
      throw new Error('La búsqueda pública solo permite fechas desde hoy hasta los próximos 10 días.')
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(params.timeFrom)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(params.timeTo)
      || params.timeFrom >= params.timeTo) {
      throw new Error('El rango horario no es válido.')
    }
    if (![1, 2, 3].includes(params.duration)) {
      throw new Error('La duración no es válida.')
    }

    const settings = await this.management.getSettings()
    const courts = settings.courts.filter((court) => court.active)
    const courtIds = params.courtId === 'all'
      ? courts.map((court) => court.id)
      : [Number(params.courtId)]
    if (courtIds.some((courtId) => !courts.some((court) => court.id === courtId))) {
      throw new Error('La cancha seleccionada no existe.')
    }

    const reservations = await this.readReservations()
    const results: Array<{ date: string; court: { id: number; name: string }; hours: string[] }> = []
    const current = new Date(`${params.startDate}T12:00:00`)
    const end = new Date(`${params.endDate}T12:00:00`)

    while (current <= end) {
      const date = getDateKey(current)
      for (const courtId of courtIds) {
        const court = courts.find((item) => item.id === courtId)!
        const openHours = this.getOpenHoursForDate(date, settings)
        const occupied = new Set<string>()

        for (const reservation of reservations) {
          if (reservation.status === 'cancelled') continue
          for (const booking of reservation.bookings) {
            if (booking.date === date && booking.courtId === courtId) {
              for (const hour of booking.hours) occupied.add(hour)
            }
          }
        }

        for (let index = 0; index < openHours.length; index += 1) {
          const startTime = openHours[index]
          const hours = openHours.slice(index, index + params.duration)
          if (hours.length !== params.duration || startTime < params.timeFrom) continue

          const lastHour = Number(hours.at(-1)!.slice(0, 2))
          const endTime = `${String(lastHour + 1).padStart(2, '0')}:00`
          if (endTime <= params.timeTo && !hours.some((hour) => occupied.has(hour))) {
            results.push({ date, court: { id: court.id, name: court.name }, hours })
          }
        }
      }
      current.setDate(current.getDate() + 1)
    }

    return results
  }

  async createReservation(input: CreateReservationInput) {
    return this.queueReservationCreation(input, true)
  }

  async createAdminReservation(input: CreateAdminReservationInput) {
    return this.queueReservationCreation(input, false)
  }

  private queueReservationCreation(
    input: CreateReservationInput | CreateAdminReservationInput,
    requirePaymentMethod: boolean,
  ) {
    const operation = this.mutationQueue.then(() =>
      this.createReservationLocked(input, requirePaymentMethod),
    )
    this.mutationQueue = operation.catch(() => {})
    return operation
  }

  private async createReservationLocked(
    input: CreateReservationInput | CreateAdminReservationInput,
    requirePaymentMethod: boolean,
  ) {
    if (!input?.reservationName?.trim()) {
      throw new BadRequestException('El nombre de la reserva es obligatorio.')
    }
    if (!this.validatePhone(input.phone?.trim() ?? '')) {
      throw new BadRequestException('Ingresa un celular boliviano válido.')
    }
    if (!['Wally', 'Raquet'].includes(input.gameType)) {
      throw new BadRequestException('El tipo de juego no es válido.')
    }
    const paymentMethod = 'paymentMethod' in input ? input.paymentMethod : undefined
    const validPaymentMethods = ['Pago por QR', 'Confirmación por WhatsApp']
    if (
      (requirePaymentMethod && !validPaymentMethods.includes(paymentMethod ?? ''))
      || (paymentMethod !== undefined && !validPaymentMethods.includes(paymentMethod))
    ) {
      throw new BadRequestException('El método de pago no es válido.')
    }
    const depositAmount = 'depositAmount' in input ? input.depositAmount ?? 0 : 0
    if (!Number.isFinite(depositAmount) || depositAmount < 0) {
      throw new BadRequestException('El anticipo debe ser un monto válido igual o mayor a cero.')
    }
    if (
      !Array.isArray(input.bookings)
      || input.bookings.length === 0
      || input.bookings.some((booking) => !booking || !Array.isArray(booking.hours))
    ) {
      throw new BadRequestException('Selecciona al menos un horario antes de confirmar.')
    }

    const normalizedBookings = input.bookings.map((booking) => ({
      date: booking.date,
      courtId: Number(booking.courtId),
      hours: Array.from(new Set(booking.hours)),
    }))

    const settings = await this.management.getSettings()
    const reservations = await this.readReservations()
    const requestedSlots = new Set<string>()
    const publicDateRange = requirePaymentMethod ? this.getPublicBookingDateRange() : null

    for (const booking of normalizedBookings) {
      const court = settings.courts.find((item) => item.id === booking.courtId && item.active)
      if (!this.validateDate(booking.date) || !court || booking.hours.length === 0) {
        throw new BadRequestException('Hay horarios inválidos en la reserva.')
      }
      if (requirePaymentMethod) {
        if (publicDateRange && booking.date < publicDateRange.startDate) {
          throw new BadRequestException('No puedes reservar horarios en una fecha pasada.')
        }
        if (publicDateRange && booking.date > publicDateRange.endDate) {
          throw new BadRequestException('Las reservas públicas solo permiten fechas hasta los próximos 10 días.')
        }
      }

      const openHours = requirePaymentMethod
        ? new Set(this.getOpenHoursForDate(booking.date, settings))
        : null
      for (const hour of booking.hours) {
        const isAllowedHour = openHours ? openHours.has(hour) : this.isValidHourlySlot(hour)
        if (!isAllowedHour) {
          throw new BadRequestException(openHours
            ? `El horario ${hour} no está dentro del horario de atención.`
            : `El horario ${hour} no es válido.`)
        }
        const requestedSlot = `${booking.date}:${booking.courtId}:${hour}`
        if (requestedSlots.has(requestedSlot)) {
          throw new BadRequestException(`El horario ${hour} está repetido en la solicitud.`)
        }
        requestedSlots.add(requestedSlot)
      }

      const occupied = new Set<string>()
      for (const reservation of reservations) {
        if (reservation.status === 'cancelled') continue
        for (const existing of reservation.bookings) {
          if (existing.date === booking.date && existing.courtId === booking.courtId) {
            for (const hour of existing.hours) occupied.add(hour)
          }
        }
      }

      const conflict = booking.hours.find((hour) => occupied.has(hour))
      if (conflict) throw new BadRequestException(`El horario ${conflict} ya está ocupado.`)
    }

    const reservation: Reservation = {
      id: `WR-${randomUUID().toUpperCase()}`,
      reservationName: input.reservationName.trim(),
      phone: input.phone.trim(),
      gameType: input.gameType,
      ...(paymentMethod ? { paymentMethod } : {}),
      depositAmount,
      bookings: normalizedBookings,
      createdAt: new Date().toISOString(),
      status: 'confirmed',
    }

    const whatsappDelivery = await this.sendWhatsAppCode(reservation)
    const reservationWithDelivery = { ...reservation, whatsappDelivery }

    await this.persistReservations([
      ...reservations,
      reservationWithDelivery,
    ])
    return reservationWithDelivery
  }

  async getAdminReservationAvailability(id: string, date: string, courtId: number) {
    const settings = await this.management.getSettings()
    const court = settings.courts.find((item) => item.id === courtId)
    if (!this.validateDate(date) || !court) {
      throw new BadRequestException('Solicitud inválida.')
    }

    const reservations = await this.readReservations()
    const reservation = reservations.find((item) =>
      item.id.toUpperCase() === id.trim().toUpperCase(),
    )
    if (!reservation) return null

    const occupied = new Set<string>()
    for (const item of reservations) {
      if (item.status === 'cancelled') continue
      for (const booking of item.bookings) {
        if (booking.date === date && booking.courtId === courtId) {
          for (const hour of booking.hours) occupied.add(hour)
        }
      }
    }
    const ownHours = new Set(reservation.bookings
      .filter((booking) => booking.date === date && booking.courtId === courtId)
      .flatMap((booking) => booking.hours))

    return {
      date,
      courtId,
      occupiedHours: Array.from(occupied).filter((hour) => !ownHours.has(hour)).sort(),
      openHours: this.getAllHourlySlots(),
    }
  }

  async updateAdminReservation(id: string, input: CreateAdminReservationInput) {
    const operation = this.mutationQueue.then(async () => {
      const reservations = await this.readReservations()
      const reservation = reservations.find((item) =>
        item.id.toUpperCase() === id.trim().toUpperCase(),
      )
      if (!reservation) return null
      if (reservation.status === 'cancelled') {
        throw new BadRequestException('No se puede modificar una reserva cancelada.')
      }
      if (!input?.reservationName?.trim()) {
        throw new BadRequestException('El nombre de la reserva es obligatorio.')
      }
      if (!this.validatePhone(input.phone?.trim() ?? '')) {
        throw new BadRequestException('Ingresa un celular boliviano válido.')
      }
      if (!['Wally', 'Raquet'].includes(input.gameType)) {
        throw new BadRequestException('El tipo de juego no es válido.')
      }
      const depositAmount = input.depositAmount ?? reservation.depositAmount ?? 0
      if (!Number.isFinite(depositAmount) || depositAmount < 0) {
        throw new BadRequestException('El anticipo debe ser un monto válido igual o mayor a cero.')
      }
      if (
        !Array.isArray(input.bookings)
        || input.bookings.length === 0
        || input.bookings.some((booking) => !booking || !Array.isArray(booking.hours))
      ) {
        throw new BadRequestException('La reserva debe conservar al menos un horario.')
      }

      const bookings = input.bookings.map((booking) => ({
        date: booking.date,
        courtId: Number(booking.courtId),
        hours: Array.from(new Set(booking.hours)),
      }))
      const settings = await this.management.getSettings()
      const otherReservations = reservations.filter((item) =>
        item.id.toUpperCase() !== reservation.id.toUpperCase() && item.status !== 'cancelled',
      )
      const selectedHours = new Set<string>()

      for (const booking of bookings) {
        const court = settings.courts.find((item) => item.id === booking.courtId)
        const isExistingBooking = reservation.bookings.some((existing) =>
          existing.date === booking.date
          && existing.courtId === booking.courtId
          && existing.hours.length === booking.hours.length
          && existing.hours.every((hour) => booking.hours.includes(hour)),
        )
        if (
          !this.validateDate(booking.date)
          || !court
          || (!court.active && !isExistingBooking)
          || booking.hours.length === 0
        ) {
          throw new BadRequestException('Hay horarios inválidos en la reserva.')
        }
        const dateCourtKey = `${booking.date}:${booking.courtId}`
        for (const hour of booking.hours) {
          if (!this.isValidHourlySlot(hour)) {
            throw new BadRequestException(`El horario ${hour} no es válido.`)
          }
          const uniqueHourKey = `${dateCourtKey}:${hour}`
          if (selectedHours.has(uniqueHourKey)) {
            throw new BadRequestException(`El horario ${hour} está repetido en la reserva.`)
          }
          selectedHours.add(uniqueHourKey)
          if (otherReservations.some((item) => item.bookings.some((existing) =>
            existing.date === booking.date
            && existing.courtId === booking.courtId
            && existing.hours.includes(hour),
          ))) {
            throw new BadRequestException(`El horario ${hour} ya está ocupado.`)
          }
        }
      }

      Object.assign(reservation, {
        reservationName: input.reservationName.trim(),
        phone: input.phone.trim(),
        gameType: input.gameType,
        depositAmount,
        bookings,
      })
      await this.persistReservations(reservations)
      return { ...reservation }
    })
    this.mutationQueue = operation.catch(() => {})
    return operation
  }

  async getAdminOverview() {
    const reservations = await this.readReservations()
    const today = getDateKey(new Date())
    const activeReservations = reservations.filter((reservation) => reservation.status !== 'cancelled')
    const statusCounts = {
      pending: reservations.filter((reservation) => reservation.status === 'pending').length,
      confirmed: reservations.filter((reservation) => !reservation.status || reservation.status === 'confirmed').length,
      completed: reservations.filter((reservation) => reservation.status === 'completed').length,
      cancelled: reservations.filter((reservation) => reservation.status === 'cancelled').length,
    }

    return {
      todayBookings: activeReservations.filter((reservation) =>
        reservation.bookings.some((booking) => booking.date === today),
      ).length,
      upcomingBookings: activeReservations.filter((reservation) =>
        reservation.bookings.some((booking) => booking.date >= today),
      ).length,
      pendingReservations: statusCounts.pending,
      whatsappIssues: reservations.filter((reservation) =>
        reservation.whatsappDelivery?.status === 'failed'
        || reservation.whatsappDelivery?.status === 'not-configured',
      ).length,
      statusCounts,
      recentReservations: [...reservations]
        .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
        .slice(0, 6)
        .map((reservation) => ({ ...reservation, status: reservation.status ?? 'confirmed' })),
    }
  }

  async getAdminReservations(filters: { status?: string; search?: string; date?: string }) {
    const reservations = await this.readReservations()
    const search = filters.search?.trim().toLocaleLowerCase()

    return reservations
      .filter((reservation) => !filters.status || filters.status === 'all' || (reservation.status ?? 'confirmed') === filters.status)
      .filter((reservation) => !filters.date || reservation.bookings.some((booking) => booking.date === filters.date))
      .filter((reservation) => !search
        || reservation.id.toLocaleLowerCase().includes(search)
        || reservation.reservationName.toLocaleLowerCase().includes(search)
        || reservation.phone.toLocaleLowerCase().includes(search),
      )
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
      .map((reservation) => ({ ...reservation, status: reservation.status ?? 'confirmed' }))
  }

  async updateReservationStatus(id: string, status: string) {
    if (!['pending', 'confirmed', 'cancelled', 'completed'].includes(status)) {
      throw new BadRequestException('El estado de reserva no es válido.')
    }

    const operation = this.mutationQueue.then(async () => {
      const reservations = await this.readReservations()
      const reservation = reservations.find((item) => item.id.toUpperCase() === id.trim().toUpperCase())
      if (!reservation) return null
      reservation.status = status as Reservation['status']
      await this.persistReservations(reservations)
      return { ...reservation }
    })
    this.mutationQueue = operation.catch(() => {})
    return operation
  }

  async getReservation(id: string) {
    const reservations = await this.readReservations()
    return reservations.find((reservation) =>
      reservation.id.toUpperCase() === id.trim().toUpperCase(),
    ) ?? null
  }

}
