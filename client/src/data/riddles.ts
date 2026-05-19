export interface Riddle {
  question: string;
  options: [string, string, string];
  correctIndex: 0 | 1 | 2;
}

export const RIDDLES: Riddle[] = [
  {
    question: "I speak without a mouth\nand hear without ears.\nWhat am I?",
    options: ["A shadow", "An echo", "The wind"],
    correctIndex: 1,
  },
  {
    question: "The more you take,\nthe more you leave behind.\nWhat am I?",
    options: ["Time", "Footsteps", "Memories"],
    correctIndex: 1,
  },
  {
    question: "I can fly without wings\nand cry without eyes.\nWhat am I?",
    options: ["A cloud", "A ghost", "Smoke"],
    correctIndex: 0,
  },
];

export function pickRiddle(): Riddle {
  return RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
}
