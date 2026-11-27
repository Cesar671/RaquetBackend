import { BadRequestException } from '@nestjs/common'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReservationService } from './reservation.service.js'
import { ManagementService } from './management.service.js'
import type { ManagementSettings } from './management.types.js'

describe('ReservationService WhatsApp delivery', () => {
  const service = new ReservationService(new ManagementService())
  const reservation = {
    id: 'WR-ABC-123',
    reservationName: 'Cliente',
    phone: '+591 71749816',
    gameType: 'Wally' as const,
    paymentMethod: 'Pago por QR',
    bookings: [],
    createdAt: '2026-11-26T00:00:00.000Z',
  }
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubEnv('WHATSAPP_CLOUD_API_TOKEN', 'test-token')
    vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'test-phone-number-id')
    vi.stubEnv('WHATSAPP_TEMPLATE_NAME', 'wally_reservation_code')
    vi.stubEnv('WHATSAPP_TEMPLATE_LANGUAGE', 'es')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  describe('ReservationService booking validation', () => {
    const dateInDays = (daysAhead: number) => {
      const date = new Date()
      date.setDate(date.getDate() + daysAhead)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
    }

    const settings: ManagementSettings = {
      courts: [{ id: 1, name: 'Cancha 1', active: true }],
      openingHours: {
        courts: [{
          id: 'daily',
          label: 'Todos los días',
          days: [0, 1, 2, 3, 4, 5, 6],
          opensAt: '10:00',
          closesAt: '11:00',
        }],
        sauna: [],
      },
      prices: [],
      services: [],
      contact: { landline: '', mobile: '', whatsappNumber: '' },
      location: { coordinates: '', timeZone: 'America/La_Paz' },
      announcements: [],
      promotions: [],
    }

    const createTestService = async (reservations: unknown[] = []) => {
      const directory = await mkdtemp(join(tmpdir(), 'wally-reservation-test-'))
      const dataFile = join(directory, 'reservations.json')
      const management = new ManagementService()
      vi.spyOn(management, 'getSettings').mockResolvedValue(settings)

      const service = new ReservationService(management)
      Object.defineProperty(service, 'dataFile', { value: dataFile })
      await writeFile(dataFile, JSON.stringify(reservations), 'utf8')
      vi.spyOn(service, 'sendWhatsAppCode').mockResolvedValue({
        status: 'not-configured',
        provider: 'meta-whatsapp-cloud-api',
        recipient: '59171749816',
        missingConfiguration: [],
      })

      return { service, dataFile, directory }
    }

    const validBooking = {
      reservationName: 'Cliente',
      phone: '71749816',
      gameType: 'Wally' as const,
      paymentMethod: 'Pago por QR',
      bookings: [{ date: dateInDays(5), courtId: 1, hours: ['10:00'] }],
    }

    it('rejects admin or customer bookings without selected hours as a bad request', async () => {
      const service = new ReservationService(new ManagementService())
      await expect(service.createReservation({
        bookings: [],
        reservationName: 'Cliente',
        phone: '71749816',
        gameType: 'Wally',
        paymentMethod: 'Pago por QR',
      })).rejects.toBeInstanceOf(BadRequestException)
    })

    it('allows dashboard bookings without a payment method', async () => {
      const service = new ReservationService(new ManagementService())
      await expect(service.createAdminReservation({
        bookings: [],
        reservationName: 'Cliente',
        phone: '71749816',
        gameType: 'Wally',
      })).rejects.toThrow('Selecciona al menos un horario antes de confirmar.')
    })

    it('rejects negative dashboard advances', async () => {
      const service = new ReservationService(new ManagementService())
      await expect(service.createAdminReservation({
        bookings: [],
        reservationName: 'Cliente',
        phone: '71749816',
        gameType: 'Wally',
        depositAmount: -1,
      })).rejects.toThrow('El anticipo debe ser un monto válido igual o mayor a cero.')
    })

    it('allows public bookings through the tenth day ahead', async () => {
      const { service, directory } = await createTestService()

      try {
        await expect(service.createReservation({
          ...validBooking,
          bookings: [{ date: dateInDays(10), courtId: 1, hours: ['10:00'] }],
        })).resolves.toMatchObject({
          bookings: [{ date: dateInDays(10), hours: ['10:00'] }],
        })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('rejects public bookings beyond the tenth day', async () => {
      const { service, directory } = await createTestService()

      try {
        await expect(service.createReservation({
          ...validBooking,
          bookings: [{ date: dateInDays(11), courtId: 1, hours: ['10:00'] }],
        })).rejects.toThrow('Las reservas públicas solo permiten fechas hasta los próximos 10 días.')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('rejects public searches extending beyond the tenth day', async () => {
      const management = new ManagementService()
      vi.spyOn(management, 'getSettings').mockResolvedValue(settings)
      const service = new ReservationService(management)

      await expect(service.searchAvailability({
        startDate: dateInDays(5),
        endDate: dateInDays(11),
        courtId: 'all',
        timeFrom: '00:00',
        timeTo: '23:59',
        duration: 1,
      })).rejects.toThrow('La búsqueda pública solo permite fechas desde hoy hasta los próximos 10 días.')
    })

    it('allows dashboard bookings on any date and hourly slot', async () => {
      const { service, directory } = await createTestService()

      try {
        const availability = await service.getAdminAvailability('2030-01-02', 1)
        const reservation = await service.createAdminReservation({
          reservationName: 'Cliente',
          phone: '71749816',
          gameType: 'Wally',
          bookings: [{ date: '2030-01-02', courtId: 1, hours: ['23:00'] }],
        })

        expect(availability.openHours).toHaveLength(24)
        expect(availability.openHours).toContain('23:00')
        expect(reservation.bookings[0].hours).toEqual(['23:00'])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('allows dashboard edits outside public opening hours', async () => {
      const existingReservation = {
        id: 'WR-EDIT',
        status: 'confirmed',
        bookings: [{ date: dateInDays(5), courtId: 1, hours: ['10:00'] }],
      }
      const { service, directory } = await createTestService([existingReservation])

      try {
        const updated = await service.updateAdminReservation('WR-EDIT', {
          reservationName: 'Cliente',
          phone: '71749816',
          gameType: 'Wally',
          bookings: [{ date: '2030-01-02', courtId: 1, hours: ['23:00'] }],
        })

        expect(updated?.bookings[0].date).toBe('2030-01-02')
        expect(updated?.bookings[0].hours).toEqual(['23:00'])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('rejects a slot already occupied by an active reservation', async () => {
      const existingReservation = {
        id: 'WR-EXISTING',
        status: 'confirmed',
        bookings: [{ date: dateInDays(5), courtId: 1, hours: ['10:00'] }],
      }
      const { service, directory } = await createTestService([existingReservation])

      try {
        await expect(service.createReservation(validBooking))
          .rejects.toThrow('El horario 10:00 ya está ocupado.')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('rejects duplicate slots within one reservation request', async () => {
      const { service, directory } = await createTestService()

      try {
        await expect(service.createReservation({
          ...validBooking,
          bookings: [
            ...validBooking.bookings,
            { date: validBooking.bookings[0].date, courtId: 1, hours: ['10:00'] },
          ],
        })).rejects.toThrow('El horario 10:00 está repetido en la solicitud.')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('allows only one concurrent reservation for the same slot', async () => {
      const { service, dataFile, directory } = await createTestService()

      try {
        const results = await Promise.allSettled([
          service.createReservation(validBooking),
          service.createReservation(validBooking),
        ])
        const fulfilled = results.filter((result) => result.status === 'fulfilled')
        const rejected = results.filter((result) => result.status === 'rejected')
        const savedReservations = JSON.parse(await readFile(dataFile, 'utf8'))

        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0]).toMatchObject({
          status: 'rejected',
          reason: expect.any(BadRequestException),
        })
        expect(savedReservations).toHaveLength(1)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('sends the backend-generated code with an approved template to the booking phone', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] })))

    const result = await service.sendWhatsAppCode(reservation)

    expect(result).toEqual({
      status: 'sent',
      provider: 'meta-whatsapp-cloud-api',
      recipient: '59171749816',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v22.0/test-phone-number-id/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: '59171749816',
          type: 'template',
          template: {
            name: 'wally_reservation_code',
            language: { code: 'es' },
            components: [{
              type: 'body',
              parameters: [{ type: 'text', text: 'WR-ABC-123' }],
            }],
          },
        }),
      }),
    )
  })

  it('does not attempt delivery when the template or credentials are missing', async () => {
    vi.stubEnv('WHATSAPP_TEMPLATE_NAME', '')

    const result = await service.sendWhatsAppCode(reservation)

    expect(result).toEqual({
      status: 'not-configured',
      provider: 'meta-whatsapp-cloud-api',
      recipient: '59171749816',
      missingConfiguration: ['WHATSAPP_TEMPLATE_NAME'],
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a rejected WhatsApp API request', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'Template not approved' } }),
      { status: 400 },
    ))

    const result = await service.sendWhatsAppCode(reservation)

    expect(result).toEqual({
      status: 'failed',
      provider: 'meta-whatsapp-cloud-api',
      recipient: '59171749816',
      error: 'Template not approved',
    })
  })
})
