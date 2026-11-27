import { BadRequestException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ManagementSettings,
  VenueAnnouncement,
  VenuePrice,
  VenuePromotion,
  VenuePromotionInput,
} from './management.types.js'

const initialSettings: ManagementSettings = {
  courts: [
    { id: 1, name: 'Cancha 1', active: true },
    { id: 2, name: 'Cancha 2', active: true },
  ],
  openingHours: {
    courts: [
      { id: 'weekday', label: 'Lunes a viernes', days: [1, 2, 3, 4, 5], opensAt: '16:00', closesAt: '23:00' },
      { id: 'weekend', label: 'Sábados y domingos', days: [0, 6], opensAt: '10:00', closesAt: '22:00' },
    ],
    sauna: [
      { id: 'weekday', label: 'Lunes a viernes', days: [1, 2, 3, 4, 5], opensAt: '16:00', closesAt: '21:00' },
      { id: 'weekend', label: 'Sábados y domingos', days: [0, 6], opensAt: '11:00', closesAt: '21:00' },
    ],
  },
  prices: [
    { id: 'wally-without-ball', category: 'courts', label: 'Wally sin balón', amount: 35, currency: 'Bs', unit: 'por juego', active: true },
    { id: 'wally-with-ball', category: 'courts', label: 'Wally con balón', amount: 40, currency: 'Bs', unit: 'por juego', active: true },
    { id: 'raquet-hour', category: 'courts', label: 'Raquet', amount: 40, currency: 'Bs', unit: 'por hora', active: true },
    { id: 'sauna-one-person', category: 'sauna', label: '1 persona', amount: 25, currency: 'Bs', unit: 'por hora', active: true },
    { id: 'sauna-two-people', category: 'sauna', label: '2 personas', amount: 40, currency: 'Bs', unit: 'por hora', active: true },
    { id: 'sauna-additional-person', category: 'sauna', label: 'Persona adicional (desde la 3.ª)', amount: 13, currency: 'Bs', unit: 'por hora', active: true },
    { id: 'sauna-child', category: 'sauna', label: 'Niños hasta 8 años', amount: 7, currency: 'Bs', unit: 'por hora', active: true },
  ],
  services: [
    { id: 'wally', name: 'Wally', active: true },
    { id: 'raquet', name: 'Raquet', active: true },
    { id: 'sauna', name: 'Sauna', active: true },
    { id: 'ball-rental', name: 'Flete de balones', active: true },
    { id: 'snack', name: 'Snack', active: true },
    { id: 'showers', name: 'Duchas', active: true },
    { id: 'motorcycle-parking', name: 'Parqueo de motos', active: true },
  ],
  contact: {
    landline: '4243128',
    mobile: '+591 71749816',
    whatsappNumber: '59171749816',
  },
  location: {
    coordinates: '-17.390320431403598,-66.17366869279044',
    timeZone: 'America/La_Paz',
  },
  announcements: [],
  promotions: [],
}

const validTime = (time: unknown) =>
  typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)

const validDateKey = (date: unknown) => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

const getPriceCategory = (price: VenuePrice): VenuePrice['category'] =>
  price.category === 'sauna'
  || price.id.startsWith('sauna-')
  || price.label.toLowerCase().includes('sauna')
    ? 'sauna'
    : 'courts'

@Injectable()
export class ManagementService {
  private readonly dataFile = join(process.cwd(), 'data', 'management.json')
  private writeQueue: Promise<void> = Promise.resolve()

