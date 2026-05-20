export type SecretReward =
  | { type: "gold"; amount: number }
  | { type: "item"; itemId: string }
  | { type: "lore"; text: string };

export interface SecretDef {
  id: string;
  dc: number;
  reward: SecretReward;
  successText: string;
  failureText: string;
}

const SECRET_POOL: SecretDef[] = [
  {
    id: "loose_stone",
    dc: 10,
    reward: { type: "gold", amount: 12 },
    successText: "A loose stone conceals a small coin stash. (+12 GP)",
    failureText: "The stones look old and undisturbed.",
  },
  {
    id: "hidden_vial",
    dc: 12,
    reward: { type: "item", itemId: "health_potion" },
    successText: "Tucked in a crevice, you find a small healing vial.",
    failureText: "The crevice holds only dust and cobwebs.",
  },
  {
    id: "inscription",
    dc: 15,
    reward: {
      type: "lore",
      text: "An inscription reads: 'The strongest walls fall from within.'",
    },
    successText: "You make out a faint inscription on the surface.",
    failureText: "The surface feels smooth and unremarkable.",
  },
  {
    id: "coin_in_dust",
    dc: 10,
    reward: { type: "gold", amount: 5 },
    successText: "A single gold coin glints in the dust. (+5 GP)",
    failureText: "The floor here is dusty and undisturbed.",
  },
  {
    id: "worn_satchel",
    dc: 12,
    reward: { type: "gold", amount: 20 },
    successText: "Behind a fallen beam, a worn satchel holds coins. (+20 GP)",
    failureText: "Nothing catches your eye in this area.",
  },
  {
    id: "scrap_parchment",
    dc: 12,
    reward: {
      type: "lore",
      text: "A scrap of parchment reads: 'They came from the east and did not leave.'",
    },
    successText: "You find a scrap of parchment wedged in a crack.",
    failureText: "A thorough search reveals only worn stone.",
  },
  {
    id: "healing_cache",
    dc: 15,
    reward: { type: "item", itemId: "health_potion" },
    successText: "A hidden niche in the wall holds a carefully wrapped vial.",
    failureText: "The walls show signs of age but nothing stands out.",
  },
];

export function pickSecrets(count: number): SecretDef[] {
  const shuffled = [...SECRET_POOL].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}
