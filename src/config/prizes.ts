// Server-side copy of the spin-wheel prizes. The user app keeps its own copy for drawing the wheel;
// `weight` only matters here. If you change segments, change them in both places.
export type PrizeId = 'no_win' | 'extra_spin' | '1000' | '2000' | '3000' | '5000' | '10000';
export type Prize = { id: PrizeId; label: string; amount: number; weight: number };

export const MAX_DAILY_SPINS = 3;

export const PRIZES: Prize[] = [
  { id: 'no_win', label: 'No Win', amount: 0, weight: 30 },
  { id: '1000', label: '₦1,000', amount: 1000, weight: 20 },
  { id: 'extra_spin', label: 'Extra Spin', amount: 0, weight: 15 },
  { id: '2000', label: '₦2,000', amount: 2000, weight: 18 },
  { id: '3000', label: '₦3,000', amount: 3000, weight: 10 },
  { id: '5000', label: '₦5,000', amount: 5000, weight: 5 },
  { id: '10000', label: '₦10,000', amount: 10000, weight: 2 }
];

export function pickWeightedPrize(random: () => number = Math.random): Prize {
  const total = PRIZES.reduce((sum, p) => sum + p.weight, 0);
  let roll = random() * total;
  for (const prize of PRIZES) {
    roll -= prize.weight;
    if (roll <= 0) return prize;
  }
  return PRIZES[0];
}
