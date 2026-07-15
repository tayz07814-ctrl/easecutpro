// Mock data for the Stage A static visual port. In Stage C these shapes are
// replaced 1:1 by the real Easecut store selectors — layout/styling untouched.

export type DashCard =
  | { kind: 'new' }
  | { kind: 'skeleton' }
  | {
      kind: 'video'
      title: string
      edited: string
      duration: string
      thumb: '16:9' | '9:16'
      image?: string // real project thumbnail URL (data-uri / blob); placeholder when absent
      hover?: boolean // shows play scrim + open context menu (design 1a card 2)
    }
  | { kind: 'processing'; title: string; sub: string; percent: number }
  | { kind: 'failed'; title: string; edited: string; duration: string }

// Exact tiles from design screen 1a, in order.
export const DASH_CARDS: DashCard[] = [
  { kind: 'new' },
  { kind: 'video', title: 'Morning routine — bedroom take', edited: 'Edited 36 min ago', duration: '3:28', thumb: '16:9', hover: true },
  { kind: 'video', title: 'GRWM hook — v2', edited: 'Edited 1 h ago', duration: '0:42', thumb: '9:16' },
  { kind: 'processing', title: 'Kitchen b-roll batch', sub: 'Uploading media…', percent: 64 },
  { kind: 'failed', title: 'Podcast clip — episode 12', edited: 'Edited 3 h ago', duration: '6:04' },
  { kind: 'video', title: 'Meal-prep voiceover', edited: 'Edited yesterday', duration: '1:56', thumb: '16:9' },
  { kind: 'video', title: 'Apartment tour — draft', edited: 'Edited 2 days ago', duration: '4:12', thumb: '16:9' },
  { kind: 'skeleton' }
]

export const MOCK_EMAIL = 'tayz07814@gmail.com'
