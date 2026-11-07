export const PRODUCTS = [
  {
    id: 'risol-mayo',
    name: 'Risol Mayo',
    description: 'Kulit renyah keemasan berpadu smoked beef gurih, telur, dan creamy mayo racikan khas Tigara.',
    price: 15000,
    unit: 'box isi 4',
    variants: ['Original', 'Spicy', 'Mix'],
    pickup_only: false,
    image: '/images/products/risol-4pcs.webp',
  },
  {
    id: 'coffee-bun',
    name: 'Coffee Bun',
    description: 'Roti lembut beraroma kopi pekat dengan lelehan mentega gurih di dalamnya.',
    price: 12000,
    unit: 'pcs',
    variants: [],
    pickup_only: false,
    image: '/images/products/coffee-bun.webp',
  },
  {
    id: 'matcha',
    name: 'Iced Matcha Latte',
    description: 'Matcha dengan susu segar dan sirup vanila, disajikan dingin.',
    price: 16000,
    unit: 'cup',
    variants: [],
    pickup_only: true,
    pickup_note: 'Pengambilan di Kampus Stasiun Bumi, tidak bisa diantar',
    image: '/images/products/matcha.webp',
  },
];

export const PICKUP_LOCATION = 'TUJ Kampus Stasiun Bumi';
