import { BadRequestException } from '@nestjs/common'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagementSettings } from './management.types.js'
import { ManagementService } from './management.service.js'

describe('ManagementService input validation', () => {
  const service = new ManagementService()

  it('rejects settings without a court as a bad request', async () => {
    const settings: ManagementSettings = {
      courts: [],
      openingHours: { courts: [], sauna: [] },
      prices: [],
      services: [],
      contact: { landline: '', mobile: '', whatsappNumber: '' },
      location: { coordinates: '', timeZone: '' },
      announcements: [],
    }

    await expect(service.updateSettings(settings)).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects publishing a sauna price until a positive amount is set', async () => {
    const settings: ManagementSettings = {
      courts: [{ id: 1, name: 'Cancha 1', active: true }],
      openingHours: { courts: [], sauna: [] },
      prices: [{
        id: 'sauna',
        category: 'sauna',
        label: 'Sauna',
        amount: 0,
        currency: 'Bs',
        unit: 'por hora',
        active: true,
      }],
      services: [],
      contact: { landline: '123', mobile: '123', whatsappNumber: '123' },
      location: { coordinates: '0,0', timeZone: 'America/La_Paz' },
      announcements: [],
      promotions: [],
    }

    await expect(service.updateSettings(settings)).rejects.toThrow(
      'Define un precio mayor a 0 para publicar una tarifa del sauna.',
    )
  })

  it('migrates existing settings to include the current sauna rates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wally-management-'))
    try {
      const service = new ManagementService()
      const dataFile = join(directory, 'management.json')
      Object.defineProperty(service, 'dataFile', { value: dataFile })
      await writeFile(dataFile, JSON.stringify({
        prices: [{
          id: 'wally-hour',
          label: 'Wally',
          amount: 35,
          currency: 'Bs',
          unit: 'por juego',
          active: true,
        }, {
          id: 'sauna',
          label: 'Sauna',
          amount: 40,
          currency: 'Bs',
          unit: 'por hora',
          active: true,
        }],
      }))

      const settings = await service.getSettings()
      expect(settings.prices).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'wally-hour', amount: 35, category: 'courts' }),
        expect.objectContaining({ id: 'sauna-one-person', amount: 25, unit: 'por hora', category: 'sauna' }),
        expect.objectContaining({ id: 'sauna-two-people', amount: 40, unit: 'por hora', category: 'sauna' }),
        expect.objectContaining({ id: 'sauna-additional-person', amount: 13, unit: 'por hora' }),
        expect.objectContaining({ id: 'sauna-child', amount: 7, unit: 'por hora' }),
      ]))
      expect(settings.prices.some((price) => price.id === 'sauna')).toBe(false)
      const publicConfig = await service.getPublicConfig()
      expect(publicConfig.prices.filter((price) => price.category === 'sauna')).toHaveLength(4)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects announcements without a title as a bad request', async () => {
    await expect(service.createAnnouncement({
      title: ' ',
      message: 'A notice',
      active: true,
    })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects a promotion with an invalid validity date as a bad request', async () => {
    await expect(service.createPromotion({
      title: 'Oferta',
      description: 'Descuento especial',
      discountAmount: 10,
      conditions: 'Válido para Wally',
      startsOn: '2026-02-30',
      endsOn: '2026-03-10',
      active: true,
    })).rejects.toBeInstanceOf(BadRequestException)
  })
})
