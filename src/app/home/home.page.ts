import {
  Component, ViewChild, ElementRef, AfterViewInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonButton, IonItem, IonInput
} from '@ionic/angular/standalone';
import {
  BleClient,
  numbersToDataView,
  dataViewToText
} from '@capacitor-community/bluetooth-le';

// UUIDs típicos de módulos BLE-UART (HM-10, JDY-08, AT-09, BT-05)
const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const CHAR_UUID    = '0000ffe1-0000-1000-8000-00805f9b34fb';

// === Resolución de la matriz LED (3 placas FC16: 32 cols x 24 filas) ===
const IMG_W = 32;
const IMG_H = 24;
const TOTAL_PX = IMG_W * IMG_H;          // 768
const IMG_BYTES = TOTAL_PX / 8;          // 96

// === Tunables BLE ===
const CHUNK_SIZE      = 20;
const INTER_CHUNK_MS  = 25;
const CMD_TO_DATA_MS  = 80;

// =====================================================================
//  Helpers de bitmap (array plano de 768 booleans, row-major)
// =====================================================================
function bm(): boolean[] { return new Array(TOTAL_PX).fill(false); }

function setP(b: boolean[], x: number, y: number, on = true) {
  if (x >= 0 && x < IMG_W && y >= 0 && y < IMG_H) b[y * IMG_W + x] = on;
}

function fillDisc(b: boolean[], cx: number, cy: number, r: number) {
  const r2 = r * r;
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++)
      if (x * x + y * y <= r2) setP(b, cx + x, cy + y);
}

function ring(b: boolean[], cx: number, cy: number, r: number) {
  const outer = r * r;
  const inner = (r - 1.4) * (r - 1.4);
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++) {
      const d2 = x * x + y * y;
      if (d2 <= outer && d2 > inner) setP(b, cx + x, cy + y);
    }
}

function fillRect2(b: boolean[], x0: number, y0: number, w: number, h: number) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) setP(b, x, y);
}

function strokeRect(b: boolean[], x0: number, y0: number, w: number, h: number) {
  for (let y = y0; y < y0 + h; y++) {
    setP(b, x0, y);
    setP(b, x0 + w - 1, y);
  }
  for (let x = x0; x < x0 + w; x++) {
    setP(b, x, y0);
    setP(b, x, y0 + h - 1);
  }
}

function lineBR(b: boolean[], x0: number, y0: number, x1: number, y1: number) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (true) {
    setP(b, x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx)  { err += dx; y += sy; }
  }
}

// =====================================================================
//  Iconos predefinidos (32x24)
// =====================================================================
function makeHeart(): boolean[] {
  const b = bm();
  fillDisc(b, 11, 9, 4);
  fillDisc(b, 20, 9, 4);
  for (let y = 11; y <= 20; y++) {
    const halfW = Math.max(0, 9 - (y - 11));
    for (let x = 16 - halfW; x < 16 + halfW; x++) setP(b, x, y);
  }
  return b;
}

function makeSmiley(): boolean[] {
  const b = bm();
  ring(b, 15, 11, 10);
  fillDisc(b, 11, 9, 1);
  fillDisc(b, 19, 9, 1);
  for (let dx = -5; dx <= 5; dx++) {
    const y = 14 + Math.round(Math.sqrt(Math.max(0, 25 - dx * dx)) * 0.5);
    setP(b, 15 + dx, y);
  }
  return b;
}

function makeStar(): boolean[] {
  const b = bm();
  const cx = 15, cy = 11;
  const outerR = 9, innerR = 4;
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const r = i % 2 === 0 ? outerR : innerR;
    pts.push([Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))]);
  }
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    lineBR(b, x0, y0, x1, y1);
  }
  return b;
}

function makeArrowUp(): boolean[] {
  const b = bm();
  for (let dy = 0; dy < 8; dy++) {
    const halfW = dy;
    for (let dx = -halfW; dx <= halfW; dx++) setP(b, 15 + dx, 1 + dy);
  }
  fillRect2(b, 13, 9, 5, 12);
  return b;
}

function makeArrowDown(): boolean[] {
  const b = bm();
  fillRect2(b, 13, 2, 5, 12);
  for (let dy = 0; dy < 8; dy++) {
    const halfW = 7 - dy;
    for (let dx = -halfW; dx <= halfW; dx++) setP(b, 15 + dx, 14 + dy);
  }
  return b;
}

function makeArrowLeft(): boolean[] {
  const b = bm();
  for (let dx = 0; dx < 8; dx++) {
    const halfH = dx;
    for (let dy = -halfH; dy <= halfH; dy++) setP(b, 1 + dx, 11 + dy);
  }
  fillRect2(b, 9, 9, 21, 5);
  return b;
}

