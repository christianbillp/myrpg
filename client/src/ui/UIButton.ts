import Phaser from "phaser";

const DPR = window.devicePixelRatio;

export function makeButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  label: string,
  bgColor: number,
  onClick: () => void,
  width = 160,
  height = 34,
  fontSize = "12px",
): Phaser.GameObjects.Container {
  const bg = scene.add.rectangle(0, 0, width, height, bgColor).setStrokeStyle(1, 0x556677);
  const text = scene.add
    .text(0, 0, label, { fontSize, color: "#ffffff", fontFamily: "monospace", resolution: DPR })
    .setOrigin(0.5);
  const container = scene.add.container(x, y, [bg, text]).setDepth(12);
  bg.setInteractive({ useHandCursor: true });
  bg.on("pointerover", () => bg.setAlpha(0.75));
  bg.on("pointerout",  () => bg.setAlpha(1));
  bg.on("pointerdown", onClick);
  return container;
}
