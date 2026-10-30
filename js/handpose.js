/**
 * handpose.js — captura de manos con ml5 + dibujo del esqueleto.
 *
 * Responsabilidad única: convertir video en datos de manos normalizados
 * y (opcionalmente) dibujarlos. Ni reglas de juego ni HUD viven acá.
 *
 * ── Contrato público (lo que gamelogic.js y ui.js pueden leer) ──────────────
 *
 *   tracker.status      'loading' | 'ready' | 'error:camera' | 'error:model'
 *   tracker.error       string | null   detalle del último fallo
 *   tracker.hands       Hand[]          vacío mientras no se detecte nada
 *   tracker.connections number[][]      pares de índices de keypoints (esqueleto)
 *   tracker.aspect      number          ancho / alto del video
 *
 *   Hand = {
 *     handedness: 'Left' | 'Right' | 'Unknown',
 *     confidence: number,
 *     keypoints: Array<{ x, y, z, name }>,   // 21 puntos
 *     named: { [name]: { x, y, z } }         // acceso directo, ej. named.index_finger_tip
 *   }
 *
 * Coordenadas: x e y van de 0 a 1 sobre el área del video, con x YA espejado
 * (modo selfie). gamelogic.js no necesita saber el tamaño de la pantalla ni
 * del canvas: multiplica por el espacio que quiera.
 *
 * Ojo: `handedness` es la etiqueta cruda del modelo. Con el espejado aplicado,
 * corresponde a la mano anatómica del usuario, no a la de la imagen.
 */

class HandTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.maxHands=2]
   * @param {boolean} [options.mirrored=true]  invierte x para que se sienta como espejo
   * @param {number} [options.width=640]       resolución pedida a la cámara
   * @param {number} [options.height=480]
   */
  constructor({ maxHands = 2, mirrored = true, width = 640, height = 480 } = {}) {
    this.maxHands = maxHands;
    this.mirrored = mirrored;
    this.requestedWidth = width;
    this.requestedHeight = height;

    this.status = 'loading';
    this.error = null;
    this.hands = [];
    this.connections = [];
    this.aspect = width / height;

    this._model = null;
    this._video = null;
    this._stream = null;
  }

  /** Arranca cámara + modelo. Nunca lanza: el resultado se lee en `status`. */
  async start() {
    this.status = 'loading';
    this.error = null;

    try {
      await this._openCamera();
    } catch (err) {
      this.status = 'error:camera';
      this.error = err && err.message ? err.message : String(err);
      console.error('[handpose] no se pudo abrir la cámara:', this.error);
      return false;
    }

    try {
      if (typeof ml5 === 'undefined') {
        throw new Error('ml5 no está cargado (revisá el <script> del CDN en index.html)');
      }

      // OJO: ml5.handPose() devuelve la instancia al instante, NO una promesa
      // con el modelo listo. `await ml5.handPose()` no espera nada: el modelo
      // todavía se está descargando y detectStart() explotaría con model=null.
      // La promesa real es `instance.ready`.
      const instance = ml5.handPose({ maxHands: this.maxHands });
      await instance.ready;

      this._model = instance;
      this.connections =
        typeof instance.getConnections === 'function' ? instance.getConnections() : [];
      instance.detectStart(this._video, (results) => this._onResults(results));
      this.status = 'ready';
      return true;
    } catch (err) {
      this.status = 'error:model';
      this.error = err && err.message ? err.message : String(err);
      console.error('[handpose] no se pudo cargar el modelo:', this.error);
      return false;
    }
  }

  /** Corta la detección, apaga la cámara y saca el <video> del DOM. */
  stop() {
    if (this._model && typeof this._model.detectStop === 'function') this._model.detectStop();
    if (this._stream) this._stream.getTracks().forEach((track) => track.stop());
    if (this._video) this._video.remove();
    this._model = null;
    this._video = null;
    this._stream = null;
    this.hands = [];
    this.status = 'loading';
  }

  async _openCamera() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      throw new Error(
        'navigator.mediaDevices no existe: abrí la página desde http://localhost, no con file://'
      );
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    // Fuera de la vista pero decodificando: con display:none algunos navegadores
    // dejan de entregar frames y la detección se congela.
    Object.assign(video.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '-1',
    });
    document.body.appendChild(video);

    this._stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: this.requestedWidth },
        height: { ideal: this.requestedHeight },
      },
      audio: false,
    });

    video.srcObject = this._stream;
    await video.play();

    this._video = video;
    this.aspect =
      (video.videoWidth || this.requestedWidth) / (video.videoHeight || this.requestedHeight);
  }

  _onResults(results) {
    const w = this._video.videoWidth || this.requestedWidth;
    const h = this._video.videoHeight || this.requestedHeight;
    this.hands = (results || []).map((hand) => this._normalizeHand(hand, w, h));
  }

  _normalizeHand(hand, videoWidth, videoHeight) {
    const keypoints = (hand.keypoints || []).map((kp) => {
      const x = kp.x / videoWidth;
      return {
        x: this.mirrored ? 1 - x : x,
        y: kp.y / videoHeight,
        z: typeof kp.z === 'number' ? kp.z : 0,
        name: kp.name,
      };
    });

    const named = {};
    for (const keypoint of keypoints) named[keypoint.name] = keypoint;

    return {
      handedness: hand.handedness || 'Unknown',
      confidence: typeof hand.confidence === 'number' ? hand.confidence : 0,
      keypoints,
      named,
    };
  }
}