function makeArrowRight(): boolean[] {
  const b = bm();
  fillRect2(b, 2, 9, 21, 5);
  for (let dx = 0; dx < 8; dx++) {
    const halfH = 7 - dx;
    for (let dy = -halfH; dy <= halfH; dy++) setP(b, 23 + dx, 11 + dy);
  }
  return b;
}

function makeSun(): boolean[] {
  const b = bm();
  const cx = 15, cy = 11;
  fillDisc(b, cx, cy, 4);
  const rayLen = 3, gap = 1;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const x0 = Math.round(cx + Math.cos(a) * (4 + gap));
    const y0 = Math.round(cy + Math.sin(a) * (4 + gap));
    const x1 = Math.round(cx + Math.cos(a) * (4 + gap + rayLen));
    const y1 = Math.round(cy + Math.sin(a) * (4 + gap + rayLen));
    lineBR(b, x0, y0, x1, y1);
  }
  return b;
}

function makeLightning(): boolean[] {
  const b = bm();
  // Rayo (zigzag relleno)
  const pts: [number, number][] = [
    [18, 2], [12, 11], [16, 11], [13, 21], [21, 10], [17, 10], [18, 2]
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    lineBR(b, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  }
  // Engrosar
  const copia = b.slice();
  for (let p = 0; p < TOTAL_PX; p++) {
    if (copia[p]) {
      const y = Math.floor(p / IMG_W), x = p % IMG_W;
      setP(b, x + 1, y);
    }
  }
  return b;
}

function makeCircleFilled(): boolean[] {
  const b = bm();
  fillDisc(b, 15, 11, 9);
  return b;
}

function makeRing(): boolean[] {
  const b = bm();
  ring(b, 15, 11, 9);
  ring(b, 15, 11, 8);
  return b;
}

function makeDiamond(): boolean[] {
  const b = bm();
  const cx = 15, cy = 11;
  for (let dy = -10; dy <= 10; dy++) {
    const halfW = 10 - Math.abs(dy);
    for (let dx = -halfW; dx <= halfW; dx++) setP(b, cx + dx, cy + dy);
  }
  return b;
}

function makeSquare(): boolean[] {
  const b = bm();
  strokeRect(b, 9, 6, 14, 14);
  strokeRect(b, 10, 7, 12, 12);
  return b;
}

function makePlus(): boolean[] {
  const b = bm();
  fillRect2(b, 4, 10, 23, 4);
  fillRect2(b, 13, 2, 5, 20);
  return b;
}

function makeX(): boolean[] {
  const b = bm();
  for (let i = 0; i <= 19; i++) {
    setP(b, 6 + i, 2 + i);
    setP(b, 7 + i, 2 + i);
    setP(b, 6 + i, 3 + i);
    setP(b, 25 - i, 2 + i);
    setP(b, 26 - i, 2 + i);
    setP(b, 25 - i, 3 + i);
  }
  return b;
}

function makeCheck(): boolean[] {
  const b = bm();
  // Trazo descendente corto
  for (let i = 0; i < 8; i++) {
    setP(b, 5 + i, 11 + i);
    setP(b, 6 + i, 11 + i);
    setP(b, 5 + i, 12 + i);
  }
  // Trazo ascendente largo
  for (let i = 0; i < 14; i++) {
    setP(b, 12 + i, 18 - i);
    setP(b, 13 + i, 18 - i);
    setP(b, 12 + i, 19 - i);
  }
  return b;
}

function makeLine(): boolean[] {
  const b = bm();
  fillRect2(b, 4, 10, 24, 3);
  return b;
}

function makeEmpty(): boolean[] {
  return bm();
}

interface Icono {
  id: string;
  nombre: string;
  emoji: string;
  bitmap: boolean[];
}

const ICONOS: Icono[] = [
  { id: 'heart',     nombre: 'Corazón',    emoji: '❤️', bitmap: makeHeart() },
  { id: 'smile',     nombre: 'Carita',     emoji: '\u{1F642}', bitmap: makeSmiley() },
  { id: 'star',      nombre: 'Estrella',   emoji: '⭐', bitmap: makeStar() },
  { id: 'sun',       nombre: 'Sol',        emoji: '☀️', bitmap: makeSun() },
  { id: 'lightning', nombre: 'Rayo',       emoji: '⚡', bitmap: makeLightning() },
  { id: 'arrow_up',  nombre: 'Arriba',     emoji: '⬆️', bitmap: makeArrowUp() },
  { id: 'arrow_dn',  nombre: 'Abajo',      emoji: '⬇️', bitmap: makeArrowDown() },
  { id: 'arrow_lf',  nombre: 'Izquierda',  emoji: '⬅️', bitmap: makeArrowLeft() },
  { id: 'arrow_rt',  nombre: 'Derecha',    emoji: '➡️', bitmap: makeArrowRight() },
  { id: 'circle',    nombre: 'Círculo',    emoji: '⚫', bitmap: makeCircleFilled() },
  { id: 'ring',      nombre: 'Anillo',     emoji: '◯', bitmap: makeRing() },
  { id: 'diamond',   nombre: 'Rombo',      emoji: '◆', bitmap: makeDiamond() },
  { id: 'square',    nombre: 'Cuadrado',   emoji: '⬜', bitmap: makeSquare() },
  { id: 'plus',      nombre: 'Cruz',       emoji: '➕', bitmap: makePlus() },
  { id: 'x',         nombre: 'Equis',      emoji: '❌', bitmap: makeX() },
  { id: 'check',     nombre: 'Check',      emoji: '✔️', bitmap: makeCheck() },
  { id: 'line',      nombre: 'Línea',      emoji: '➖', bitmap: makeLine() },
  { id: 'empty',     nombre: 'Vacío',      emoji: '⬛', bitmap: makeEmpty() },
];

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonButton, IonItem, IonInput
  ],
})
export class HomePage implements AfterViewInit {
  @ViewChild('ledCanvas') ledCanvasEl!: ElementRef<HTMLDivElement>;

