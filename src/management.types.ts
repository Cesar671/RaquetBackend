export type AdminCourt = {
  id: number
  name: string
  active: boolean
}

export type OpeningPeriod = {
  id: string
  label: string
  days: number[]
  opensAt: string
  closesAt: string
}

export type VenuePrice = {
  id: string
  category: 'courts' | 'sauna'
  label: string
  amount: number
  currency: string
  unit: string
  active: boolean
}

export type VenueService = {
  id: string
  name: string
  active: boolean
}

export type VenueAnnouncement = {
  id: string
  title: string
  message: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export type VenuePromotion = {
  id: string
  title: string
  description: string
  discountAmount: number
  conditions: string
  startsOn: string
  endsOn: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export type VenuePromotionInput = Pick<
  VenuePromotion,
  'title' | 'description' | 'discountAmount' | 'conditions' | 'startsOn' | 'endsOn' | 'active'
>

export type ManagementSettings = {
  courts: AdminCourt[]
  openingHours: {
    courts: OpeningPeriod[]
    sauna: OpeningPeriod[]
  }
  prices: VenuePrice[]
  services: VenueService[]
  contact: {
    landline: string
    mobile: string
    whatsappNumber: string
  }
  location: {
    coordinates: string
    timeZone: string
  }
  announcements: VenueAnnouncement[]
  promotions: VenuePromotion[]
}