class HandRenderer {
  /**
   * @param {object} [options]
   * @param {number[]} [options.boneColor=[120,220,255]]
   * @param {number[]} [options.jointColor=[255,255,255]]
   * @param {number} [options.boneWeight=4]
   * @param {number} [options.jointSize=7]
   */
  constructor({ boneColor = [120, 220, 255], jointColor = [255, 255, 255], boneWeight = 4, jointSize = 7 } = {}) {
    this.boneColor = boneColor;
    this.jointColor = jointColor;
    this.boneWeight = boneWeight;
    this.jointSize = jointSize;
  }

  /** Dibuja el estado del tracker: manos, o el mensaje de carga/error. */
  draw(tracker) {
    if (tracker.status !== 'ready') {
      this._drawStatus(tracker.status, tracker.error);
      return;
    }
    const box = this._layout(tracker.aspect);
    for (const hand of tracker.hands) this._drawHand(hand, tracker.connections, box);
  }

  /**
   * Letterbox: el video es 4:3 y la ventana suele ser 16:9. Sin esto el
   * esqueleto se estira en horizontal y las distancias mienten.
   */
  _layout(aspect) {
    const w = Math.min(width, height * aspect);
    const h = w / aspect;
    return { ox: (width - w) / 2, oy: (height - h) / 2, w, h };
  }

  _toPixels(keypoint, box) {
    return { x: box.ox + keypoint.x * box.w, y: box.oy + keypoint.y * box.h };
  }

  _drawHand(hand, connections, box) {
    stroke(...this.boneColor);
    strokeWeight(this.boneWeight);
    noFill();
    for (const [a, b] of connections) {
      const start = hand.keypoints[a];
      const end = hand.keypoints[b];
      if (!start || !end) continue;
      const p1 = this._toPixels(start, box);
      const p2 = this._toPixels(end, box);
      line(p1.x, p1.y, p2.x, p2.y);
    }

    noStroke();
    fill(...this.jointColor);
    for (const keypoint of hand.keypoints) {
      const p = this._toPixels(keypoint, box);
      circle(p.x, p.y, this.jointSize * 2);
    }
  }

  _drawStatus(status, detail) {
    const messages = {
      loading: 'Cargando modelo de manos…',
      'error:camera': 'No se pudo acceder a la cámara. Revisá los permisos del navegador.',
      'error:model': 'No se pudo cargar el modelo. ¿Hay conexión a internet?',
    };
    noStroke();
    fill(200);
    textAlign(CENTER, CENTER);
    textSize(16);
    text(messages[status] || status, width / 2, height / 2);

    if (detail) {
      const line = detail.length > 90 ? `${detail.slice(0, 90)}…` : detail;
      textSize(12);
      fill(140);
      text(line, width / 2, height / 2 + 28);
    }
  }
}