  // ===== Estado conexión =====
  conectado = false;
  estado = 'Desconectado';
  mensaje = '';
  deviceId = '';

  // ===== Estado canvas =====
  iconos = ICONOS;
  iconoActivoId: string | null = null;
  modoDibujo: 'on' | 'off' = 'on';

  /** Estado lógico del canvas (32x24 = 768 booleans). */
  private canvas: boolean[] = bm();
  /** Referencias a los <span class="led"> para mutar la clase 'on' directamente. */
  private cells: HTMLElement[] = [];

  // Estado del puntero
  private drawing = false;
  private lastX = -1;
  private lastY = -1;

  readonly cellIndices = Array.from({ length: TOTAL_PX }, (_, i) => i);

  trackByIdx = (i: number) => i;
  trackByIconId = (_: number, ic: Icono) => ic.id;

  ngAfterViewInit() {
    const root = this.ledCanvasEl.nativeElement;
    this.cells = Array.from(root.querySelectorAll('.led')) as HTMLElement[];
    this.repaintAll();
  }

  // =====================================================================
  //  Canvas
  // =====================================================================
  private repaintAll() {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i].classList.toggle('on', this.canvas[i]);
    }
  }

  private setPixel(idx: number, on: boolean) {
    if (idx < 0 || idx >= TOTAL_PX) return;
    if (this.canvas[idx] === on) return;
    this.canvas[idx] = on;
    const el = this.cells[idx];
    if (el) el.classList.toggle('on', on);
  }

  cargarIcono(ic: Icono) {
    this.iconoActivoId = ic.id;
    this.canvas = ic.bitmap.slice();
    this.repaintAll();
  }

  limpiar() {
    this.canvas = bm();
    this.iconoActivoId = null;
    this.repaintAll();
  }

  // =====================================================================
  //  Dibujo con el dedo
  // =====================================================================
  onPointerDown(ev: PointerEvent) {
    ev.preventDefault();
    this.drawing = true;
    this.lastX = -1;
    this.lastY = -1;
    try { (ev.target as Element).setPointerCapture?.(ev.pointerId); } catch {}
    this.paintAt(ev);
  }

  onPointerMove(ev: PointerEvent) {
    if (!this.drawing) return;
    ev.preventDefault();
    this.paintAt(ev);
  }

  onPointerUp(_ev: PointerEvent) {
    this.drawing = false;
    this.lastX = -1;
    this.lastY = -1;
  }

  private paintAt(ev: PointerEvent) {
    const rect = this.ledCanvasEl.nativeElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width)  * IMG_W;
    const y = ((ev.clientY - rect.top)  / rect.height) * IMG_H;
    const col = Math.floor(x);
    const row = Math.floor(y);

    if (this.lastX < 0) {
      this.paintCell(col, row);
    } else {
      this.paintLine(this.lastX, this.lastY, col, row);
    }
    this.lastX = col;
    this.lastY = row;
  }

  private paintCell(col: number, row: number) {
    if (col < 0 || col >= IMG_W || row < 0 || row >= IMG_H) return;
    this.setPixel(row * IMG_W + col, this.modoDibujo === 'on');
  }

  private paintLine(x0: number, y0: number, x1: number, y1: number) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    while (true) {
      this.paintCell(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx)  { err += dx; y += sy; }
    }
  }

  // =====================================================================
  //  BLE: conexión
  // =====================================================================
  async conectar() {
    try {
      this.estado = 'Inicializando BLE...';
      await BleClient.initialize({ androidNeverForLocation: true });

      let deviceId = await this.buscarDispositivoVinculado();

      if (!deviceId) {
        this.estado = 'Selecciona tu dispositivo...';
        const device = await BleClient.requestDevice({
          namePrefix: 'PIXEL',
          services: [],
          optionalServices: [SERVICE_UUID],
          allowDuplicates: false
        });
        deviceId = device.deviceId;
      } else {
        this.estado = 'Dispositivo vinculado encontrado...';
      }

      await this.conectarA(deviceId);
    } catch (e: any) {
      this.estado = 'Error: ' + (e.message || JSON.stringify(e));
    }
  }

  private async buscarDispositivoVinculado(): Promise<string | null> {
    try {
      const conectados = await BleClient.getConnectedDevices([SERVICE_UUID]);
      const ya = conectados.find(d => d.name?.toUpperCase().startsWith('PIXEL'));
      if (ya) return ya.deviceId;
    } catch {}

    try {
      const bonded = await (BleClient as any).getBondedDevices?.();
      if (Array.isArray(bonded)) {
        const match = bonded.find((d: any) => d.name?.toUpperCase().startsWith('PIXEL'));
        if (match) return match.deviceId;
      }
    } catch {}

    return null;
  }

  private async conectarA(deviceId: string) {
    this.deviceId = deviceId;
    this.estado = 'Conectando...';

    try {
      await BleClient.connect(deviceId, () => {
        this.conectado = false;
        this.estado = 'Desconectado del dispositivo';
      });
    } catch (e: any) {
      const msg = (e?.message || '').toLowerCase();
      if (!msg.includes('already')) throw e;
    }

    await BleClient.startNotifications(
      deviceId, SERVICE_UUID, CHAR_UUID,
      (value) => {
        const txt = dataViewToText(value);
        console.log('Recibido:', txt);
        this.estado = 'RX: ' + txt;
      }
    );

    this.conectado = true;
    this.estado = 'Conectado ✅';
  }

  // =====================================================================
  //  Envío
  // =====================================================================
  async enviar() {
    if (!this.conectado || !this.deviceId) {
      this.estado = 'No conectado';
      return;
    }

    const hayPixeles = this.canvas.some(v => v);

    if (hayPixeles) {
      await this.enviarCanvas();
      return;
    }

    if (this.mensaje.trim()) {
      try {
        await this.escribirTexto(this.mensaje + '\n');
        this.estado = 'Enviado: ' + this.mensaje;
        this.mensaje = '';
      } catch (e: any) {
        this.estado = 'Error envío: ' + (e.message || e);
      }
      return;
    }

    this.estado = 'Dibuja algo o escribe un mensaje';
  }

  private async enviarCanvas() {
    try {
      this.estado = 'Preparando imagen...';
      // Espejo horizontal antes de empaquetar: lo que se envía al dispositivo
      // es la imagen del canvas reflejada (eje X). El canvas mostrado en la
      // app no cambia visualmente.
      const espejada = this.espejarHorizontal(this.canvas);
      const bytes = this.empaquetar(espejada);

      await this.escribirTexto('IMG\n');
      await this.delay(CMD_TO_DATA_MS);

      for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const slice = bytes.slice(i, i + CHUNK_SIZE);
        await BleClient.write(
          this.deviceId, SERVICE_UUID, CHAR_UUID,
          numbersToDataView(slice)
        );
        const pct = Math.min(100, Math.round(((i + slice.length) / bytes.length) * 100));
        this.estado = `Enviando ${pct}%`;
        if (i + CHUNK_SIZE < bytes.length) await this.delay(INTER_CHUNK_MS);
      }

      this.estado = 'Enviado ✅';
    } catch (e: any) {
      this.estado = 'Error envío: ' + (e.message || e);
    }
  }

  /** Devuelve una copia del canvas reflejada horizontalmente (eje X). */
  private espejarHorizontal(c: boolean[]): boolean[] {
    const out = new Array(TOTAL_PX).fill(false);
    for (let y = 0; y < IMG_H; y++) {
      const base = y * IMG_W;
      for (let x = 0; x < IMG_W; x++) {
        out[base + (IMG_W - 1 - x)] = c[base + x];
      }
    }
    return out;
  }

  private empaquetar(c: boolean[]): number[] {
    const out: number[] = new Array(IMG_BYTES).fill(0);
    for (let p = 0; p < TOTAL_PX; p++) {
      if (c[p]) {
        const byteIdx = p >> 3;
        const bitIdx  = 7 - (p & 7);
        out[byteIdx] |= (1 << bitIdx);
      }
    }
    return out;
  }

  private async escribirTexto(s: string) {
    const bytes = Array.from(new TextEncoder().encode(s));
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const slice = bytes.slice(i, i + CHUNK_SIZE);
      await BleClient.write(
        this.deviceId, SERVICE_UUID, CHAR_UUID,
        numbersToDataView(slice)
      );
    }
  }

  private delay(ms: number) {
    return new Promise(r => setTimeout(r, ms));
  }
}
