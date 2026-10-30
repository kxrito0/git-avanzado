/**
 * sketch.js — bootstrap. Solo instancia módulos y los conecta.
 * Ni reglas de juego ni dibujo de detalles: eso vive en cada módulo.
 */

let tracker;
let renderer;

function setup() {
  createCanvas(windowWidth, windowHeight);

  tracker = new HandTracker({ maxHands: 2, mirrored: true });
  renderer = new HandRenderer();

  // Sin await a propósito: el modelo pesa varios MB. Si bloqueamos setup,
  // draw() no arranca y el usuario ve una pantalla negra sin explicación.
  // Así el primer frame ya muestra "Cargando modelo…" y el estado de error.
  tracker.start();
}

function draw() {
  background(0);
  renderer.draw(tracker);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