  async getSettings(): Promise<ManagementSettings> {
    try {
      const content = await readFile(this.dataFile, 'utf8')
      const saved = JSON.parse(content) as Partial<ManagementSettings>
      const savedPrices = Array.isArray(saved.prices) ? saved.prices : structuredClone(initialSettings.prices)
      const hasLegacyPriceCategories = savedPrices.some((price) =>
        price.category !== 'courts' && price.category !== 'sauna',
      )
      const isPlaceholderSaunaPrice = (price: VenuePrice) =>
        price.id === 'sauna' && Number(price.amount) === 0 && !price.active
      const hasConfiguredSaunaPrice = savedPrices.some((price) =>
        getPriceCategory(price) === 'sauna'
        && !isPlaceholderSaunaPrice(price),
      )
      const prices = savedPrices
        .filter((price) =>
          !isPlaceholderSaunaPrice(price)
          && !(hasLegacyPriceCategories && getPriceCategory(price) === 'sauna'),
        )
        .map((price) => ({
          ...price,
          category: getPriceCategory(price),
        }))
      if (hasLegacyPriceCategories || !hasConfiguredSaunaPrice) {
        prices.push(...structuredClone(initialSettings.prices.filter((price) => price.category === 'sauna')))
      }
      return {
        ...structuredClone(initialSettings),
        ...saved,
        prices,
        promotions: Array.isArray(saved.promotions) ? saved.promotions : [],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.saveSettings(initialSettings)
      return structuredClone(initialSettings)
    }
  }

  async getPublicConfig() {
    const settings = await this.getSettings()
    const today = this.getTodayDateKey(settings.location.timeZone)
    return {
      courts: settings.courts.filter((court) => court.active),
      openingHours: settings.openingHours,
      prices: settings.prices.filter((price) => price.active),
      services: settings.services.filter((service) => service.active),
      contact: settings.contact,
      location: settings.location,
      announcements: settings.announcements.filter((announcement) => announcement.active),
      promotions: settings.promotions.filter((promotion) =>
        promotion.active
        && promotion.startsOn <= today
        && promotion.endsOn >= today,
      ),
    }
  }

  async updateSettings(input: ManagementSettings) {
    this.validateSettings(input)
    await this.saveSettings(input)
    return input
  }

  async createAnnouncement(input: Pick<VenueAnnouncement, 'title' | 'message' | 'active'>) {
    const title = input?.title?.trim()
    const message = input?.message?.trim()
    if (!title || !message || typeof input.active !== 'boolean') {
      throw new BadRequestException('El título, el mensaje y el estado del anuncio son obligatorios.')
    }

    const settings = await this.getSettings()
    const now = new Date().toISOString()
    const announcement: VenueAnnouncement = {
      id: randomUUID(),
      title,
      message,
      active: input.active,
      createdAt: now,
      updatedAt: now,
    }
    settings.announcements.unshift(announcement)
    await this.saveSettings(settings)
    return announcement
  }

  async updateAnnouncement(
    id: string,
    input: Pick<VenueAnnouncement, 'title' | 'message' | 'active'>,
  ) {
    const title = input?.title?.trim()
    const message = input?.message?.trim()
    if (!title || !message || typeof input.active !== 'boolean') {
      throw new BadRequestException('El título, el mensaje y el estado del anuncio son obligatorios.')
    }

    const settings = await this.getSettings()
    const announcement = settings.announcements.find((item) => item.id === id)
    if (!announcement) return null
    Object.assign(announcement, {
      title,
      message,
      active: input.active,
      updatedAt: new Date().toISOString(),
    })
    await this.saveSettings(settings)
    return announcement
  }

  async deleteAnnouncement(id: string) {
    const settings = await this.getSettings()
    const announcement = settings.announcements.find((item) => item.id === id)
    if (!announcement) return null
    settings.announcements = settings.announcements.filter((item) => item.id !== id)
    await this.saveSettings(settings)
    return announcement
  }

  async createPromotion(input: VenuePromotionInput) {
    const promotionInput = this.normalizePromotionInput(input)
    const settings = await this.getSettings()
    const now = new Date().toISOString()
    const promotion: VenuePromotion = {
      id: randomUUID(),
      ...promotionInput,
      createdAt: now,
      updatedAt: now,
    }
    settings.promotions.unshift(promotion)
    await this.saveSettings(settings)
    return promotion
  }

  async updatePromotion(id: string, input: VenuePromotionInput) {
    const promotionInput = this.normalizePromotionInput(input)
    const settings = await this.getSettings()
    const promotion = settings.promotions.find((item) => item.id === id)
    if (!promotion) return null
    Object.assign(promotion, promotionInput, { updatedAt: new Date().toISOString() })
    await this.saveSettings(settings)
    return promotion
  }

  async deletePromotion(id: string) {
    const settings = await this.getSettings()
    const promotion = settings.promotions.find((item) => item.id === id)
    if (!promotion) return null
    settings.promotions = settings.promotions.filter((item) => item.id !== id)
    await this.saveSettings(settings)
    return promotion
  }

  private validateSettings(input: ManagementSettings) {
    if (!input || !Array.isArray(input.courts) || input.courts.length === 0) {
      throw new BadRequestException('Debe existir al menos una cancha.')
    }
    if (input.courts.some((court) => !court.name?.trim() || !Number.isInteger(court.id))) {
      throw new BadRequestException('Revisa los nombres e identificadores de las canchas.')
    }
    if (new Set(input.courts.map((court) => court.id)).size !== input.courts.length) {
      throw new BadRequestException('No puede haber identificadores de cancha repetidos.')
    }

    for (const facility of ['courts', 'sauna'] as const) {
      const schedule = input.openingHours?.[facility]
      if (!Array.isArray(schedule) || schedule.some((period) =>
        !period.label?.trim()
        || !validTime(period.opensAt)
        || !validTime(period.closesAt)
        || period.opensAt >= period.closesAt
        || !Array.isArray(period.days)
        || period.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6),
      )) {
        throw new BadRequestException('Revisa los horarios de atención.')
      }
    }

    if (!Array.isArray(input.prices) || input.prices.some((price) =>
      !price.label?.trim()
      || !['courts', 'sauna'].includes(price.category)
      || !Number.isFinite(price.amount)
      || price.amount < 0
      || !price.unit?.trim()
      || !price.currency?.trim(),
    )) {
      throw new BadRequestException('Revisa los precios.')
    }
    if (input.prices.some((price) =>
      price.active
      && price.category === 'sauna'
      && price.amount <= 0,
    )) {
      throw new BadRequestException('Define un precio mayor a 0 para publicar una tarifa del sauna.')
    }
    if (!Array.isArray(input.services) || input.services.some((service) => !service.name?.trim())) {
      throw new BadRequestException('Revisa los servicios.')
    }
    if (!Array.isArray(input.promotions)) {
      throw new BadRequestException('Revisa las promociones.')
    }
    if (input.promotions.some((promotion) => !promotion?.id?.trim())) {
      throw new BadRequestException('Revisa los identificadores de las promociones.')
    }
    for (const promotion of input.promotions) this.normalizePromotionInput(promotion)
    if (new Set(input.promotions.map((promotion) => promotion.id)).size !== input.promotions.length) {
      throw new BadRequestException('No puede haber identificadores de promoción repetidos.')
    }
    if (
      !input.contact?.landline?.trim()
      || !input.contact?.mobile?.trim()
      || !input.contact?.whatsappNumber?.trim()
      || !input.location?.coordinates?.trim()
      || !input.location?.timeZone?.trim()
    ) {
      throw new BadRequestException('Completa los datos de contacto y ubicación.')
    }
  }

  private normalizePromotionInput(input: VenuePromotionInput): VenuePromotionInput {
    const title = input?.title?.trim()
    const description = input?.description?.trim()
    const conditions = input?.conditions?.trim()
    if (
      !title
      || !description
      || !conditions
      || !Number.isFinite(input?.discountAmount)
      || input.discountAmount <= 0
      || !validDateKey(input?.startsOn)
      || !validDateKey(input?.endsOn)
      || input.startsOn > input.endsOn
      || typeof input.active !== 'boolean'
    ) {
      throw new BadRequestException('Completa los datos de la promoción y revisa sus fechas y descuento.')
    }
    return {
      title,
      description,
      conditions,
      discountAmount: input.discountAmount,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      active: input.active,
    }
  }

  private getTodayDateKey(timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date())
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
    return `${values.year}-${values.month}-${values.day}`
  }

  private saveSettings(settings: ManagementSettings) {
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.dataFile), { recursive: true })
      const temporaryFile = `${this.dataFile}.tmp`
      await writeFile(temporaryFile, JSON.stringify(settings, null, 2), 'utf8')
      await rename(temporaryFile, this.dataFile)
    })
    this.writeQueue = operation.catch(() => {})
    return operation
  }
}
