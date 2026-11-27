export type Court = {
  id: number
  name: string
  occupiedHours: Record<string, string[]>
}

export type Booking = {
  date: string
  courtId: number
  hours: string[]
}

export type CreateReservationInput = {
  bookings: Booking[]
  reservationName: string
  phone: string
  gameType: 'Wally' | 'Raquet'
  paymentMethod: string
}

export type CreateAdminReservationInput = Omit<CreateReservationInput, 'paymentMethod'> & {
  depositAmount?: number
}

export type Reservation = {
  id: string
  reservationName: string
  phone: string
  gameType: 'Wally' | 'Raquet'
  paymentMethod?: string
  depositAmount?: number
  bookings: Booking[]
  createdAt: string
  status?: 'pending' | 'confirmed' | 'cancelled' | 'completed'
  whatsappDelivery?: {
    status: 'sent' | 'failed' | 'not-configured'
    provider: 'meta-whatsapp-cloud-api'
    recipient: string
    error?: string
    missingConfiguration?: string[]
  }
}
